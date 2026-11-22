"use strict";
// ---------------------------------------------------------------------------
// Output: the self-contained HTML report and the CSV.
//
// The HTML inlines everything — styles, script, data — so it can be opened from
// disk with no server and no network beyond the photo CDNs. ui/report.css and
// ui/report.js are kept as real files (so they are editable with syntax
// highlighting) and stitched in here at build time.
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { clientHelper, SOURCE_KIND } = require("./images");

const UI_DIR = path.join(__dirname, "..", "ui");

// The brand is a theme: a stylesheet layered over ui/report.css, its fonts,
// its name and mark, and its map-pin colours. config.json "theme" picks one.
const BRANDS = {
  kvartals: {
    name: "Kvartāls",
    css: null, // report.css is already Kvartāls
    fonts: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Jost:wght@400;500;600&display=swap",
    themeColor: "#FAF6EE",
    mark: '<svg class="mark" viewBox="0 0 64 78" aria-hidden="true"><path d="M4 76 V30 A28 28 0 0 1 60 30 V76" fill="none" stroke="currentColor" stroke-width="3"/><path d="M12 76 V32 A20 20 0 0 1 52 32 V76" fill="none" stroke="#B8932F" stroke-width="2"/><path d="M26 34 V64 M26 50 L40 34 M30 46 L40 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    pins: { todo: "#0F4C4A", seen: "#B9806A", like: "#B8932F", discard: "#A7B0AE" },
  },
  logs: {
    name: "logs",
    css: "theme-logs.css",
    fonts: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;800&display=swap",
    themeColor: "#F4F1EA",
    mark: '<svg class="mark" viewBox="0 0 68 68" aria-hidden="true"><rect x="3" y="3" width="62" height="62" rx="10" fill="none" stroke="currentColor" stroke-width="4"/><rect x="36" y="8" width="24" height="24" rx="4" fill="#8FB8DE"/><path d="M34 6 V62 M6 34 H62" stroke="currentColor" stroke-width="4"/></svg>',
    pins: { todo: "#1F3A5F", seen: "#8FB8DE", like: "#2F8F6B", discard: "#B4BCC6" },
  },
};
const MAP_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>';

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Keep the JSON blob out of trouble: a literal "</script>" inside any listing
// text would otherwise end the script element early.
function safeJSON(v) {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")        // a literal </script> in ad copy would close the tag
    .replace(/\u2028/g, "\\u2028")  // JS treats these as line breaks; JSON does not
    .replace(/\u2029/g, "\\u2029");
}

// Trim each listing down to what the report actually reads. The full record
// carries scraping scaffolding that would only bloat the file.
function forReport(l) {
  // photoSource, not source: a de-duplicated card can carry the gallery of a
  // member from a different site, and a photo reference only resolves against
  // the URL rule of the site it came from.
  const kind = SOURCE_KIND[l.photoSource || l.source] || "ss";
  const o = {
    id: l.id,
    source: l.source,
    url: l.url,
    price: l.price,
    rooms: l.rooms,
    area: l.area,
    pricePerM2: l.pricePerM2 == null ? null : Math.round(l.pricePerM2 * 10) / 10,
    floor: l.floor || "",
    floorNum: l.floorNum,
    street: l.street || "",
    district: l.district || "",
    title: l.title || "",
    description: l.description || "",
    date: l.date || null,
    utilities: l.utilities || "unknown",
    renovation: l.renovation || "unknown",
    furnished: l.furnished || "unknown",
    summerUtil: l.summerUtil,
    winterUtil: l.winterUtil,
    isNew: !!l.isNew,
    firstSeen: l.firstSeen || null,
    img: { k: kind, p: l.photoRefs || [] },
  };
  // only carry the extras when they exist, so the payload stays lean
  if (l.ids && l.ids.length > 1) o.ids = l.ids;
  if (l.near) o.near = l.near; // nearest supermarket / tram / bus: [name, metres]
  if (l.alts && l.alts.length) o.alts = l.alts;
  // coordinates: city24 publishes them; the rest are geocoded (see lib/geocode.js).
  // 5 decimals ≈ 1 m — more than the data deserves, cheap to carry.
  if (l.latitude != null && l.longitude != null) {
    o.lat = Math.round(l.latitude * 1e5) / 1e5;
    o.lon = Math.round(l.longitude * 1e5) / 1e5;
    if (l.geoPrec) o.geoPrec = l.geoPrec; // "street" = centroid, not the house
  }
  return o;
}

// Airbnb monthly stays, Riga-centre bounding box, starting the 1st of next
// month for 3 months. A plain human-facing link — Airbnb's ToS and robots.txt
// forbid scraping it, so a one-tap search is the honest integration.
function airbnbUrl() {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 4, 1);
  const iso = (x) => x.toISOString().slice(0, 10);
  return (
    "https://www.airbnb.com/s/Riga--Latvia/homes?refinement_paths%5B%5D=%2Fhomes" +
    "&flexible_trip_lengths%5B%5D=one_month&price_filter_input_type=2" +
    `&monthly_start_date=${iso(start)}&monthly_length=3&monthly_end_date=${iso(end)}` +
    "&ne_lat=56.97&ne_lng=24.16&sw_lat=56.92&sw_lng=24.06&zoom=13&search_by_map=true"
  );
}

function writeHTML(root, listings, meta, userState, pois) {
  const brand = BRANDS[meta.theme] || BRANDS.kvartals;
  const css = fs.readFileSync(path.join(UI_DIR, "report.css"), "utf8") +
    (brand.css ? "\n" + fs.readFileSync(path.join(UI_DIR, brand.css), "utf8") : "");
  const js = fs.readFileSync(path.join(UI_DIR, "report.js"), "utf8");
  // Leaflet is vendored (lib/vendor/) and inlined, so the report stays a single
  // self-contained file; only the map TILES need the network, like the photos.
  let leafletJs = "", leafletCss = "";
  try {
    leafletJs = fs.readFileSync(path.join(__dirname, "vendor", "leaflet.js"), "utf8");
    leafletCss = fs.readFileSync(path.join(__dirname, "vendor", "leaflet.css"), "utf8");
  } catch {}
  const data = listings.map(forReport);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(brand.name)} · Rīga rentals</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${brand.themeColor}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(brand.fonts)}">
<meta name="apple-mobile-web-app-capable" content="yes">
${leafletCss ? `<style>\n${leafletCss}\n</style>` : ""}
<style>
${css}
</style>
</head>
<body>

<header class="top">
  <div class="top-row">
    <div class="brand">
      ${brand.mark}
      <div>
        <h1>${esc(brand.name)}</h1>
        <p class="sub" id="sub">${meta.total} flats · ${esc(meta.generated)}</p>
      </div>
    </div>
    <div class="top-acts">
      <button id="authBtn" class="btn ghost" type="button" hidden>Sign in</button>
      <button id="mapBtn" class="btn ghost" type="button" aria-label="Map">${MAP_ICON}<span class="hide-sm">Map</span></button>
      <button id="filterBtn" class="btn" type="button">Filters<span id="filterCount" class="badge" hidden></span></button>
    </div>
  </div>
  <nav class="tabs" role="tablist">
    <button class="tab on" data-tab="todo" role="tab"><span>Unviewed</span><b id="nTodo">0</b></button>
    <button class="tab" data-tab="seen" role="tab"><span>Viewed</span><b id="nSeen">0</b></button>
    <button class="tab" data-tab="like" role="tab"><span>Liked</span><b id="nLike">0</b></button>
    <button class="tab" data-tab="discard" role="tab"><span>Disliked</span><b id="nDiscard">0</b></button>
  </nav>
  <div id="chips" class="chips"></div>
  <button id="barToggle" class="bar-handle" type="button" aria-expanded="true" aria-label="Hide tabs and filters" title="Hide tabs and filters"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button>
</header>

<main id="list" class="list" aria-live="polite"></main>
<div id="empty" class="empty" hidden></div>
<div id="sentinel" class="sentinel"></div>

<footer class="foot">
  <p>Sources: ${esc(meta.sources)}. The same flat found on several sites is shown as one card.</p>
  <p class="manual">Search these by hand (login required or scraping not allowed):
    <a href="https://www.city24.lv/real-estate/apartments-for-rent/riga" target="_blank" rel="noopener">city24</a>
    <a href="https://www.facebook.com/marketplace/riga/propertyrentals" target="_blank" rel="noopener">FB Marketplace</a>
    <a href="https://www.facebook.com/search/groups/?q=%C4%ABr%C4%93%20dz%C4%ABvokli%20R%C4%ABg%C4%81" target="_blank" rel="noopener">FB groups</a>
    <a href="${airbnbUrl()}" target="_blank" rel="noopener">Airbnb monthly</a>
  </p>
  <p class="backup">
    <span id="saveNote">Your votes are saved in this browser.</span>
    <button id="exportBtn" class="link" type="button">Back up votes</button> ·
    <button id="importBtn" class="link" type="button">Restore a backup</button>
  </p>
</footer>

<!-- filters: a bottom sheet on phones, a side panel on wide screens -->
<div id="sheet" class="sheet" hidden>
  <div class="sheet-scrim" data-close></div>
  <section class="sheet-card" role="dialog" aria-modal="true" aria-label="Filters">
    <div class="sheet-head">
      <h2>Filters</h2>
      <button class="btn ghost" type="button" data-close aria-label="Close"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="sheet-body">
      <div class="fgroup">
        <label class="flabel" for="fMax">Max rent (€ / month)</label>
        <div class="presets" data-for="fMax" data-vals="400,600,800,1000,1500"></div>
        <input id="fMax" type="number" inputmode="numeric" min="0" step="50" placeholder="no limit">
      </div>
      <div class="fgroup">
        <span class="flabel">Rooms</span>
        <div class="toggles" id="fRooms">
          <button type="button" data-v="1">1</button><button type="button" data-v="2">2</button>
          <button type="button" data-v="3">3</button><button type="button" data-v="4">4+</button>
        </div>
      </div>
      <div class="fgroup">
        <label class="flabel" for="fArea">Min size (m²)</label>
        <div class="presets" data-for="fArea" data-vals="30,40,50,60,80"></div>
        <input id="fArea" type="number" inputmode="numeric" min="0" step="5" placeholder="no limit">
      </div>
      <div class="fgroup">
        <span class="flabel">Area on the map</span>
        <p id="zoneInfo" class="fnote"></p>
        <div class="zone-acts">
          <button id="zoneDraw" class="btn primary" type="button">Draw on map</button>
          <button id="zoneClear" class="btn ghost" type="button" hidden>Clear</button>
        </div>
      </div>
      <div class="fgroup">
        <span class="flabel">Districts <small>(none selected = all of Rīga)</small></span>
        <div class="toggles wrap" id="fDistricts"></div>
      </div>
      <div class="fgroup">
        <span class="flabel">Only</span>
        <div class="toggles wrap" id="fFlags">
          <button type="button" data-v="fresh">Last 3 days</button>
          <button type="button" data-v="util">Utilities included</button>
          <button type="button" data-v="reno">Renovated / new</button>
          <button type="button" data-v="furn">Furnished</button>
          <button type="button" data-v="photos">Has photos</button>
        </div>
      </div>
      <div class="fgroup">
        <label class="flabel" for="fQ">Search</label>
        <input id="fQ" type="search" placeholder="street, district, any word from the ad…" autocomplete="off">
      </div>
      <div class="fgroup">
        <label class="flabel" for="fSort">Sort by</label>
        <select id="fSort">
          <option value="new">Newest first</option>
          <option value="cheap">Cheapest first</option>
          <option value="ppm">Lowest €/m²</option>
          <option value="big">Biggest first</option>
        </select>
      </div>
    </div>
    <div class="sheet-foot">
      <button id="resetBtn" class="btn ghost" type="button">Clear all</button>
      <button id="applyBtn" class="btn primary" type="button" data-close>Show</button>
    </div>
  </section>
</div>

<div id="map" class="mapview" hidden role="dialog" aria-modal="true" aria-label="Map">
  <div class="map-head">
    <span id="mapTitle"></span>
    <span class="map-acts">
      <button id="drawBtn" class="btn primary" type="button">Draw area</button>
      <button id="clearZonesBtn" class="btn ghost" type="button" hidden>Clear areas</button>
      <button id="mapClose" class="btn ghost" type="button" aria-label="Close"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </span>
  </div>
  <div id="poiBar" class="poi-bar" hidden>
    <span class="poi-note">Zoom in to see</span>
    <button type="button" class="poi-t on" data-k="g"><i class="poi-dot g" aria-hidden="true">S</i>Lidl · Rimi · Maxima</button>
    <button type="button" class="poi-t on" data-k="t"><i class="poi-dot t" aria-hidden="true">T</i>Tram</button>
    <button type="button" class="poi-t on" data-k="b"><i class="poi-dot b" aria-hidden="true">B</i>Bus</button>
  </div>
  <div id="drawHint" class="draw-hint" hidden>Drag one finger around the area you want, then let go.</div>
  <div id="mapCanvas" class="map-canvas"></div>
</div>

<div id="lb" class="lightbox" hidden role="dialog" aria-modal="true" aria-label="Photos">
  <div id="lbStage" class="lb-stage"></div>
  <div class="lb-bar"><span id="lbCount"></span><button id="lbClose" class="btn ghost" type="button" aria-label="Close"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
</div>

<button id="toTop" class="totop" type="button" hidden aria-label="Back to top"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>

<div id="toast" class="toast" hidden role="status"><span id="toastMsg"></span><button id="toastUndo" class="link" type="button">Undo</button></div>

<script>
const DATA=${safeJSON(data)};
const SAVED=${safeJSON({ pile: userState.pile, visited: userState.visited, cleared: userState.cleared || [] })};
const POIS=${safeJSON(pois ? { g: pois.g, t: pois.t, b: pois.b } : null)};
const META=${safeJSON({ generated: meta.generated, total: meta.total, builtAt: Date.now(), firebase: meta.firebase || null, brand: { name: brand.name, pins: brand.pins } })};
${clientHelper()}
</script>
${leafletJs ? `<script>\n${leafletJs}\n</script>` : ""}
<script>
${js}
</script>
</body>
</html>`;

  const out = path.join(root, "listings.html");
  fs.writeFileSync(out, html);
  return out;
}

// --- CSV --------------------------------------------------------------------

const CSV_COLS = [
  "price", "rooms", "area", "pricePerM2", "utilities", "renovation", "furnished",
  "summerUtil", "winterUtil", "verdict", "seen", "isNew", "district", "street",
  "floor", "date", "photos", "source", "alsoOn", "url",
];

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCSV(root, listings) {
  const lines = [CSV_COLS.join(",")];
  for (const l of listings) {
    lines.push(
      CSV_COLS.map((c) => {
        if (c === "photos") return (l.photoRefs || []).length;
        if (c === "alsoOn") return (l.alts || []).map((a) => a.source).join(" ");
        if (c === "verdict") return l.verdict || "";
        if (c === "seen") return l.seen ? "yes" : "";
        if (c === "isNew") return l.isNew ? "yes" : "";
        return l[c];
      })
        // quote exactly once — running csvCell over an already-quoted cell
        // double-wraps it, so a street like `Blaumaņa 5, k-2` reaches Excel as
        // """Blaumaņa 5, k-2"""
        .map(csvCell)
        .join(",")
    );
  }
  const out = path.join(root, "listings.csv");
  // BOM so Excel opens the Latvian characters correctly
  fs.writeFileSync(out, "﻿" + lines.join("\r\n"), "utf8");
  return out;
}

module.exports = { writeHTML, writeCSV, forReport };
