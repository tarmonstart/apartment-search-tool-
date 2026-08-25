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
    img: { k: kind, p: l.photoRefs || [] },
  };
  // only carry the extras when they exist, so the payload stays lean
  if (l.ids && l.ids.length > 1) o.ids = l.ids;
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

function writeHTML(root, listings, meta, userState) {
  const css = fs.readFileSync(path.join(UI_DIR, "report.css"), "utf8");
  const js = fs.readFileSync(path.join(UI_DIR, "report.js"), "utf8");
  // Leaflet is vendored (lib/vendor/) and inlined, so the report stays a single
  // self-contained file; only the map TILES need the network, like the photos.
  // If the vendor files are missing the report still builds — without the map.
  let leafletJs = "", leafletCss = "";
  try {
    leafletJs = fs.readFileSync(path.join(__dirname, "vendor", "leaflet.js"), "utf8");
    leafletCss = fs.readFileSync(path.join(__dirname, "vendor", "leaflet.css"), "utf8");
  } catch {}
  const data = listings.map(forReport);

  const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rīga rentals · ${meta.total} listings</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#06070a">
${leafletCss ? `<style>\n${leafletCss}\n</style>` : ""}
<style>
${css}
</style>
<script>
// set the theme before first paint, so there is no white flash on a dark setup
(function(){try{var t=localStorage.getItem('rr.theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
</script>
</head>
<body>

<header class="top">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <div>
      <h1>Rīga rentals</h1>
      <p class="sub">${meta.total} flats · ${meta.nnew} new · updated ${esc(meta.generated)}</p>
    </div>
  </div>
  <div class="head-actions">
    <div id="tally" class="tally"></div>
    <button id="mapBtn" class="ghost" type="button" title="All filtered flats on one map">Map</button>
    <button id="themeBtn" class="ghost" type="button">Light</button>
    <details class="menu" id="moreMenu">
      <summary class="ghost" aria-label="Backup and sync">⋯</summary>
      <div class="menu-list">
        <button id="syncBtn" type="button" title="Write picks straight to state/user-state.json (needs the page served over http)">Sync to disk</button>
        <button id="exportBtn" type="button" title="Download your picks. The next run adopts it automatically.">Export picks</button>
        <button id="importBtn" type="button" title="Restore picks from a file">Import picks</button>
      </div>
    </details>
  </div>
</header>

<div id="saveState" class="savebar" hidden></div>

<section class="controls" aria-label="Filters">
  <div class="row row-main">
    <label class="field grow">
      <span class="flabel">Search</span>
      <input id="q" type="search" placeholder="street, description, anything… ( / )" autocomplete="off">
    </label>
    <label class="field">
      <span class="flabel">Street</span>
      <input id="street" type="search" placeholder="e.g. Blaumaņa" autocomplete="off" style="width:130px">
    </label>
    <label class="field"><span class="flabel">District</span><select id="districtF"></select></label>
    <span class="field range">
      <span class="flabel">Price €</span>
      <input id="pmin" class="mini" type="number" min="0" placeholder="min">
      <input id="pmax" class="mini" type="number" min="0" placeholder="max">
    </span>
    <label class="field">
      <span class="flabel">Sort</span>
      <select id="sort">
        <option value="smart">best match</option>
        <option value="price:1">price ↑</option>
        <option value="price:-1">price ↓</option>
        <option value="pricePerM2:1">€/m² ↑</option>
        <option value="area:-1">biggest m²</option>
        <option value="date:-1">newest</option>
        <option value="rooms:1">rooms ↑</option>
      </select>
    </label>
    <label class="field">
      <span class="flabel">Pile</span>
      <select id="pileF">
        <option value="">everything</option>
        <option value="not-discard">hide discarded</option>
        <option value="like">liked</option>
        <option value="maybe">maybe</option>
        <option value="discard">discarded</option>
        <option value="none">untouched</option>
      </select>
    </label>
    <span class="field toggles">
      <label class="chip" title="One card per address: the best of the flats advertised at that address (most photos, cheapest), with the rest one click away"><input type="checkbox" id="groupAddr" checked><span>one per address</span></label>
    </span>
    <button id="filtersBtn" class="ghost" type="button" aria-expanded="false">Filters</button>
    <span class="count" id="count"></span>
  </div>
  <div class="row">
    <span class="field range">
      <span class="flabel">Area m²</span>
      <input id="amin" class="mini" type="number" min="0" placeholder="min">
      <input id="amax" class="mini" type="number" min="0" placeholder="max">
    </span>
    <span class="field range">
      <span class="flabel">Floor</span>
      <input id="fmin" class="mini" type="number" min="0" placeholder="min">
      <input id="fmax" class="mini" type="number" min="0" placeholder="max">
    </span>
    <span class="field" id="rooms"></span>
  </div>
  <div class="row">
    <label class="field"><span class="flabel">Utilities</span>
      <select id="util">
        <option value="">any</option><option value="included">included</option>
        <option value="unknown">unknown</option><option value="excluded">extra</option>
      </select>
    </label>
    <label class="field"><span class="flabel">Condition</span>
      <select id="cond">
        <option value="">any</option><option value="renovated">renovated</option>
        <option value="unknown">unknown</option><option value="old">needs work</option>
      </select>
    </label>
    <label class="field"><span class="flabel">Furnishing</span>
      <select id="furn">
        <option value="">any</option><option value="furnished">furnished</option>
        <option value="unfurnished">unfurnished</option><option value="unknown">unknown</option>
      </select>
    </label>
    <label class="field"><span class="flabel">Source</span><select id="src"></select></label>
    <span class="field toggles">
      <label class="chip"><input type="checkbox" id="newOnly"><span>new only</span></label>
      <label class="chip"><input type="checkbox" id="hideSeen"><span>hide seen</span></label>
      <label class="chip"><input type="checkbox" id="withPhotos"><span>has photos</span></label>
      <button id="resetBtn" class="ghost sm" type="button">Reset</button>
    </span>
  </div>
</section>

<main id="grid" class="grid"></main>

<footer class="foot">
  <span>Public listings, personal use. ${esc(meta.sources)}</span>
  <span class="fb">Not scrapeable (ToS / login walls) — search by hand:
    <a href="https://www.facebook.com/marketplace/riga/propertyrentals" target="_blank" rel="noopener">FB Marketplace ↗</a>
    <a href="https://www.facebook.com/search/groups/?q=%C4%ABr%C4%93%20dz%C4%ABvokli%20R%C4%ABg%C4%81" target="_blank" rel="noopener">FB groups ↗</a>
    <a href="${airbnbUrl()}" target="_blank" rel="noopener">Airbnb monthly ↗</a>
  </span>
  <span class="keys"><b>j</b>/<b>k</b> move · <b>L</b>/<b>M</b>/<b>D</b> tag · <b>O</b> open · <b>Enter</b> photos · <b>/</b> search</span>
</footer>

<div id="map" class="mappanel" hidden role="dialog" aria-modal="true" aria-label="Map">
  <div class="map-head">
    <span id="mapTitle" class="map-title"></span>
    <button id="drawBtn" class="ghost sm" type="button" title="Draw an area on the map — the list then shows only flats inside it">✏ Draw area</button>
    <span class="map-links">
      <a id="mapGmaps" href="#" target="_blank" rel="noopener">Google Maps ↗</a>
      <a id="mapOsmLink" href="#" target="_blank" rel="noopener">OSM ↗</a>
    </span>
    <button id="mapClose" class="lbbtn map-close" type="button" aria-label="Close">✕</button>
  </div>
  <div id="mapCanvas" class="map-canvas"></div>
  <div id="mapLegend" class="map-legend" hidden>
    <span class="pip p-like">liked</span><span class="pip p-maybe">maybe</span>
    <span class="pip p-none">untouched</span><span class="pip p-discard">discarded</span>
    <span class="map-note">street-position pins are approximate</span>
  </div>
</div>

<div id="lb" class="lightbox" hidden tabindex="-1" role="dialog" aria-modal="true" aria-label="Listing photos">
  <button id="lbClose" class="lbbtn lb-close" type="button" aria-label="Close">✕</button>
  <button id="lbPrev" class="lbbtn lb-prev" type="button" aria-label="Previous">‹</button>
  <div class="lb-stage"><img id="lbImg" alt="" decoding="async"></div>
  <button id="lbNext" class="lbbtn lb-next" type="button" aria-label="Next">›</button>
  <div class="lb-bar">
    <span id="lbCount" class="lb-count"></span>
    <span id="lbCap" class="lb-cap"></span>
  </div>
  <div id="lbStrip" class="lb-strip"></div>
</div>

<button id="mapFab" class="mapfab" type="button" aria-label="Open the map">◉ Map</button>

<div id="toast" class="toast" hidden role="status"></div>

<script>
const DATA=${safeJSON(data)};
const SAVED=${safeJSON({ pile: userState.pile, visited: userState.visited })};
const META=${safeJSON({
    preferredRooms: meta.preferredRooms,
    generated: meta.generated,
    total: meta.total,
    builtAt: Date.now(),
  })};
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
