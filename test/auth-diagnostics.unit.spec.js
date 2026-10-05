'use strict';
// Unit-tests voor src/auth-diagnostics.js. Puur Node:   node test/auth-diagnostics.unit.spec.js
var assert = require('assert');
var AD = require('../src/auth-diagnostics.js');

var fouten = 0;
var wachtend = [];
function test(naam, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') {
      wachtend.push(r.then(function () { console.log('OK   - ' + naam); }, function (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); }));
    } else console.log('OK   - ' + naam);
  } catch (e) { fouten++; console.log('FOUT - ' + naam + '\n       ' + e.message); }
}

var PUB = 'sb_publishable_TESTKEYabcdefghijklmnop';
var CFG = { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: PUB };
function jwt(role) {
  var b = function (o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); };
  return 'eyJ' + b({ alg: 'HS256' }).slice(3) + '.' + b({ role: role, iss: 'supabase' }) + '.c2lnbmF0dXJl';
}

// --- configuratie ---------------------------------------------------------
test('geldige config: publishable key, https-host zonder pad', function () {
  var c = AD.checkConfig(CFG);
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.host, 'abcdefghijklmnopqrst.supabase.co');
  assert.strictEqual(c.keyKind, 'publishable');
});
test('ontbrekende config/url/sleutel -> CONFIG_MISSING', function () {
  assert.strictEqual(AD.checkConfig(null).code, 'CONFIG_MISSING');
  assert.strictEqual(AD.checkConfig({ url: '', anonKey: PUB }).code, 'CONFIG_MISSING');
  assert.strictEqual(AD.checkConfig({ url: CFG.url, anonKey: '' }).code, 'CONFIG_MISSING');
});
test('ongeldige url, http, of pad /auth/v1 -> CONFIG_MISSING met reden', function () {
  assert.ok(/geen geldige URL/.test(AD.checkConfig({ url: 'tcx.supabase.co', anonKey: PUB }).problems.join()));
  assert.ok(/https/.test(AD.checkConfig({ url: 'http://x.supabase.co', anonKey: PUB }).problems.join()));
  assert.ok(/zonder pad/.test(AD.checkConfig({ url: 'https://x.supabase.co/auth/v1', anonKey: PUB }).problems.join()));
});
test('geheime sleutel of service_role in de frontend wordt geweigerd; anon-JWT is ok', function () {
  assert.strictEqual(AD.checkConfig({ url: CFG.url, anonKey: 'sb_secret_abc123' }).ok, false);
  assert.strictEqual(AD.checkConfig({ url: CFG.url, anonKey: jwt('service_role') }).ok, false);
  var anon = AD.checkConfig({ url: CFG.url, anonKey: jwt('anon') });
  assert.strictEqual(anon.ok, true);
  assert.strictEqual(anon.keyKind, 'anon_jwt');
});
test('initStatus: CONFIG_MISSING, SDK_NOT_LOADED, ok', function () {
  var sdk = { createClient: function () {} };
  assert.strictEqual(AD.initStatus({ supabase: sdk }).code, 'CONFIG_MISSING');
  assert.strictEqual(AD.initStatus({ SUPABASE_CONFIG: CFG }).code, 'SDK_NOT_LOADED');
  assert.strictEqual(AD.initStatus({ supabase: sdk, SUPABASE_CONFIG: CFG }).ok, true);
});

// --- terugkeer-URL --------------------------------------------------------
test('redirect: GitHub Pages-subpad met trailing slash; index.html wordt /', function () {
  var gh = { protocol: 'https:', origin: 'https://twandijkmans-afk.github.io', pathname: '/MJOP-App/' };
  assert.strictEqual(AD.redirectUrlFor(gh).url, 'https://twandijkmans-afk.github.io/MJOP-App/');
  gh.pathname = '/MJOP-App/index.html';
  assert.strictEqual(AD.redirectUrlFor(gh).url, 'https://twandijkmans-afk.github.io/MJOP-App/');
  assert.strictEqual(AD.redirectUrlFor({ protocol: 'http:', origin: 'http://localhost:8937', pathname: '/index.html' }).url, 'http://localhost:8937/');
});
test('redirect: file:// -> REDIRECT_CONFIGURATION_ERROR', function () {
  var r = AD.redirectUrlFor({ protocol: 'file:', origin: 'null', pathname: '/x/index.html' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'REDIRECT_CONFIGURATION_ERROR');
});

// --- fouten indelen -------------------------------------------------------
test('"Failed to fetch" (AuthRetryableFetchError, status 0) -> NETWORK_ERROR met NL-melding', function () {
  var e = { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 };
  var r = AD.classifyAuthError(e, { action: 'signInWithOtp', host: 'x.supabase.co' });
  assert.strictEqual(r.code, 'NETWORK_ERROR');
  assert.ok(/^Kan geen verbinding maken met de inlogservice\./.test(r.message));
  assert.ok(!/Failed to fetch/.test(r.message));
  assert.deepStrictEqual([r.detail.action, r.detail.host, r.detail.name, r.detail.message], ['signInWithOtp', 'x.supabase.co', 'AuthRetryableFetchError', 'Failed to fetch']);
});
test('TypeError NetworkError / Load failed (Firefox/Safari) -> NETWORK_ERROR', function () {
  assert.strictEqual(AD.classifyAuthError(new TypeError('NetworkError when attempting to fetch resource.')).code, 'NETWORK_ERROR');
  assert.strictEqual(AD.classifyAuthError(new TypeError('Load failed')).code, 'NETWORK_ERROR');
});
test('Supabase-foutantwoord -> SUPABASE_AUTH_ERROR, bekende code vertaald', function () {
  var r = AD.classifyAuthError({ name: 'AuthApiError', message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' });
  assert.strictEqual(r.code, 'SUPABASE_AUTH_ERROR');
  assert.ok(/te veel inlogmails/.test(r.message));
  var o = AD.classifyAuthError({ name: 'AuthApiError', message: 'Something odd', status: 400, code: 'weird_code' });
  assert.strictEqual(o.code, 'SUPABASE_AUTH_ERROR');
  assert.ok(/Something odd/.test(o.message));
});
test('redirect-fout van Supabase -> REDIRECT_CONFIGURATION_ERROR', function () {
  assert.strictEqual(AD.classifyAuthError({ name: 'AuthApiError', message: 'Invalid redirect URL', status: 400 }).code, 'REDIRECT_CONFIGURATION_ERROR');
});
test('iets anders -> UNKNOWN_AUTH_ERROR', function () {
  assert.strictEqual(AD.classifyAuthError(new Error('boem')).code, 'UNKNOWN_AUTH_ERROR');
  assert.strictEqual(AD.classifyAuthError(undefined).code, 'UNKNOWN_AUTH_ERROR');
});
test('geen secrets in meldingen of details', function () {
  var e = { name: 'AuthApiError', status: 400, message: 'bad apikey=' + PUB + ' token ' + jwt('anon') + ' Bearer abc.def.ghi password=hunter2' };
  var r = AD.classifyAuthError(e);
  var all = JSON.stringify(r);
  assert.ok(all.indexOf(PUB) === -1 && all.indexOf('eyJ') === -1 && all.indexOf('hunter2') === -1 && all.indexOf('abc.def.ghi') === -1, all);
});

// --- logging --------------------------------------------------------------
test('logging alleen in development/test, zonder sleutel', function () {
  var logs = [];
  var con = { warn: function (m) { logs.push(m); } };
  var prod = { location: { hostname: 'twandijkmans-afk.github.io', search: '' }, console: con, localStorage: { getItem: function () { return null; } } };
  var dev = { location: { hostname: 'localhost', search: '' }, console: con };
  var r = AD.classifyAuthError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }, { action: 'signInWithOtp', host: 'x.supabase.co' });
  assert.strictEqual(AD.log(prod, r), false);
  assert.strictEqual(AD.log(dev, r), true);
  prod.location.search = '?debug=auth';
  assert.strictEqual(AD.log(prod, r), true);
  assert.ok(/NETWORK_ERROR action=signInWithOtp host=x\.supabase\.co error\.name=AuthRetryableFetchError error\.message=Failed to fetch/.test(logs[0]));
  assert.ok(logs.every(function (l) { return l.indexOf('sb_publishable') === -1; }));
});

// --- health check ---------------------------------------------------------
var LOC = { protocol: 'https:', origin: 'https://twandijkmans-afk.github.io', pathname: '/MJOP-App/', hostname: 'twandijkmans-afk.github.io' };
test('health check: alles ok (HTTP-antwoord = bereikbaar), één GET naar /auth/v1/health', function () {
  var calls = [];
  var f = function (url, opt) { calls.push([url, opt.method]); return Promise.resolve({ status: 200, ok: true }); };
  return AD.healthCheck({ supabase: { createClient: function () {} }, SUPABASE_CONFIG: CFG, location: LOC }, f).then(function (r) {
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(calls, [['https://abcdefghijklmnopqrst.supabase.co/auth/v1/health', 'GET']]);
    assert.deepStrictEqual(r.steps.map(function (s) { return s.id; }), ['SDK_LOADED', 'CONFIG_PRESENT', 'URL_PARSEABLE', 'REDIRECT_URL', 'HOST_REACHABLE']);
    assert.ok(JSON.stringify(r).indexOf(PUB) === -1);
  });
});
test('health check: fetch-reject -> NETWORK_ERROR', function () {
  var f = function () { return Promise.reject(new TypeError('Failed to fetch')); };
  return AD.healthCheck({ supabase: { createClient: function () {} }, SUPABASE_CONFIG: CFG, location: LOC }, f).then(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NETWORK_ERROR');
  });
});
test('health check: geen SDK / geen config, zonder netwerkcall', function () {
  var called = 0;
  var f = function () { called++; return Promise.resolve({ status: 200, ok: true }); };
  return Promise.all([
    AD.healthCheck({ SUPABASE_CONFIG: CFG, location: LOC }, f),
    AD.healthCheck({ supabase: { createClient: function () {} }, location: LOC }, f),
  ]).then(function (rs) {
    assert.strictEqual(rs[0].code, 'SDK_NOT_LOADED');
    assert.strictEqual(rs[1].code, 'CONFIG_MISSING');
    assert.strictEqual(called, 1); // alleen de eerste (config geldig) probeert de host
  });
});

Promise.all(wachtend).then(function () {
  if (fouten) { console.log('\n' + fouten + ' test(s) mislukt.'); process.exit(1); }
  console.log('\nAlle auth-diagnostics-unit-tests geslaagd.');
});
