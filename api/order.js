'use strict';

/*
 * POST /api/order — приймає замовлення з сайту, зберігає його файлом у ПРИВАТНОМУ репозиторії GitHub
 * і, якщо налаштовано, надсилає в Telegram. Замовлення прийнято, коли спрацював хоча б один спосіб.
 * Змінні середовища (Vercel → Settings → Environment Variables):
 *   GITHUB_ORDERS_TOKEN — fine-grained токен з доступом Contents: Read and write лише до репозиторію замовлень
 *   GITHUB_ORDERS_REPO  — необов'язково, за замовчуванням cosmetexrolandcomua-ai/clearderma-orders
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — необов'язково
 * У файлах замовлень є персональні дані, тому в публічний репозиторій функція не пише.
 * Ціни беруться з масиву PRODUCTS в index.html (див. includeFiles у vercel.json),
 * тому окремо оновлювати їх тут не потрібно.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LINES = 30;      // різних товарів в одному замовленні (ліміт довжини повідомлення Telegram)
const MAX_QTY = 99;        // штук одного товару
const MAX_BODY = 20000;    // символів у тілі запиту
const MAX_ITEM_NAME = 70;  // символів назви товару в повідомленні
const TELEGRAM_TIMEOUT_MS = 8000;
const GITHUB_TIMEOUT_MS = 5000;
const GITHUB_ATTEMPTS = 3;
const DEFAULT_ORDERS_REPO = 'cosmetexrolandcomua-ai/clearderma-orders';

class OrderError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ===== Каталог ===== */
let catalog = null;

function parseCatalog(html) {
  const marker = /const\s+PRODUCTS\s*=\s*\[/.exec(html);
  if (!marker) throw new Error('PRODUCTS not found');
  const start = marker.index + marker[0].length - 1;
  let depth = 0, inString = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) throw new Error('PRODUCTS is not closed');
  const products = JSON.parse(html.slice(start, end));
  const byId = new Map();
  for (const p of products) {
    if (!Number.isInteger(p.id) || typeof p.name !== 'string' || !Number.isFinite(p.price) || p.price <= 0) {
      throw new Error('Invalid product in PRODUCTS');
    }
    byId.set(p.id, p);
  }
  if (byId.size === 0) throw new Error('PRODUCTS is empty');
  return byId;
}

function getCatalog() {
  if (!catalog) {
    catalog = parseCatalog(fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'));
  }
  return catalog;
}

/* ===== Перевірка полів ===== */
const FIELDS = {
  name: { label: 'ПІБ', min: 2, max: 100 },
  phone: { label: 'Телефон', min: 10, max: 30 }
};

const DELIVERY = {
  np_branch: { label: 'Нова Пошта — відділення', city: true, address: 'Відділення' },
  np_postomat: { label: 'Нова Пошта — поштомат', city: true, address: 'Поштомат' },
  np_courier: { label: "Нова Пошта — кур'єр", city: true, address: 'Адреса' },
  ukrposhta: { label: 'Укрпошта', city: true, address: 'Адреса' },
  pickup: { label: 'Самовивіз (Київ)' }
};
const PAYMENT = ['Передоплата на реквізити ФОП', 'Оплата при отриманні'];

// Керівні символи й переноси рядків прибираємо, щоб не можна було підробити рядки повідомлення
function clean(raw) {
  return typeof raw === 'string' ? raw.replace(/[\p{C}\p{Zl}\p{Zp}\s]+/gu, ' ').trim() : '';
}

function checkLength(value, label, min, max) {
  const length = [...value].length;
  if (length < min || length > max) throw new OrderError(400, 'invalid_field', `Перевірте поле «${label}».`);
  return value;
}

function validateDelivery(body) {
  const type = Object.hasOwn(DELIVERY, body.deliveryType) ? DELIVERY[body.deliveryType] : null;
  if (!type) throw new OrderError(409, 'form_changed', 'Форма замовлення оновилася. Оновіть сторінку й заповніть її ще раз.');
  if (!PAYMENT.includes(body.payment)) throw new OrderError(400, 'invalid_field', 'Перевірте поле «Спосіб оплати».');
  return {
    delivery: type.label,
    addressLabel: type.address,
    city: type.city ? checkLength(clean(body.city), 'Місто', 2, 100) : '',
    address: type.address ? checkLength(clean(body.address), type.address, 1, 200) : '',
    payment: body.payment,
    comment: checkLength(clean(body.comment), 'Коментар', 0, 300)
  };
}

function validateCustomer(body) {
  const customer = {};
  for (const [key, rule] of Object.entries(FIELDS)) {
    const value = checkLength(clean(body[key]), rule.label, rule.min, rule.max);
    customer[key] = value;
  }
  const digits = customer.phone.replace(/\D/g, '');
  if (!/^[0-9+()\s-]+$/.test(customer.phone) || digits.length < 10 || digits.length > 15) {
    throw new OrderError(400, 'invalid_field', 'Перевірте поле «Телефон».');
  }
  return { ...customer, ...validateDelivery(body) };
}

function validateItems(items, products) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderError(400, 'empty_cart', 'Кошик порожній.');
  }
  if (items.length > MAX_LINES) {
    throw new OrderError(400, 'too_many_items', `В одному замовленні може бути не більше ${MAX_LINES} різних товарів.`);
  }
  const lines = new Map();
  for (const item of items) {
    const id = item && item.id, qty = item && item.qty;
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) {
      throw new OrderError(400, 'invalid_item', 'Перевірте кількість товарів у кошику.');
    }
    const product = products.get(id);
    if (!product) {
      throw new OrderError(409, 'catalog_changed', 'Каталог оновився. Оновіть сторінку й перевірте кошик.');
    }
    const total = (lines.has(id) ? lines.get(id).qty : 0) + qty;
    if (total > MAX_QTY) {
      throw new OrderError(400, 'invalid_item', `Можна замовити не більше ${MAX_QTY} шт. одного товару.`);
    }
    lines.set(id, { product, qty: total });
  }
  return [...lines.values()];
}

/* ===== Повідомлення ===== */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shorten(text, max) {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
}

function buildMessage(order, customer, lines, total) {
  const list = lines.map(({ product, qty }) =>
    `- ${escapeHtml(shorten(product.name, MAX_ITEM_NAME))} (Арт: ${escapeHtml(product.sku || '—')}) x${qty} = ${product.price * qty} грн`
  ).join('\n');
  return [
    `🔔 <b>Нове замовлення clearderma № ${order.number}</b> 🛒`,
    '',
    `👤 <b>Клієнт:</b> ${escapeHtml(customer.name)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(customer.phone)}`,
    `🚚 <b>Доставка:</b> ${escapeHtml(customer.delivery)}`,
    customer.city === '' ? undefined : `📍 <b>Місто:</b> ${escapeHtml(customer.city)}`,
    customer.address === '' ? undefined : `🏤 <b>${customer.addressLabel}:</b> ${escapeHtml(customer.address)}`,
    `💳 <b>Оплата:</b> ${escapeHtml(customer.payment)}`,
    customer.comment === '' ? undefined : `💬 <b>Коментар:</b> ${escapeHtml(customer.comment)}`,
    '',
    '📦 <b>Товари:</b>',
    list,
    '',
    `💰 <b>Сума до сплати:</b> ${total} грн`
  ].filter(line => line !== undefined).join('\n');
}

async function sendToTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set');

  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.trim(), text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    });
  } catch (err) {
    // Текст вихідної помилки не логуємо: він може містити URL із токеном
    throw new Error(`Telegram request failed (${err && err.name})`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    throw new Error(`Telegram rejected the message: HTTP ${res.status} ${(data && data.description) || ''}`);
  }
}

/* ===== GitHub ===== */
// Номер і час замовлення за Києвом
function createOrder() {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date())) parts[p.type] = p.value;
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    number: `${day.replace(/-/g, '')}-${code}`,
    date: `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`,
    file: `orders/${parts.year}-${parts.month}/${day}_${parts.hour}-${parts.minute}-${parts.second}_${code}.md`
  };
}

function escapeMarkdown(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]|~#!]/g, '\\$&');
}

function buildFile(order, customer, lines, total) {
  const rows = [
    ['Дата й час', order.date],
    ['Отримувач', customer.name],
    ['Телефон', customer.phone],
    ['Доставка', customer.delivery],
    ['Місто', customer.city],
    [customer.addressLabel, customer.address],
    ['Оплата', customer.payment],
    ['Коментар', customer.comment]
  ].filter(([label, value]) => label && value);
  return [
    `# Замовлення № ${order.number}`,
    '',
    '| Поле | Значення |',
    '|---|---|',
    ...rows.map(([label, value]) => `| ${label} | ${escapeMarkdown(value)} |`),
    '',
    '| Артикул | Товар | Ціна, грн | К-сть | Сума, грн |',
    '|---|---|---:|---:|---:|',
    ...lines.map(({ product, qty }) =>
      `| ${escapeMarkdown(product.sku || '—')} | ${escapeMarkdown(product.name)} | ${product.price} | ${qty} | ${product.price * qty} |`),
    '',
    `**Разом: ${total} грн**`,
    ''
  ].join('\n');
}

async function github(method, url, body) {
  try {
    return await fetch(`https://api.github.com/repos/${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_ORDERS_TOKEN.trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'clearderma-orders',
        'Content-Type': 'application/json'
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    });
  } catch (err) {
    throw new Error(`GitHub request failed (${err && err.name})`);
  }
}

async function saveToGitHub(order, text) {
  const repo = (process.env.GITHUB_ORDERS_REPO || DEFAULT_ORDERS_REPO).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_ORDERS_REPO is invalid');

  // Перевіряємо щоразу: репозиторій могли зробити публічним
  const info = await github('GET', repo);
  const data = await info.json().catch(() => null);
  if (!info.ok || !data) throw new Error(`GitHub repository is not available: HTTP ${info.status}`);
  if (data.private !== true) throw new Error('GitHub orders repository is public, refusing to save personal data');

  for (let attempt = 1; ; attempt++) {
    const res = await github('PUT', `${repo}/contents/${order.file}`, {
      message: `Замовлення ${order.number}`,
      content: Buffer.from(text, 'utf8').toString('base64')
    });
    if (res.ok) return;
    // 409: у ту саму мить записується інше замовлення
    if (res.status !== 409 || attempt >= GITHUB_ATTEMPTS) throw new Error(`GitHub rejected the file: HTTP ${res.status}`);
    await new Promise(resolve => setTimeout(resolve, 200 * attempt + Math.random() * 200));
  }
}

/* ===== Надсилання ===== */
async function deliver(customer, lines, total) {
  const order = createOrder();
  const jobs = [];
  if (process.env.GITHUB_ORDERS_TOKEN) jobs.push(saveToGitHub(order, buildFile(order, customer, lines, total)));
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) jobs.push(sendToTelegram(buildMessage(order, customer, lines, total)));
  if (jobs.length === 0) throw new Error('No order channel: set GITHUB_ORDERS_TOKEN or TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');

  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  if (failed.length === results.length) throw new Error(failed.join('; '));
  if (failed.length) console.error(`Order ${order.number}: one channel failed:`, failed.join('; '));
  return order;
}

/* ===== Запит ===== */
function readBody(req) {
  let body;
  try {
    body = req.body; // Vercel розбирає JSON при першому зверненні й кидає помилку, якщо він некоректний
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (err) {
    throw new OrderError(400, 'bad_json', 'Некоректний запит.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OrderError(400, 'bad_json', 'Некоректний запит.');
  }
  if (JSON.stringify(body).length > MAX_BODY) {
    throw new OrderError(413, 'too_large', 'Завеликий запит.');
  }
  return body;
}

function checkRequest(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new OrderError(415, 'bad_content_type', 'Некоректний запит.');
  }
  // Форма працює лише з самого сайту: браузер завжди передає Origin для POST
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let originHost = null;
  try { originHost = new URL(origin).host; } catch (err) { /* Origin відсутній або некоректний */ }
  if (!originHost || originHost !== host) {
    throw new OrderError(403, 'bad_origin', 'Запит відхилено.');
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'Метод не підтримується.' });
  }
  try {
    checkRequest(req);
    const body = readBody(req);
    const customer = validateCustomer(body);
    const lines = validateItems(body.items, getCatalog());
    const total = lines.reduce((sum, l) => sum + l.product.price * l.qty, 0);

    // Клієнт мав бачити ту саму суму; інакше сторінка відкрита зі старими цінами
    if (body.total !== total) {
      throw new OrderError(409, 'price_changed', 'Ціни на сайті оновилися. Оновіть сторінку й перевірте суму замовлення.');
    }

    const order = await deliver(customer, lines, total);
    return res.status(200).json({ ok: true, total, number: order.number });
  } catch (err) {
    if (err instanceof OrderError) {
      return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
    }
    console.error('Order failed:', err.message);
    return res.status(502).json({ ok: false, error: 'send_failed', message: 'Не вдалося надіслати замовлення.' });
  }
};
