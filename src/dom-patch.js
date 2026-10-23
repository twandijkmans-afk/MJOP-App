// DOM-patch voor render(): werkt de bestaande DOM bij in plaats van root.innerHTML te vervangen.
//
// Waarom: render() vervangt de hele pagina na elke toetsaanslag en elke resize. Het invoerveld waarin je typt werd daardoor vernietigd en als nieuw
// element opnieuw gefocust; iOS gooit dan de gekozen toetsenbordstand (123) weg, de cursor springt en lopende invoer kan verdwijnen. Hier blijven
// bestaande knooppunten bestaan en worden alleen echte verschillen doorgevoerd.
//
// Regels:
// - Een element met id wordt aan het element met hetzelfde id gekoppeld (ook als de volgorde verschuift); overige knooppunten op positie en tag.
// - Het ACTIEVE tekstveld (gebruiker typt) wordt niet aangeraakt: waarde, selectie en focus blijven staan. Wijkt zijn waarde af van de nieuwe HTML,
//   dan meldt patch() dat via resultaat.pendingSync zodat de aanroeper bij blur opnieuw kan renderen (normalisatie pas na het typen).
// - Niet-actieve velden krijgen waarde/checked/selected als PROPERTY (het value-attribuut verandert na typen niets meer aan de weergave).
// - <input type=file> behoudt zijn selectie; scripts in de nieuwe HTML worden niet uitgevoerd (zoals bij innerHTML).
(function (root) {
  'use strict';

  var TEXTLIKE = /^(text|search|tel|url|email|password|number|)$/i;

  function isEl(n) { return n && n.nodeType === 1; }

  function activeOf(container) {
    var a = container.ownerDocument.activeElement;
    return a && container.contains(a) ? a : null;
  }

  function syncAttributes(o, n, active) {
    var i, a;
    for (i = o.attributes.length - 1; i >= 0; i--) {
      a = o.attributes[i];
      if (!n.hasAttribute(a.name)) { if (!(o === active && a.name === 'value')) o.removeAttribute(a.name); }
    }
    for (i = 0; i < n.attributes.length; i++) {
      a = n.attributes[i];
      if (o === active && a.name === 'value') continue;
      if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    }
  }

  function compatible(o, n) {
    if (o.nodeType !== n.nodeType) return false;
    if (!isEl(o)) return true;
    if (o.tagName !== n.tagName) return false;
    if (o.tagName === 'INPUT' && (o.getAttribute('type') || 'text') !== (n.getAttribute('type') || 'text')) return false;
    return true;
  }

  function patchControl(o, n, active, res) {
    var tag = o.tagName;
    if (tag === 'INPUT') {
      var type = (n.getAttribute('type') || 'text').toLowerCase();
      if (type === 'file') return;
      if (type === 'checkbox' || type === 'radio') { if (o.checked !== n.hasAttribute('checked')) o.checked = n.hasAttribute('checked'); return; }
      var want = n.hasAttribute('value') ? n.getAttribute('value') : '';
      if (o === active && TEXTLIKE.test(type)) { if (o.value !== want) res.pendingSync = true; return; }
      if (o === active && type === 'range') return;       // wordt versleept
      if (o.value !== want) o.value = want;
    } else if (tag === 'TEXTAREA') {
      var tw = n.textContent;
      if (o === active) { if (o.value !== tw) res.pendingSync = true; return; }
      if (o.value !== tw) o.value = tw;
    } else if (tag === 'SELECT') {
      patchChildren(o, n, active, res);
      var idx = -1;
      for (var i = 0; i < n.options.length; i++) if (n.options[i].hasAttribute('selected')) { idx = i; break; }
      if (idx < 0 && n.options.length) idx = 0;
      if (o !== active && o.selectedIndex !== idx) o.selectedIndex = idx;
    }
  }

  function patchNode(o, n, active, res) {
    if (!isEl(o)) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return; }
    syncAttributes(o, n, active);
    var tag = o.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { patchControl(o, n, active, res); return; }
    patchChildren(o, n, active, res);
  }

  function patchChildren(oldParent, newParent, active, res) {
    var oldKids = Array.prototype.slice.call(oldParent.childNodes);
    var newKids = Array.prototype.slice.call(newParent.childNodes);
    var newIds = {};
    newKids.forEach(function (n) { if (isEl(n) && n.id) newIds[n.id] = true; });
    var keyed = {}, loose = [];
    oldKids.forEach(function (o) {
      if (isEl(o) && o.id && newIds[o.id] && !keyed[o.id]) keyed[o.id] = o; else loose.push(o);
    });
    var li = 0, pos = 0;
    newKids.forEach(function (n) {
      var match = null;
      if (isEl(n) && n.id && keyed[n.id] && compatible(keyed[n.id], n)) { match = keyed[n.id]; keyed[n.id] = null; }
      else {
        // eerstvolgende los knooppunt dat past (zonder een ander element met id over te nemen)
        while (li < loose.length && (loose[li] === null || (isEl(loose[li]) && loose[li].id && newIds[loose[li].id]))) li++;
        if (li < loose.length && compatible(loose[li], n)) { match = loose[li]; loose[li] = null; li++; }
      }
      var ref = oldParent.childNodes[pos] || null;
      if (match) {
        if (match !== ref) oldParent.insertBefore(match, ref);
        patchNode(match, n, active, res);
      } else {
        oldParent.insertBefore(n, ref);
      }
      pos++;
    });
    // alles wat overblijft is verdwenen uit de nieuwe HTML
    while (oldParent.childNodes.length > pos) oldParent.removeChild(oldParent.lastChild);
  }

  // Maakt de kinderen van container gelijk aan html. Geeft { pendingSync } terug.
  function patch(container, html) {
    var tpl = container.ownerDocument.createElement('template');
    tpl.innerHTML = html;
    var res = { pendingSync: false };
    patchChildren(container, tpl.content, activeOf(container), res);
    return res;
  }

  var api = { patch: patch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MJOPDomPatch = api;
})(typeof window !== 'undefined' ? window : this);
