"use strict";
// ---------------------------------------------------------------------------
// pp.lv — public apipub JSON API.
//
// action=5 means "Izīrē" (rent). The category endpoint returns roughly the 20
// newest lots per region and exposes no deeper paging, so coverage here is
// shallow by design; widen it by adding region ids to config, not by paging.
//
// Photos: o.files[] is complete — its length matches the API's own fileCount on
// every lot sampled, and matches the single-lot detail endpoint exactly. Only
// the URL was wrong before: the size segment is a fixed whitelist and the old
// "21" is not in it, so the server fell back to the full original every time.
// See lib/images.js for the whitelist and the Accept-header caveat.
// ---------------------------------------------------------------------------
const { getJSON, sleep } = require("../http");

const loc0 = (o) => {
  const r = o.publicLocation && o.publicLocation.region;
  return r && r.parent ? r.parent.name : r ? r.name : null;
};
const {
  num, detectUtilities, detectRenovation, mergeReno, detectFurnished,
  extractSeasonUtils, isShortTerm,
} = require("../detect");

const API = "https://apipub.pp.lv/lv/api_user/v1/categories";

async function collect(cfg, { log = () => {} } = {}) {
  const out = [];
  const seen = new Set();

  // The lots endpoint pages with `currentPage` (20 per page) and reports the
  // total in content.count. Region 85 is Rīga as a whole — the old setup asked
  // seven district ids for page 1 only and saw ~50 of the ~230 Rīga rentals.
  const regions = Array.isArray(cfg.regions) && cfg.regions.length ? cfg.regions : [85];
  const maxPages = cfg.maxPages || 25;
  const jobs = [];
  for (const region of regions) for (let p = 1; p <= maxPages; p++) jobs.push([region, p]);

  let stopRegion = null;
  for (const [region, page] of jobs) {
    if (stopRegion === region) continue;
    const url =
      `${API}/${cfg.categoryId}/lots` +
      `?region=${region}&action=5&orderColumn=orderDate&orderDirection=DESC&currentPage=${page}`;
    let j;
    try {
      j = await getJSON(url, { timeout: 30000 });
    } catch (e) {
      log(`    region ${region} page ${page}: request failed (${e.message})`);
      stopRegion = region;
      continue;
    }
    const arr = j && j.content && j.content.data;
    if (!Array.isArray(arr) || !arr.length) { stopRegion = region; continue; }

    let added = 0;
    for (const o of arr) {
      if (!o.action || o.action.id !== 5) continue; // rent only
      const par = loc0(o);
      if (par && par !== "Rīga") continue; // the API leaks the suburbs
      const monthly = (o.prices || []).find((p) => p.priceType && p.priceType.id === 5);
      if (!monthly) continue; // no monthly price => not a normal tenancy
      const id = "pp:" + o.id;
      if (seen.has(id)) continue;

      const findF = (name) => (o.adFilterValues || []).find((x) => x.filter && x.filter.name === name);
      const fv = (name) => {
        const f = findF(name);
        return f ? f.textValue : null;
      };
      const fvLabel = (name) => {
        const f = findF(name);
        return f ? (f.value && f.value.displayValue) || f.textValue || "" : "";
      };

      const bodyText = (o.title || "") + " " + (o.adTexts || []).map((t) => t.text || "").join(" ");
      if (isShortTerm(bodyText)) continue;

      const floorNum = num(fv("Stāvs"));
      const totalFloors = fv("Stāvu skaits");
      const loc = o.publicLocation || {};
      const condL = (fvLabel("Īpašuma stāvoklis") + " " + fvLabel("Mājas sērija")).toLowerCase();
      const condReno = /(p[eē]c\s+.*remont)|(jaun\w*\s+projekt)/.test(condL)
        ? "renovated"
        : /(vajag|nepiecie)/.test(condL)
        ? "old"
        : "unknown";
      const su = extractSeasonUtils(bodyText);

      // files[] is already ordered, and o.thumbnail duplicates files[0].
      const refs = [];
      const seenRef = new Set();
      for (const f of Array.isArray(o.files) ? o.files : []) {
        const file = f && f.file;
        if (!file || file.outputType !== "image" || !file.storageId) continue;
        if (seenRef.has(file.storageId)) continue;
        seenRef.add(file.storageId);
        refs.push(file.storageId);
      }

      seen.add(id);
      added++;
      out.push({
        source: "pp.lv",
        id,
        url: o.frontUrl,
        title: o.title || "",
        street: loc.address || (loc.street && loc.street.name) || "",
        houseNo: loc.building && loc.building.number ? String(loc.building.number) : null,
        district: (loc.region && loc.region.name) || "Rīga",
        // pp.lv publishes exact coordinates (coordinateX is the latitude)
        latitude: loc.accurateCoordinates && loc.coordinateX ? Number(loc.coordinateX) : null,
        longitude: loc.accurateCoordinates && loc.coordinateY ? Number(loc.coordinateY) : null,
        rooms: num(fv("Istabu skaits")),
        area: num(fv("Platība, m2")),
        floor: floorNum != null ? floorNum + (totalFloors ? "/" + totalFloors : "") : "",
        floorNum,
        totalFloors: num(totalFloors),
        series: fvLabel("Mājas sērija"),
        pricePerM2: null,
        price: num(monthly.value),
        date: o.publishDate || o.createDate || null,
        utilities: detectUtilities(bodyText),
        renovation: mergeReno(condReno, detectRenovation(bodyText)),
        furnished: detectFurnished(bodyText),
        summerUtil: su.summerUtil,
        winterUtil: su.winterUtil,
        description: (o.adTexts || []).map((t) => t.text || "").join(" ").slice(0, 400),
        photoRefs: refs,
      });
    }
    log(`    region ${region} page ${page}: +${added} (${out.length} total)`);
    if (arr.length < 20) stopRegion = region;
    await sleep(cfg.delayMs || 500);
  }
  return out;
}

module.exports = { collect };
