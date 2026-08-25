"use strict";
// ---------------------------------------------------------------------------
// ss.lv — HTML listing tables, then a deep read of each surviving ad.
//
// The gallery handling here is the important part. ss.lv builds a photo's URL
// from the GLOBAL image id and nothing else:
//
//   dir  = ceil(id/1e7) / ceil(id/5e4) / ceil(id/200)
//   file = <category prefix> + id + <.t|.th2|.800> + .jpg
//
// (straight out of the site's own main.lv.ss.js). Ids are handed out globally,
// so when an advertiser adds photos to an ad over time the new ones land in
// entirely different folders — one ad was measured spanning nine of them.
//
// The previous implementation scraped .800.jpg URLs out of the page and kept
// only those in the same folder as the row thumbnail. Measured against 32 real
// listings that dropped 103 of 472 photos (21.8%), undercounted half of all
// listings, and reported "1 photo" for ads that actually have 5-17. Worse, on
// some ads the row thumbnail's folder is not in the gallery at all.
//
// So we read `msg_img` instead — the inline array the site's own lightbox uses.
// Its entry count matches the page's MAX_NAVI on every listing tested, and it
// cannot pull in "related ads" photos by construction, because it is the ad's
// own model.
// ---------------------------------------------------------------------------
const { getText, pool } = require("../http");
const {
  stripTags, num, detectUtilities, detectRenovation, mergeReno,
  detectFurnished, extractSeasonUtils, isShortTerm,
} = require("../detect");

const BASE = "https://www.ss.lv";

// --- gallery ----------------------------------------------------------------

// msg_img = ["", "1|910|606|39686825|<hdToken>|1", "2|801|534|63668383", ...]
//            index|width|height|globalImageId|hdToken|hdFlag
function parseMsgImg(html) {
  const m = /msg_img\s*=\s*(\[[\s\S]*?\]);/.exec(html);
  if (!m) return [];
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of arr) {
    if (typeof entry !== "string" || !entry) continue;
    const f = entry.split("|");
    const id = parseInt(f[3], 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.push({ id, w: parseInt(f[1], 10) || null, h: parseInt(f[2], 10) || null });
  }
  return out;
}

// The category prefix ("flats-riga-centre-") is part of the filename and is
// derived from the category, so read it from the page rather than hardcoding it.
function galleryPrefix(html) {
  const m = /MSG_GALLERY_PREFIX\s*=\s*['"]([^'"]*)['"]/.exec(html);
  if (m) return m[1];
  const any = /\/gallery\/\d+\/\d+\/\d+\/([a-z0-9-]*?)\d+\.(?:800|t|th2)\.jpg/i.exec(html);
  return any ? any[1] : "flats-riga-centre-";
}

// Ads that predate the global-id scheme carry a directory instead. Rare — it did
// not fire on any of 50 sampled listings — but the old regex would return zero
// photos for them, so handle it rather than silently losing the gallery.
function legacyGallery(html) {
  const dm = /msg_img_dir\s*=\s*['"]([^'"]+)['"]/.exec(html);
  const cm = /MAX_NAVI\s*=\s*(\d+)/.exec(html);
  if (!dm || !cm) return [];
  const dir = dm[1];
  const n = parseInt(cm[1], 10) || 0;
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ legacy: dir + i + ".800.jpg" });
  return out;
}

function extractGallery(html) {
  const imgs = parseMsgImg(html);
  if (imgs.length) return { prefix: galleryPrefix(html), refs: imgs.map((x) => String(x.id)), dims: imgs };
  const legacy = legacyGallery(html);
  return { prefix: galleryPrefix(html), refs: [], legacy: legacy.map((x) => x.legacy), dims: [] };
}

// --- listing rows -----------------------------------------------------------

// ss.lv url slugs → Latvian district names. The all-Riga list embeds the
// district in each ad's link (/msg/…/flats/riga/<slug>/…), which is the one
// reliable per-row source of it. Unknown slugs fall back to a prettified form.
const DISTRICT_SLUGS = {
  centre: "Centrs", vecriga: "Vecrīga", "klusais-centrs": "Klusais centrs",
  agenskalns: "Āgenskalns", aplokciems: "Aplokciems", bergi: "Berģi",
  bierini: "Bieriņi", bolderaya: "Bolderāja", breksi: "Brekši",
  bukulti: "Bukulti", chiekurkalns: "Čiekurkalns", darzciems: "Dārzciems",
  darzini: "Dārziņi", daugavgriva: "Daugavgrīva", dreilini: "Dreiliņi",
  dzeguzhkalns: "Dzegužkalns", grizinkalns: "Grīziņkalns", ilguciems: "Iļģuciems",
  imanta: "Imanta", jaunciems: "Jaunciems", yugla: "Jugla",
  katlakalns: "Katlakalns", kengarags: "Ķengarags", kipsala: "Ķīpsala",
  kleisti: "Kleisti", "krasta-st-area": "Krasta masīvs", kundzinsala: "Kundziņsala",
  lucavsala: "Lucavsala", mangali: "Mangaļi", mangalsala: "Mangaļsala",
  "maskavas-priekshpilseta": "Maskavas priekšpilsēta", mezhaparks: "Mežaparks",
  mezhciems: "Mežciems", milgravis: "Mīlgrāvis", plyavnieki: "Pļavnieki",
  purvciems: "Purvciems", "shampeteris-pleskodale": "Šampēteris-Pleskodāle",
  sarkandaugava: "Sarkandaugava", shkirotava: "Šķirotava", teika: "Teika",
  tornjakalns: "Torņakalns", trisciems: "Trīsciems", vecaki: "Vecāķi",
  vecdaugava: "Vecdaugava", vecmilgravis: "Vecmīlgrāvis", zakusala: "Zaķusala",
  zasulauks: "Zasulauks", ziepniekkalns: "Ziepniekkalns", zolitude: "Zolitūde",
  voleri: "Voleri",
};
function districtFromLink(link) {
  const m = /\/flats\/riga\/([^/]+)\//.exec(link || "");
  if (!m) return "Rīga";
  const slug = m[1];
  if (DISTRICT_SLUGS[slug]) return DISTRICT_SLUGS[slug];
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
// On all-Riga pages the street cell reads "Jugla Brīvības 386" — the district
// display name prefixed to the street. Strip it when it matches.
function stripDistrictPrefix(street, district) {
  const s = String(street || "").trim();
  const d = String(district || "").trim();
  if (d && s.toLowerCase().startsWith(d.toLowerCase()))
    return s.slice(d.length).trim() || s;
  // multi-word districts sometimes render without the hyphen
  const dSpaced = d.replace(/-/g, " ");
  if (dSpaced !== d && s.toLowerCase().startsWith(dSpaced.toLowerCase()))
    return s.slice(dSpaced.length).trim() || s;
  return s;
}

async function collect(cfg, { log = () => {} } = {}) {
  const base = `${BASE}/lv/real-estate/flats/riga/${cfg.category}/hand_over/`;
  const out = [];
  const seenIds = new Set();

  for (let p = 1; p <= cfg.maxPages; p++) {
    const url = p === 1 ? base : `${base}page${p}.html`;
    let html;
    try {
      html = await getText(url);
    } catch (e) {
      break;
    }
    const rows = html.match(/<tr id="tr_\d+">[\s\S]*?<\/tr>/g) || [];
    if (!rows.length) break;

    let added = 0;
    for (const row of rows) {
      const idm = /id="tr_(\d+)"/.exec(row);
      const linkm = /href="(\/msg\/[^"]+)"/.exec(row);
      if (!idm || !linkm) continue;
      const id = "ss:" + idm[1];
      if (seenIds.has(id)) continue;

      const cells = [...row.matchAll(/<td class="msga2-o pp6"[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
        stripTags(m[1])
      );
      // Two layouts exist:
      //   district pages (7 cells): [street, rooms, area, floor, series, €/m², price]
      //   all-Riga    (6 cells): [district+street, rooms, area, floor, series, price]
      if (cells.length < 6) continue;
      const seven = cells.length >= 7;
      const priceCell = seven ? cells[6] : cells[5];
      if (isShortTerm(priceCell)) continue; // per-day / per-week pricing

      const descm = /class="am"[^>]*>([\s\S]*?)<\/a>/.exec(row);
      const imgm = /<img[^>]+src="([^"]+)"/.exec(row);
      const district = seven && cfg.category === "centre" ? "Centrs" : districtFromLink(linkm[1]);
      const street = seven ? cells[0] : stripDistrictPrefix(cells[0], district);
      const price = num(priceCell);
      const area = num(cells[2]);

      seenIds.add(id);
      added++;
      out.push({
        source: "ss.lv",
        id,
        url: BASE + linkm[1],
        title: descm ? stripTags(descm[1]) : "",
        rowImage: imgm ? imgm[1] : "",
        street,
        district,
        rooms: num(cells[1]),
        area,
        floor: cells[3],
        floorNum: num(cells[3]),
        series: cells[4],
        pricePerM2: seven
          ? num(cells[5])
          : price != null && area ? Math.round((price / area) * 10) / 10 : null,
        price,
        date: null,
        utilities: "unknown",
        renovation: "unknown",
        furnished: "unknown",
        summerUtil: null,
        winterUtil: null,
        photoRefs: [],
        photoDims: [],
      });
    }
    log(`    page ${p}: ${added} rows (${out.length} total)`);
    if (!added) break;
  }
  return out;
}

// --- deep read --------------------------------------------------------------

async function enrich(listing) {
  const html = await getText(listing.url);

  // "Datums: 01.07.2026 19:42"
  const dm = /Datums:[\s\S]{0,60}?(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})/.exec(html);
  if (dm) {
    const [, dd, mm, yyyy, H, M] = dm;
    listing.date = new Date(+yyyy, +mm - 1, +dd, +H, +M).toISOString();
  }

  const start = html.indexOf('id="msg_div_msg"');
  const body = start >= 0 ? stripTags(html.slice(start, start + 6000)) : "";
  const full = (listing.title || "") + " " + body;

  if (isShortTerm(full)) listing.shortTerm = true;

  listing.utilities = detectUtilities(full);
  const s = (listing.series || "").toLowerCase();
  const seriesReno = /renov|jaun/.test(s) ? "renovated" : /hru[sš][cč]|pa[dt]omju/.test(s) ? "old" : "unknown";
  listing.renovation = mergeReno(seriesReno, detectRenovation(full));
  listing.furnished = detectFurnished(full);
  const su = extractSeasonUtils(full);
  listing.summerUtil = su.summerUtil;
  listing.winterUtil = su.winterUtil;
  listing.description = body.slice(0, 400);

  const g = extractGallery(html);
  listing.photoPrefix = g.prefix;
  listing.photoRefs = g.refs;
  listing.photoDims = g.dims;
  if (!g.refs.length && g.legacy && g.legacy.length) listing.legacyPhotos = g.legacy;

  return listing;
}

async function enrichAll(listings, { concurrency = 4, delayMs = 500, log = () => {} } = {}) {
  let done = 0;
  await pool(
    listings,
    enrich,
    concurrency,
    delayMs,
    (n, total) => {
      done = n;
      if (n % 25 === 0 || n === total) log(`    deep-read ${n}/${total}`);
    }
  );
  return done;
}

module.exports = { collect, enrich, enrichAll, extractGallery, parseMsgImg, galleryPrefix };
