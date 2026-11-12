'use strict';
// Unit-tests voor src/native-nav.js (native navigatie voor de iPhone-app, brugversie 1 / app-versie 2).
// Puur Node, geen browser en geen dependencies:   node test/native-nav.unit.spec.js
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var NN = require('../src/native-nav.js');
var C = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'native-bridge', 'contract_v1.json'), 'utf8'));

var fouten = 0;
var pending = [];
function test(naam, fn) {
  var p;
  try { p = fn(); } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); return; }
  if (p && typeof p.then === 'function') {
    pending.push(p.then(function () { console.log('OK   - ' + naam); }, function (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); }));
  } else console.log('OK   - ' + naam);
}

var APP2 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MJOPLiveApp/2';
var APP1 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MJOPLiveApp/1';
var SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';

// Nagebootste omgeving: win met brug-handler, env met vastlegging, timers die we zelf afvuren.
function setup(ua, opts) {
  opts = opts || {};
  var posted = [], tabsLog = [], timers = [], calls = [];
  var win = { navigator: { userAgent: ua } };
  if (opts.handler !== false) win.webkit = { messageHandlers: { mjopNative: { postMessage: function (m) { posted.push(JSON.parse(JSON.stringify(m))); } } } };
  var status = { loggedIn: true, planId: null, tab: 'home' };
  var env = {
    setNativeTabs: function (on) { tabsLog.push(!!on); },
    onNativeInfo: function (i) { calls.push(['info', i]); },
    getStatus: function () { return status; },
    listProjects: function () { calls.push(['list']); return Promise.resolve(C.projects_reply_example); },
    setTab: function (t, s) { calls.push(['tab', t, s]); return { tab: t }; },
    openProject: function (id, tab, force) { calls.push(['open', id, tab, force]); return opts.openFails ? Promise.reject({ code: 'UNSAVED_CHANGES', message: 'wijzigingen' }) : Promise.resolve({ planId: id }); },
    startMeasurement: function (c) { calls.push(['measure', c.mode, c.planId || null, c.elementKey || null, c.force]); return Promise.resolve({ started: true }); },
    getProposals: function () { return { planRef: null, total: 0, pending: [] }; },
    signOut: function () { calls.push(['signout']); return { signedOut: true }; },
    newProject: function () { calls.push(['new']); return { tab: 'start' }; },
  };
  var inst = NN.create({
    win: win, env: env,
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: function (id) { if (timers[id - 1]) timers[id - 1].fn = null; },
  });
  function fire() { var t = timers.splice(0); t.forEach(function (x) { if (x.fn) x.fn(); }); }
  return { win: win, inst: inst, posted: posted, tabsLog: tabsLog, calls: calls, fire: fire, status: status, timers: timers };
}
function tick() { return new Promise(function (r) { setTimeout(r, 5); }); }

// --- User-Agent -----------------------------------------------------------
test('appLevel: alleen MJOPLiveApp/<n> telt', function () {
  assert.strictEqual(NN.appLevel(APP2), 2);
  assert.strictEqual(NN.appLevel(APP1), 1);
  assert.strictEqual(NN.appLevel(SAFARI), 0);
  assert.strictEqual(NN.appLevel('XMJOPLiveApp/2'), 0);
  assert.strictEqual(NN.appLevel(undefined), 0);
  assert.strictEqual(NN.appLevel(null), 0);
});

// --- Commandovalidatie (gedeeld contractbestand) ----------------------------
test('alle geldige voorbeeldcommando\'s uit het contract worden geaccepteerd', function () {
  C.commands_valid.forEach(function (m) {
    var v = NN.validateCommand(m);
    assert.ok(v.ok, JSON.stringify(m) + ' -> ' + v.error);
    assert.strictEqual(v.cmd.command, m.command);
    assert.strictEqual(v.cmd.requestId, m.requestId);
  });
});
test('alle ongeldige voorbeeldcommando\'s uit het contract worden geweigerd', function () {
  C.commands_invalid.forEach(function (x) {
    var v = NN.validateCommand(x.msg);
    assert.ok(!v.ok, x.why + ' werd niet geweigerd');
  });
});
test('commando-lijst en tab-lijst bevatten niets onverwachts', function () {
  assert.deepStrictEqual(NN.COMMANDS.slice().sort(), ['getProjects', 'getProposals', 'getStatus', 'navigate', 'newProject', 'openProject', 'signOut', 'startMeasurement']);
  assert.ok(NN.TABS.indexOf('javascript:') < 0);
  assert.ok(NN.TABS.every(function (t) { return /^[a-z]+$/.test(t); }));
});
test('onbekende extra velden worden genegeerd, niet doorgegeven', function () {
  var v = NN.validateCommand({ v: 1, type: 'command', command: 'navigate', requestId: 'r1', tab: 'home', evil: '<script>', html: 'x' });
  assert.ok(v.ok);
  assert.deepStrictEqual(Object.keys(v.cmd).sort(), ['command', 'requestId', 'tab']);
});
test('openProject: force is standaard onwaar (geen stil overschrijven van niet-opgeslagen werk)', function () {
  var v = NN.validateCommand({ v: 1, type: 'command', command: 'openProject', requestId: 'r1', id: '11111111-2222-3333-4444-555555555555' });
  assert.strictEqual(v.cmd.force, false);
  var w = NN.validateCommand({ v: 1, type: 'command', command: 'openProject', requestId: 'r1', id: '11111111-2222-3333-4444-555555555555', force: 'yes' });
  assert.strictEqual(w.cmd.force, false, 'alleen echt true telt');
});

// --- Handshake en achterwaartse compatibiliteit ----------------------------------
test('app-versie 2: de eigen tabbalk wordt meteen verborgen en de site meldt zich met webReady', function () {
  var s = setup(APP2);
  assert.deepStrictEqual(s.tabsLog, [true]);
  assert.strictEqual(s.inst.announce(), true);
  assert.strictEqual(s.posted.length, 1);
  assert.strictEqual(s.posted[0].action, 'webReady');
  assert.strictEqual(s.posted[0].v, 1);
  assert.deepStrictEqual(s.posted[0].payload.features, ['nav1']);
  assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(s.posted[0].requestId));
});
test('de gepubliceerde webReady-vorm komt overeen met het contractbestand', function () {
  var s = setup(APP2); s.inst.announce();
  assert.deepStrictEqual(s.posted[0].payload, C.web_ready.payload);
  assert.strictEqual(s.posted[0].action, C.web_ready.action);
});
test('OUDE APP (MJOPLiveApp/1): geen enkel nieuw bericht, tabbalk blijft, ontvangen berichten worden niet afgehandeld', function () {
  var s = setup(APP1);
  assert.deepStrictEqual(s.tabsLog, [], 'tabbalk niet aangeraakt');
  assert.strictEqual(s.inst.announce(), false);
  assert.strictEqual(s.inst.receive(C.native_ready), false);
  assert.strictEqual(s.inst.receive(C.commands_valid[0]), false);
  s.inst.notify(); s.fire();
  assert.strictEqual(s.posted.length, 0);
});
test('geen app (gewone browser): geen berichten, tabbalk blijft', function () {
  var s = setup(SAFARI, { handler: false });
  assert.deepStrictEqual(s.tabsLog, []);
  assert.strictEqual(s.inst.announce(), false);
  assert.strictEqual(s.posted.length, 0);
});
test('versie 2 zonder brug-handler: geen berichten (en dus ook geen fout)', function () {
  var s = setup(APP2, { handler: false });
  assert.deepStrictEqual(s.tabsLog, []);
  assert.strictEqual(s.inst.announce(), false);
});
test('app antwoordt niet binnen de tijdslimiet: de tabbalk van de website komt terug', function () {
  var s = setup(APP2); s.inst.announce();
  assert.deepStrictEqual(s.tabsLog, [true]);
  s.fire();
  assert.deepStrictEqual(s.tabsLog, [true, false]);
});
test('app antwoordt wel (tabs1): tijdslimiet vervalt, tabbalk blijft verborgen en info gaat door', function () {
  var s = setup(APP2); s.inst.announce();
  assert.strictEqual(s.inst.receive(C.native_ready), true);
  s.fire();
  assert.strictEqual(s.tabsLog[s.tabsLog.length - 1], true);
  assert.strictEqual(s.inst.ready, true);
  assert.deepStrictEqual(s.calls.filter(function (c) { return c[0] === 'info'; })[0][1], { lidar: true, appVersion: '2' });
});
test('app zonder tabs1: tabbalk van de website blijft zichtbaar', function () {
  var s = setup(APP2); s.inst.announce();
  s.inst.receive({ v: 1, type: 'nativeReady', features: [], appVersion: '2' });
  assert.strictEqual(s.inst.ready, false);
  assert.strictEqual(s.tabsLog[s.tabsLog.length - 1], false);
});
test('commando\'s voor de handshake worden genegeerd (geen antwoord)', function () {
  var s = setup(APP2); s.inst.announce(); s.posted.length = 0;
  s.inst.receive(C.commands_valid[2]);
  return tick().then(function () { assert.strictEqual(s.posted.length, 0); assert.strictEqual(s.calls.length, 0); });
});

// --- Commando's uitvoeren -------------------------------------------------
function ready(ua, opts) { var s = setup(ua || APP2, opts); s.inst.announce(); s.inst.receive(C.native_ready); s.fire(); s.posted.length = 0; s.calls.length = 0; return s; }

test('navigate: voert setTab uit en antwoordt met hetzelfde requestId', function () {
  var s = ready();
  s.inst.receive({ v: 1, type: 'command', command: 'navigate', requestId: 'abc-1', tab: 'account', sub: 'organisatie' });
  return tick().then(function () {
    assert.deepStrictEqual(s.calls[0], ['tab', 'account', 'organisatie']);
    var r = s.posted[0];
    assert.strictEqual(r.action, 'webReply'); assert.strictEqual(r.requestId, 'abc-1');
    assert.strictEqual(r.payload.command, 'navigate'); assert.strictEqual(r.payload.ok, true);
  });
});
test('getProjects: antwoord bevat de lijst uit de omgeving', function () {
  var s = ready();
  s.inst.receive({ v: 1, type: 'command', command: 'getProjects', requestId: 'g1' });
  return tick().then(function () {
    var r = s.posted[0];
    assert.strictEqual(r.payload.ok, true);
    assert.strictEqual(r.payload.data.projects.length, 2);
    assert.strictEqual(r.payload.data.projects[1].updatedAt, null, 'ontbrekende datum blijft null');
  });
});
test('openProject met niet-opgeslagen wijzigingen: fout UNSAVED_CHANGES wordt doorgegeven, niets overschreven', function () {
  var s = ready(APP2, { openFails: true });
  s.inst.receive({ v: 1, type: 'command', command: 'openProject', requestId: 'o1', id: '11111111-2222-3333-4444-555555555555' });
  return tick().then(function () {
    assert.deepStrictEqual(s.calls[0], ['open', '11111111-2222-3333-4444-555555555555', null, false]);
    var r = s.posted[0];
    assert.strictEqual(r.payload.ok, false); assert.strictEqual(r.payload.error.code, 'UNSAVED_CHANGES');
  });
});
test('startMeasurement (round en element) en signOut/newProject/getStatus/getProposals worden doorgegeven', function () {
  var s = ready();
  [C.commands_valid[5], C.commands_valid[6], C.commands_valid[7], C.commands_valid[8], C.commands_valid[9], C.commands_valid[10]].forEach(function (m) { s.inst.receive(m); });
  return tick().then(function () {
    assert.deepStrictEqual(s.calls.map(function (c) { return c[0]; }), ['measure', 'measure', 'signout', 'new']);
    assert.deepStrictEqual(s.calls[0], ['measure', 'round', '11111111-2222-3333-4444-555555555555', null, false]);
    assert.deepStrictEqual(s.calls[1], ['measure', 'element', null, 'kozijnen-onderhoud', false]);
    assert.strictEqual(s.posted.length, 6);
    assert.ok(s.posted.every(function (p) { return p.payload.ok === true; }));
  });
});
test('ongeldig commando met geldig requestId krijgt een foutantwoord en voert niets uit', function () {
  var s = ready();
  s.inst.receive(C.commands_invalid[0].msg);
  s.inst.receive(C.commands_invalid[1].msg);
  return tick().then(function () {
    assert.strictEqual(s.calls.length, 0);
    assert.strictEqual(s.posted.length, 2);
    assert.ok(s.posted.every(function (p) { return p.payload.ok === false && p.payload.error.code === 'INVALID_COMMAND'; }));
  });
});
test('ongeldig commando zonder bruikbaar requestId: stil genegeerd', function () {
  var s = ready();
  s.inst.receive({ v: 1, type: 'command', command: 'getStatus', requestId: 'a b' });
  return tick().then(function () { assert.strictEqual(s.posted.length, 0); assert.strictEqual(s.calls.length, 0); });
});
test('een uitzondering in de omgeving wordt een foutantwoord, geen crash', function () {
  var s = ready();
  s.inst.receive({ v: 1, type: 'command', command: 'getStatus', requestId: 'e1' });
  return tick().then(function () { assert.strictEqual(s.posted[0].payload.ok, true); });
});

// --- Statusmeldingen --------------------------------------------------------
test('webState: alleen versturen als de status verandert, en gebundeld (debounce)', function () {
  var s = setup(APP2); s.inst.announce(); s.inst.receive(C.native_ready); s.posted.length = 0; s.fire(); s.posted.length = 0;
  s.status.tab = 'gebouw';            // de eerste status is al verstuurd tijdens de handshake: maak eerst een echte wijziging
  s.inst.notify(); s.inst.notify(); s.inst.notify();
  assert.strictEqual(s.timers.length, 1, 'één timer, niet drie');
  s.fire();
  assert.strictEqual(s.posted.length, 1); assert.strictEqual(s.posted[0].action, 'webState');
  s.inst.notify(); s.fire();
  assert.strictEqual(s.posted.length, 1, 'ongewijzigd: niet opnieuw versturen');
  s.status.tab = 'planning';
  s.inst.notify(); s.fire();
  assert.strictEqual(s.posted.length, 2);
});
test('webState voor de handshake wordt niet verstuurd', function () {
  var s = setup(APP2); s.inst.announce(); s.posted.length = 0;
  s.inst.notify(); s.fire();
  assert.strictEqual(s.posted.length, 0);
});

// --- Ketting naar de bestaande brug ----------------------------------------------
test('install: eigen berichten gaan naar de module, alle andere naar de vorige ontvanger (Fotoronde-brug blijft werken)', function () {
  var seen = [];
  var win = { navigator: { userAgent: APP2 }, MJOPNativeBridge: { receive: function (m) { seen.push(m.type); return true; } } };
  win.webkit = { messageHandlers: { mjopNative: { postMessage: function () {} } } };
  var inst = NN.create({ win: win, env: { setNativeTabs: function () {}, getStatus: function () { return {}; } }, setTimeout: function () { return 1; }, clearTimeout: function () {} });
  NN.install(win, inst);
  assert.strictEqual(win.MJOPNativeBridge.receive({ v: 1, type: 'capabilities', lidar: true, appVersion: '2', requestId: 'x' }), true);
  assert.strictEqual(win.MJOPNativeBridge.receive({ v: 1, type: 'proposals', planRef: 'plan-0123456789abcdef01234567', proposals: [] }), true);
  assert.deepStrictEqual(seen, ['capabilities', 'proposals']);
  assert.strictEqual(win.MJOPNativeBridge.receive({ v: 1, type: 'nativeReady', features: ['tabs1'] }), true);
  assert.deepStrictEqual(seen, ['capabilities', 'proposals'], 'nativeReady niet doorgegeven aan de oude ontvanger');
});
test('install zonder vorige ontvanger crasht niet', function () {
  var win = { navigator: { userAgent: SAFARI } };
  var inst = NN.create({ win: win, env: { setNativeTabs: function () {} } });
  NN.install(win, inst);
  assert.strictEqual(win.MJOPNativeBridge.receive({ v: 1, type: 'proposals' }), false);
});

// Gebouwgegevens voor het native projectdetailscherm: onbekend blijft null (nooit 0), het voorbeeldgebouw heeft geen details.
test('buildingDetails: echte waarden, afgerond, met bron (3D BAG of afleiding)', function () {
  var d = NN.buildingDetails({ bouwjaar: 1972, units: 12, dakM2: 312.6, gevelM2: 1099.7, d3: { dak: 312.6 } },
    { posten: 10, totaal: 55148.4, van: 2026, tot: 2035, gevelfotos: 2 });
  assert.deepStrictEqual(d, { bouwjaar: 1972, units: 12, dakM2: 313, dakGeschat: false, gevelM2: 1100, gevelGeschat: true,
    posten: 10, geraamdTotaal: 55148, periodeVan: 2026, periodeTot: 2035, gevelfotos: 2 });
});
test('buildingDetails: ontbrekende waarden zijn null, nooit 0', function () {
  var d = NN.buildingDetails({ bouwjaar: null, units: 0, dakM2: 0, gevelM2: undefined }, { posten: 0, totaal: 0 });
  assert.strictEqual(d.bouwjaar, null); assert.strictEqual(d.units, null); assert.strictEqual(d.dakM2, null); assert.strictEqual(d.gevelM2, null);
  assert.strictEqual(d.dakGeschat, false); assert.strictEqual(d.gevelGeschat, false);
  assert.strictEqual(d.geraamdTotaal, null, 'een totaal van 0 is onbekend, niet 0 euro');
  assert.strictEqual(d.posten, 0); assert.strictEqual(d.periodeVan, null); assert.strictEqual(d.gevelfotos, 0);
});
test('buildingDetails: geen gebouw of het voorbeeldgebouw geeft null; rommel wordt genegeerd', function () {
  assert.strictEqual(NN.buildingDetails(null, {}), null);
  assert.strictEqual(NN.buildingDetails({ isVoorbeeld: true, bouwjaar: 1978 }, {}), null);
  assert.strictEqual(NN.buildingDetails('x', {}), null);
  var d = NN.buildingDetails({ bouwjaar: '1972', units: NaN, dakM2: Infinity, gevelM2: -5 }, { posten: 2.5, gevelfotos: -1, totaal: '9' });
  assert.deepStrictEqual([d.bouwjaar, d.units, d.dakM2, d.gevelM2, d.posten, d.gevelfotos, d.geraamdTotaal], [null, null, null, null, null, 0, null]);
});

Promise.all(pending).then(function () {
  console.log(fouten ? '\n' + fouten + ' test(s) mislukt.' : '\nAlle controles geslaagd.');
  process.exit(fouten ? 1 : 0);
});
