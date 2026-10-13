'use strict';
// Statische controles voor agent-leesbaarheid (is-agentic.com). Puur Node:   node test/agent-readiness.unit.spec.js
// Controleert de ruwe bestanden (zoals een agent ze zonder JavaScript ziet), niet de draaiende app.
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var BASE = 'https://twandijkmans-afk.github.io/MJOP-App/';

var fouten = 0;
function test(naam, fn) {
  try { fn(); console.log('OK   - ' + naam); } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); }
}
function lees(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function tekstVan(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
function bestaatLokaal(url) {
  assert.ok(url.indexOf(BASE) === 0, 'URL buiten de site: ' + url);
  var rel = url.slice(BASE.length) || 'index.html';
  assert.ok(fs.existsSync(path.join(ROOT, rel)), 'bestaat niet: ' + rel);
}

var index = lees('index.html');

test('index: <html lang>, canonical, og:image en og:type', function () {
  assert.ok(/<html lang="nl">/.test(index));
  assert.ok(index.indexOf('<link rel="canonical" href="' + BASE + '">') > -1);
  assert.ok(/<meta property="og:image" content="[^"]+">/.test(index));
  assert.ok(/<meta property="og:type" content="website">/.test(index));
});

test('index: ruwe HTML heeft precies één H1 en minstens 500 tekens inhoud binnen #root', function () {
  assert.strictEqual((index.match(/<h1[\s>]/g) || []).length, 1);
  var root = index.slice(index.indexOf('<div id="root">'), index.indexOf('<script src="https://cdn.jsdelivr.net/npm/xlsx'));
  assert.ok(tekstVan(root).length >= 500, 'tekst in #root: ' + tekstVan(root).length);
});

test('index: koppen op elkaar aansluitend (geen sprong h1 -> h3)', function () {
  var niveaus = (index.match(/<h([1-6])[\s>]/g) || []).map(function (m) { return +m[2]; });
  for (var i = 1; i < niveaus.length; i++) assert.ok(niveaus[i] <= niveaus[i - 1] + 1, 'sprong in koppen: ' + niveaus.join(','));
});

test('index: JSON-LD is geldig en beschrijft een SoftwareApplication', function () {
  var m = index.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'geen JSON-LD');
  var d = JSON.parse(m[1]);
  assert.strictEqual(d['@context'], 'https://schema.org');
  assert.strictEqual(d['@type'], 'SoftwareApplication');
  ['name', 'description', 'url', 'applicationCategory'].forEach(function (k) { assert.ok(d[k], 'ontbreekt: ' + k); });
  assert.strictEqual(d.url, BASE);
});

test('index: app mount blijft #root en het statische blok wordt door de app vervangen (innerHTML)', function () {
  assert.ok(lees('src/app.js').indexOf("document.getElementById('root')") > -1);
  assert.ok(lees('src/app.js').indexOf('root.innerHTML =') > -1);
});

test('index: alternate-links wijzen naar bestaande bestanden', function () {
  ['index.md', 'llms.txt'].forEach(function (f) { assert.ok(fs.existsSync(path.join(ROOT, f)), f); assert.ok(index.indexOf('href="' + f + '"') > -1, f); });
});

['about.html', 'contact.html'].forEach(function (f) {
  test(f + ': >= 500 tekens, één H1, canonical, lang, og:image/type', function () {
    var h = lees(f);
    assert.ok(tekstVan(h.slice(h.indexOf('<body>'))).length >= 500);
    assert.strictEqual((h.match(/<h1[\s>]/g) || []).length, 1);
    assert.ok(h.indexOf('<link rel="canonical" href="' + BASE + f + '">') > -1);
    assert.ok(/<html lang="nl">/.test(h) && /og:image/.test(h) && /og:type/.test(h));
    assert.ok(!/noindex/.test(h));
  });
});

test('privacy: bestaat met minstens 500 tekens', function () {
  assert.ok(tekstVan(lees('privacy.html')).length >= 500);
});

test('robots.txt: staat alles toe en wijst naar de sitemap', function () {
  var r = lees('robots.txt');
  assert.ok(/^User-agent: \*$/m.test(r));
  assert.ok(!/^Disallow:\s*\S/m.test(r), 'blokkeert iets');
  assert.ok(r.indexOf('Sitemap: ' + BASE + 'sitemap.xml') > -1);
});

test('sitemap.xml: geldig sitemaps.org-formaat, lastmod als datum, alleen bestaande en indexeerbare URLs', function () {
  var x = lees('sitemap.xml');
  assert.ok(/^<\?xml version="1.0" encoding="UTF-8"\?>/.test(x));
  assert.ok(x.indexOf('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') > -1);
  var urls = x.match(/<url>[\s\S]*?<\/url>/g);
  assert.ok(urls && urls.length >= 3);
  urls.forEach(function (u) {
    var loc = u.match(/<loc>([^<]+)<\/loc>/)[1];
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(u.match(/<lastmod>([^<]+)<\/lastmod>/)[1]), 'lastmod: ' + loc);
    bestaatLokaal(loc);
    var rel = loc.slice(BASE.length) || 'index.html';
    assert.ok(!/noindex/.test(lees(rel)), 'noindex-pagina in sitemap: ' + rel);
  });
  assert.ok(Buffer.byteLength(x) < 50 * 1024 * 1024);
});

test('llms.txt: H1, samenvatting, "Wanneer gebruik je" en links naar bestaande pagina\'s', function () {
  var t = lees('llms.txt');
  assert.ok(/^# MJOP Live$/m.test(t));
  assert.ok(/^> .{20,}/m.test(t));
  assert.ok(/^## Wanneer gebruik je MJOP Live\?$/m.test(t));
  var links = t.match(/\]\((https:[^)]+)\)/g).map(function (l) { return l.slice(2, -1); });
  assert.ok(links.length >= 4);
  links.forEach(bestaatLokaal);
});

test('index.md: Markdown met H1 en links die bestaan', function () {
  var t = lees('index.md');
  assert.ok(/^# .+/m.test(t) && t.length >= 500);
  (t.match(/\]\(([^)#]+)\)/g) || []).forEach(function (l) { var u = l.slice(2, -1); if (!/^https?:/.test(u)) assert.ok(fs.existsSync(path.join(ROOT, u)), u); });
});

test('404.html: leesbare uitleg met links naar app, sitemap en llms.txt (absolute paden onder /MJOP-App/)', function () {
  var h = lees('404.html');
  assert.ok(tekstVan(h).length >= 20);
  ['/MJOP-App/', '/MJOP-App/sitemap.xml', '/MJOP-App/llms.txt'].forEach(function (p) { assert.ok(h.indexOf('href="' + p + '"') > -1, p); });
});

test('manifest en deploy-workflow ongewijzigd in gedrag: Pages uploadt de hele map (nieuwe bestanden gaan mee)', function () {
  assert.ok(/path: \./.test(lees('.github/workflows/deploy-pages.yml')));
});

if (fouten) { console.log('\n' + fouten + ' fout(en)'); process.exit(1); }
console.log('\nAlles OK');
