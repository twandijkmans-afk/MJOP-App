'use strict';
// Browsertest: los prototype "Gevelfoto naar hoeveelheden" (gevelfoto/index.html). Staat los van de MJOP-app en haar opslag.
// De AI-dienst en de BAG-diensten zijn nagebootst; er gaat niets naar buiten.
//   python3 -m http.server 8993 &  ;  MJOP_TEST_BASE=http://localhost:8993/ node test/gevelfoto.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8993/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
var checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail]); }
var near = function (a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= tol; };

async function main() {
  var fs = require('fs');
  var opts = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }; if (fs.existsSync(CHROMIUM_PATH)) opts.executablePath = CHROMIUM_PATH;
  var browser = await chromium.launch(opts);
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  var page = await ctx.newPage(), errors = [], aiRequest = null, outside = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.route(/^https?:\/\/(?!localhost)/, function (route) {
    var url = route.request().url(), j = function (body) { return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) }); };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.indexOf('https://api.anthropic.com/v1/messages') === 0) {
      aiRequest = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
      return j({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ elements: [
        { type: 'kozijn_raam', points: [{ x: 250, y: 250 }, { x: 430, y: 390 }], material: 'hout', confidence: 'high', note: '' },
        { type: 'hwa', points: [{ x: 1450, y: 154 }, { x: 1450, y: 1000 }], material: 'zink', confidence: 'medium', note: '' },
        { type: 'metselwerk', points: [{ x: 100, y: 150 }, { x: 1500, y: 150 }, { x: 1500, y: 1000 }, { x: 100, y: 1000 }], material: 'baksteen', confidence: 'high', note: '' },
        { type: 'bestaat_niet', points: [], material: '', confidence: 'low', note: '' }] }) }] });
    }
    if (url.indexOf('https://api.pdok.nl/bzk/locatieserver/') === 0) return j({ response: { docs: [{ weergavenaam: 'Teststraat 1, 1234AB Testdorp', centroide_rd: 'POINT(100005 400003)' }] } });
    if (url.indexOf('https://api.pdok.nl/kadaster/bag/ogc/') === 0) return j({ features: [{ properties: { identificatie: '0000100000000001', bouwjaar: 1975 },
      geometry: { type: 'Polygon', coordinates: [[[100000, 400000], [100014, 400000], [100014, 400008], [100000, 400008], [100000, 400000]]] } }] });
    if (url.indexOf('https://api.3dbag.nl/') === 0) return j({ feature: { CityObjects: { x: { attributes: { b3_h_maaiveld: 1, b3_h_dak_min: 7, b3_h_dak_max: 9.5, b3_dak_type: 'slanted' } } } } });
    outside.push(url); return route.abort();
  });
  await page.goto(BASE + 'gevelfoto/index.html');
  var at = function (x, y) { return page.evaluate(function (p) { return window.Gevelfoto.imageToClient(p); }, [x, y]); };
  var tap = async function (x, y) { await page.waitForTimeout(900); var c = await at(x, y); await page.mouse.click(c[0], c[1]); };
  var totals = function () { return page.evaluate(function () { var o = {}; window.Gevelfoto.buildExport().totals.forEach(function (t) { o[t.type] = t; }); return o; }); };

  var t = await totals();
  check('1. opent met de voorbeeldgevel; zonder maat is elke hoeveelheid onbekend (null), het aantal wel bekend', t.kozijn_raam && t.kozijn_raam.count === 5 && t.kozijn_raam.total === null && t.metselwerk.total === null, JSON.stringify(t));

  await page.click('#manualRef > summary'); await page.click('#refPick'); await tap(750, 770); await tap(750, 1000); await page.fill('#refLen', '2,30');
  t = await totals();
  check('2. eigen maat (deurhoogte 2,30 m): kozijnen 13,56 m2, metselwerk netto 103,14 m2, hwa 8,46 m', near(t.kozijn_raam.total, 13.56, 0.1) && near(t.metselwerk.total, 103.14, 0.6) && near(t.hwa.total, 8.46, 0.05), JSON.stringify(t));

  await page.fill('#addr', 'Teststraat 1 Testdorp'); await page.click('#addrBtn');
  await page.waitForFunction(function () { return window.Gevelfoto.state.bag.pand; });
  var sides = await page.evaluate(function () { return window.Gevelfoto.state.bag.sides.map(function (s) { return [Math.round(s.length), s.facing]; }); });
  check('3. BAG-omtrek in zijden met lengte en windrichting', JSON.stringify(sides) === JSON.stringify([[14, 'zuid'], [8, 'oost'], [14, 'noord'], [8, 'west']]), JSON.stringify(sides));
  await page.locator('#bagMap .hit[data-side="0"]').dispatchEvent('click');
  var ex = await page.evaluate(function () { return window.Gevelfoto.buildExport(); });
  t = await totals();
  check('4. zijde aantikken vult de maten vanzelf in: breedte van het gevelvlak = BAG-zijde, zonder punten aan te wijzen', ex.scale && ex.scale.source.type === 'BAG_FOOTPRINT_SIDE' && ex.scale.source.placement === 'AUTO_WALL_WIDTH' && ex.scale.length_m === 14 && near(t.kozijn_raam.total, 13.56, 0.05) && near(t.metselwerk.total, 103.14, 0.05), JSON.stringify([ex.scale, t.metselwerk]));
  check('5. uitvoer is altijd een voorstel zonder foto, met het pand erbij', ex.status === 'PROPOSED' && ex.booking_allowed === false && ex.validated === false && ex.photo.included_in_export === false && ex.building.bag_pand_id === '0000100000000001');

  await page.click('#checkBox > summary'); await page.click('#checkPick'); await tap(750, 770); await tap(750, 1000); await page.fill('#checkLen', '2,00');
  var chk = await page.evaluate(function () { return window.Gevelfoto.buildExport().scale_check; }), t2 = await totals();
  check('6. controlemaat meldt alleen de afwijking en verandert geen hoeveelheid', chk && near(chk.measured_m, 2.3, 0.03) && near(chk.deviation_pct, 15, 1.5) && JSON.stringify(t2) === JSON.stringify(t), JSON.stringify(chk));

  // een geel punt verslepen: de maat volgt, en de automatische plaatsing wordt niet meer overschreven
  await page.waitForTimeout(900);
  var c1 = await at(100, 1000), c2 = await at(400, 1000);
  await page.mouse.move(c1[0], c1[1]); await page.mouse.down(); await page.mouse.move(c2[0], c2[1], { steps: 5 }); await page.mouse.up();
  ex = await page.evaluate(function () { return window.Gevelfoto.buildExport(); }); t2 = await totals();
  check('6b. geel punt versleept: hoeveelheden schalen mee en de herkomst zegt dat de gebruiker heeft bijgesteld', ex.scale.source.placement === 'USER_ADJUSTED' && t2.hwa.total > t.hwa.total * 1.2, JSON.stringify([ex.scale.source.placement, t2.hwa]));

  await page.fill('#key', 'sk-ant-test'); await page.click('#detectBtn');
  await page.waitForFunction(function () { return document.querySelector('#detectMsg').textContent.length > 0; });
  var els = await page.evaluate(function () { return window.Gevelfoto.state.elements.map(function (e) { return e.type + ':' + e.source; }); });
  check('7. AI-antwoord: geldige elementen overgenomen, ongeldige overgeslagen en gemeld', els.join() === 'kozijn_raam:ai,hwa:ai,metselwerk:ai' && /1 overgeslagen/.test(await page.textContent('#detectMsg')), els.join());
  check('8. AI-aanvraag: sleutel alleen in de header, foto als JPEG', aiRequest && aiRequest.headers['x-api-key'] === 'sk-ant-test' && aiRequest.body.messages[0].content[0].source.media_type === 'image/jpeg' && JSON.stringify(aiRequest.body).indexOf('sk-ant-test') < 0);

  var tilt = await page.evaluate(function () { return [window.Gevelfoto.tiltFromOrientation(90, 0), window.Gevelfoto.tiltFromOrientation(80, 0), window.Gevelfoto.tiltFromOrientation(85, -90)]; });
  check('9. waterpas: rechtop = 0 graden, voorover = omlaag, 5 graden scheef herkend', near(tilt[0].pitch, 0, 0.01) && near(tilt[1].pitch, -10, 0.01) && near(Math.abs(tilt[2].roll), 5, 0.01), JSON.stringify(tilt));

  // inzoomen op de foto: een tik komt nog steeds op het juiste beeldpunt, en slepen naast een punt verschuift de foto
  await page.evaluate(function () { window.scrollTo(0, 0); }); await page.waitForTimeout(500);
  var c0 = await at(340, 320); await page.mouse.move(c0[0], c0[1]); await page.mouse.wheel(0, -300); await page.mouse.wheel(0, -300);
  var z = await page.evaluate(function () { return window.Gevelfoto.state.view.z; });
  var c3 = await at(340, 320); await page.mouse.click(c3[0], c3[1]);
  var act = await page.evaluate(function () { var s = window.Gevelfoto.state, e = s.elements.filter(function (x) { return x.id === s.active; })[0]; return e ? e.type : null; });
  var ox0 = await page.evaluate(function () { return window.Gevelfoto.state.view.ox; });
  var cp = await at(600, 600); await page.mouse.move(cp[0], cp[1]); await page.mouse.down(); await page.mouse.move(cp[0] - 60, cp[1], { steps: 4 }); await page.mouse.up();
  var ox1 = await page.evaluate(function () { return window.Gevelfoto.state.view.ox; });
  check('12. inzoomen op de foto: tik raakt het juiste element, slepen verschuift het beeld, 1x toont weer alles', z > 1.4 && act === 'kozijn_raam' && ox1 > ox0 + 20 && await page.evaluate(function () { document.getElementById('zoomReset').click(); return window.Gevelfoto.state.view.z === 1; }), JSON.stringify([z, act, ox0, ox1]));

  // camera: zoom snijdt het midden uit (de testcamera biedt geen lenszoom)
  await page.click('#camBtn'); await page.waitForFunction(function () { return document.querySelector('#camVideo').videoWidth > 0; });
  var vw = await page.evaluate(function () { return document.querySelector('#camVideo').videoWidth; });
  await page.evaluate(function () { window.Gevelfoto.setCamZoom(2); }); await page.click('#camShot');
  var shot = await page.evaluate(function () { var s = window.Gevelfoto.state; return [s.W, s.capture && s.capture.zoom, s.capture && s.capture.zoom_kind]; });
  check('13. camera met zoom 2x: de foto is het uitgesneden midden en de zoom staat in de export', Math.abs(shot[0] - Math.min(2000, vw / 2)) <= 1 && shot[1] === 2 && shot[2] === 'DIGITAL', JSON.stringify([vw, shot]));

  // camera met groothoeklens: de telefoon biedt een tweede camera aan (hier nagebootst); zonder zo'n camera komt er geen knop
  check('13b. zonder groothoeklens geen knop "Groothoek 0,5×"', await (async function () {
    await page.click('#camBtn'); await page.waitForFunction(function () { return document.querySelector('#camVideo').videoWidth > 0; });
    var hidden = await page.evaluate(function () { return document.getElementById('camWide').hidden; });
    await page.click('#camClose'); return hidden;
  })());
  await page.evaluate(function () {
    var md = navigator.mediaDevices, eo = md.enumerateDevices.bind(md), go = md.getUserMedia.bind(md);
    md.enumerateDevices = async function () { var l = await eo(); return l.concat([{ kind: 'videoinput', label: 'Back Ultra Wide Camera', deviceId: 'wide1' }]); };
    md.getUserMedia = function (c) { var v = c && c.video; if (v && v.deviceId && v.deviceId.exact === 'wide1') c = { audio: false, video: true }; return go(c); };
  });
  await page.click('#camBtn'); await page.waitForFunction(function () { return document.querySelector('#camVideo').videoWidth > 0 && !document.getElementById('camWide').hidden; });
  var w0 = await page.textContent('#camWide');
  await page.click('#camWide');
  await page.waitForFunction(function () { return document.querySelector('#camVideo').videoWidth > 0 && /Normaal/.test(document.getElementById('camWide').textContent); });
  var w1 = await page.evaluate(function () { return [document.getElementById('camZoomVal').textContent, document.getElementById('camText').textContent]; });
  check('13c. groothoek: knop zegt "Groothoek 0,5×", daarna 0,5× en een waarschuwing over vertekening', /Groothoek 0,5×/.test(w0) && w1[0] === '0,5×' && /vertekend/.test(w1[1]), JSON.stringify([w0, w1]));
  await page.click('#camShot');
  var w2 = await page.evaluate(function () { var s = window.Gevelfoto.state; return [s.capture && s.capture.zoom, document.getElementById('photoMsg').textContent]; });
  check('13d. foto met groothoek: zoom 0,5× in de export, een melding dat de maten minder nauwkeurig zijn en de controlemaat staat open', w2[0] === 0.5 && /groothoeklens/.test(w2[1]) && /minder nauwkeurig/.test(w2[1]) && /Controlemaat/.test(w2[1]) && await page.evaluate(function () { return document.getElementById('checkBox').open; }), JSON.stringify(w2));

  var keys = await page.evaluate(function () { var k = []; for (var i = 0; i < localStorage.length; i++) k.push(localStorage.key(i)); return k; });
  check('10. zonder "onthouden" staat de sleutel niet in de browseropslag; alleen het laatst gezochte adres wordt bewaard', keys.join() === 'gevelfoto_adres', keys.join());
  check('11. geen scriptfouten, geen verzoeken naar andere hosts, geen zijwaarts scrollen', !errors.length && !outside.length && await page.evaluate(function () { return document.documentElement.scrollWidth <= innerWidth; }), errors.concat(outside).join(' | '));

  await browser.close();
  var failed = checks.filter(function (c) { return !c[1]; });
  checks.forEach(function (c) { console.log((c[1] ? 'OK   - ' : 'FAIL - ') + c[0] + (c[1] ? '' : ' [' + c[2] + ']')); });
  console.log(failed.length ? failed.length + ' controle(s) mislukt.' : 'Alle controles geslaagd.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(2); });
