'use strict';

/*
 * POST /api/order — приймає замовлення з сайту й надсилає його в Telegram.
 * Змінні середовища (Vercel → Settings → Environment Variables):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Ціни беруться з масиву PRODUCTS в index.html (див. includeFiles у vercel.json),
 * тому окремо оновлювати їх тут не потрібно.
 */

const fs = require('fs');
const path = require('path');

const MAX_LINES = 30;      // різних товарів в одному замовленні (ліміт довжини повідомлення Telegram)
const MAX_QTY = 99;        // штук одного товару
const MAX_BODY = 20000;    // символів у тілі запиту
const MAX_ITEM_NAME = 70;  // символів назви товару в повідомленні
const TELEGRAM_TIMEOUT_MS = 8000;

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
  phone: { label: 'Телефон', min: 10, max: 30 },
  city: { label: 'Місто', min: 2, max: 100 },
  delivery: { label: 'Спосіб доставки', min: 2, max: 80 },
  payment: { label: 'Спосіб оплати', min: 2, max: 80 }
};

function validateCustomer(body) {
  const customer = {};
  for (const [key, rule] of Object.entries(FIELDS)) {
    const raw = body[key];
    // Керівні символи й переноси рядків прибираємо, щоб не можна було підробити рядки повідомлення
    const value = typeof raw === 'string' ? raw.replace(/[\p{C}\p{Zl}\p{Zp}\s]+/gu, ' ').trim() : '';
    if (value.length < rule.min || value.length > rule.max) {
      throw new OrderError(400, 'invalid_field', `Перевірте поле «${rule.label}».`);
    }
    customer[key] = value;
  }
  const digits = customer.phone.replace(/\D/g, '');
  if (!/^[0-9+()\s-]+$/.test(customer.phone) || digits.length < 10 || digits.length > 15) {
    throw new OrderError(400, 'invalid_field', 'Перевірте поле «Телефон».');
  }
  return customer;
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

function buildMessage(customer, lines, total) {
  const list = lines.map(({ product, qty }) =>
    `- ${escapeHtml(shorten(product.name, MAX_ITEM_NAME))} (Арт: ${escapeHtml(product.sku || '—')}) x${qty} = ${product.price * qty} грн`
  ).join('\n');
  return [
    '🔔 <b>Нове замовлення clearderma!</b> 🛒',
    '',
    `👤 <b>Клієнт:</b> ${escapeHtml(customer.name)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(customer.phone)}`,
    `📍 <b>Місто:</b> ${escapeHtml(customer.city)}`,
    `🚚 <b>Доставка:</b> ${escapeHtml(customer.delivery)}`,
    `💳 <b>Оплата:</b> ${escapeHtml(customer.payment)}`,
    '',
    '📦 <b>Товари:</b>',
    list,
    '',
    `💰 <b>Сума до сплати:</b> ${total} грн`
  ].join('\n');
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

    await sendToTelegram(buildMessage(customer, lines, total));
    return res.status(200).json({ ok: true, total });
  } catch (err) {
    if (err instanceof OrderError) {
      return res.status(err.status).json({ ok: false, error: err.code, message: err.message });
    }
    console.error('Order failed:', err.message);
    return res.status(502).json({ ok: false, error: 'send_failed', message: 'Не вдалося надіслати замовлення.' });
  }
};
