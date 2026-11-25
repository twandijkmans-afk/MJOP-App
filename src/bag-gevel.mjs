// Gevelbreedte uit de BAG: adres opzoeken, omtrek van het pand ophalen en in gevelzijden verdelen.
//
// Zelfde werkwijze als de Gevelfoto-pagina (gevelfoto/index.html, "maat via het adres"); daar staat een eigen kopie
// in de pagina zelf. Openbare, sleutelloze diensten: PDOK Locatieserver (adres → punt) en BAG (omtrek in meters, RD).
// De omtrek is van boven ingemeten en kan enkele decimeters afwijken van de gevel op ooghoogte (overstekken, aanbouwen),
// en een BAG-pand kan meer omvatten dan de gefotografeerde gevel. De lengte is daarom een voorstel dat de gebruiker
// moet controleren, geen meting.

export const PDOK_SEARCH = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";
export const BAG_PAND = "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items";
const RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function area(r) { let s = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; }
function inside(p, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

// Voegt opeenvolgende, bijna rechte stukken van de omtrek samen tot gevelzijden. Ring in meters; geeft [{a, b, length, facing}].
export function footprintSides(ring, tolDeg = 10) {
  let pts = ring.map((p) => [p[0], p[1]]);
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  pts = pts.filter((p, i) => dist(p, pts[(i + 1) % pts.length]) > 0.01);
  if (pts.length < 3) return [];
  const n = pts.length, dir = (i) => Math.atan2(pts[(i + 1) % n][1] - pts[i][1], pts[(i + 1) % n][0] - pts[i][0]);
  const turn = (i) => { let d = Math.abs(dir(i) - dir((i + n - 1) % n)) * 180 / Math.PI; if (d > 180) d = 360 - d; return d; };
  const corners = []; for (let i = 0; i < n; i++) if (turn(i) > tolDeg) corners.push(i);
  if (corners.length < 3) return [];
  let signed = 0; for (let i = 0; i < n; i++) signed += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  const names = ["noord", "noordoost", "oost", "zuidoost", "zuid", "zuidwest", "west", "noordwest"];
  return corners.map((c, k) => {
    const a = pts[c], b = pts[corners[(k + 1) % corners.length]], dx = b[0] - a[0], dy = b[1] - a[1];
    const nx = signed > 0 ? dy : -dy, ny = signed > 0 ? -dx : dx;                 // naar buiten gerichte normaal (x = oost, y = noord)
    const az = (Math.atan2(nx, ny) * 180 / Math.PI + 360) % 360;
    return { a, b, length: Math.hypot(dx, dy), facing: names[Math.round(az / 45) % 8] };
  });
}

export function outerRing(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") return geom.coordinates[0];
  if (geom.type === "MultiPolygon") return geom.coordinates.map((p) => p[0]).sort((a, b) => area(b) - area(a))[0];
  return null;
}

async function getJson(fetchFn, url) {
  let res;
  try { res = await fetchFn(url, { headers: { accept: "application/json" } }); } catch (e) { throw new Error("Geen verbinding met de BAG-dienst."); }
  if (!res.ok) throw new Error("De BAG-dienst gaf een fout (HTTP " + res.status + ").");
  return res.json();
}

export async function searchAddress(q, fetchFn = globalThis.fetch) {
  const d = await getJson(fetchFn, `${PDOK_SEARCH}?q=${encodeURIComponent(q)}&fq=type:adres&rows=6&fl=weergavenaam,centroide_rd`);
  return ((d.response && d.response.docs) || []).map((x) => {
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(x.centroide_rd || "");
    return m ? { name: x.weergavenaam, pt: [parseFloat(m[1]), parseFloat(m[2])] } : null;
  }).filter(Boolean);
}

// Het pand waar het adrespunt in ligt (of het dichtstbijzijnde), met de buren en de gevelzijden.
export async function loadPand(doc, fetchFn = globalThis.fetch) {
  const [x, y] = doc.pt, r = 30;
  const d = await getJson(fetchFn, `${BAG_PAND}?bbox=${x - r},${y - r},${x + r},${y + r}&bbox-crs=${encodeURIComponent(RD_CRS)}&crs=${encodeURIComponent(RD_CRS)}&limit=50&f=json`);
  const feats = (d.features || []).map((f) => ({ id: f.properties && f.properties.identificatie, bouwjaar: f.properties && f.properties.bouwjaar, ring: outerRing(f.geometry) })).filter((f) => f.ring && f.id);
  if (!feats.length) throw new Error("Bij dit adres is geen pand gevonden in de BAG.");
  const distTo = (f) => inside(doc.pt, f.ring) ? 0 : Math.min(...f.ring.map((p, i) => distToSegment(doc.pt, p, f.ring[(i + 1) % f.ring.length])));
  const pand = feats.slice().sort((a, b) => distTo(a) - distTo(b))[0];
  return { address: doc.name, pand, neighbours: feats.filter((f) => f !== pand), sides: footprintSides(pand.ring), retrieved_at: new Date().toISOString() };
}

// Voorstel voor de twee schaalpunten: de linker- en rechterrand van het grootste muurvlak dat een taalmodel aanwees,
// op de onderrand daarvan. Aanname: dat muurvlak is precies de gekozen BAG-zijde. De gebruiker moet het controleren.
export function wallEndpoints(elements) {
  const walls = (elements || []).filter((e) => e.kind === "poly" && ["metselwerk", "stucwerk", "gevelbekleding"].includes(e.type));
  if (!walls.length) return null;
  const w = walls.sort((a, b) => area(b.points) - area(a.points))[0];
  const xs = w.points.map((p) => p[0]), y = Math.max(...w.points.map((p) => p[1]));
  const x1 = Math.min(...xs), x2 = Math.max(...xs);
  return x2 - x1 >= 4 ? [[x1, y], [x2, y]] : null;
}
