"use strict";
// ---------------------------------------------------------------------------
// varianti.lv — public JSON API (also the backend of cityreal.lv, which is just
// a frontend shell over the same data, so this one collector covers both).
//
//   POST https://api.varianti.lv/rest/list/ad   { page, size, filters, order }
//
// Notes that cost real debugging to learn (all verified against the live API):
//   * filter values are string KEYS ("rent", "flat") — numeric ids make the
//     backend throw HTTP 500
//   * `page` is 0-based; `size` is free (100 covers Centrs in two pages)
//   * title fields carry mojibake for Latvian/Russian text — address_name and
//     description_lv are clean, so those are what we read
//   * deal_type "rent" is long-term only; short-term is its own key
//   * items carry latitude/longitude directly — no geocoding needed
// ---------------------------------------------------------------------------
const { postJSON, sleep } = require("../http");
const {
  stripTags, num, detectUtilities, detectRenovation, detectFurnished,
  extractSeasonUtils,
} = require("../detect");
const { packGallery } = require("../images");

const API = "https://api.varianti.lv/rest/list/ad";
const RIGA_CITY = 50; // address catalog id, verified via /rest/address/district

// "Rīga, Ausekļa iela, 11" / "Rīga, Ausekļa iela, 11-3" → street + house number
function splitAddress(name) {
  const parts = String(name || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length && /^r[īi]ga$/i.test(parts[0])) parts.shift();
  let houseNo = null;
  if (parts.length > 1 && /^\d+[a-zA-Z]?(?:-\d+)?$/.test(parts[parts.length - 1])) {
    houseNo = parts.pop().replace(/-\d+$/, ""); // drop the apartment part
  }
  return { street: parts.join(", "), houseNo };
}

// district id → Latvian name, from the site's own catalog. Fetched once per
// run; an empty map just means district names stay blank (never fatal).
async function districtNames() {
  try {
    const d = await postJSON("https://api.varianti.lv/rest/address/district", {});
    const arr = Array.isArray(d.result) ? d.result : (d.result && d.result.list) || [];
    const map = {};
    for (const x of arr) if (x && x.id != null && x.value) map[x.id] = x.value;
    return map;
  } catch {
    return {};
  }
}

async function collect(cfg, { log = () => {} } = {}) {
  // an empty districts list = the whole of Rīga (no address_district filter)
  const districts = Array.isArray(cfg.districts) && cfg.districts.length ? cfg.districts : [null];
  const dNames = await districtNames();
  const out = [];
  const seen = new Set();

  for (const district of districts) {
    for (let page = 0; page < (cfg.maxPages || 5); page++) {
      const filters = {
        address_country: 1,
        address_city: RIGA_CITY,
        deal_type: "rent",
        category_type: "flat",
        features: [],
        is_promoted: false,
      };
      if (district != null) filters.address_district = district;
      let res;
      try {
        res = await postJSON(API, {
          page,
          size: 100,
          filters,
          order: { field: "DATE", asc: "false" },
        });
      } catch (e) {
        log(`    district ${district == null ? "all" : district} page ${page}: ${e.message} — stopping`);
        break;
      }
      const list = res && res.result && Array.isArray(res.result.list) ? res.result.list : [];
      if (!list.length) break;

      let added = 0;
      for (const it of list) {
        if (it.status && it.status !== "ACTIVE") continue;
        const id = "var:" + it.id;
        if (seen.has(id)) continue;
        seen.add(id);

        const o = it.object || {};
        const { street, houseNo } = splitAddress(it.address_name);
        const desc = stripTags(o.description_lv || o.description_ru || o.description_en || "");
        const floorNum = o.floor != null ? num(o.floor) : null;
        const totalFloors = o.floors_count != null ? num(o.floors_count) : null;
        const price = num(o.price);
        const area = num(o.area);
        const su = extractSeasonUtils(desc);

        added++;
        out.push({
          source: "varianti.lv",
          id,
          url: "https://www.varianti.lv" + ((it.meta && it.meta.hreflang_lv) || "/lv/dzivokli/" + it.id),
          title: [street, houseNo].filter(Boolean).join(" "),
          street,
          houseNo,
          district: dNames[it.address && it.address.district_id] || "Rīga",
          rooms: o.rooms_count != null ? num(o.rooms_count) : null,
          area,
          floor: floorNum != null ? floorNum + (totalFloors ? "/" + totalFloors : "") : "",
          floorNum,
          totalFloors,
          latitude: it.latitude != null ? Number(it.latitude) : null,
          longitude: it.longitude != null ? Number(it.longitude) : null,
          series: "",
          renovation: detectRenovation(desc),
          furnished: detectFurnished(desc),
          summerUtil: su.summerUtil,
          winterUtil: su.winterUtil,
          pricePerM2: price != null && area ? Math.round((price / area) * 10) / 10 : null,
          price,
          date: o.date_update || o.date_create
            ? new Date(o.date_update || o.date_create).toISOString()
            : null,
          utilities: detectUtilities(desc),
          description: desc.slice(0, 400),
          photoRefs: packGallery("var", (it.images || []).map((im) => im && (im.original || im.small)).filter(Boolean)).p,
        });
      }
      log(`    ${district == null ? "all Rīga" : "district " + district} page ${page + 1}: +${added} (${out.length} total)`);
      const pages = res.result && res.result.pages;
      if (pages != null && page + 1 >= pages) break;
      await sleep(600);
    }
  }
  return out;
}

module.exports = { collect, splitAddress };
