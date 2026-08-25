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
const { getJSON } = require("../http");
const {
  num, detectUtilities, detectRenovation, mergeReno, detectFurnished,
  extractSeasonUtils, isShortTerm,
} = require("../detect");

const API = "https://apipub.pp.lv/lv/api_user/v1/categories";

async function collect(cfg, { log = () => {} } = {}) {
  const out = [];
  const seen = new Set();

  for (const region of cfg.regions) {
    const url =
      `${API}/${cfg.categoryId}/lots` +
      `?region=${region}&action=5&orderColumn=orderDate&orderDirection=DESC`;
    let j;
    try {
      j = await getJSON(url);
    } catch (e) {
      log(`    region ${region}: request failed (${e.message})`);
      continue;
    }
    const arr = j && j.content && j.content.data;
    if (!Array.isArray(arr)) continue;

    let added = 0;
    for (const o of arr) {
      if (!o.action || o.action.id !== 5) continue; // rent only
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
        district: (loc.region && loc.region.name) || "Centrs",
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
    log(`    region ${region}: +${added} (${out.length} total)`);
  }
  return out;
}

module.exports = { collect };
