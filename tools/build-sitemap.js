'use strict';
// Оновлює sitemap.xml за товарами з index.html. Запуск: node tools/build-sitemap.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..'), SITE = 'https://clearderma.com.ua';
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const products = /const PRODUCTS = \[.*\];/.exec(html)[0];
const from = html.indexOf('const UA_MAP'), to = html.indexOf('function currentPath');
const ctx = {};
vm.runInNewContext(`${products}\n${html.slice(from, to)}\nthis.P = PRODUCTS; this.S = SLUG_BY_ID;`, ctx);
const cats = [...new Set(ctx.P.map(p => p.mainKey))];
const today = new Date().toISOString().slice(0, 10);
const paths = ['/', '/catalog', ...cats.map(c => `/catalog/${c}`), ...ctx.P.map(p => `/product/${ctx.S[p.id]}`), '/about', '/payment', '/returns', '/privacy'];
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  paths.map(p => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod></url>`).join('\n') + '\n</urlset>\n';
fs.writeFileSync(path.join(root, 'sitemap.xml'), xml);
console.log(`${paths.length} URL`);
