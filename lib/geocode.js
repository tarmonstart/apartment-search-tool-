"use strict";
// ---------------------------------------------------------------------------
// Build-time geocoding for the map view.
//
// city24 publishes lat/lon; ss.lv and pp.lv do not. This fills the gap with
// Nominatim (OpenStreetMap's geocoder), under its usage policy:
//   * at most 1 request per second, sequential
//   * an identifying User-Agent (the default browser UA is forbidden)
//   * results cached so an address is asked about once, ever
//
// The cache lives in state/geocache.json keyed by the normalised address.
// Misses are cached too (retried monthly), otherwise one unparseable street
// would be re-queried on every run. A run geocodes at most `maxPerRun` new
// addresses (default 150 ≈ 3 minutes) — the rest simply wait for the next run,
// which the twice-daily schedule turns into "everything within a day or two".
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { getJSON, sleep } = require("./http");

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Identifying, per policy. No contact details on purpose; the tool is personal.
const GEO_UA = "riga-rentals/2.0 (personal apartment hunt; local desktop tool)";
const MISS_RETRY_DAYS = 30;

// "Ģertrūdes 65B" -> { streetName: "Ģertrūdes", houseNo: "65B" }
// "Aleksandra Čaka iela 134" -> { streetName: "Aleksandra Čaka iela", houseNo: "134" }
// "Tērbatas" -> { streetName: "Tērbatas", houseNo: null }
function splitStreet(street) {
  const s = String(street || "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const m = /^(.*?)[\s,]+(\d+[a-zA-Zžšķļņčģē]?(?:\s*\/\s*\d+[a-zA-Z]?)?(?:\s*k-?\s*\d+)?)$/.exec(s);
  if (m && m[1]) return { streetName: m[1].replace(/,$/, ""), houseNo: m[2].replace(/\s+/g, "") };
  return { streetName: s, houseNo: null };
}

// Latvian street references usually omit the generic ("iela" = street). Nominatim
// resolves "Avotu iela 8" far more reliably than "Avotu 8", so add it unless the
// name already ends in a generic (iela / bulvāris / gatve / prospekts / laukums / dambis / krastmala).
function canonicalStreet(name) {
  const n = name.trim();
  if (/(iela|bulv[āa]ris|bulv\.|gatve|prospekts|laukums|dambis|krastmala|aleja|šķērsiela)\s*$/i.test(n)) return n;
  return n + " iela";
}

function keyOf(listing) {
  const p = splitStreet(listing.street);
  if (!p) return null;
  return (p.streetName + "|" + (p.houseNo || "") + "|riga").toLowerCase();
}

function loadCache(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "state", "geocache.json"), "utf8"));
  } catch {
    return {};
  }
}
function saveCache(root, cache) {
  const dir = path.join(root, "state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "geocache.json"), JSON.stringify(cache));
}

function inRiga(lat, lon) {
  return isFinite(lat) && isFinite(lon) && lat >= 56.85 && lat <= 57.1 && lon >= 23.9 && lon <= 24.35;
}

// Free-text query, verified against the live service: "Avotu iela 8, Riga"
// hits the exact building (place_rank 30) even with ASCII input.
async function lookup(streetName, houseNo) {
  const q = canonicalStreet(streetName) + (houseNo ? " " + houseNo : "") + ", Riga";
  const url =
    NOMINATIM + "?format=jsonv2&limit=1&countrycodes=lv&q=" + encodeURIComponent(q);
  const arr = await getJSON(url, { headers: { "User-Agent": GEO_UA }, tries: 2 });
  if (!Array.isArray(arr) || !arr.length) return null;
  const r = arr[0];
  const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
  if (!inRiga(lat, lon)) return null;
  // place_rank 30 / addresstype building = the house itself; 26 = street centroid
  const prec = r.place_rank >= 29 || r.addresstype === "building" ? "house" : "street";
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, prec };
}

// Photon (photon.komoot.io) — OSM-based fallback for when Nominatim declines.
// GeoJSON, and the coordinates arrive as [lon, lat].
async function lookupPhoton(streetName, houseNo) {
  const q = canonicalStreet(streetName) + (houseNo ? " " + houseNo : "") + ", Riga";
  const j = await getJSON(
    "https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(q),
    { tries: 1 }
  );
  const f = j && j.features && j.features[0];
  if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
  if (f.properties && f.properties.countrycode && f.properties.countrycode !== "LV") return null;
  const lon = parseFloat(f.geometry.coordinates[0]), lat = parseFloat(f.geometry.coordinates[1]);
  if (!inRiga(lat, lon)) return null;
  const prec = f.properties && (f.properties.housenumber || f.properties.type === "house") ? "house" : "street";
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, prec };
}

// Fill coordinates onto every listing that lacks them. Cache-only when
// `network` is false (--report runs promise to stay offline).
async function geocodeAll(listings, root, cfg = {}, { log = () => {}, network = true } = {}) {
  const maxPerRun = cfg.maxPerRun == null ? 150 : cfg.maxPerRun;
  const cache = loadCache(root);
  const now = Date.now();

  // group listings by address key
  const byKey = new Map();
  for (const l of listings) {
    if (l.latitude != null && l.longitude != null) continue;
    const k = keyOf(l);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }

  let applied = 0, fetched = 0, misses = 0;
  const pending = [];
  for (const [k, group] of byKey) {
    const c = cache[k];
    if (c && c.lat != null) {
      for (const l of group) { l.latitude = c.lat; l.longitude = c.lon; l.geoPrec = c.prec; applied++; }
    } else if (c && c.miss && now - c.miss < MISS_RETRY_DAYS * 864e5) {
      // known miss, not due for retry
    } else {
      pending.push(k);
    }
  }

  if (network && pending.length) {
    const batch = pending.slice(0, maxPerRun);
    log(`  geocoding ${batch.length} new address${batch.length === 1 ? "" : "es"}` +
        (pending.length > batch.length ? ` (${pending.length - batch.length} left for next run)` : "") +
        " — Nominatim, 1/s…");
    for (const k of batch) {
      const [streetName, houseNo] = k.split("|");
      let res = null;
      try {
        res = await lookup(streetName, houseNo || null);
        // a numbered address that misses may still resolve as a street centroid
        if (!res && houseNo) res = await sleep(1100).then(() => lookup(streetName, null));
      } catch (e) {
        // Nominatim said no (403/429/network) — try the Photon fallback once
        try { res = await lookupPhoton(streetName, houseNo || null); } catch (e2) {}
      }
      fetched++;
      if (res) {
        cache[k] = res;
        for (const l of byKey.get(k)) { l.latitude = res.lat; l.longitude = res.lon; l.geoPrec = res.prec; applied++; }
      } else {
        cache[k] = { miss: now };
        misses++;
      }
      if (fetched % 25 === 0) saveCache(root, cache); // survive an interrupted run
      await sleep(1100);
    }
    saveCache(root, cache);
  }

  const withGeo = listings.filter((l) => l.latitude != null).length;
  log(`  coordinates: ${withGeo}/${listings.length} listings` +
      (fetched ? ` (${fetched} looked up now, ${misses} not found)` : " (from cache/API)"));
  return { withGeo, fetched, misses };
}

module.exports = { geocodeAll, splitStreet, keyOf };
