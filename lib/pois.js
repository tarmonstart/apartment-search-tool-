"use strict";
// ---------------------------------------------------------------------------
// What is around a flat: the big discount supermarkets (Lidl, Rimi Hyper /
// Super, Maxima XX / XXX — not Rimi Mini / Express or Maxima X), tram stops
// and bus stops, from OpenStreetMap through the Overpass API.
//
// The data changes slowly, so it is fetched at most once a week and cached in
// state/pois.json (committed by the workflow, like the geocache). A failed
// fetch keeps the old cache; no cache at all just means no layer on the map.
//
// Stops are stored once per stop, not once per platform: OSM has a node for
// each direction (and tram stops often a track node besides), so same-named
// stops of one kind within STOP_MERGE_M metres are folded into one point.
// Trolleybus stops are bus stops in OSM, and count as bus stops here.
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { getText } = require("./http");

// the main Overpass server first, then two public mirrors (some networks are
// refused by one and served by another)
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
// Rīga plus the edge of its suburbs (south, west, north, east)
const BBOX = "56.85,23.93,57.09,24.33";
const STOP_MERGE_M = 90;
const CACHE_VERSION = 2; // v2: big supermarkets only, labelled with their format

const QUERY = `[out:json][timeout:120];
(
  nwr["shop"]["brand"~"rimi|maxima|lidl",i](${BBOX});
  nwr["shop"]["name"~"rimi|maxima|lidl",i](${BBOX});
  node["highway"="bus_stop"](${BBOX});
  node["railway"="tram_stop"](${BBOX});
  node["public_transport"="platform"]["tram"="yes"](${BBOX});
);
out center tags;`;

// The store formats worth walking to: big and cheap. Rimi Mini / Express and
// Maxima X are small convenience formats with higher prices, so they are out.
// OSM names carry the format ("Maxima XX", "Rimi Hyper"); a bare brand name
// counts only when the shop is tagged a supermarket.
function bigStore(t) {
  if (t.shop !== "supermarket" && t.shop !== "convenience" && t.shop !== "grocery") return null;
  const name = String(t.name || "").trim(), brand = String(t.brand || "").trim();
  const s = (name + " " + brand).toLowerCase();
  if (/lidl/.test(s)) return "Lidl";
  if (/rimi/.test(s)) {
    if (/mini|express|\bgo\b/.test(s)) return null;
    if (/hyper/.test(s)) return "Rimi Hyper";
    if (/super/.test(s)) return "Rimi Super";
    return t.shop === "supermarket" ? "Rimi" : null;
  }
  if (/maxima/.test(s)) {
    const m = /maxima\s*(x{1,3})\b/i.exec(name) || /maxima\s*(x{1,3})\b/i.exec(brand);
    if (m) return m[1].length >= 2 ? "Maxima " + m[1].toUpperCase() : null;
    return t.shop === "supermarket" ? "Maxima" : null;
  }
  return null;
}

function metres(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Overpass elements → { g: grocery, t: tram, b: bus } lists of [lat, lon, name]
function classify(elements) {
  const g = [], stops = { t: [], b: [] };
  for (const e of elements) {
    const lat = e.lat != null ? e.lat : e.center && e.center.lat;
    const lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (lat == null || lon == null) continue;
    const t = e.tags || {};
    const pt = [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
    if (t.shop) {
      const label = bigStore(t);
      if (label) g.push([pt[0], pt[1], label]);
      continue;
    }
    const isTram = t.railway === "tram_stop" || t.tram === "yes";
    const name = String(t.name || "").slice(0, 40);
    (isTram ? stops.t : stops.b).push([pt[0], pt[1], name]);
  }
  // fold the platforms of one stop together
  const fold = (list) => {
    const out = [];
    for (const p of list) {
      const twin = out.find((q) => q[2] === p[2] && metres(q, p) < STOP_MERGE_M);
      if (twin) {
        twin[0] = Math.round(((twin[0] + p[0]) / 2) * 1e5) / 1e5;
        twin[1] = Math.round(((twin[1] + p[1]) / 2) * 1e5) / 1e5;
      } else out.push(p.slice());
    }
    return out;
  };
  return { g, t: fold(stops.t), b: fold(stops.b) };
}

async function loadPois(root, cfg = {}, { log = () => {}, network = true } = {}) {
  const file = path.join(root, "state", "pois.json");
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  // an older cache (any grocery) is only a fallback: keep its Lidl / Rimi / Maxima
  if (cache && cache.v !== CACHE_VERSION) cache.g = (cache.g || []).filter((p) => /^(lidl|rimi|maxima)/i.test(p[2] || "") && !/mini|express|maxima x$/i.test(p[2] || ""));
  const maxAge = (cfg.maxAgeDays || 7) * 864e5;
  const fresh = cache && cache.v === CACHE_VERSION && Date.now() - Date.parse(cache.fetchedAt || 0) < maxAge;
  if (fresh || !network) {
    if (cache) log(`  stores & stops: ${cache.g.length} supermarkets · ${cache.t.length} tram · ${cache.b.length} bus stops (cached ${String(cache.fetchedAt).slice(0, 10)})`);
    return cache;
  }
  try {
    let body = null, lastErr = null;
    for (const url of OVERPASS) {
      try {
        body = await getText(url + "?data=" + encodeURIComponent(QUERY), {
          timeout: 180000,
          tries: 1,
          headers: { Accept: "application/json" },
        });
        break;
      } catch (e) {
        lastErr = e;
        log(`  stores & stops: ${new URL(url).host} failed (${e.message})`);
      }
    }
    if (body == null) throw lastErr || new Error("no Overpass server answered");
    const j = JSON.parse(body);
    const p = classify(j.elements || []);
    if (p.g.length < 20 || p.b.length < 50) throw new Error(`suspiciously little data (${p.g.length} supermarkets, ${p.b.length} bus stops)`);
    const out = { v: CACHE_VERSION, fetchedAt: new Date().toISOString(), ...p };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out));
    log(`  stores & stops: fetched ${p.g.length} supermarkets · ${p.t.length} tram · ${p.b.length} bus stops from OpenStreetMap`);
    return out;
  } catch (e) {
    log(`  stores & stops: fetch failed (${e.message}) — ${cache ? "keeping the cached set" : "no map layer this run"}`);
    return cache;
  }
}

// The nearest of each kind for every flat with a position:
// l.near = { g: [name, metres], t: [...], b: [...] }
function attachNearest(listings, pois) {
  if (!pois) return 0;
  let n = 0;
  for (const l of listings) {
    if (l.latitude == null || l.longitude == null) continue;
    const at = [l.latitude, l.longitude];
    const near = {};
    for (const k of ["g", "t", "b"]) {
      let best = null, bd = Infinity;
      for (const p of pois[k] || []) {
        // cheap box test first: 0.02° is ~2 km north-south, ~1.2 km east-west here
        if (Math.abs(p[0] - at[0]) > 0.02 || Math.abs(p[1] - at[1]) > 0.035) continue;
        const d = metres(at, p);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) near[k] = [best[2], Math.round(bd / 10) * 10];
    }
    if (Object.keys(near).length) { l.near = near; n++; }
  }
  return n;
}

module.exports = { loadPois, attachNearest, classify, metres, QUERY };
