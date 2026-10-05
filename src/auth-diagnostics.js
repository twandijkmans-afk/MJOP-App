// Auth-diagnostiek voor de Supabase-login (zonder DOM, zodat het in Node
// getest kan worden: test/auth-diagnostics.unit.spec.js).
//
// Doel: niet langer de kale browsertekst "Failed to fetch" tonen, maar
// onderscheiden WAAROM inloggen niet lukt:
//
//   CONFIG_MISSING               src/config.js heeft geen (geldige) Supabase-URL of publieke sleutel
//   SDK_NOT_LOADED               de Supabase-SDK (CDN-script) is niet geladen
//   NETWORK_ERROR                de browser kreeg geen antwoord van de Supabase-host
//                                (DNS, project gepauzeerd/verwijderd, CORS, adblocker, offline)
//   SUPABASE_AUTH_ERROR          Supabase antwoordde met een fout (bijv. te veel mails, ongeldig e-mailadres)
//   REDIRECT_CONFIGURATION_ERROR de terugkeer-URL is ongeldig of wordt door Supabase geweigerd
//   UNKNOWN_AUTH_ERROR           iets anders
//
// Er worden nooit sleutels, tokens of wachtwoorden getoond of gelogd. Logging
// (console) alleen in development/test: localhost, ?debug=auth of
// localStorage 'mjop-debug-auth' = '1'.
(function (root) {
  'use strict';

  var CODES = {
    CONFIG_MISSING: 'CONFIG_MISSING',
    SDK_NOT_LOADED: 'SDK_NOT_LOADED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    SUPABASE_AUTH_ERROR: 'SUPABASE_AUTH_ERROR',
    REDIRECT_CONFIGURATION_ERROR: 'REDIRECT_CONFIGURATION_ERROR',
    UNKNOWN_AUTH_ERROR: 'UNKNOWN_AUTH_ERROR',
  };

  var MESSAGES = {
    CONFIG_MISSING: 'Inloggen is nog niet geconfigureerd: de Supabase-projectgegevens (URL en publieke sleutel) in src/config.js ontbreken of zijn ongeldig.',
    SDK_NOT_LOADED: 'De inlogmodule kon niet geladen worden. Controleer je internetverbinding of een adblocker, en ververs de pagina.',
    NETWORK_ERROR: 'Kan geen verbinding maken met de inlogservice. Controleer je internetverbinding en probeer het opnieuw. Blijft dit gebeuren, dan is de inlogservice mogelijk niet bereikbaar.',
    REDIRECT_CONFIGURATION_ERROR: 'De inloglink kan niet naar deze pagina terugverwijzen (terugkeer-adres niet toegestaan). Neem contact op met de beheerder.',
    UNKNOWN_AUTH_ERROR: 'Inloggen is niet gelukt door een onbekende fout. Probeer het opnieuw.',
  };

  // Bekende Supabase Auth-foutcodes -> begrijpelijke NL-tekst. Onbekende
  // codes tonen de (opgeschoonde) melding van Supabase zelf.
  var AUTH_MESSAGES = {
    over_email_send_rate_limit: 'Er zijn te veel inlogmails verstuurd. Wacht even en probeer het dan opnieuw.',
    over_request_rate_limit: 'Te veel pogingen achter elkaar. Wacht even en probeer het dan opnieuw.',
    email_address_invalid: 'Dit e-mailadres wordt niet geaccepteerd. Controleer het adres.',
    validation_failed: 'De gegevens zijn niet geldig. Controleer je e-mailadres.',
    invalid_credentials: 'E-mailadres of wachtwoord klopt niet.',
    email_not_confirmed: 'Je e-mailadres is nog niet bevestigd. Klik eerst op de link in de bevestigingsmail.',
    user_already_exists: 'Er bestaat al een account met dit e-mailadres.',
    weak_password: 'Dit wachtwoord is te zwak. Kies een langer of minder voorspelbaar wachtwoord.',
    signup_disabled: 'Nieuwe accounts aanmaken staat uit.',
    otp_disabled: 'Inloggen met een inloglink staat uit.',
  };

  var NETWORK_TEXT = /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_name_not_resolved|err_connection|timeout/i;

  // ------------------------------------------------------------------
  // Opschonen: nooit sleutels/tokens in tekst of logs
  // ------------------------------------------------------------------
  function sanitize(text) {
    return String(text == null ? '' : text)
      .replace(/sb_(publishable|secret)_[A-Za-z0-9_\-]+/g, 'sb_$1_[verborgen]')
      .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '[jwt verborgen]')
      .replace(/(access_token|refresh_token|apikey|api_key|token|password)=([^&\s"']+)/gi, '$1=[verborgen]')
      .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[verborgen]')
      .slice(0, 300);
  }

  // ------------------------------------------------------------------
  // Configuratie
  // ------------------------------------------------------------------
  function parseUrl(text) {
    try { return new URL(String(text)); } catch (e) { return null; }
  }

  function jwtRole(key) {
    var parts = String(key).split('.');
    if (parts.length !== 3) return null;
    try {
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
      return JSON.parse(json).role || null;
    } catch (e) { return null; }
  }

  // Geeft {ok, code, problems[], host, keyKind}. Toont nooit de sleutel zelf.
  function checkConfig(cfg) {
    var problems = [];
    var url = cfg && cfg.url ? String(cfg.url).trim() : '';
    var key = cfg && cfg.anonKey ? String(cfg.anonKey).trim() : '';
    var u = url ? parseUrl(url) : null;
    if (!url) problems.push('url ontbreekt');
    else if (!u) problems.push('url is geen geldige URL');
    else {
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') problems.push('url moet https zijn');
      if (u.pathname !== '/' && u.pathname !== '') problems.push('url hoort alleen de projecthost te zijn (zonder pad zoals /auth/v1)');
    }
    var keyKind = null;
    if (!key) problems.push('publieke sleutel (anonKey) ontbreekt');
    else if (/^sb_secret_/.test(key)) { keyKind = 'secret'; problems.push('dit is een GEHEIME sleutel (sb_secret_…): die hoort nooit in de frontend'); }
    else if (/^sb_publishable_/.test(key)) keyKind = 'publishable';
    else if (/^eyJ/.test(key)) {
      var role = jwtRole(key);
      keyKind = role === 'anon' ? 'anon_jwt' : 'jwt';
      if (role === 'service_role') problems.push('dit is de service_role-sleutel: die hoort nooit in de frontend');
    } else { keyKind = 'unknown'; problems.push('onbekend sleutelformaat (verwacht sb_publishable_… of de anon-JWT)'); }
    return { ok: problems.length === 0, code: problems.length ? CODES.CONFIG_MISSING : null, problems: problems,
      host: u ? u.host : null, keyKind: keyKind };
  }

  // Status bij het opstarten: welke reden is er dat er (geen) client is?
  function initStatus(win) {
    var cfgCheck = checkConfig(win && win.SUPABASE_CONFIG);
    var sdk = !!(win && win.supabase && typeof win.supabase.createClient === 'function');
    if (!cfgCheck.ok) return { ok: false, code: CODES.CONFIG_MISSING, config: cfgCheck, sdkLoaded: sdk };
    if (!sdk) return { ok: false, code: CODES.SDK_NOT_LOADED, config: cfgCheck, sdkLoaded: false };
    return { ok: true, code: null, config: cfgCheck, sdkLoaded: true };
  }

  // ------------------------------------------------------------------
  // Terugkeer-URL (emailRedirectTo / redirectTo)
  // ------------------------------------------------------------------
  // De pagina zonder query/hash. '/index.html' wordt '/', zodat de app via
  // https://<host>/<repo>/ en via https://<host>/<repo>/index.html dezelfde
  // terugkeer-URL geeft (anders moeten beide op de Supabase-allowlist staan).
  function redirectUrlFor(loc) {
    var proto = loc && loc.protocol;
    if (proto !== 'https:' && proto !== 'http:') {
      return { ok: false, code: CODES.REDIRECT_CONFIGURATION_ERROR, url: null,
        reason: 'pagina is niet via http(s) geopend (' + (proto || 'onbekend') + '): een inloglink kan hier niet naar terugkeren' };
    }
    var path = String(loc.pathname || '/').replace(/\/index\.html$/, '/');
    return { ok: true, code: null, url: loc.origin + path };
  }

  // ------------------------------------------------------------------
  // Fouten indelen
  // ------------------------------------------------------------------
  // err: een Supabase AuthError (res.error) of een gegooide fout (catch).
  // ctx: {action, host}. Geeft {code, message, detail}.
  function classifyAuthError(err, ctx) {
    ctx = ctx || {};
    var name = err && err.name ? String(err.name) : (err && err.constructor && err.constructor.name) || 'Error';
    var msg = err && err.message != null ? String(err.message) : String(err == null ? '' : err);
    var status = err && typeof err.status === 'number' ? err.status : null;
    var errCode = err && err.code ? String(err.code) : null;
    var code;
    if (name === 'AuthRetryableFetchError' && (status === 0 || status == null) || (name === 'TypeError' && NETWORK_TEXT.test(msg)) ||
        (status === 0 && NETWORK_TEXT.test(msg)) || (status == null && NETWORK_TEXT.test(msg))) {
      code = CODES.NETWORK_ERROR;
    } else if (/redirect/i.test(msg) || /redirect/i.test(errCode || '')) {
      code = CODES.REDIRECT_CONFIGURATION_ERROR;
    } else if (status != null && status >= 400 || errCode || /^Auth/.test(name)) {
      code = CODES.SUPABASE_AUTH_ERROR;
    } else {
      code = CODES.UNKNOWN_AUTH_ERROR;
    }
    var message;
    if (code === CODES.SUPABASE_AUTH_ERROR) {
      message = (errCode && AUTH_MESSAGES[errCode]) || ('De inlogservice gaf een fout: ' + sanitize(msg || ('HTTP ' + status)));
    } else {
      message = MESSAGES[code];
    }
    return { code: code, message: message,
      detail: { action: ctx.action || null, host: ctx.host || null, name: sanitize(name), message: sanitize(msg), status: status, errorCode: errCode } };
  }

  function forCode(code, ctx) {
    return { code: code, message: MESSAGES[code] || MESSAGES.UNKNOWN_AUTH_ERROR, detail: { action: (ctx && ctx.action) || null, host: (ctx && ctx.host) || null } };
  }

  // ------------------------------------------------------------------
  // Logging (alleen development/test)
  // ------------------------------------------------------------------
  function debugEnabled(win) {
    try {
      var loc = win && win.location;
      if (loc && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) return true;
      if (loc && /[?&]debug=auth\b/.test(loc.search || '')) return true;
      if (win && win.localStorage && win.localStorage.getItem('mjop-debug-auth') === '1') return true;
    } catch (e) { /* geen toegang tot storage */ }
    return false;
  }

  function log(win, result) {
    if (!debugEnabled(win) || !win || !win.console) return false;
    var d = result.detail || {};
    win.console.warn('[auth] ' + result.code + ' action=' + (d.action || '-') + ' host=' + (d.host || '-') +
      ' error.name=' + (d.name || '-') + ' error.message=' + (d.message || '-') + (d.status != null ? ' status=' + d.status : ''));
    return true;
  }

  // ------------------------------------------------------------------
  // Health check (niet-destructief): SDK, config, URL, bereikbaarheid
  // ------------------------------------------------------------------
  // Doet hoogstens één GET naar <project>/auth/v1/health (met de publieke
  // sleutel, zoals de SDK zelf ook doet). Geen login, geen database-write.
  function healthCheck(win, fetchImpl) {
    var steps = [];
    var add = function (id, ok, info) { steps.push({ id: id, ok: ok, info: info || '' }); };
    var sdk = !!(win && win.supabase && typeof win.supabase.createClient === 'function');
    add('SDK_LOADED', sdk, sdk ? 'window.supabase.createClient aanwezig' : 'window.supabase ontbreekt (CDN-script niet geladen of geblokkeerd)');
    var cfg = checkConfig(win && win.SUPABASE_CONFIG);
    var present = !!(win && win.SUPABASE_CONFIG && win.SUPABASE_CONFIG.url && win.SUPABASE_CONFIG.anonKey);
    add('CONFIG_PRESENT', present, present ? 'url en publieke sleutel aanwezig (sleuteltype: ' + cfg.keyKind + ')' : 'url en/of sleutel ontbreekt');
    add('URL_PARSEABLE', cfg.ok, cfg.ok ? 'host ' + cfg.host : cfg.problems.join('; '));
    var redirect = win && win.location ? redirectUrlFor(win.location) : { ok: false, reason: 'geen location' };
    add('REDIRECT_URL', redirect.ok, redirect.ok ? redirect.url : redirect.reason);
    var done = function (reach) {
      add('HOST_REACHABLE', reach.ok, reach.info);
      var ok = steps.every(function (s) { return s.ok; });
      var code = !present || !cfg.ok ? CODES.CONFIG_MISSING : !sdk ? CODES.SDK_NOT_LOADED : !redirect.ok ? CODES.REDIRECT_CONFIGURATION_ERROR :
        !reach.ok ? CODES.NETWORK_ERROR : null;
      return { ok: ok, code: code, host: cfg.host, steps: steps };
    };
    var f = fetchImpl || (win && win.fetch && win.fetch.bind(win));
    if (!cfg.ok || !f) return Promise.resolve(done({ ok: false, info: 'niet gecontroleerd (geen geldige config of geen fetch)' }));
    var url = String(win.SUPABASE_CONFIG.url).replace(/\/+$/, '') + '/auth/v1/health';
    return Promise.resolve().then(function () {
      return f(url, { method: 'GET', headers: { apikey: String(win.SUPABASE_CONFIG.anonKey) }, cache: 'no-store' });
    }).then(function (r) {
      // Elk HTTP-antwoord betekent: de host is bereikbaar en geeft CORS-headers.
      return done({ ok: true, info: 'GET /auth/v1/health -> HTTP ' + r.status + (r.ok ? '' : ' (host bereikbaar; status ' + r.status + ')') });
    }, function (e) {
      return done({ ok: false, info: 'fetch mislukt: ' + sanitize((e && e.name) || 'Error') + ': ' + sanitize(e && e.message) +
        ' — DNS, gepauzeerd/verwijderd project, CORS, adblocker of offline' });
    });
  }

  var api = {
    CODES: CODES, MESSAGES: MESSAGES, sanitize: sanitize, checkConfig: checkConfig, initStatus: initStatus,
    redirectUrlFor: redirectUrlFor, classifyAuthError: classifyAuthError, forCode: forCode,
    debugEnabled: debugEnabled, log: log, healthCheck: healthCheck,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPAuthDiagnostics = api;
})(typeof window !== 'undefined' ? window : this);
