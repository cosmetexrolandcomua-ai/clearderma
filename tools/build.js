'use strict';
/*
 * Збірка сайту (Vercel запускає її під час кожної публікації, див. vercel.json).
 * З одного index.html створює в dist/:
 *   - окремий HTML кожної сторінки з власними title, description, canonical, Open Graph і JSON-LD;
 *   - 404.html;
 *   - sitemap.xml із усіма сторінками та товарами.
 * Нічого оновлювати вручну не треба: новий товар у PRODUCTS одразу потрапляє на сайт і в sitemap.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..'), out = path.join(root, 'dist');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function cut(from, to) {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`index.html: не знайдено блок «${from}»`);
  return html.slice(a, b);
}
const products = /const PRODUCTS = \[.*\];/.exec(html);
if (!products) throw new Error('index.html: не знайдено PRODUCTS');
const ctx = {};
vm.runInNewContext(`${products[0]}\n${cut('/* ===== Derive category structure', 'function currentPath')}\nthis.api = { pageMeta, metaTags, sitePaths, SITE };`, ctx);
const { pageMeta, metaTags, sitePaths, SITE } = ctx.api;

const HEAD = /<title>[^<]*<\/title>\n<!--seo-->[\s\S]*?<!--\/seo-->/;
if (!HEAD.test(html)) throw new Error('index.html: немає блоку <!--seo-->');
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function render(pagePath) {
  const m = pageMeta(pagePath);
  return html.replace(HEAD, () => `<title>${escape(m.title)}</title>\n<!--seo-->\n${metaTags(m)}\n<!--/seo-->`);
}
function write(file, text) {
  fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
  fs.writeFileSync(path.join(out, file), text);
}

fs.rmSync(out, { recursive: true, force: true });
const pages = sitePaths();
for (const p of pages) {
  if (!pageMeta(p).found) throw new Error(`Немає метаданих для ${p}`);
  write(p === '/' ? 'index.html' : `${p.slice(1)}.html`, render(p));
}
write('checkout.html', render('/checkout'));
write('404.html', render('/404'));
write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  pages.map(p => `  <url><loc>${SITE}${p}</loc></url>`).join('\n') + '\n</urlset>\n');
fs.cpSync(path.join(root, 'images'), path.join(out, 'images'), { recursive: true });
fs.copyFileSync(path.join(root, 'robots.txt'), path.join(out, 'robots.txt'));
console.log(`Готово: ${pages.length} сторінок у sitemap.xml`);
