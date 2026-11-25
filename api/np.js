'use strict';

/*
 * GET /api/np — довідник Нової Пошти для сторінки оформлення.
 *   ?type=city&q=Ічня                                   — населені пункти
 *   ?type=warehouse&kind=branch|postomat&ref=<Ref>&q=12 — відділення або поштомати
 * Ключ не обов'язковий; якщо задати NOVA_POSHTA_API_KEY (Vercel → Environment Variables), буде використано його.
 */

const API_URL = 'https://api.novaposhta.ua/v2.0/json/';
const TIMEOUT_MS = 8000;
const REF_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const POSTOMAT = 'f9316480-5f2d-425d-bc2c-ac7cd29decf0';
const BRANCHES = [
  '841339c7-591a-42e2-8233-7a0a00f0ed6f', // поштове
  '9a68df70-0267-42a8-bb5c-37f427e36ee4', // вантажне
  '6f8c7162-4b72-4b0a-88e5-906948c6a92f'  // з обмеженням ваги
];

async function call(calledMethod, methodProperties) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: (process.env.NOVA_POSHTA_API_KEY || '').trim(),
      modelName: 'Address', calledMethod, methodProperties
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.success) {
    throw new Error(`${calledMethod}: HTTP ${res.status} ${((data && data.errors) || []).join('; ')}`);
  }
  return data.data || [];
}

async function cities(q) {
  const data = await call('searchSettlements', { CityName: q, Limit: '15', Page: '1' });
  const list = (data[0] && data[0].Addresses) || [];
  return list.filter(c => REF_RE.test(c.Ref || '')).map(c => ({ ref: c.Ref, label: c.Present, warehouses: Number(c.Warehouses) || 0 }));
}

async function warehouses(ref, kind, q) {
  const types = kind === 'postomat' ? [POSTOMAT] : BRANCHES;
  const props = { SettlementRef: ref, Language: 'UA', Limit: '60', Page: '1' };
  if (q) props.FindByString = q;
  const parts = await Promise.all(types.map(t => call('getWarehouses', { ...props, TypeOfWarehouseRef: t })));
  const seen = new Set();
  return parts.flat()
    .filter(w => w.WarehouseStatus === 'Working' && w.DenyToSelect !== '1' && (kind === 'postomat') === (w.CategoryOfWarehouse === 'Postomat'))
    .filter(w => !seen.has(w.Ref) && seen.add(w.Ref))
    .sort((a, b) => Number(a.Number) - Number(b.Number))
    .slice(0, 80)
    .map(w => ({ ref: w.Ref, label: w.Description }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false });
  }
  const one = v => (typeof v === 'string' ? v.replace(/[\p{C}\s]+/gu, ' ').trim().slice(0, 60) : '');
  const type = one(req.query.type), q = one(req.query.q), ref = one(req.query.ref), kind = one(req.query.kind);
  try {
    let items;
    if (type === 'city' && q.length >= 2) items = await cities(q);
    else if (type === 'warehouse' && REF_RE.test(ref) && (kind === 'branch' || kind === 'postomat')) items = await warehouses(ref, kind, q);
    else return res.status(400).json({ ok: false });
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, items });
  } catch (err) {
    console.error('Nova Poshta failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ ok: false });
  }
};
