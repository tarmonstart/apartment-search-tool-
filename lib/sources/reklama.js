"use strict";
// ---------------------------------------------------------------------------
// reklama.lv — classifieds, fully server-rendered HTML.
//
//   GET /riga/nedvizhimost/dzivokli/noma/?c=3054&lt=table&page=N
//
// The table layout carries everything a card needs: address, rooms (prop 3027),
// area (3028), floor (3029), house series (3031), price and a relative date
// ("Šodien", "Vakar", "31.jūlijs"). 20 rows a page, ~40 pages for Rīga.
//
// The per-ad page adds the district ("Stabu iela 38, apgabals Centrs, Rīga"),
// the full description and the whole gallery, so — like ss.lv — the survivors
// of the basic filters get a deep read (enrichAll).
//
// Photos: /files/images/items/{floor(id/1000)}/{id}{size}{hash}.jpg where size
// is s (~5 KB) · m (~23 KB) · v (~128 KB) · z (~270 KB). A ref is "{folder}/{id}|{hash}".
// Many agency ads here are cross-posts of varianti / ss.lv ads; lib/dedupe.js
// folds those together by address, house number, size and text.
// ---------------------------------------------------------------------------
const { getText, sleep, pool } = require("../http");
const {
  stripTags, num, detectUtilities, detectRenovation, detectFurnished,
  extractSeasonUtils, isShortTerm, isRoomRental,
} = require("../detect");
const { packGallery } = require("../images");

const BASE = "https://reklama.lv";
const LIST = BASE + "/riga/nedvizhimost/dzivokli/noma/";

const MONTHS = {
  janvāris: 0, februāris: 1, marts: 2, aprīlis: 3, maijs: 4, jūnijs: 5,
  jūlijs: 6, augusts: 7, septembris: 8, oktobris: 9, novembris: 10, decembris: 11,
};

// "Šodien" / "Vakar" / "31.jūlijs" / "16.oktobris 2025" → ISO date (noon, so a
// timezone shift never moves it a day). Dates without a year that would land in
// the future belong to last year.
function parseDate(s, now = new Date()) {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return null;
  const day = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)).toISOString();
  if (/^šodien/.test(t)) return day(now);
  if (/^vakar/.test(t)) return day(new Date(now.getTime() - 864e5));
  const m = /^(\d{1,2})\.\s*([a-zāčēģīķļņšūž]+)(?:\s+(\d{4}))?/.exec(t);
  if (!m || MONTHS[m[2]] == null) return null;
  let y = m[3] ? +m[3] : now.getUTCFullYear();
  let d = new Date(Date.UTC(y, MONTHS[m[2]], +m[1], 12));
  if (!m[3] && d.getTime() > now.getTime() + 864e5) d = new Date(Date.UTC(y - 1, MONTHS[m[2]], +m[1], 12));
  return d.toISOString();
}

function photoRef(url) {
  const m = /\/files\/images\/items\/(\d+)\/(\d+)[smvz]([0-9a-f]{6,})\.jpe?g/i.exec(url || "");
  return m ? `${m[1]}/${m[2]}|${m[3]}` : null;
}

// "Stabu iela 38" → street + house number
function splitStreet(addr) {
  const a = String(addr || "").trim();
  const m = /^(.*?\D)\s+(\d+[a-zA-Z]?)(?:\s*[-/]\s*\d+)?$/.exec(a);
  return m ? { street: m[1].trim(), houseNo: m[2] } : { street: a, houseNo: null };
}

function parseRows(html) {
  const rows = html.split('class="j-item it-table-item" data-id="').slice(1);
  const out = [];
  for (const r of rows) {
    const id = (/^(\d+)/.exec(r) || [])[1];
    if (!id) continue;
    const url = (/href="(https:\/\/reklama\.lv\/[^"]+-\d+\.html)"/.exec(r) || [])[1];
    if (!url || !/\/noma\//.test(url)) continue;
    const title = stripTags((/class="it-item-title"[^>]*>([\s\S]*?)<\/a>/.exec(r) || [])[1] || "");
    const addr = stripTags((/class="addr[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(r) || [])[1] || "");
    const prop = (pid) =>
      stripTags((new RegExp(`it-col-prop-${pid}"[^>]*>([\\s\\S]*?)</td>`).exec(r) || [])[1] || "");
    const priceTxt = stripTags((/class="it-price"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/.exec(r) || [])[1] || "");
    const dateTxt = stripTags((/class="it-date[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(r) || [])[1] || "");
    const img = (/<img class="it-img"\s+src="([^"]+)"/.exec(r) || [])[1];
    out.push({ id, url, title, addr, rooms: prop(3027), area: prop(3028), floor: prop(3029), series: prop(3031), priceTxt, dateTxt, img });
  }
  return out;
}

async function collect(cfg, { log = () => {} } = {}) {
  const out = [];
  const seen = new Set();
  for (let p = 1; p <= (cfg.maxPages || 60); p++) {
    let html;
    try {
      html = await getText(`${LIST}?c=3054&lt=table&page=${p}`, { timeout: 30000 });
    } catch (e) {
      log(`    page ${p}: ${e.message} — stopping`);
      break;
    }
    const rows = parseRows(html);
    if (!rows.length) break;
    let added = 0;
    for (const r of rows) {
      const id = "rek:" + r.id;
      if (seen.has(id)) continue;
      seen.add(id);
      // per day / per week prices are short stays, not tenancies
      if (/dien|nedēļ|сутк|день/i.test(r.priceTxt)) continue;
      const price = num(r.priceTxt);
      const area = num(r.area);
      const floorNum = num(r.floor);
      const { houseNo } = splitStreet(r.addr);
      const ref = photoRef(r.img);
      added++;
      out.push({
        source: "reklama.lv",
        id,
        url: r.url,
        title: r.title,
        street: r.addr,
        houseNo,
        district: "Rīga", // the ad page names it; filled by enrich()
        rooms: num(r.rooms),
        area,
        floor: floorNum != null ? String(floorNum) : "",
        floorNum,
        totalFloors: null,
        series: r.series,
        pricePerM2: price != null && area ? Math.round((price / area) * 10) / 10 : null,
        price,
        date: parseDate(r.dateTxt),
        utilities: detectUtilities(r.title),
        renovation: detectRenovation(r.title + " " + r.series),
        furnished: detectFurnished(r.title),
        summerUtil: null,
        winterUtil: null,
        description: r.title,
        photoRefs: ref ? [ref] : [],
      });
    }
    log(`    page ${p}: +${added} (${out.length} total)`);
    if (rows.length < 20) break;
    await sleep(cfg.delayMs || 700);
  }
  return out;
}

// Per-ad read: district, full text, the whole gallery, total floors, and the
// "Publicēts" date (the list only shows the last update).
async function enrich(l) {
  const html = await getText(l.url, { timeout: 30000 });
  const addr = stripTags((/class="vw-address-val">([\s\S]*?)<\/span>/.exec(html) || [])[1] || "");
  const dm = /apgabals\s+([^,]+)/i.exec(addr);
  if (dm) l.district = dm[1].trim();
  const props = {};
  for (const m of html.matchAll(/vw-dynprops-item-attr">([\s\S]*?)<\/span>\s*<span class="vw-dynprops-item-val">([\s\S]*?)<\/span>/g))
    props[stripTags(m[1]).replace(/:$/, "")] = stripTags(m[2]);
  if (props["Stāvu skaits"]) {
    l.totalFloors = num(props["Stāvu skaits"]);
    if (l.floorNum != null && l.totalFloors) l.floor = l.floorNum + "/" + l.totalFloors;
  }
  const desc = stripTags((/id="j-descr"[^>]*>([\s\S]*?)<\/div>/.exec(html) || [])[1] || "");
  if (desc) {
    const text = l.title + " " + desc;
    if (isShortTerm(text)) l.shortTerm = true;
    if (isRoomRental(text)) l.roomRental = true;
    l.description = desc.slice(0, 400);
    l.utilities = detectUtilities(text);
    l.renovation = detectRenovation(text + " " + l.series);
    l.furnished = detectFurnished(text);
    const su = extractSeasonUtils(text);
    l.summerUtil = su.summerUtil;
    l.winterUtil = su.winterUtil;
  }
  const pub = /Publicēts:\s*([^<]+)</.exec(html);
  if (pub) l.date = parseDate(pub[1]) || l.date;
  const urls = [...html.matchAll(/\/files\/images\/items\/\d+\/\d+z[0-9a-f]+\.jpe?g/gi)].map((m) => m[0]);
  const refs = packGallery("rek", urls).p;
  if (refs.length) l.photoRefs = refs;
  return l;
}

async function enrichAll(listings, { concurrency = 3, delayMs = 600, log = () => {} } = {}) {
  await pool(listings, enrich, concurrency, delayMs, (d, n) => {
    if (d % 50 === 0 || d === n) log(`    reklama deep-read ${d}/${n}`);
  });
}

module.exports = { collect, enrich, enrichAll, parseDate, parseRows, photoRef, splitStreet };
