'use strict';
// Browsertest Fotoronde (website <-> iPhone-app-brug) met een NAGEBOOTSTE native brug.
// Bewijst de website-kant: contextbericht, projectcontrole, voorstel -> bron -> bevestigde hoeveelheid, geen overschrijving van handmatige waarden,
// geen kapotte iPhone-knoppen op de gewone website, behoud van focus bij typen, behoud na herladen. Bewijst NIET de echte app (zie iPhone-tests).
//   python3 -m http.server 8937 &   ;   node test/fotoronde.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var fs = require('fs');
var path = require('path');
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8937/';
var CHROMIUM_PATH = process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium';
var APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MJOPLiveApp/1';
var COUNT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-round', 'count_building_v2.json'), 'utf8'));
var AREA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'photo-round', 'area_building_incomplete_v2.json'), 'utf8'));
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }

// Nieuwe app: antwoordt op getCapabilities. Oude app (alleen afdrukken): de brug bestaat maar er komt nooit een antwoord.
var BRIDGE_STUB = function (answers) {
  window.__posted = [];
  window.webkit = { messageHandlers: { mjopNative: { postMessage: function (m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (answers && m.action === 'getCapabilities') setTimeout(function () { window.MJOPNativeBridge.receive({ v: 1, type: 'capabilities', requestId: m.requestId, lidar: true, appVersion: '1' }); }, 10);
  } } } };
};

async function newPage(browser, inApp, oldApp) {
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: inApp ? APP_UA : undefined, isMobile: true, hasTouch: true });
  var page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', function (e) { page.__errors.push(String(e)); });
  if (inApp) await page.addInitScript('(' + BRIDGE_STUB.toString() + ')(' + (oldApp ? 'false' : 'true') + ')');
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await page.goto(BASE + 'index.html'); await page.waitForTimeout(300);
  return page;
}
async function click(page, sel) { await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel); await page.waitForTimeout(120); }
async function text(page) { return page.evaluate(function () { return document.body.innerText; }); }
async function posted(page) { return page.evaluate(function () { return window.__posted; }); }
function forPlan(p, ref, patch) { var c = JSON.parse(JSON.stringify(p)); c.project.plan_ref = ref; Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; }); return c; }
async function rows(page) {
  return page.evaluate(function () {
    return { vals: Array.from(document.querySelectorAll('.koz-row .val')).map(function (e) { return e.textContent.trim(); }),
      total: (document.querySelector('.koz-total .count') || {}).textContent, hint0: ((document.querySelectorAll('.koz-row')[0] || {}).innerText || '') };
  });
}
async function receive(page, msg) { return page.evaluate(function (m) { return window.MJOPNativeBridge.receive(m); }, msg); }

async function main() {
  var browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // ===== in de app =====
  var page = await newPage(browser, true);
  await click(page, '[data-act=skip-onboarding]');
  var tabs = await page.evaluate(function () { return Array.from(document.querySelectorAll('.tab-item')).map(function (e) { return e.textContent.trim(); }); });
  check('Tab "Fotoronde" aanwezig in de navigatie', tabs.indexOf('Fotoronde') >= 0, tabs.join(','));
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  check('In de app: knop "Fotoronde starten" zichtbaar, geen uitleg "alleen in de app"', !!(await page.$('[data-act=photo-round-start]')) && !(await page.$('[data-fotoronde-niet-in-app]')));

  // gevel voorbereiden + start
  await page.fill('#pr-plan-naam', 'Voorgevel'); await page.dispatchEvent('#pr-plan-naam', 'input');
  await page.selectOption('#pr-plan-orient', 'S');
  await click(page, '[data-act=pr-plan-add]');
  check('Voorbereiding: gevel "Voorgevel (zuid)" genoteerd', /Voorgevel \(zuid\)/.test(await text(page)));
  await click(page, '[data-act=photo-round-start]');
  var msgs = await posted(page);
  var start = msgs.filter(function (m) { return m.action === 'startPhotoRound'; })[0];
  check('Start: bericht v1 met requestId en projectcontext', start && start.v === 1 && /^w\d+-/.test(start.requestId) && /^plan-[0-9a-f]{24}$/.test(start.payload.planRef) && start.payload.mode === 'round' && start.payload.element === null && start.payload.buildingLabel.length > 0, JSON.stringify(start));
  check('Start: geplande gevels worden meegegeven', start && start.payload.plannedFacades.length === 1 && start.payload.plannedFacades[0].orientation === 'S', JSON.stringify(start && start.payload.plannedFacades));
  var planRef = start.payload.planRef;

  // verkeerd project -> nooit toegepast
  await receive(page, { v: 1, type: 'proposals', planRef: planRef, proposals: [forPlan(COUNT, 'plan-ander-project-xxxxxxxx')], rounds: [] });
  var t = await text(page);
  check('Voorstel voor een ander project wordt niet getoond', !(await page.$('[data-pr-card]')), t.slice(0, 80));
  check('… en de gebruiker ziet waarom', /ander project/.test(await text(page)));
  // bericht dat naar een andere planRef verwijst wordt volledig genegeerd
  await receive(page, { v: 1, type: 'proposals', planRef: 'plan-ander-project-xxxxxxxx', proposals: [forPlan(COUNT, planRef)], rounds: [] });
  check('Antwoord met andere planRef wordt genegeerd', !(await page.$('[data-pr-card]')));
  // ongeldig contract
  await receive(page, { v: 1, type: 'proposals', planRef: planRef, proposals: [forPlan(COUNT, planRef, { booking_allowed: true })], rounds: [] });
  check('Voorstel dat boeken toestaat wordt geweigerd', !(await page.$('[data-pr-card]')));

  // geldige voorstellen
  var before = await page.evaluate(function () { return document.body.innerText; });
  await receive(page, { v: 1, type: 'proposals', planRef: planRef, proposals: [forPlan(COUNT, planRef), forPlan(AREA, planRef)], rounds: [{ roundId: 'r1a2b3c4-demo', status: 'COMPLETED', photos: 4, objects: 12, synced: false }] });
  await page.waitForTimeout(150);
  var ackMsgs = (await posted(page)).filter(function (m) { return m.action === 'ackProposals'; });
  check('Ontvangst wordt bevestigd aan de app (ackProposals met id\'s)', ackMsgs.length === 1 && ackMsgs[0].payload.proposalIds.length === 2 && ackMsgs[0].payload.planRef === planRef, JSON.stringify(ackMsgs));
  var cards = await page.$$('[data-pr-card]');
  check('Twee voorstellen zichtbaar (aantal en oppervlak)', cards.length === 2);
  t = await text(page);
  check('Aantal: "12 st." met onzekerheid en redenen genoemd', /12 st/.test(t) && /nog niet gevalideerd/.test(t) && /verschillende scanmomenten/.test(t));
  check('Oppervlak met onbemeten kozijnen: "Niet te bepalen", deelsom alleen informatief, geen knop om te gebruiken', /Niet te bepalen/.test(t) && /17,4/.test(t) && /onvolledig/.test(t) && await page.evaluate(function () { var c = document.querySelector('[data-pr-card] [data-act=pr-keep]'); return !c || c.disabled; }));
  check('Fasen zichtbaar: detectie, meting, voorstel, bevestiging "nog niet"', /Detectie: 11 automatisch/.test(t) && /Meting: LiDAR, geschat/.test(t) && /Voorstel/.test(t) && /Bevestiging: nog niet/.test(t));
  check('Lokaal-markering: plan nog niet opgeslagen, voorstellen alleen op dit toestel', !!(await page.$('[data-fotoronde-lokaal]')) && /alleen lokaal op dit toestel/.test(t));
  var kozBefore = await page.evaluate(function () { return Array.from(document.querySelectorAll('input')).length; });

  // handmatige waarde op rij 'Draaiend raam' zetten (via element-detail), dan voorstel als bron toevoegen
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var detail = await text(page);
  check('Elementdetail Buitenkozijnen: knop "Scannen met camera" aanwezig (in de app)', !!(await page.$('[data-act=photo-scan-element]')));
  check('Elementdetail meldt de voorstellen uit de ronde', !!(await page.$('[data-pr-bij-post]')));
  await click(page, '[data-act=photo-scan-element][data-id=kozijnen-onderhoud]');
  var es = (await posted(page)).filter(function (m) { return m.action === 'startElementScan'; })[0];
  check('Scannen vanuit element: context bevat element-sleutel, naam en eenheid st', es && es.payload.mode === 'element' && es.payload.element.key === 'kozijnen-onderhoud' && es.payload.element.unit === 'st' && es.payload.planRef === planRef, JSON.stringify(es && es.payload.element));
  var rowsBefore = await rows(page);

  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  var cardId = await page.evaluate(function () { return document.querySelector('[data-pr-card][data-pr-status=PROPOSED] [data-act=pr-add-source]').dataset.id; });
  check('Toevoegen als bron is uitgeschakeld zolang er geen post gekozen is', await page.evaluate(function (id) { return document.querySelector('[data-act=pr-add-source][data-id="' + id + '"]').disabled; }, cardId));
  // correctie typen: focus blijft (toetsenbordfix) en foute invoer wordt niet geraden
  await page.evaluate(function (id) { var e = document.getElementById('pr-corr-' + id); e.__m = 1; e.focus(); }, cardId);
  await page.keyboard.type('1.250');                        // onduidelijk: 1250 of 1,25? niet raden
  var st = await page.evaluate(function (id) { var e = document.getElementById('pr-corr-' + id); return { same: e.__m === 1, focused: document.activeElement === e, value: e.value }; }, cardId);
  check('Correctieveld: zelfde element, focus en tekst blijven tijdens typen', st.same && st.focused && st.value === '1.250', JSON.stringify(st));
  check('Onduidelijke invoer "1.250" wordt niet geraden: melding en geen gecorrigeerde waarde', /Onduidelijk/.test(await page.evaluate(function () { return (document.querySelector('[data-pr-fout]') || {}).textContent || ''; })));
  await page.evaluate(function (id) { var e = document.getElementById('pr-corr-' + id); e.select(); }, cardId);
  await page.keyboard.type('11'); await page.waitForTimeout(100);
  await page.selectOption('#pr-target-' + cardId, 'kozijnen-onderhoud:0');
  await page.waitForTimeout(100);
  await click(page, '[data-act=pr-add-source][data-id="' + cardId + '"]');
  t = await text(page);
  check('Als bron toegevoegd: nog niet gebruikt voor de kosten', /Staat als bron/.test(t) && /Nog niet gebruikt voor de kosten/.test(t));
  var eff0 = await page.evaluate(function () { return document.body.innerText; });
  // gebruiken zonder bevestiging
  await click(page, '[data-act=pr-use]');
  check('Gebruiken zonder bevestiging van de onzekerheid wordt geweigerd', /Bevestig eerst/.test(await text(page)) && !(await page.$('[data-pr-status=IN_USE]')));
  await page.evaluate(function (id) { var c = document.getElementById('pr-ack-' + id); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }, cardId);
  await page.waitForTimeout(100);
  await click(page, '[data-act=pr-use]');
  check('Met bevestiging: voorstel is in gebruik, gebruiker is de beslisser', !!(await page.$('[data-pr-status=IN_USE]')) && /door jou gekozen/.test(await text(page)));
  // effectief op de rij met de GECORRIGEERDE waarde 11
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var rowsAfter = await rows(page);
  var expectTotal = (parseInt(rowsBefore.total, 10) - parseInt(rowsBefore.vals[0], 10) + 11) + ' kozijnen';
  check('Kozijnrij "Draaiend raam" is nu 11 (de gecorrigeerde waarde, niet het voorstel 12); andere rijen ongewijzigd', rowsAfter.vals[0] === '11' && rowsAfter.vals.slice(1).join() === rowsBefore.vals.slice(1).join(), JSON.stringify([rowsBefore.vals, rowsAfter.vals]));
  check('Totaal en kosten volgen via de bestaande berekening (totaal ' + expectTotal + ')', rowsAfter.total === expectTotal, rowsAfter.total + ' vs ' + expectTotal);

  // blijft bewaard na herladen (werksessie)
  await page.reload(); await page.waitForTimeout(500);
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  check('Na herladen: voorstellen en beslissingen behouden (zelfde planRef)', !!(await page.$('[data-pr-status=IN_USE]')) && (await posted(page)).every(function (m) { return !m.payload || !m.payload.planRef || m.payload.planRef === planRef; }));
  check('Geen JavaScript-fouten (app)', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  // ===== handmatige waarde wordt nooit ongemerkt overschreven =====
  page = await newPage(browser, true);
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await click(page, '[data-act=photo-round-start]');
  planRef = (await posted(page)).filter(function (m) { return m.action === 'startPhotoRound'; })[0].payload.planRef;
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  await click(page, '[data-act=koz-plus][data-id=kozijnen-onderhoud][data-i="0"]');
  await click(page, '[data-act=koz-plus][data-id=kozijnen-onderhoud][data-i="0"]');
  var man = await rows(page);
  check('Handmatige aanpassing op rij 1 gemaakt ("Door jou aangepast")', /Door jou aangepast/.test(man.hint0), man.hint0);
  await receive(page, { v: 1, type: 'proposals', planRef: planRef, proposals: [forPlan(COUNT, planRef)], rounds: [] });
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  cardId = await page.evaluate(function () { return document.querySelector('[data-pr-card] [data-act=pr-add-source]').dataset.id; });
  await page.selectOption('#pr-target-' + cardId, 'kozijnen-onderhoud:0'); await page.waitForTimeout(100);
  await click(page, '[data-act=pr-add-source][data-id="' + cardId + '"]');
  var afterAdd = await rows(page.mainFrame ? page : page);
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  afterAdd = await rows(page);
  check('Voorstel als bron toevoegen laat de handmatige waarde staan', afterAdd.vals[0] === man.vals[0] && /Door jou aangepast/.test(afterAdd.hint0), JSON.stringify([man.vals, afterAdd.vals]));
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await page.evaluate(function (id) { var c = document.getElementById('pr-ack-' + id); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }, cardId);
  await page.waitForTimeout(100);
  await click(page, '[data-act=pr-use]');
  check('Gebruiken zonder uitdrukkelijk "mijn waarde vervangen" wordt geweigerd', /door jou ingevulde waarde/.test(await text(page)) && !!(await page.$('[data-pr-status=SOURCE_ADDED]')));
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var still = await rows(page);
  check('… en de handmatige waarde is onveranderd', still.vals[0] === man.vals[0] && /Door jou aangepast/.test(still.hint0));
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await page.evaluate(function (id) { var c = document.getElementById('pr-replace-' + id); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }, cardId);
  await page.waitForTimeout(100);
  await click(page, '[data-act=pr-use]');
  await click(page, '[data-act=set-tab][data-tab=gebouw]'); await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  var repl = await rows(page);
  check('Pas na uitdrukkelijke keuze vervangt de scan de handmatige waarde (12)', repl.vals[0] === '12' && !/Door jou aangepast/.test(repl.hint0), JSON.stringify(repl.vals) + ' ' + repl.hint0);
  check('Geen JavaScript-fouten (handmatig-scenario)', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  // ===== oude versie van de app (brug bestaat, Fotoronde niet): geen knoppen die niets doen =====
  page = await newPage(browser, true, true);
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  await page.waitForTimeout(300);
  check('Oude app: geen start-knop, wel uitleg over de nieuwste versie', !(await page.$('[data-act=photo-round-start]')) && !!(await page.$('[data-fotoronde-app-oud]')) && /nieuwste versie/.test(await text(page)));
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  check('Oude app: ook op het element geen scanknop', !(await page.$('[data-act=photo-scan-element]')) && /nieuwste versie/.test(await text(page)));
  check('Oude app: er is niets naar de app gestuurd behalve de capabilities-vraag', (await posted(page)).every(function (m) { return m.action === 'getCapabilities' || m.action === 'listProposals'; }));
  await page.context().close();

  // ===== gewone website (geen app) =====
  page = await newPage(browser, false);
  await click(page, '[data-act=skip-onboarding]');
  await click(page, '[data-act=set-tab][data-tab=fotoronde]');
  t = await text(page);
  check('Website: uitleg dat de LiDAR-scanner in de iPhone-app zit', !!(await page.$('[data-fotoronde-niet-in-app]')) && /MJOP Live-app op de iPhone/.test(t));
  check('Website: GEEN kapotte scanknoppen (start / ophalen)', !(await page.$('[data-act=photo-round-start]')) && !(await page.$('[data-act=photo-round-refresh]')));
  await page.fill('#pr-plan-naam', 'Achtergevel'); await page.dispatchEvent('#pr-plan-naam', 'input');
  await click(page, '[data-act=pr-plan-add]');
  check('Website: inspectievoorbereiding (gevel noteren) werkt', /Achtergevel/.test(await text(page)));
  await click(page, '[data-act=set-tab][data-tab=gebouw]');
  await click(page, '[data-act=open-element][data-id=kozijnen-onderhoud]');
  check('Website: op het element geen scanknop, wel verwijzing naar de app', !(await page.$('[data-act=photo-scan-element]')) && !!(await page.$('[data-fotoronde-niet-in-app]')));
  check('Website: geen JavaScript-fouten', page.__errors.length === 0, page.__errors.join('; '));
  await page.context().close();

  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0] + (c[1] || !c[2] ? '' : '\n         ' + c[2])); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}
main().catch(function (e) { console.error(e); process.exitCode = 1; });
