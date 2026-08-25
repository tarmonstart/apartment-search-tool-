"use strict";
// ---------------------------------------------------------------------------
// Durable user state: the like / maybe / discard verdicts and the visited set.
//
// This is the one thing in the project that CANNOT be regenerated — listings can
// always be re-scraped, but hand-sorting 300 flats cannot. So it is defended in
// depth:
//
//   1. Every run adopts any newer `user-state*.json` export it can find (the
//      report's Export button drops these in Downloads), unions them into the
//      canonical state/user-state.json, and bakes the result into the report.
//   2. Every run snapshots the canonical file into state/backups/history/.
//   3. Verdicts follow a flat across de-duplication: see spreadVerdicts().
//
// Why (1) exists: the File System Access API is unavailable on file:// origins,
// so the report's "sync to disk" cannot work when the HTML is opened directly.
// Export → next run picks it up is the path that actually works.
// ---------------------------------------------------------------------------
const fs = require("fs");
const os = require("os");
const path = require("path");

const VERDICTS = new Set(["like", "maybe", "discard"]);

function readState(file) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d || typeof d !== "object") throw new Error("not an object");
  const pile = {};
  if (d.pile && typeof d.pile === "object")
    for (const [id, v] of Object.entries(d.pile)) if (VERDICTS.has(v)) pile[id] = v;
  // legacy format: { liked: [ids] }
  if (Array.isArray(d.liked)) for (const id of d.liked) if (!pile[id]) pile[id] = "like";
  const visited = Array.isArray(d.visited) ? d.visited.filter((x) => typeof x === "string") : [];
  // Ids the user deliberately un-tagged. Without this, "absence is not deletion"
  // means a verdict can never be taken back: the old value simply returns from
  // the canonical file on the next run, for ever.
  const cleared = Array.isArray(d.cleared) ? d.cleared.filter((x) => typeof x === "string") : [];
  return { pile, visited, cleared };
}

// Places the user's browser realistically drops an exported state file.
function candidateFiles(root) {
  const home = os.homedir();
  const dirs = [
    path.join(root, "state"),
    root,
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
  ];
  const out = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      // user-state.json, "user-state (1).json", user-state-backup.json …
      if (!/^user-state.*\.json$/i.test(n)) continue;
      const f = path.join(dir, n);
      try {
        const st = fs.statSync(f);
        if (st.isFile()) out.push({ file: f, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

// Union every source, oldest first, so the newest file wins any conflict.
// Absence is never a deletion — an id missing from a newer export does NOT
// clear a verdict recorded in an older one. Losing a verdict is the failure
// mode we care about; a stale verdict is merely re-clickable.
function loadUserState(root, { log = () => {} } = {}) {
  const stateDir = path.join(root, "state");
  const canonical = path.join(stateDir, "user-state.json");
  fs.mkdirSync(stateDir, { recursive: true });

  let canonicalMtime = 0;
  try {
    canonicalMtime = fs.statSync(canonical).mtimeMs;
  } catch {}

  // Only adopt an external export if it is NEWER than what we already have.
  // Without this, an ancient export in Downloads would resurrect verdicts the
  // user has since cleared, every single run.
  const sources = candidateFiles(root)
    .filter((s) => path.resolve(s.file) === path.resolve(canonical) || s.mtime > canonicalMtime)
    .sort((a, b) => a.mtime - b.mtime);

  const pile = {};
  const visited = new Set();
  const cleared = new Set();
  const adopted = [];
  for (const s of sources) {
    let d;
    try {
      d = readState(s.file);
    } catch (e) {
      // Never swallow this. A file that fails to parse may be the newest record
      // of the user's decisions — half-written, locked by a sync client, saved
      // in the wrong encoding — and silently skipping it looks identical to
      // there being nothing there.
      log(`  WARNING: could not read ${s.file} (${e.message}) — skipped, nothing lost from it`);
      continue;
    }
    const before = Object.keys(pile).length;
    // Applied in mtime order, so a later file re-asserting a verdict wins over
    // an earlier file that cleared it, and vice versa.
    for (const id of d.cleared) { delete pile[id]; cleared.add(id); }
    for (const [id, v] of Object.entries(d.pile)) { pile[id] = v; cleared.delete(id); }
    for (const v of d.visited) visited.add(v);
    const gained = Object.keys(pile).length - before;
    if (path.resolve(s.file) !== path.resolve(canonical))
      adopted.push({ file: s.file, gained, total: Object.keys(d.pile).length, cleared: d.cleared.length });
  }

  for (const a of adopted)
    log(
      `  adopted ${a.total} verdicts from ${a.file}` +
        (a.gained > 0 ? ` (+${a.gained} new)` : "") +
        (a.cleared ? `, ${a.cleared} un-tagged` : "")
    );

  return { pile, visited: [...visited], cleared: [...cleared] };
}

function countVerdicts(pile) {
  const c = { like: 0, maybe: 0, discard: 0 };
  for (const v of Object.values(pile)) if (c[v] != null) c[v]++;
  return c;
}

// Write the canonical file and keep a dated snapshot. Snapshots are cheap
// (a few KB) and are the last line of defence against a bad run.
function saveUserState(root, state, { keep = 30 } = {}) {
  const stateDir = path.join(root, "state");
  const histDir = path.join(stateDir, "backups", "history");
  fs.mkdirSync(histDir, { recursive: true });
  const canonical = path.join(stateDir, "user-state.json");
  const json = JSON.stringify(
    { pile: state.pile, visited: state.visited, cleared: state.cleared || [] },
    null,
    2
  );

  // Never overwrite a bigger file with a smaller one without keeping the old one.
  try {
    const prev = fs.readFileSync(canonical, "utf8");
    if (prev !== json) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(path.join(histDir, `user-state.${stamp}.json`), prev);
    }
  } catch {}

  // Write to a sibling temp file and rename. A plain writeFileSync truncates
  // first, so a crash or power cut mid-write leaves a half-file — and the next
  // run would find it unparseable and carry on with an empty pile. rename is
  // atomic on the same volume, so the canonical file is always either the old
  // complete version or the new complete one.
  const tmp = canonical + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, canonical);

  // prune old snapshots
  try {
    const files = fs
      .readdirSync(histDir)
      .filter((f) => f.startsWith("user-state."))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep)))
      fs.unlinkSync(path.join(histDir, f));
  } catch {}
}

// ---------------------------------------------------------------------------
// De-duplication merges several posts of the same flat into one card. The card
// keeps one primary id, so a verdict recorded against an absorbed id would
// silently vanish from the report. spreadVerdicts() copies each cluster's
// verdict onto every member id, in both directions:
//
//   * so the merged card shows the verdict the user gave to any of its posts,
//   * so a future run that clusters differently still finds it.
//
// Conflict inside a cluster (liked one post, discarded another) resolves by
// precedence: an explicit like beats maybe beats discard — the user actively
// wanting a flat is the stronger signal.
// ---------------------------------------------------------------------------
const RANK = { like: 3, maybe: 2, discard: 1 };

function spreadVerdicts(listings, state) {
  const pile = state.pile;
  const cleared = new Set(state.cleared || []);
  const visited = new Set(state.visited);
  let healed = 0;
  for (const l of listings) {
    const ids = Array.isArray(l.ids) && l.ids.length ? l.ids : [l.id];
    let best = null;
    for (const id of ids) {
      const v = pile[id];
      if (v && (!best || RANK[v] > RANK[best])) best = v;
    }
    if (best) {
      // Fill in only the ids the user never judged. Overwriting a verdict that
      // already exists would let a stale decision about one post destroy a
      // newer, deliberate decision about another: the user likes a flat in
      // July, the landlord re-posts it in August, they discard the re-post —
      // and propagating "like" across the cluster would erase the discard from
      // the one file that cannot be regenerated. The card still displays the
      // strongest verdict; each post keeps its own record.
      for (const id of ids)
        if (!pile[id] && !cleared.has(id)) {
          pile[id] = best;
          healed++;
        }
    }
    const seen = ids.some((id) => visited.has(id));
    if (seen) for (const id of ids) visited.add(id);
    l.verdict = best || null;
    l.seen = seen;
  }
  state.visited = [...visited];
  return healed;
}

module.exports = { loadUserState, saveUserState, spreadVerdicts, countVerdicts, VERDICTS };
