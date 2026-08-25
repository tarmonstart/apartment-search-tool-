"use strict";
// ---------------------------------------------------------------------------
// latio.lv (the Latio agency) — fully server-rendered HTML, no API needed.
//
//   GET /lv/ipasumi?filters[0]=1-755&filters[1]=2216&filters[2]=<place>&p=N
//
//   1-755 = Īrēt/Nomāt (rent) · 2216 = Dzīvokļi (apartments) · 7533 = Centrs.
//   12 cards per page; the total sits in <span class="data__results"><b>N</b>.
//
// Latio publishes no posting dates, so listings arrive with date=null and the
// report shows "—". New-project complex cards link to /lv/jaunie-majokli/…
// instead of /lv/ipasumi/{id}; those are developments, not flats — skipped.
// ---------------------------------------------------------------------------
const { getText, sleep } = require("../http");
const {
  stripTags, num, detectUtilities, detectRenovation, detectFurnished,
} = require("../detect");
const { packGallery } = require("../images");

const BASE = "https://latio.lv";

// place=null drops the location filter entirely (all of Latvia — rows outside
// Rīga are discarded client-side by the ", Rīga" check below).
function listUrl(place, page) {
  return (
    BASE +
    "/lv/ipasumi?filters%5B0%5D=1-755&filters%5B1%5D=2216" +
    (place != null ? "&filters%5B2%5D=" + place : "") +
    "&lang=lv&action=filter&p=" +
    page
  );
}

// "Antonijas iela, Centrs, Rīga" → street + district; the last part is the city
function splitTitle(t) {
  const parts = String(t || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    street: parts[0] || "",
    district: parts.length > 2 ? parts[1] : "Rīga",
    city: parts.length > 1 ? parts[parts.length - 1] : "",
  };
}

async function collect(cfg, { log = () => {} } = {}) {
  // empty places = all of Rīga (no location filter, city checked per row)
  const places = Array.isArray(cfg.places) && cfg.places.length ? cfg.places : [null];
  const out = [];
  const seen = new Set();

  for (const place of places) {
    let scanned = 0;
    for (let p = 1; p <= (cfg.maxPages || 8); p++) {
      let html;
      try {
        html = await getText(listUrl(place, p));
      } catch (e) {
        log(`    place ${place} page ${p}: ${e.message} — stopping this place`);
        break;
      }

      const cards = html.split('class="results__item"').slice(1);
      if (!cards.length) break;

      let added = 0;
      for (const c of cards) {
        const um = /href="(\/lv\/ipasumi\/(\d+))"[^>]*class="results__link"/.exec(c);
        if (!um) continue; // new-project cards link elsewhere — not a flat ad
        const id = "lat:" + um[2];
        if (seen.has(id)) continue;
        seen.add(id);

        const title = (/class="results__title"[^>]*>([^<]+)</.exec(c) || [])[1] || "";
        const loc = (/class="results__location"[^>]*>([^<]+)</.exec(c) || [])[1] || "";
        if (loc && !/Īrēt/i.test(loc)) continue; // belt and braces: rent only

        const priceTxt = (/results__price"[^>]*>\s*([^<]+)</.exec(c) || [])[1] || "";
        // description spans: area, rooms, floor — in that order
        const spans = [...c.matchAll(/<span>\s*([^<]+?)\s*(?:<sup>2<\/sup>\s*)?<\/span>/g)].map((m) =>
          stripTags(m[1])
        );
        let area = null, rooms = null, floor = "", floorNum = null, totalFloors = null;
        for (const s of spans) {
          if (area == null && /m\s*$/.test(s)) area = num(s);
          else if (rooms == null && /^\d+$/.test(s.trim())) rooms = num(s);
          else if (!floor && /^\d+\s*\/\s*\d+$/.test(s.trim())) {
            floor = s.replace(/\s+/g, "");
            const fm = /^(\d+)\/(\d+)$/.exec(floor);
            if (fm) { floorNum = +fm[1]; totalFloors = +fm[2]; }
          }
        }

        const thumbs = [...c.matchAll(/data-src="(\/uploads\/products\/\d+\/th\/[^"]+)"/g)].map(
          (m) => BASE + m[1]
        );
        const { street, district, city } = splitTitle(title);
        if (city && city !== "Rīga") continue; // whole-country query — Rīga only
        const price = num(priceTxt);
        const blurb = stripTags(title + " " + loc);

        added++;
        out.push({
          source: "latio.lv",
          id,
          url: BASE + um[1],
          title,
          street,
          houseNo: null, // list cards omit the house number; the detail page has it
          district,
          rooms,
          area,
          floor,
          floorNum,
          totalFloors,
          series: "",
          renovation: detectRenovation(blurb),
          furnished: detectFurnished(blurb),
          summerUtil: null,
          winterUtil: null,
          pricePerM2: price != null && area ? Math.round((price / area) * 10) / 10 : null,
          price,
          date: null, // latio publishes no dates
          utilities: detectUtilities(blurb),
          description: "",
          photoRefs: packGallery("lat", thumbs).p,
        });
      }
      scanned += cards.length;
      log(`    ${place == null ? "all" : "place " + place} page ${p}: +${added} kept (${out.length} total)`);

      // the advertised total counts every card scanned, not just Rīga ones
      const total = num((/data__results"[^>]*>\s*<b>([\d\s]+)<\/b>/.exec(html) || [])[1]);
      if (total != null && scanned >= total) break;
      if (cards.length < 12) break;
      await sleep(600);
    }
  }
  return out;
}

module.exports = { collect };
