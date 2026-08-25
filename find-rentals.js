#!/usr/bin/env node
"use strict";
// ---------------------------------------------------------------------------
// Rīga centre rental finder.
//
//   node find-rentals.js            normal run
//   node find-rentals.js --fast     skip the ss.lv deep read (quicker, shallower)
//   node find-rentals.js --report   rebuild the report from the last run's cache,
//                                   without touching the network
//
// Pipeline: collect → pre-filter → deep-read ss.lv → final filter → collapse
// duplicates → carry user verdicts across the merge → write listings.html + .csv
//
// Everything tunable lives in config.json. The scraping specifics live in
// lib/sources/*.js; the parts most likely to need a tweak when a site changes
// its markup are documented there.
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const STATE_DIR = path.join(ROOT, "state");
const SEEN_FILE = path.join(STATE_DIR, "seen.json");
const CACHE_FILE = path.join(STATE_DIR, "last-run.json");

const sslv = require("./lib/sources/sslv");
const city24 = require("./lib/sources/city24");
const pplv = require("./lib/sources/pplv");
const varianti = require("./lib/sources/varianti");
const latio = require("./lib/sources/latio");
const arcoreal = require("./lib/sources/arcoreal");
const { dedupe } = require("./lib/dedupe");
const { geocodeAll } = require("./lib/geocode");
const { loadUserState, saveUserState, spreadVerdicts, countVerdicts } = require("./lib/state");
const { writeHTML, writeCSV } = require("./lib/report");

const ARGS = new Set(process.argv.slice(2));
const FAST = ARGS.has("--fast");
const REPORT_ONLY = ARGS.has("--report");

const log = (s) => console.log(s);
const t0 = Date.now();

// --- filtering --------------------------------------------------------------

const ABS_MAX_PRICE = Math.max(CONFIG.maxPrice, CONFIG.maxPriceWithUtilities || 0);
const priceCap = (l) =>
  l.utilities === "included" ? CONFIG.maxPriceWithUtilities || CONFIG.maxPrice : CONFIG.maxPrice;

function passesBase(l) {
  if (l.rooms != null && !CONFIG.allowedRooms.includes(l.rooms)) return false;
  if (CONFIG.minArea && l.area != null && l.area < CONFIG.minArea) return false;
  if (CONFIG.excludeFirstFloor && l.floorNum === 1) return false;
  if (CONFIG.excludeOld && l.renovation === "old") return false;
  if (CONFIG.requireRenovated && l.renovation !== "renovated") return false;
  return true;
}

// Before the deep read we do not yet know whether utilities are included, so we
// admit anything under the higher cap and tighten up afterwards.
function preFilter(l) {
  if (l.price == null) return false;
  if (l.price < CONFIG.minPrice || l.price > ABS_MAX_PRICE) return false;
  return passesBase(l);
}

function finalFilter(l) {
  if (l.shortTerm) return false;
  if (l.price == null) return false;
  if (l.price < CONFIG.minPrice || l.price > priceCap(l)) return false;
  if (CONFIG.requireUtilitiesIncluded && l.utilities !== "included") return false;
  return passesBase(l);
}

function sortListings(list) {
  const utilRank = { included: 0, unknown: 1, excluded: 2 };
  const renoRank = { renovated: 0, unknown: 1, old: 2 };
  list.sort((a, b) => {
    if (CONFIG.utilitiesPriority) {
      const u = utilRank[a.utilities] - utilRank[b.utilities];
      if (u) return u;
    }
    if (CONFIG.renovatedPriority) {
      const r = renoRank[a.renovation] - renoRank[b.renovation];
      if (r) return r;
    }
    const ap = a.rooms === CONFIG.preferredRooms ? 0 : 1;
    const bp = b.rooms === CONFIG.preferredRooms ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0);
  });
}

// --- seen tracking ----------------------------------------------------------

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSeen(seen, ids) {
  const now = new Date().toISOString();
  for (const id of ids) if (!seen[id]) seen[id] = now;
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  for (const [id, ts] of Object.entries(seen)) if (Date.parse(ts) < cutoff) delete seen[id];
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
}

// --- collection -------------------------------------------------------------

// One source failing must not take the whole run with it. That matters most
// when this runs unattended in the cloud: a site that blocks datacenter IPs, or
// simply changes its markup, should cost its own listings and nothing else.
async function collectOne(name, mod, cfg, all, tally, failed) {
  log("\n  " + name);
  try {
    const r = await mod.collect(cfg, { log });
    tally.push([name, r.length]);
    all.push(...r);
  } catch (e) {
    failed.push(name);
    tally.push([name, 0]);
    log("    FAILED: " + (e && e.message ? e.message : e) + " — carrying on without it");
  }
}

async function collectAll() {
  const all = [];
  const tally = [];
  const failed = [];

  const sources = [
    ["ss.lv", sslv, CONFIG.sslv],
    ["city24", city24, CONFIG.city24],
    ["pp.lv", pplv, CONFIG.pplv],
    ["varianti.lv", varianti, CONFIG.varianti],
    ["latio.lv", latio, CONFIG.latio],
    ["arcoreal.lv", arcoreal, CONFIG.arcoreal],
  ];
  for (const [name, mod, cfg] of sources)
    if (cfg && cfg.enabled) await collectOne(name, mod, cfg, all, tally, failed);

  log("\n  collected: " + tally.map(([s, n]) => `${s} ${n}`).join(" · ") + ` = ${all.length}`);
  if (failed.length) log("  sources that failed this run: " + failed.join(", "));
  return { all, tally, failed };
}


// ---------------------------------------------------------------------------

(async () => {
  log("Rīga centre rental finder");

  // Verdicts first: loadUserState() also hoovers up any user-state*.json the
  // report has exported since the last run, so a fresh export in Downloads is
  // picked up automatically rather than quietly ignored.
  log("\n  reading your saved picks…");
  const userState = loadUserState(ROOT, { log });
  const before = countVerdicts(userState.pile);
  log(
    `  ${Object.keys(userState.pile).length} verdicts on file ` +
      `(${before.like} liked · ${before.maybe} maybe · ${before.discard} discarded), ` +
      `${userState.visited.length} visited`
  );

  let list;
  let failedSources = [];
  let sourcesLine = "ss.lv · city24.lv · pp.lv · varianti.lv · latio.lv · arcoreal.lv";

  if (REPORT_ONLY) {
    log("\n  --report: rebuilding from state/last-run.json, no network");
    list = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } else {
    const collected = await collectAll();
    list = collected.all;
    failedSources = collected.failed || [];
    sourcesLine = collected.tally.map(([s]) => s).join(" · ");

    const beforePre = list.length;
    list = list.filter(preFilter);
    log(`  ${list.length} pass the basic filters (dropped ${beforePre - list.length})`);

    if (!FAST && CONFIG.deepCheckUtilities) {
      const targets = list.filter((l) => l.source === "ss.lv");
      if (targets.length) {
        log(`\n  reading ${targets.length} ss.lv ads for dates, utilities and full galleries…`);
        await sslv.enrichAll(targets, {
          concurrency: CONFIG.concurrency || 4,
          delayMs: CONFIG.requestDelayMs || 500,
          log,
        });
      }
    } else {
      log("\n  --fast: skipping the ss.lv deep read (no dates, shallow galleries)");
    }

    const beforeFinal = list.length;
    list = list.filter(finalFilter);
    log(`  ${list.length} pass the full filters (dropped ${beforeFinal - list.length})`);

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(list));
  }

  // same ad crawled twice in one run
  const byId = new Map();
  for (const l of list) if (!byId.has(l.id)) byId.set(l.id, l);
  list = [...byId.values()];

  // the same physical flat posted on several sites, or re-posted on one
  const beforeDedupe = list.length;
  const dedupeReport = dedupe(list, CONFIG.dedupe || {});
  list = dedupeReport.listings;
  const merged = beforeDedupe - list.length;
  log(
    `\n  collapsed ${merged} duplicate post${merged === 1 ? "" : "s"} ` +
      `into ${dedupeReport.clusters} flat${dedupeReport.clusters === 1 ? "" : "s"}`
  );
  for (const m of dedupeReport.examples.slice(0, 6)) log("    " + m);

  // Coordinates for the map: city24 brings its own; the rest are geocoded via
  // Nominatim behind a persistent cache. --report stays offline (cache only).
  if (!CONFIG.geocode || CONFIG.geocode.enabled !== false) {
    log("");
    await geocodeAll(list, ROOT, CONFIG.geocode || {}, { log, network: !REPORT_ONLY });
  }

  // Carry each verdict onto every id in its cluster, so collapsing posts can
  // never orphan a decision the user made about one of them.
  const healed = spreadVerdicts(list, userState);
  if (healed) log(`  carried ${healed} verdict${healed === 1 ? "" : "s"} across merged posts`);

  const seen = loadSeen();
  for (const l of list) l.isNew = !(l.ids || [l.id]).some((id) => seen[id]);
  const nnew = list.filter((l) => l.isNew).length;

  sortListings(list);

  const photos = list.reduce((s, l) => s + (l.photoRefs || []).length, 0);
  const withPhotos = list.filter((l) => (l.photoRefs || []).length).length;

  const meta = {
    generated: new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
    total: list.length,
    nnew,
    merged,
    photos,
    preferredRooms: CONFIG.preferredRooms,
    sources: sourcesLine,
  };

  if (!list.length) {
    log("\n  ABORT: the crawl produced no listings at all — refusing to " +
        "overwrite the existing report with an empty one. Nothing was changed.");
    process.exit(2);
  }

  const csvPath = writeCSV(ROOT, list);
  const htmlPath = writeHTML(ROOT, list, meta, userState);
  // --report only re-renders what the last crawl already found, so recording
  // these ids as seen would wipe the "new" markers the real run just produced.
  if (!REPORT_ONLY) saveSeen(seen, list.flatMap((l) => l.ids || [l.id]));
  saveUserState(ROOT, userState);

  const after = countVerdicts(userState.pile);
  log(
    `\n  ${list.length} flats · ${nnew} new · ${photos.toLocaleString("en-GB")} photos ` +
      `(${withPhotos}/${list.length} have any)`
  );
  log(
    `  verdicts kept: ${after.like} liked · ${after.maybe} maybe · ${after.discard} discarded`
  );
  if (failedSources.length)
    log(`\n  WARNING: ${failedSources.join(", ")} returned nothing this run — ` +
        "their listings are missing from this report.");
  log(`\n  report: ${htmlPath}`);
  log(`  csv:    ${csvPath}`);
  log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => {
  console.error("\nERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
