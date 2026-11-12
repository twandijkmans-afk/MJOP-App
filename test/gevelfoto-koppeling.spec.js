'use strict';
// Browsertest: gevelfoto -> MJOP, heen en terug in de browser (geen iPhone-app nodig).
// Bewijst: de knop in de Fotoronde geeft de projectreferentie mee; de proefpagina stuurt alleen een echt resultaat met maat terug; de app toont het als
// voorstel, neemt niets automatisch over, en maakt het pas na "bron toevoegen" + bevestiging de hoeveelheid van de gevelpost; behoud na herladen.
// Bewijst NIET de herkenning door AI of de BAG-diensten (hier wordt met de hand ingetekend en een eigen maat opgegeven).
//   python3 -m http.server 8994 &   ;   MJOP_TEST_BASE=http://localhost:8994/ node test/gevelfoto-koppeling.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var GF = require('../src/gevelfoto.js');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8994/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(200); }
async function text(page, sel) { return page.evaluate(function (s) { var e = s ? document.querySelector(s) : document.body; return e ? e.innerText : null; }, sel || null); }
function stored(page, key) { return page.evaluate(function (k) { return localStorage.getItem(k); }, key); }

async function main() {
  var browser = await chromium.launch(fs.existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {});
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  var page = await ctx.newPage(), errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.addInitScript(function () { try { if (!localStorage.getItem('mjop-instellingen')) localStorage.setItem('mjop-instellingen', JSON.stringify({ toonCbsBron: true, eenvoudig: false })); } catch (e) {} });
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(300);
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  check('1. de Fotoronde toont het blok Gevelfoto, ook zonder iPhone-app', !!(await page.$('[data-gevelfoto] [data-act=gf-start]')));
  var postNu = function (id) { return text(page, '[data-gf-post="' + id + '"] .input-row .hint'); };

  await click(page, '[data-act=gf-start]');
  await page.waitForURL(/gevelfoto\/index\.html/); await page.waitForTimeout(400);
  var req = JSON.parse(await stored(page, GF.REQUEST_KEY));
  check('2. naar de proefpagina met de projectreferentie; voor het voorbeeldgebouw geen adres', req && /^plan-[0-9a-f]{24}$/.test(req.planRef) && req.address === null && /index\.html/.test(req.returnUrl), JSON.stringify(req));
  check('3. de proefpagina meldt de koppeling en toont "Naar Mijn MJOP sturen"', await page.isVisible('#linkBar') && await page.isVisible('#sendBtn'));

  await page.click('#sendBtn');
  check('4. de voorbeeldgevel kan niet naar het MJOP', /voorbeeldgevel/.test(await page.textContent('#exportMsg')) && /gevelfoto\/index\.html/.test(page.url()) && (await stored(page, GF.OUTBOX_KEY)) === null);

  // eigen foto (hier een getekend vlak), met de hand intekenen
  var png = await page.evaluate(function () {
    var c = document.createElement('canvas'); c.width = 1600; c.height = 1100; var g = c.getContext('2d');
    g.fillStyle = '#9ab'; g.fillRect(0, 0, 1600, 1100); g.fillStyle = '#a53'; g.fillRect(100, 150, 1400, 850);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.setInputFiles('#file', { name: 'gevel.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(function () { return window.Gevelfoto.state.photoName === 'gevel.png'; });
  var tap = async function (x, y) { await page.waitForTimeout(700); var c = await page.evaluate(function (p) { return window.Gevelfoto.imageToClient(p); }, [x, y]); await page.mouse.click(c[0], c[1]); };
  await page.selectOption('#addType', 'metselwerk'); await page.click('#addBtn');
  await tap(100, 150); await tap(1500, 150); await tap(1500, 1000); await tap(100, 1000); await page.click('#polyDone');
  await page.selectOption('#addType', 'kozijn_raam'); await page.click('#addBtn'); await tap(250, 250); await tap(430, 390);
  await page.click('#sendBtn');
  check('5. zonder maat wordt er niets verstuurd', /maat/.test(await page.textContent('#exportMsg')) && /gevelfoto\/index\.html/.test(page.url()));
  await page.click('#manualRef > summary'); await page.click('#refPick'); await tap(100, 1000); await tap(1500, 1000); await page.fill('#refLen', '14');
  var result = await page.evaluate(function () { return window.Gevelfoto.buildMjopResult(); });
  var v = GF.validate(result);
  check('6. het resultaat voldoet aan het contract: 119 m2 bruto, 116,48 m2 netto, 1 raamkozijn, onbekend blijft null, geen foto',
    v.ok && result.quantities.masonry_gross_m2.value === 119 && Math.abs(result.quantities.masonry_net_m2.value - 116.48) < 0.02 && result.quantities.window_frames_st.value === 1 &&
    result.quantities.downpipe_m1.value === null && result.scale.source === 'USER_INPUT' && JSON.stringify(result).length < 3000, v.errors.join('; ') + ' ' + JSON.stringify(result.quantities));

  await page.click('#sendBtn');
  await page.waitForURL(function (u) { return !/gevelfoto\//.test(String(u)); }); await page.waitForSelector('[data-gf-res]');
  var card = await text(page, '[data-gevelfoto]');
  check('7. terug in het MJOP staat de gevelfoto als voorstel, met de waarschuwingen', /metselwerk netto 116,48 m²/.test(card) && /1 raamkozijn/.test(card) && /maat zelf opgegeven/.test(card) && /Onbekend welk deel van het gebouw/.test(card), card);
  check('8. de opslag is leeg na het ophalen en de melding zegt dat niets is overgenomen', (await stored(page, GF.OUTBOX_KEY)) === null && /er is nog niets overgenomen/.test(await text(page)));
  var voor = await postNu('gevel-metselwerk'), voorVoeg = await postNu('voegwerk');
  // het voorbeeldgebouw heeft wel de post metselwerk, niet de post voegwerk: alleen posten die in het plan staan worden aangeboden
  check('9. de gevelpost die in het plan staat wordt aangeboden met haar huidige hoeveelheid; een post die er niet staat niet', /nu .* m²/.test(voor || '') && voorVoeg === null, voor + ' | ' + voorVoeg);

  await click(page, '[data-act=gf-add-source][data-el=gevel-metselwerk]');
  check('10. bron toevoegen verandert de hoeveelheid niet', (await postNu('gevel-metselwerk')) === voor && !!(await page.$('[data-act=gf-use][data-el=gevel-metselwerk]')));
  await click(page, '[data-act=gf-use][data-el=gevel-metselwerk]');
  check('11. zonder bevestiging van de onzekerheid wordt niets overgenomen', /Bevestig eerst/.test((await text(page, '[data-gf-fout]')) || '') && (await postNu('gevel-metselwerk')) === voor);
  await click(page, '[data-change=gf-ack][data-el=gevel-metselwerk]');
  await click(page, '[data-act=gf-use][data-el=gevel-metselwerk]');
  check('12. na bevestiging is de som de hoeveelheid van de post; de andere post is niet aangeraakt',
    /nu 116,48 m²/.test((await postNu('gevel-metselwerk')) || '') && !!(await page.$('[data-gf-post="gevel-metselwerk"] [data-gf-in-gebruik]')) && (await postNu('voegwerk')) === voorVoeg,
    (await postNu('gevel-metselwerk')) + ' | ' + (await postNu('voegwerk')));

  // resultaat van een ander plan: niet tonen, laten staan
  var ander = JSON.parse(JSON.stringify(result)); ander.plan_ref = 'plan-ander-project-xxxxxxxxx'; ander.result_id = 'gf-ander00000000001';
  await page.evaluate(function (a) { localStorage.setItem(a[0], JSON.stringify([a[1]])); }, [GF.OUTBOX_KEY, ander]);
  await page.reload(); await page.waitForTimeout(500);
  var left = JSON.parse((await stored(page, GF.OUTBOX_KEY)) || '[]');
  check('13. na herladen: gevelfoto en keuze zijn bewaard; een resultaat van een ander plan wordt niet getoond en blijft staan',
    (await page.$$('[data-gf-res]')).length === 1 && /nu 116,48 m²/.test((await postNu('gevel-metselwerk')) || '') && left.length === 1, String(left.length));

  await click(page, '[data-act=gf-remove]');
  check('14. gevelfoto verwijderd: er staat niets meer om voor te stellen', !(await page.$('[data-gf-res]')) && !(await page.$('[data-gf-post]')));
  check('15. geen scriptfouten', errors.length === 0, errors.join(' | '));

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
