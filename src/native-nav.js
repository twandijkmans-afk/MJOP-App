// Native navigatie voor de iPhone-app MJOP Live (vanaf app-versie 2, User-Agent "MJOPLiveApp/2").
//
// De app toont zelf de tabbalk onderin (Home, Projecten, Meten, MJOP, Profiel) en gebruikt de website voor de schermen die nog niet native zijn.
// Deze module is de website-kant van die samenwerking. Principes:
// - Alleen optellend: de bestaande brug (src/photo-round.js, acties startPhotoRound/startElementScan/listProposals/ackProposals/getCapabilities/print)
//   blijft ongewijzigd. Deze module hangt zich er alleen NAAST (chain op window.MJOPNativeBridge.receive).
// - Achterwaarts compatibel: een oudere app (User-Agent MJOPLiveApp/1 of geen app) krijgt van deze module nooit een nieuw bericht en ziet geen
//   verandering (de eigen tabbalk van de website blijft zichtbaar). Een nieuwe app met een oudere website valt terug op de klassieke weergave,
//   want die website meldt zich nooit met 'webReady'.
// - Geen DOM-geklik: de app stuurt gevalideerde commando's (vaste lijst); de website voert ze uit via zijn eigen acties.
// - Alleen lezen/navigeren: geen enkel commando schrijft naar saved_plans. Het openen van een project is dezelfde actie als op de website.
// - Onbekend blijft onbekend: waarden die ontbreken worden als null doorgegeven, nooit als 0.
// Zonder DOM/netwerk testbaar in Node (test/native-nav.unit.spec.js).
(function (root) {
  'use strict';

  var BRIDGE_VERSION = 1;
  var MIN_APP_LEVEL = 2;
  var FEATURES = ['nav1'];           // wat deze website kan (gemeld in 'webReady')
  var APP_TABS_FEATURE = 'tabs1';    // wat de app moet melden om de eigen tabbalk te verbergen
  var WEB_VERSION = 'native-nav-1';
  var READY_TIMEOUT_MS = 6000;
  var NOTIFY_DELAY_MS = 200;
  var MAX_PROJECTS = 200;

  var TABS = ['start', 'home', 'gebouw', 'fotoronde', 'planning', 'rapport', 'account', 'instellingen', 'mijngebouwen'];
  var SUBS = ['profiel', 'organisatie', 'weergave', 'rapport', 'abonnement'];
  var COMMANDS = ['navigate', 'getProjects', 'openProject', 'startMeasurement', 'getStatus', 'getProposals', 'signOut', 'newProject'];
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var PLAN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
  var ELEMENT_KEY_RE = /^[a-z0-9-]{1,80}$/;

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function has(list, x) { return list.indexOf(x) >= 0; }

  // Welke app-versie draait er? Uit de User-Agent ("MJOPLiveApp/2"); 0 = geen app of onbekend.
  function appLevel(ua) {
    var m = /\bMJOPLiveApp\/(\d{1,3})\b/.exec(typeof ua === 'string' ? ua : '');
    return m ? parseInt(m[1], 10) : 0;
  }

  // Streng, gesloten commando-schema. Onbekende commando's, tabs of parameters worden geweigerd.
  function validateCommand(msg) {
    if (!isObj(msg)) return { ok: false, error: 'geen object' };
    if (msg.v !== BRIDGE_VERSION) return { ok: false, error: 'versie' };
    if (msg.type !== 'command') return { ok: false, error: 'type' };
    if (typeof msg.requestId !== 'string' || !ID_RE.test(msg.requestId)) return { ok: false, error: 'requestId' };
    if (typeof msg.command !== 'string' || !has(COMMANDS, msg.command)) return { ok: false, error: 'onbekend commando' };
    var c = { command: msg.command, requestId: msg.requestId };
    switch (msg.command) {
      case 'navigate':
        if (typeof msg.tab !== 'string' || !has(TABS, msg.tab)) return { ok: false, error: 'tab' };
        c.tab = msg.tab;
        if (msg.sub !== undefined && msg.sub !== null) {
          if (typeof msg.sub !== 'string' || !has(SUBS, msg.sub) || !(msg.tab === 'account' || msg.tab === 'instellingen')) return { ok: false, error: 'sub' };
          c.sub = msg.sub;
        }
        break;
      case 'openProject':
        if (typeof msg.id !== 'string' || !PLAN_ID_RE.test(msg.id)) return { ok: false, error: 'id' };
        c.id = msg.id;
        if (msg.tab !== undefined && msg.tab !== null) {
          if (typeof msg.tab !== 'string' || !has(TABS, msg.tab)) return { ok: false, error: 'tab' };
          c.tab = msg.tab;
        }
        c.force = msg.force === true;
        break;
      case 'startMeasurement':
        if (msg.mode !== 'round' && msg.mode !== 'element') return { ok: false, error: 'mode' };
        c.mode = msg.mode;
        if (msg.planId !== undefined && msg.planId !== null) {
          if (typeof msg.planId !== 'string' || !PLAN_ID_RE.test(msg.planId)) return { ok: false, error: 'planId' };
          c.planId = msg.planId;
        }
        if (msg.mode === 'element') {
          if (typeof msg.elementKey !== 'string' || !ELEMENT_KEY_RE.test(msg.elementKey)) return { ok: false, error: 'elementKey' };
          c.elementKey = msg.elementKey;
        }
        c.force = msg.force === true;
        break;
      default:
        break;
    }
    return { ok: true, cmd: c };
  }

  // Gegevens van het geopende gebouw voor het native projectdetailscherm van de app. Alleen lezen. Onbekend blijft null (nooit 0);
  // het voorbeeldgebouw heeft geen details. Dak en gevel zonder 3D BAG-waarde zijn een afleiding uit de BAG-geometrie: dat wordt meegegeven.
  function buildingDetails(b, extra) {
    if (!isObj(b) || b.isVoorbeeld) return null;
    extra = isObj(extra) ? extra : {};
    function pos(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : null; }
    function whole(v) { var p = pos(v); return p === null ? null : Math.round(p); }
    function count(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v ? v : null; }
    var d3 = isObj(b.d3) ? b.d3 : {};
    var dak = whole(b.dakM2), gevel = whole(b.gevelM2);
    return {
      bouwjaar: whole(b.bouwjaar), units: whole(b.units),
      dakM2: dak, dakGeschat: dak !== null && d3.dak == null,
      gevelM2: gevel, gevelGeschat: gevel !== null && d3.gevel == null,
      posten: count(extra.posten), geraamdTotaal: whole(extra.totaal), periodeVan: whole(extra.van), periodeTot: whole(extra.tot),
      gevelfotos: count(extra.gevelfotos) === null ? 0 : count(extra.gevelfotos),
    };
  }

  function errorOf(e) {
    if (isObj(e) && typeof e.code === 'string') return { code: e.code.slice(0, 40), message: String(e.message || '').slice(0, 200) };
    return { code: 'FAILED', message: String((e && e.message) || e || 'Mislukt').slice(0, 200) };
  }

  // opts: { win, env, setTimeout?, clearTimeout? }
  // env: { setNativeTabs(bool), onNativeInfo({lidar, appVersion}), getStatus(), listProjects(), setTab(tab, sub), openProject(id, tab, force),
  //        startMeasurement(cmd), getProposals(), signOut(), newProject() }  (alles dat een belofte of waarde teruggeeft)
  function create(opts) {
    var win = opts.win, env = opts.env;
    var st = opts.setTimeout || setTimeout, ct = opts.clearTimeout || clearTimeout;
    var ua = win && win.navigator ? win.navigator.userAgent : '';
    var self = { level: appLevel(ua), ready: false, features: [] };
    var seq = 0, readyTimer = null, notifyTimer = null, lastState = null;

    function handler() {
      try { return win && win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.mjopNative || null; } catch (e) { return null; }
    }
    function active() { return self.level >= MIN_APP_LEVEL && !!handler(); }

    // Alleen een app van versie 2 of nieuwer krijgt ooit een nieuw bericht (een oudere app zou het als 'ongeldig bericht' tonen).
    function post(action, payload, requestId) {
      var h = handler();
      if (self.level < MIN_APP_LEVEL || !h) return null;
      var id = requestId || ('n' + (++seq) + '-' + Date.now().toString(36));
      h.postMessage({ v: BRIDGE_VERSION, action: action, requestId: id, payload: payload || {} });
      return id;
    }

    // De eigen tabbalk meteen verbergen (geen flits); als de app niet binnen enkele seconden bevestigt, komt hij terug.
    if (active()) {
      env.setNativeTabs(true);
    }

    function announce() {
      if (!active()) return false;
      post('webReady', { features: FEATURES, webVersion: WEB_VERSION });
      if (readyTimer) ct(readyTimer);
      readyTimer = st(function () { readyTimer = null; if (!self.ready) env.setNativeTabs(false); }, READY_TIMEOUT_MS);
      return true;
    }

    function notify() {
      if (!self.ready || notifyTimer) return;
      notifyTimer = st(function () {
        notifyTimer = null;
        var s;
        try { s = env.getStatus(); } catch (e) { return; }
        var json = JSON.stringify(s);
        if (json === lastState) return;
        lastState = json;
        post('webState', s);
      }, NOTIFY_DELAY_MS);
    }

    function onReady(msg) {
      var feats = Array.isArray(msg.features) ? msg.features.filter(function (f) { return typeof f === 'string' && f.length <= 32; }).slice(0, 20) : [];
      self.features = feats;
      if (readyTimer) { ct(readyTimer); readyTimer = null; }
      if (has(feats, APP_TABS_FEATURE)) {
        self.ready = true;
        env.setNativeTabs(true);
        if (env.onNativeInfo) env.onNativeInfo({ lidar: !!msg.lidar, appVersion: String(msg.appVersion || '').slice(0, 20) });
        lastState = null;
        notify();
      } else {
        env.setNativeTabs(false);
      }
    }

    function reply(requestId, command, ok, data, error) {
      var payload = { command: command, ok: ok };
      if (ok) payload.data = data === undefined ? null : data; else payload.error = error;
      post('webReply', payload, requestId);
    }

    function run(c) {
      switch (c.command) {
        case 'navigate': return env.setTab(c.tab, c.sub || null);
        case 'getProjects': return env.listProjects();
        case 'openProject': return env.openProject(c.id, c.tab || null, c.force);
        case 'startMeasurement': return env.startMeasurement(c);
        case 'getStatus': return env.getStatus();
        case 'getProposals': return env.getProposals();
        case 'signOut': return env.signOut();
        case 'newProject': return env.newProject();
        default: return Promise.reject({ code: 'UNKNOWN_COMMAND', message: 'Onbekend commando.' });
      }
    }

    function handleCommand(msg) {
      var v = validateCommand(msg);
      var rid = isObj(msg) && typeof msg.requestId === 'string' && ID_RE.test(msg.requestId) ? msg.requestId : null;
      if (!v.ok) {
        if (rid) reply(rid, isObj(msg) && typeof msg.command === 'string' ? msg.command.slice(0, 40) : 'unknown', false, null, { code: 'INVALID_COMMAND', message: 'Ongeldig commando (' + v.error + ').' });
        return;
      }
      var c = v.cmd;
      Promise.resolve().then(function () { return run(c); }).then(function (data) {
        reply(c.requestId, c.command, true, data);
      }, function (e) {
        reply(c.requestId, c.command, false, null, errorOf(e));
      });
    }

    // Berichten van de app. true = door deze module afgehandeld.
    function receive(msg) {
      if (!isObj(msg) || msg.v !== BRIDGE_VERSION || typeof msg.type !== 'string') return false;
      if (self.level < MIN_APP_LEVEL) return false;
      if (msg.type === 'nativeReady') { onReady(msg); return true; }
      if (msg.type === 'command') { if (self.ready) handleCommand(msg); return true; }
      return false;
    }

    self.announce = announce;
    self.notify = notify;
    self.receive = receive;
    self.post = post;
    return self;
  }

  // Hangt de module NAAST de bestaande brug: eigen berichten gaan hierheen, alles anders naar de vorige ontvanger (photo-round.js).
  function install(win, instance) {
    var prev = win.MJOPNativeBridge;
    win.MJOPNativeBridge = {
      receive: function (msg) {
        if (instance && instance.receive(msg)) return true;
        return prev && typeof prev.receive === 'function' ? prev.receive(msg) : false;
      },
    };
  }

  var api = {
    BRIDGE_VERSION: BRIDGE_VERSION, MIN_APP_LEVEL: MIN_APP_LEVEL, FEATURES: FEATURES, TABS: TABS, SUBS: SUBS, COMMANDS: COMMANDS, MAX_PROJECTS: MAX_PROJECTS,
    appLevel: appLevel, validateCommand: validateCommand, buildingDetails: buildingDetails, create: create, install: install,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPNativeNav = api;
})(typeof window !== 'undefined' ? window : this);
