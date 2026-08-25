"use strict";
// ---------------------------------------------------------------------------
// arcoreal.lv (Arco Real Estate) — server-rendered HTML.
//
//   GET /lv/dzivojamas-platibas/dzivokli/izire/riga/{place}/cena-no-n-lidz-n-eur-
//       platiba-no-n-lidz-n-istabas-no-n-lidz-n-stavs-no-n-lidz-n/[lapa-N/]
//
// 12 cards per page. Only the card data is read (no per-ad deep fetch), so each
// listing carries one thumbnail and no posting date. The card block ends at the
// "pagination-centered" div — everything after it is "recently viewed" carousels
// that would double-count listings.
// ---------------------------------------------------------------------------
const { getText, sleep } = require("../http");
const { stripTags, num, detectUtilities, detectRenovation, detectFurnished } = require("../detect");
const { packGallery } = require("../images");

const BASE = "https://www.arcoreal.lv";

function listUrl(place, page) {
  return (
    BASE +
    `/lv/dzivojamas-platibas/dzivokli/izire/riga/${place}/` +
    "cena-no-n-lidz-n-eur-platiba-no-n-lidz-n-istabas-no-n-lidz-n-stavs-no-n-lidz-n/" +
    (page > 1 ? `lapa-${page}/` : "")
  );
}

const CARD_RE =
  /<a href="(lv\/(\d+)\/)" target="_blank" class="small-12[^>]*>\s*<div class="list-thumb"><div style="background-image:url\(([^)]+)\)[\s\S]*?<\/div><\/div>\s*([^<]+)<br \/>\s*<div class="thumbs-smalltext">\s*([\s\S]*?)<\/div>\s*<span class="thumbs-largetext">([^<]+)<\/span>\s*<span class="thumbs-smalltext">([^<]+)<\/span>/g;

async function collect(cfg, { log = () => {} } = {}) {
  const places = Array.isArray(cfg.places) && cfg.places.length ? cfg.places : ["centrs"];
  const out = [];
  const seen = new Set();

  for (const place of places) {
    let maxPage = 1;
    for (let p = 1; p <= Math.min(maxPage, cfg.maxPages || 8); p++) {
      let html;
      try {
        html = await getText(listUrl(place, p));
      } catch (e) {
        log(`    ${place} page ${p}: ${e.message} — stopping this place`);
        break;
      }
      // cut before the carousels that repeat listings
      const cut = html.indexOf("pagination-centered");
      const zone = cut > 0 ? html.slice(0, cut) : html;
      const pager = cut > 0 ? html.slice(cut, cut + 4000) : "";
      for (const pm of pager.matchAll(/lapa-(\d+)\//g)) maxPage = Math.max(maxPage, +pm[1]);

      let added = 0;
      for (const m of zone.matchAll(CARD_RE)) {
        const [, rel, rawId, thumb, streetRaw, metaRaw, priceRaw, unitRaw] = m;
        if (!/mēn/i.test(unitRaw)) continue; // monthly rent only, not per-day
        const id = "arc:" + rawId;
        if (seen.has(id)) continue;
        seen.add(id);

        const street = stripTags(streetRaw).trim();
        const meta = stripTags(metaRaw).replace(/\s+/g, " ").trim();
        const rooms = num((/(\d+)\s*ist\./.exec(meta) || [])[1]);
        const fm = /(\d+)\s*no\s*(\d+)\s*st\./.exec(meta);
        const area = num((/(\d+(?:[.,]\d+)?)\s*m\s*2?\s*$/.exec(meta) || /(\d+(?:[.,]\d+)?)\s*m/.exec(meta) || [])[1]);
        const price = num(priceRaw);
        const districtM = /R[īi]ga,\s*([^,\d]+?)(?:\s+\d|$)/.exec(meta);

        added++;
        out.push({
          source: "arcoreal.lv",
          id,
          url: BASE + "/" + rel,
          title: street + " · " + meta,
          street,
          houseNo: null,
          district: districtM ? districtM[1].trim() : "Centrs",
          rooms,
          area,
          floor: fm ? fm[1] + "/" + fm[2] : "",
          floorNum: fm ? +fm[1] : null,
          totalFloors: fm ? +fm[2] : null,
          series: "",
          renovation: detectRenovation(meta),
          furnished: detectFurnished(meta),
          summerUtil: null,
          winterUtil: null,
          pricePerM2: price != null && area ? Math.round((price / area) * 10) / 10 : null,
          price,
          date: null, // list cards carry no dates
          utilities: detectUtilities(meta),
          description: "",
          photoRefs: packGallery("arc", [thumb.replace(/^['"]|['"]$/g, "")].map((u) =>
            /^https?:/i.test(u) ? u : BASE + (u.startsWith("/") ? "" : "/") + u
          )).p,
        });
      }
      log(`    ${place} page ${p}: +${added} (${out.length} total)`);
      if (!added) break;
      await sleep(600);
    }
  }
  return out;
}

module.exports = { collect };
