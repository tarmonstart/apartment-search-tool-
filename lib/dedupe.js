"use strict";
// ---------------------------------------------------------------------------
// Cross-source de-duplication.
//
// The same flat is routinely posted on ss.lv, city24 AND pp.lv, and often
// re-posted on one site at a slightly different price. The previous version
// bucketed candidates on an EXACT "rooms|price" key, so any price change at all
// put two posts of one flat in different buckets where they were never even
// compared. Every duplicate that survived to the report escaped through that gap.
//
// Approach here:
//   1. BLOCK on street name tokens (plus a geo block, plus a fallback block for
//      listings with no usable street) — never on price.
//   2. SCORE each candidate pair on several independent signals.
//   3. CLUSTER with union-find, so the result does not depend on input order the
//      way the old greedy first-match loop did.
//
// The scoring is deliberately conservative. Wrongly merging two different flats
// is worse than leaving a duplicate: a duplicate is visible clutter, whereas a
// bad merge silently removes a real apartment from the list. So a pair must
// clear a hard gate (same street, compatible rooms and area) AND accumulate
// evidence from more than one independent signal.
//
// Calibrated against four hand-checked pairs from a real run:
//
//   Skolas 12      ss 530€ vs pp 550€   price 1.04, text 0.51            → 7.5  merge
//   Dzirnavu 70    ss 600€ vs ss 500€   8 shared photos, floors differ   → 5.0  merge
//   K. Barona      c24 1250 vs c24 1150 2.5 m apart, price 1.09          → 7.5  merge
//   Ģertrūdes 129  ss 1500 vs ss 600    same street/area/floor, nothing  → 1.5  keep both
// ---------------------------------------------------------------------------

const DEFAULTS = {
  threshold: 4.0,
  areaTolerance: 2.5, // m²
  geoMetres: 40,
  maxPriceRatio: 1.35, // beyond this, price is evidence AGAINST rather than neutral
};

// --- normalisation ----------------------------------------------------------

function fold(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[āàáã]/g, "a").replace(/[īìí]/g, "i").replace(/[ēèé]/g, "e")
    .replace(/[ūùú]/g, "u").replace(/[ōòó]/g, "o").replace(/[čç]/g, "c")
    .replace(/š/g, "s").replace(/[žź]/g, "z").replace(/[ņň]/g, "n")
    .replace(/ķ/g, "k").replace(/ļ/g, "l").replace(/ģ/g, "g");
}

// Generic words that carry no identifying information about which street it is.
const STREET_STOP = new Set([
  "iela", "ielas", "bulvaris", "bulvara", "prospekts", "gatve", "laukums",
  "street", "str", "boulevard", "dambis", "krastmala", "aleja",
]);

function streetTokens(l) {
  const s = fold(l.street);
  return new Set(s.split(/[^a-z]+/).filter((t) => t.length >= 3 && !STREET_STOP.has(t)));
}

// city24 carries the house number in its own field; ss.lv and pp.lv bake it into
// the street string ("Ģertrūdes 129", "Brīvības 106A"). Case matters here: a
// case-sensitive match would silently return null for every uppercase letter
// suffix and disable the different-building gate exactly where addresses are
// most ambiguous. The letter is part of the identity — 106 and 106A are
// different buildings — so it is kept, lowercased.
function houseNumber(l) {
  if (l.houseNo) {
    const m = /^(\d+\s*[a-z]?)/i.exec(String(l.houseNo).trim());
    if (m) return m[1].replace(/\s+/g, "").toLowerCase();
  }
  const m = /(\d+\s*[a-z]?)\s*$/i.exec((l.street || "").trim());
  return m ? m[1].replace(/\s+/g, "").toLowerCase() : null;
}

// Words worth comparing between two ads: drop short words, digits, and anything
// that is just the address repeated — city24 auto-generates its title from the
// address, so address words would otherwise make every pair on a street look
// identical.
function textTokens(l) {
  const addr = new Set([...streetTokens(l), ...fold(l.district).split(/[^a-z]+/)]);
  const raw = fold((l.title || "") + " " + (l.description || ""));
  const out = new Set();
  for (const w of raw.split(/[^a-z0-9]+/)) {
    if (w.length < 4) continue;
    if (addr.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (w === "msg" || w === "div") continue; // scrape artefacts from the ss.lv body
    out.add(w);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function metres(a, b) {
  if (a.latitude == null || b.latitude == null) return null;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const la = a.latitude * rad, lb = b.latitude * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function photoOverlap(a, b) {
  const pa = a.photoRefs || [], pb = b.photoRefs || [];
  if (!pa.length || !pb.length) return 0;
  const s = new Set(pa);
  let n = 0;
  for (const x of pb) if (s.has(x)) n++;
  return n;
}

// --- pairwise scoring -------------------------------------------------------

function score(a, b, cfg) {
  // --- hard gates: things that must not disagree ---------------------------
  if (a.rooms != null && b.rooms != null && a.rooms !== b.rooms) return null;
  if (a.area != null && b.area != null && Math.abs(a.area - b.area) > cfg.areaTolerance) return null;

  const ta = streetTokens(a), tb = streetTokens(b);
  const geo = metres(a, b);
  const streetShared = [...ta].some((t) => tb.has(t));
  const streetUnknown = ta.size === 0 || tb.size === 0;
  const geoSame = geo != null && geo <= cfg.geoMetres;
  if (!streetShared && !geoSame && !streetUnknown) return null;

  const ha = houseNumber(a), hb = houseNumber(b);
  const houseSame = !!(ha && hb && ha === hb);
  if (ha && hb && ha !== hb && !geoSame) return null; // different buildings on one street

  // --- evidence -----------------------------------------------------------
  let s = 0;
  const why = [];

  // Shared photos are the strongest signal for a re-post — but only in bulk.
  // Agencies reuse a single facade or stairwell shot across every flat they
  // list in a building, so one common photo says "same building", not "same
  // flat". Weight by how much of the smaller gallery is shared.
  const shared = photoOverlap(a, b);
  const photoStrong = shared > 0 &&
    (shared >= 3 || shared / (Math.min((a.photoRefs || []).length, (b.photoRefs || []).length) || 1) >= 0.5);
  if (shared > 0) {
    if (photoStrong) { s += 5; why.push(shared + " shared photos"); }
    else { s += 1.5; why.push(shared + " shared photo (weak)"); }
  }

  if (geoSame) {
    s += 3;
    why.push(Math.round(geo) + "m apart");
  } else if (geo != null && geo > 250) {
    s -= 3; // same street name, clearly not the same building
  }

  if (a.price != null && b.price != null) {
    const ratio = Math.max(a.price, b.price) / Math.min(a.price, b.price);
    if (ratio === 1) { s += 3.5; why.push("same price"); }
    else if (ratio <= 1.1) { s += 3; why.push("price within " + Math.round((ratio - 1) * 100) + "%"); }
    else if (ratio <= 1.25) { s += 1.5; why.push("price within " + Math.round((ratio - 1) * 100) + "%"); }
    else if (ratio > cfg.maxPriceRatio) { s -= 2; }
  }

  // Text similarity, but only when BOTH sides actually have prose to compare.
  const xa = textTokens(a), xb = textTokens(b);
  let textStrong = false;
  if (xa.size >= 8 && xb.size >= 8) {
    const j = jaccard(xa, xb);
    if (j >= 0.45) { s += 3; textStrong = true; why.push("text " + j.toFixed(2)); }
    else if (j >= 0.25) { s += 1.5; textStrong = true; why.push("text " + j.toFixed(2)); }
  }

  // A flat does not move between floors. A known mismatch therefore means two
  // different units — almost always the identical layout stacked one storey
  // apart, which matches on rooms, area, price and street and would otherwise
  // sail through. Only direct proof that the ads show the same rooms (shared
  // photos, or near-identical prose) can override it.
  const floorKnown = a.floorNum != null && b.floorNum != null;
  const floorSame = floorKnown && a.floorNum === b.floorNum;
  if (floorKnown && !floorSame && !photoStrong && !textStrong) return null;
  if (floorSame) { s += 1.5; why.push("same floor"); }
  else if (floorKnown) s -= 2.5;

  if (houseSame) { s += 1; why.push("house " + ha); }

  if (a.area != null && b.area != null && Math.abs(a.area - b.area) <= 0.6) s += 0.5;

  // --- identity requirement ------------------------------------------------
  // Price, floor, rooms and area describe a TYPE of flat, not a particular one.
  // A block of identical units matches on all four, so those signals alone must
  // never merge anything: "same price + same floor" already sums past the
  // threshold, and for pairs with no photos, no prose and no coordinates that
  // was the entire basis of most merges in the previous build. Require at least
  // one signal that ties the two ads to the same physical address or the same
  // rooms.
  const identity = photoStrong || textStrong || geoSame || houseSame;
  if (!identity) return null;

  return { s, why, identity: true };
}

// --- union-find -------------------------------------------------------------

function makeDSU(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) p[ra] = rb;
  };
  return { find, union };
}

// --- merging ----------------------------------------------------------------

// Prefer the record with the most information: a real date, known utilities,
// a big gallery. That one becomes the card, the rest become "also listed on".
function quality(l) {
  let s = 0;
  if (l.date) s += 3;
  if (l.utilities && l.utilities !== "unknown") s += 2;
  if (l.renovation && l.renovation !== "unknown") s += 1;
  if (l.furnished && l.furnished !== "unknown") s += 1;
  if (l.summerUtil != null || l.winterUtil != null) s += 1;
  if (l.pricePerM2 != null) s += 0.5;
  if (l.description) s += 0.5;
  s += Math.min((l.photoRefs || []).length, 30) * 0.1;
  return s;
}

function merge(items) {
  items = items.slice().sort((a, b) => quality(b) - quality(a));
  const primary = { ...items[0] };

  const numK = ["area", "rooms", "floorNum", "totalFloors", "pricePerM2", "summerUtil", "winterUtil", "latitude", "longitude"];
  const strK = ["street", "district", "floor", "series", "title", "description"];
  const unkK = ["utilities", "renovation", "furnished"];

  for (const o of items.slice(1)) {
    for (const k of numK) if (primary[k] == null && o[k] != null) primary[k] = o[k];
    for (const k of strK) if (!primary[k] && o[k]) primary[k] = o[k];
    for (const k of unkK)
      if ((primary[k] == null || primary[k] === "unknown") && o[k] && o[k] !== "unknown") primary[k] = o[k];
    if (!primary.date && o.date) primary.date = o.date;
    // the lowest asking price is the one worth showing
    if (o.price != null && (primary.price == null || o.price < primary.price)) primary.price = o.price;
  }

  // Take the richest single gallery rather than concatenating them: two posts of
  // one flat are usually the same rooms shot twice, so a union just pads the
  // lightbox with near-identical frames.
  //
  // The gallery must carry its OWN source with it. Photo references are only
  // meaningful against the URL rule of the site they came from, and the richest
  // gallery frequently belongs to a different member than the one that wins on
  // quality — so deriving the rule from the card's source rendered whole
  // galleries as broken-image placeholders.
  let best = items[0];
  for (const o of items) if ((o.photoRefs || []).length > (best.photoRefs || []).length) best = o;
  primary.photoRefs = best.photoRefs || [];
  primary.photoPrefix = best.photoPrefix;
  primary.photoSource = best.source;
  primary.source = items[0].source;

  primary.ids = items.map((x) => x.id);
  const seenUrl = new Set([primary.url]);
  primary.alts = [];
  for (const o of items) {
    if (seenUrl.has(o.url)) continue;
    seenUrl.add(o.url);
    primary.alts.push({ source: o.source, url: o.url });
  }
  return primary;
}

// --- entry point ------------------------------------------------------------

function dedupe(list, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const n = list.length;
  const dsu = makeDSU(n);

  // Candidate generation. Blocking on street tokens keeps this near-linear;
  // comparing all 317x317 pairs would also work but this stays cheap as the
  // catchment grows.
  const byToken = new Map();
  const noStreet = [];
  list.forEach((l, i) => {
    const toks = streetTokens(l);
    if (!toks.size) { noStreet.push(i); return; }
    for (const t of toks) {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(i);
    }
  });

  const pairs = new Set();
  const addPair = (i, j) => pairs.add(i < j ? i + "," + j : j + "," + i);
  for (const idxs of byToken.values()) {
    if (idxs.length > 400) continue; // pathological block, skip rather than stall
    for (let a = 0; a < idxs.length; a++)
      for (let b = a + 1; b < idxs.length; b++) addPair(idxs[a], idxs[b]);
  }
  // listings with no usable street still get a chance, against everything nearby
  for (const i of noStreet) for (let j = 0; j < n; j++) if (i !== j) addPair(i, j);

  const merges = [];
  for (const key of pairs) {
    const [i, j] = key.split(",").map(Number);
    const r = score(list[i], list[j], cfg);
    if (!r || r.s < cfg.threshold) continue;
    dsu.union(i, j);
    merges.push({ a: list[i], b: list[j], s: r.s, why: r.why });
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(list[i]);
  }

  const out = [];
  let clusters = 0;
  for (const g of groups.values()) {
    if (g.length === 1) { g[0].ids = [g[0].id]; out.push(g[0]); }
    else { clusters++; out.push(merge(g)); }
  }

  const examples = merges
    .sort((x, y) => y.s - x.s)
    .map(
      (m) =>
        `${m.a.id} + ${m.b.id}  ${m.a.street || "?"} · ` +
        `${m.a.price}€/${m.b.price}€ · ${m.why.join(", ")}`
    );

  return { listings: out, clusters, merges, examples };
}

module.exports = { dedupe, score, streetTokens, textTokens, jaccard, metres, DEFAULTS };
