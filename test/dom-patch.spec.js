'use strict';
// Eigenschappen van src/dom-patch.js (de renderstrategie die het actieve invoerveld niet vervangt), in een echte browser.
//   python3 -m http.server 8937 &   ;   node test/dom-patch.spec.js
let chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = require('/opt/node22/lib/node_modules/playwright').chromium; }
var BASE = process.env.MJOP_TEST_BASE || 'http://localhost:8937/';
var checks = [];
function check(n, ok, d) { checks.push([n, !!ok, d]); }

async function main() {
  var browser = await chromium.launch({ executablePath: process.env.MJOP_CHROMIUM || '/opt/pw-browsers/chromium' });
  var page = await browser.newPage();
  await page.route(/^https?:\/\/(?!localhost)/, function (r) { return r.abort(); });
  await page.goto(BASE + 'index.html');
  var r = await page.evaluate(function () {
    var out = {}, P = window.MJOPDomPatch;
    var c = document.createElement('div'); document.body.appendChild(c);

    P.patch(c, '<div><input id="a" value="1"><input id="b" value="2"><span>x</span></div>');
    var a = c.querySelector('#a'), b = c.querySelector('#b'); a.__m = 1; b.__m = 1;
    // 1. gebruiker typt in a, state normaliseert -> actief veld blijft, pendingSync gemeld
    a.focus(); a.value = '12,'; a.setSelectionRange(3, 3);
    var res = P.patch(c, '<div><input id="a" value="12"><input id="b" value="2"><span>y</span></div>');
    out.activeKeepsValue = a.value === '12,' && document.activeElement === a && a.selectionStart === 3 && res.pendingSync === true && c.querySelector('span').textContent === 'y';
    out.sameNodes = c.querySelector('#a') === a && c.querySelector('#b') === b;
    // 2. niet-actief veld krijgt nieuwe waarde (property), ook na typen (dirty flag)
    b.value = 'typed'; var res2 = P.patch(c, '<div><input id="a" value="12"><input id="b" value="3"><span>y</span></div>');
    out.inactiveSynced = b.value === '3' && res2.pendingSync === true; // a wijkt nog af
    a.blur(); var res3 = P.patch(c, '<div><input id="a" value="12"><input id="b" value="3"><span>y</span></div>');
    out.afterBlurSynced = a.value === '12' && res3.pendingSync === false;
    // 3. invoegen vóór het gefocuste veld: node blijft, focus blijft
    a.focus();
    P.patch(c, '<div><p>nieuw</p><input id="a" value="12"><input id="b" value="3"><span>y</span></div>');
    out.insertBeforeKeepsFocus = c.querySelector('#a') === a && document.activeElement === a && c.querySelector('p').textContent === 'nieuw';
    // 4. volgorde wisselen op id
    P.patch(c, '<div><input id="b" value="3"><input id="a" value="12"></div>');
    out.reordered = c.querySelector('div').children[0].id === 'b' && c.querySelector('#a') === a && c.querySelector('#b') === b;
    // 5. checkbox, select, textarea
    P.patch(c, '<div><input id="k" type="checkbox"><select id="s"><option value="1">1</option><option value="2" selected>2</option></select><textarea id="t">hoi</textarea></div>');
    var k = c.querySelector('#k'), s = c.querySelector('#s'), t = c.querySelector('#t');
    k.checked = false; P.patch(c, '<div><input id="k" type="checkbox" checked><select id="s"><option value="1" selected>1</option><option value="2">2</option></select><textarea id="t">doei</textarea></div>');
    out.controls = k.checked === true && s.value === '1' && t.value === 'doei' && c.querySelector('#k') === k && c.querySelector('#s') === s;
    // 6. bestandsveld behoudt zijn node; attributen en tekst worden bijgewerkt; verdwenen nodes worden verwijderd
    P.patch(c, '<div><input id="f" type="file" style="display:none"><p class="x">a</p><p>b</p></div>');
    var f = c.querySelector('#f');
    P.patch(c, '<div><input id="f" type="file" style="display:none"><p class="y">c</p></div>');
    out.fileAndText = c.querySelector('#f') === f && c.querySelectorAll('p').length === 1 && c.querySelector('p').className === 'y' && c.querySelector('p').textContent === 'c';
    // 7. andere tag op dezelfde plek -> vervangen; SVG blijft SVG
    P.patch(c, '<div><span id="z">1</span></div>');
    P.patch(c, '<div><svg id="z" viewBox="0 0 2 2"><path d="M0 0L2 2"/></svg></div>');
    out.svgNs = c.querySelector('#z').namespaceURI === 'http://www.w3.org/2000/svg' && c.querySelector('path').namespaceURI === 'http://www.w3.org/2000/svg';
    // 8. scripts uit de nieuwe HTML worden niet uitgevoerd
    window.__ran = false; P.patch(c, '<div><script>window.__ran = true<\/script></div>');
    out.noScripts = window.__ran === false;
    // 9. dezelfde HTML tweemaal: geen DOM-mutaties
    var muts = 0, mo = new MutationObserver(function (l) { muts += l.length; }); mo.observe(c, { subtree: true, childList: true, attributes: true, characterData: true });
    P.patch(c, '<div><p>vast</p><input id="q" value="1"></div>'); mo.takeRecords(); muts = 0;
    P.patch(c, '<div><p>vast</p><input id="q" value="1"></div>');
    out.idempotent = mo.takeRecords().length === 0;
    return out;
  });
  Object.keys(r).forEach(function (k) { check('dom-patch: ' + k, r[k]); });
  await browser.close();
  var fail = 0;
  checks.forEach(function (c) { console.log((c[1] ? 'OK  ' : 'FAIL') + ' - ' + c[0]); if (!c[1]) fail++; });
  if (fail) { console.log(fail + ' controle(s) mislukt.'); process.exitCode = 1; return; }
  console.log('Alle controles geslaagd.');
}
main().catch(function (e) { console.error(e); process.exitCode = 1; });
