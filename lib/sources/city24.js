"use strict";
// ---------------------------------------------------------------------------
// city24.lv — public search API. Structured, so most fields arrive clean and
// only the free-text slogans need classifying.
//
// The real listing URL is /real-estate/apartments-for-rent/<slug>/<friendly_id>.
// The slug is cosmetic — the app resolves by the trailing friendly_id — but the
// path must be the PLURAL "apartments-for-rent" with a single combined slug; an
// earlier singular "/riga/centrs/" form silently 404s in a browser.
// ---------------------------------------------------------------------------
const { getJSON } = require("../http");
const { num, detectUtilities } = require("../detect");

const API = "https://api.city24.lv/lv_LV/search/realties";

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[āàá]/g, "a").replace(/[īìí]/g, "i").replace(/[ēèé]/g, "e")
    .replace(/[ūùú]/g, "u").replace(/[ōòó]/g, "o")
    .replace(/[čç]/g, "c").replace(/š/g, "s").replace(/[žź]/g, "z")
    .replace(/[ņň]/g, "n").replace(/ķ/g, "k").replace(/ļ/g, "l").replace(/ģ/g, "g")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function listingUrl(o) {
  const a = o.address || {};
  const slug = slugify(["riga", a.district_name, a.street_name].filter(Boolean).join(" ")) || "riga";
  return `https://www.city24.lv/real-estate/apartments-for-rent/${slug}/${o.friendly_id}`;
}

// The API hands back URLs containing a literal "{fmt:em}" placeholder; the
// number substituted there picks the rendition. We keep only the path stem and
// let the report choose a size, so the grid never pulls the 5 MB rendition the
// old code defaulted to.
function imageRefs(o) {
  const urls = [];
  if (o.main_image && o.main_image.url) urls.push(o.main_image.url);
  for (const x of Array.isArray(o.images) ? o.images : []) {
    const u = typeof x === "string" ? x : x && x.url;
    if (u) urls.push(u);
  }
  const refs = [];
  const seen = new Set();
  for (const u of urls) {
    const m = /\/object\/[^/]+\/(.+?)\.jpg/i.exec(u.replace("{fmt:em}", "21"));
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    refs.push(m[1]);
  }
  return refs;
}

async function collect(cfg, { log = () => {} } = {}) {
  // an empty allowedDistricts list means: keep every Rīga district
  const allow = new Set(cfg.allowedDistricts || []);
  const out = [];
  const seen = new Set();

  for (let p = 1; p <= cfg.maxPages; p++) {
    const url = `${API}?tsType=rent&unitType=Apartment&itemsPerPage=100&page=${p}`;
    let arr;
    try {
      arr = await getJSON(url);
    } catch (e) {
      break;
    }
    if (!Array.isArray(arr) || !arr.length) break;

    let added = 0;
    for (const o of arr) {
      const a = o.address || {};
      if (a.city_name !== "Rīga") continue; // the API leaks other cities
      if (allow.size && !allow.has(a.district_name)) continue;
      const id = "c24:" + o.friendly_id;
      if (seen.has(id)) continue;
      seen.add(id);

      const at = o.attributes || {};
      const floorNum = at.FLOOR != null ? num(at.FLOOR) : null;
      const cond = [].concat(at.CONDITION || [], at.HOUSE_TYPE || []).join(" ");
      const renovation = /renovated|new_building|new_project/.test(cond)
        ? "renovated"
        : /needs|emergency|unfinished/.test(cond)
        ? "old"
        : "unknown";

      // city24 has no free-text description to classify, so utilities almost
      // always come back "unknown". But when it publishes explicit summer and
      // winter communal costs, those are amounts billed ON TOP of the rent —
      // which settles the question for that listing.
      const summerUtil = at.RENT_SUMMER_COMMUNAL_COSTS != null ? num(at.RENT_SUMMER_COMMUNAL_COSTS) : null;
      const winterUtil = at.RENT_WINTER_COMMUNAL_COSTS != null ? num(at.RENT_WINTER_COMMUNAL_COSTS) : null;
      let utilities = detectUtilities(
        [Array.isArray(o.slogans) ? o.slogans.join(" ") : o.slogans, o.project && o.project.name]
          .filter(Boolean)
          .join(" ")
      );
      if (utilities === "unknown" && ((summerUtil || 0) > 0 || (winterUtil || 0) > 0))
        utilities = "excluded";

      added++;
      out.push({
        source: "city24",
        id,
        url: listingUrl(o),
        title: [a.district_name, a.street_name].filter(Boolean).join(", "),
        street: a.street_name || "",
        // city24 publishes the house number as its own field and leaves it out
        // of street_name. De-duplication needs it: without it, two flats on one
        // long street look like the same building.
        houseNo: a.house_number != null ? String(a.house_number).trim() : null,
        district: a.district_name || "",
        rooms: o.room_count != null ? num(o.room_count) : null,
        area: num(o.property_size),
        floor: floorNum != null ? floorNum + (at.TOTAL_FLOORS ? "/" + at.TOTAL_FLOORS : "") : "",
        floorNum,
        totalFloors: at.TOTAL_FLOORS != null ? num(at.TOTAL_FLOORS) : null,
        latitude: o.latitude != null ? Number(o.latitude) : null,
        longitude: o.longitude != null ? Number(o.longitude) : null,
        series: "",
        renovation,
        furnished:
          at.FURNITURE === true ? "furnished" : at.FURNITURE === false ? "unfurnished" : "unknown",
        summerUtil,
        winterUtil,
        pricePerM2: num(o.price_per_unit),
        price: num(o.price),
        date: o.date_published || null,
        utilities,
        description: Array.isArray(o.slogans) ? o.slogans.join(" ").slice(0, 400) : "",
        photoRefs: imageRefs(o),
      });
    }
    log(`    page ${p}: +${added} in centre (${out.length} total)`);
  }
  return out;
}

module.exports = { collect, listingUrl, slugify, imageRefs };
