/* eslint-env browser */
// ---------------------------------------------------------------------------
// Report front-end. Injected into listings.html together with DATA, SAVED, META
// and the image-rule helper. No frameworks, no network beyond the photo CDNs.
//
// The three things this file is careful about:
//   * verdicts (like/maybe/discard) must never be lost — see pile handling
//   * ~300 photo cards must not stall the browser — see progressive rendering
//   * every photo of a listing must be reachable — see the lightbox
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // -------------------------------------------------------------------------
  // Durable state
  //
  // Layers, in order of authority when they disagree:
  //   1. what the user does right now, held in memory + localStorage
  //   2. SAVED, baked into this file by the last run of find-rentals.js
  //      (which itself unions every user-state*.json it can find on disk)
  //
  // Layer 1 wins outright, because it has already absorbed every earlier layer 2.
  // Layer 2 only ever fills gaps. An id missing from layer 1 is a deletion ONLY
  // if it appears in `cleared`; otherwise it just means this build had not heard
  // of it yet. Both halves matter: without the first, changing your mind about a
  // flat silently reverts on reload; without the second, no verdict can ever be
  // taken back.
  // -------------------------------------------------------------------------
  var LS_PILE = "rr.pile", LS_SEEN = "rr.visited", LS_THEME = "rr.theme", LS_CLEARED = "rr.cleared";
  var RANK = { like: 3, maybe: 2, discard: 1 };

  function loadObj(k) { try { return JSON.parse(localStorage.getItem(k) || "{}") || {}; } catch (e) { return {}; } }
  function loadSet(k) { try { return new Set(JSON.parse(localStorage.getItem(k) || "[]")); } catch (e) { return new Set(); } }
  function saveObj(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) {} }
  function saveSet(k, s) { try { localStorage.setItem(k, JSON.stringify(Array.from(s))); } catch (e) {} }

  var pile = loadObj(LS_PILE);
  var visited = loadSet(LS_SEEN);
  // Ids the user explicitly un-tagged. Needed because "no entry in the pile" is
  // otherwise indistinguishable from "this build had not heard of it yet", so a
  // cleared verdict would come straight back from SAVED on the next reload.
  var cleared = loadSet(LS_CLEARED);

  // legacy: an older build stored plain hearts
  try {
    JSON.parse(localStorage.getItem("rr.liked") || "[]").forEach(function (id) { if (!pile[id]) pile[id] = "like"; });
  } catch (e) {}

  // SAVED fills GAPS ONLY — it must never overrule the live layer.
  //
  // The live pile already absorbed every earlier SAVED blob (the merge below is
  // written straight back to localStorage), so an id it does not hold was either
  // never judged or deliberately cleared. Letting SAVED win "because it ranks
  // higher" meant every downgrade — like a flat, view it, discard it — silently
  // reverted on the next reload and then got written back to disk as the like.
  try {
    var sp = (SAVED && SAVED.pile) || {};
    for (var id in sp) if (!pile[id] && !cleared.has(id)) pile[id] = sp[id];
    if (SAVED && Array.isArray(SAVED.liked))
      SAVED.liked.forEach(function (i) { if (!pile[i] && !cleared.has(i)) pile[i] = "like"; });
    ((SAVED && SAVED.visited) || []).forEach(function (i) { visited.add(i); });
    // a clear recorded on another machine, carried in through the state file
    ((SAVED && SAVED.cleared) || []).forEach(function (i) {
      if (!pile[i]) cleared.add(i);
    });
  } catch (e) {}
  saveObj(LS_PILE, pile);
  saveSet(LS_SEEN, visited);
  saveSet(LS_CLEARED, cleared);

  // A card may stand for several posts of the same flat. Read the strongest
  // verdict across all of them, and write to all of them, so re-clustering on a
  // later run can never orphan a decision.
  function idsOf(l) { return (l.ids && l.ids.length) ? l.ids : [l.id]; }
  function verdictOf(l) {
    var best = null, ids = idsOf(l);
    for (var i = 0; i < ids.length; i++) {
      var v = pile[ids[i]];
      if (v && (!best || RANK[v] > RANK[best])) best = v;
    }
    return best;
  }
  function seenOf(l) {
    var ids = idsOf(l);
    for (var i = 0; i < ids.length; i++) if (visited.has(ids[i])) return true;
    return false;
  }
  function setVerdict(l, cat) {
    var ids = idsOf(l), cur = verdictOf(l), i;
    if (cur === cat) {
      // toggling off is a real decision, so record it as one
      for (i = 0; i < ids.length; i++) { delete pile[ids[i]]; cleared.add(ids[i]); }
    } else {
      for (i = 0; i < ids.length; i++) { pile[ids[i]] = cat; cleared.delete(ids[i]); }
    }
    saveObj(LS_PILE, pile);
    saveSet(LS_CLEARED, cleared);
    markDirty();
  }
  function markSeen(l) {
    var ids = idsOf(l), changed = false;
    for (var i = 0; i < ids.length; i++) if (!visited.has(ids[i])) { visited.add(ids[i]); changed = true; }
    if (changed) { saveSet(LS_SEEN, visited); markDirty(); }
  }
  function stateObj() { return { pile: pile, visited: Array.from(visited), cleared: Array.from(cleared) }; }

  // -------------------------------------------------------------------------
  // "Unsaved work" nag.
  //
  // The File System Access API is unavailable on file:// origins, which is how
  // this report is opened, so silent disk sync is not possible. Rather than
  // pretend, we track how many verdicts were made since the file was generated
  // and prompt for an Export — which the next find-rentals.js run adopts
  // automatically from the Downloads folder.
  // -------------------------------------------------------------------------
  var dirty = 0;
  function markDirty() { dirty++; paintDirty(); scheduleDiskWrite(); }
  function paintDirty() {
    var el = $("#saveState");
    if (!el) return;
    el.hidden = dirty === 0 || diskOk;
    // On static hosting nothing is at risk on close — localStorage keeps the
    // verdicts in this browser — so the bar informs instead of warning.
    el.textContent = httpMode && apiOk === false
      ? dirty + (dirty === 1 ? " change is" : " changes are") + " saved in this browser only — Export to back up or move devices"
      : dirty + (dirty === 1 ? " change not saved to disk" : " changes not saved to disk");
  }
  window.addEventListener("beforeunload", function (e) {
    if (httpMode && apiOk === false) return; // localStorage already has it all
    if (dirty > 0 && !diskOk) { e.preventDefault(); e.returnValue = ""; }
  });

  // Optional: if the report is ever served over http(s), real disk sync works.
  var fileHandle = null, diskOk = false, writeTimer = null;
  var fsAvail = typeof window.showOpenFilePicker === "function";
  // Served by serve.js (PC or phone over the LAN): every change POSTs straight
  // into state/, which merges it into the canonical user-state.json at once.
  var httpMode = /^https?:$/.test(location.protocol) && typeof fetch === "function";
  // null = unknown yet · true = serve.js is answering · false = static hosting
  // (e.g. GitHub Pages) where there is no save API and no point retrying it
  var apiOk = null;
  function writeHttp() {
    fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stateObj()),
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      apiOk = true; diskOk = true; dirty = 0; paintDirty(); setSyncLabel("synced");
    }).catch(function () {
      // static hosting without the API — verdicts live in this browser's
      // localStorage (which is durable); Export moves them between devices
      apiOk = false; diskOk = false; paintDirty();
    });
  }
  function idbOpen() { return new Promise(function (res, rej) { var r = indexedDB.open("rr-fs", 1); r.onupgradeneeded = function () { r.result.createObjectStore("h"); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function idbGet(k) { return idbOpen().then(function (db) { return new Promise(function (res, rej) { var q = db.transaction("h", "readonly").objectStore("h").get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }).catch(function () { return null; }); }
  function idbSet(k, v) { return idbOpen().then(function (db) { return new Promise(function (res) { var t = db.transaction("h", "readwrite"); t.objectStore("h").put(v, k); t.oncomplete = function () { res(); }; t.onerror = function () { res(); }; }); }).catch(function () {}); }
  function scheduleDiskWrite() {
    if (!fileHandle && !(httpMode && apiOk !== false)) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(fileHandle ? writeDisk : writeHttp, 400);
  }
  function writeDisk() {
    if (!fileHandle) return;
    fileHandle.createWritable().then(function (w) {
      return w.write(JSON.stringify(stateObj(), null, 2)).then(function () { return w.close(); });
    }).then(function () { diskOk = true; dirty = 0; paintDirty(); setSyncLabel("synced"); })
      .catch(function () { diskOk = false; setSyncLabel("error"); paintDirty(); });
  }
  function setSyncLabel(s) {
    var b = $("#syncBtn"); if (!b) return;
    b.textContent = { synced: "Synced to disk", error: "Sync failed", off: "Sync to disk" }[s] || "Sync to disk";
    b.dataset.state = s;
  }
  function connectDisk() {
    if (httpMode && apiOk !== false) {
      writeHttp();
      toast("Saving through the local server into state/user-state.json.");
      return;
    }
    if (httpMode && apiOk === false) {
      toast("This copy is hosted statically — verdicts stay in this browser. Use Export / Import to move them between devices.");
      return;
    }
    if (!fsAvail) {
      toast("This browser can't write files from a local page. Use Export — the next run picks it up automatically.");
      return;
    }
    window.showOpenFilePicker({ types: [{ description: "JSON", accept: { "application/json": [".json"] } }] })
      .then(function (h) { return h[0]; })
      .then(function (h) {
        return h.requestPermission({ mode: "readwrite" }).then(function (p) {
          if (p !== "granted") throw new Error("denied");
          fileHandle = h; idbSet("stateFile", h);
          return h.getFile().then(function (f) { return f.text(); }).then(function (t) {
            try { adopt(JSON.parse(t)); } catch (e) {}
            writeDisk(); render();
          });
        });
      }).catch(function () {});
  }
  // union a loaded state in; stronger verdict wins, nothing is dropped
  function adopt(d) {
    if (!d || typeof d !== "object") return;
    var p = d.pile || {};
    for (var id in p) if (!pile[id] || RANK[p[id]] > RANK[pile[id]]) pile[id] = p[id];
    if (Array.isArray(d.liked)) d.liked.forEach(function (i) { if (!pile[i]) pile[i] = "like"; });
    (d.visited || []).forEach(function (i) { visited.add(i); });
    (d.cleared || []).forEach(function (i) { if (!pile[i]) cleared.add(i); });
    saveObj(LS_PILE, pile); saveSet(LS_SEEN, visited); saveSet(LS_CLEARED, cleared);
  }
  function exportState() {
    var blob = new Blob([JSON.stringify(stateObj(), null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "user-state.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    // Deliberately do NOT clear `dirty` here. Nothing tells this page whether
    // the download actually landed — a file:// page can have the save silently
    // blocked, or the user can cancel the dialog — and zeroing the counter would
    // drop the reminder bar and the leave-page warning on the strength of a
    // click alone. The count keeps ticking until a run confirms it read the file.
    toast("Exported to your Downloads folder. The next run of find-rentals.js picks it up automatically.");
  }
  function importState() {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try { adopt(JSON.parse(r.result)); markDirty(); render(); toast("Imported."); }
        catch (e) { toast("That file could not be read as saved state."); }
      };
      r.readAsText(f);
    };
    inp.click();
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast"); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4200);
  }

  // -------------------------------------------------------------------------
  // Filtering + sorting
  // -------------------------------------------------------------------------
  var F = {};
  function readFilters() {
    F = {
      q: ($("#q").value || "").trim().toLowerCase(),
      street: ($("#street").value || "").trim().toLowerCase(),
      pmin: num($("#pmin").value), pmax: num($("#pmax").value),
      amin: num($("#amin").value), amax: num($("#amax").value),
      fmin: num($("#fmin").value), fmax: num($("#fmax").value),
      util: $("#util").value, cond: $("#cond").value, furn: $("#furn").value,
      pileF: $("#pileF").value, src: $("#src").value,
      district: $("#districtF") ? $("#districtF").value : "",
      groupAddr: $("#groupAddr") ? $("#groupAddr").checked : false,
      rooms: $$("#rooms input:checked").map(function (i) { return +i.value; }),
      newOnly: $("#newOnly").checked, hideSeen: $("#hideSeen").checked,
      withPhotos: $("#withPhotos").checked
    };
  }
  function num(v) { v = parseFloat(v); return isFinite(v) ? v : null; }

  function match(l) {
    if (F.pmin != null && (l.price == null || l.price < F.pmin)) return false;
    if (F.pmax != null && (l.price == null || l.price > F.pmax)) return false;
    if (F.amin != null && (l.area == null || l.area < F.amin)) return false;
    if (F.amax != null && (l.area == null || l.area > F.amax)) return false;
    if (F.fmin != null && (l.floorNum == null || l.floorNum < F.fmin)) return false;
    if (F.fmax != null && (l.floorNum == null || l.floorNum > F.fmax)) return false;
    if (F.rooms.length && (l.rooms == null || F.rooms.indexOf(l.rooms) < 0)) return false;
    if (F.util && l.utilities !== F.util) return false;
    if (F.cond && l.renovation !== F.cond) return false;
    if (F.furn && l.furnished !== F.furn) return false;
    if (F.src && l.source !== F.src) return false;
    if (F.district && l.district !== F.district) return false;
    if (F.newOnly && !l.isNew) return false;
    if (F.withPhotos && !(l.img && l.img.p && l.img.p.length)) return false;
    // area drawn on the map: only flats inside it (no position = outside)
    if (areaPoly && (l.lat == null || !pointInArea(l.lat, l.lon))) return false;

    var v = verdictOf(l);
    if (F.pileF === "none" && v) return false;
    if (F.pileF === "not-discard" && v === "discard") return false;
    if (F.pileF && F.pileF !== "none" && F.pileF !== "not-discard" && v !== F.pileF) return false;
    if (F.hideSeen && seenOf(l) && v !== "like") return false;

    if (F.street && (l.street || "").toLowerCase().indexOf(F.street) < 0) return false;
    if (F.q) {
      var hay = ((l.street || "") + " " + (l.district || "") + " " + (l.title || "") + " " +
        (l.description || "") + " " + (l.source || "")).toLowerCase();
      var terms = F.q.split(/\s+/);
      for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
    }
    return true;
  }

  var sortKey = "smart", sortDir = 1;
  var UTIL_RANK = { included: 0, unknown: 1, excluded: 2 };
  var RENO_RANK = { renovated: 0, unknown: 1, old: 2 };
  function cmp(a, b) {
    if (sortKey === "smart") {
      // the ranking the generator already applied: utilities, then condition,
      // then preferred room count, then newest
      var u = UTIL_RANK[a.utilities] - UTIL_RANK[b.utilities]; if (u) return u;
      var r = RENO_RANK[a.renovation] - RENO_RANK[b.renovation]; if (r) return r;
      var ap = a.rooms === META.preferredRooms ? 0 : 1, bp = b.rooms === META.preferredRooms ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
    }
    var x = a[sortKey], y = b[sortKey];
    if (sortKey === "date") { x = Date.parse(a.date) || 0; y = Date.parse(b.date) || 0; }
    if (x == null) x = sortDir > 0 ? Infinity : -Infinity;
    if (y == null) y = sortDir > 0 ? Infinity : -Infinity;
    if (typeof x === "string") return sortDir * String(x).localeCompare(String(y));
    return sortDir * ((x > y) - (x < y));
  }


  // -------------------------------------------------------------------------
  // One card per address.
  //
  // A building routinely has several flats advertised at once — Kaukāza 11 had
  // five, all sharing one agency gallery. They are NOT duplicates, so deleting
  // them would silently remove real apartments (which is what de-duplication
  // deliberately refuses to do). Instead the address gets ONE card: the best of
  // the group — most photos, cheapest as the tie-break — with the others one
  // click away, so the list reads clean without losing anything.
  // -------------------------------------------------------------------------
  var addrGroups = {};              // representative id -> { key, others: [listing] }
  var expandedAddrs = loadSet("rr.addrOpen");

  // Exact address only: a street with no house number is a whole street, not an
  // address, so those never group.
  function addrKey(l) {
    var s = String(l.street || "").toLowerCase()
      .replace(/[āàáã]/g, "a").replace(/[īìí]/g, "i").replace(/[ēèé]/g, "e")
      .replace(/[ūùú]/g, "u").replace(/[ōòó]/g, "o").replace(/[čç]/g, "c")
      .replace(/š/g, "s").replace(/[žź]/g, "z").replace(/[ņň]/g, "n")
      .replace(/ķ/g, "k").replace(/ļ/g, "l").replace(/ģ/g, "g")
      .replace(/[^a-z0-9]+/g, " ").trim();
    return /[0-9]/.test(s) ? s : null;
  }
  function photoCount(l) { return (l.img && l.img.p && l.img.p.length) || 0; }

  // The one to show: most pictures, then the cheapest.
  function bestOf(list) {
    return list.slice().sort(function (a, b) {
      var d = photoCount(b) - photoCount(a);
      if (d) return d;
      var pa = a.price == null ? Infinity : a.price, pb = b.price == null ? Infinity : b.price;
      return pa - pb;
    })[0];
  }

  // Collapse an already-filtered, already-sorted list. Group order follows the
  // representative, so the active sort still governs the page.
  function groupByAddress(list) {
    addrGroups = {};
    var buckets = {}, order = [], out = [];
    for (var i = 0; i < list.length; i++) {
      var k = addrKey(list[i]);
      if (!k) { order.push({ solo: list[i] }); continue; }
      if (!buckets[k]) { buckets[k] = []; order.push({ key: k }); }
      buckets[k].push(list[i]);
    }
    for (var j = 0; j < order.length; j++) {
      if (order[j].solo) { out.push(order[j].solo); continue; }
      var members = buckets[order[j].key];
      if (members.length === 1) { out.push(members[0]); continue; }
      var rep = bestOf(members);
      var others = members.filter(function (m) { return m !== rep; });
      addrGroups[rep.id] = { key: order[j].key, others: others };
      out.push(rep);
      if (expandedAddrs.has(order[j].key)) out = out.concat(others);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Rendering
  //
  // Cards are appended in batches behind an IntersectionObserver sentinel, so
  // opening the report paints one screenful immediately instead of building
  // three hundred DOM subtrees up front. Images are lazy and sit in a fixed
  // aspect-ratio box, so nothing reflows as they arrive.
  // -------------------------------------------------------------------------
  var BATCH = 24;
  var rows = [], drawn = 0;
  var grid = null, sentinel = null, io = null;

  var U_LABEL = { included: ["ok", "utilities incl."], excluded: ["no", "utilities extra"], unknown: ["maybe", "utilities ?"] };
  var R_LABEL = { renovated: ["ok", "renovated"], old: ["no", "needs work"], unknown: ["maybe", "condition ?"] };
  var F_LABEL = { furnished: ["ok", "furnished"], unfurnished: ["no", "unfurnished"], unknown: ["maybe", "furnishing ?"] };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Listing URLs are scraped — pp.lv hands its frontUrl over verbatim — and esc()
  // only neutralises markup, not schemes. Anything that is not plain http(s)
  // becomes inert rather than something a click can execute.
  function safeUrl(u) {
    var s = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(s) ? s : "#";
  }
  function fmtDate(s) {
    if (!s) return "—";
    var d = new Date(s); if (isNaN(d)) return "—";
    var days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return days + "d ago";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  }

  // Tags only earn their place when they say something. "utilities ?" three
  // hundred times is noise; a card with nothing known simply shows no tags.
  function knownTags(l) {
    var t = "";
    if (l.utilities !== "unknown") { var u = U_LABEL[l.utilities]; t += '<span class="tag t-' + u[0] + '">' + u[1] + "</span>"; }
    if (l.renovation !== "unknown") { var r = R_LABEL[l.renovation]; t += '<span class="tag t-' + r[0] + '">' + r[1] + "</span>"; }
    if (l.furnished !== "unknown") { var f = F_LABEL[l.furnished]; t += '<span class="tag t-' + f[0] + '">' + f[1] + "</span>"; }
    return t;
  }

  // A phone shows ONE card per row, so its photo is ~360 CSS px (720-1080 real
  // pixels at DPR 2-3) — four times what the desktop grid rendition holds. Ask
  // for the bigger 'card' rendition there, and keep the small one on desktop
  // where cards are 268px and twenty of them share a screen.
  var narrowMQ = window.matchMedia ? window.matchMedia("(max-width: 720px)") : null;
  function shotSize() { return narrowMQ && narrowMQ.matches ? "card" : "grid"; }

  function cardHTML(l) {
    var v = verdictOf(l), seen = seenOf(l);
    var n = (l.img && l.img.p && l.img.p.length) || 0;
    var thumb = n ? imgUrl(l.img.k, l.img.p[0], shotSize()) : "";

    var grp = addrGroups[l.id];
    var akey = addrKey(l);
    var inOpen = !grp && akey && expandedAddrs.has(akey);
    var cls = ["card"];
    if (grp) cls.push("is-group");
    if (inOpen) cls.push("is-sibling");
    if (v) cls.push("is-" + v);
    if (seen) cls.push("is-seen");
    if (l.rooms === META.preferredRooms) cls.push("is-pref");

    var alts = (l.alts || []).map(function (a) {
      return '<a class="alt" href="' + esc(safeUrl(a.url)) + '" target="_blank" rel="noopener" title="Same flat on ' + esc(a.source) + '">' + esc(a.source) + "</a>";
    }).join("");

    var util = (l.summerUtil != null || l.winterUtil != null)
      ? '<span class="fact" title="Utilities quoted in the ad, summer / winter">' +
        (l.summerUtil == null ? "?" : l.summerUtil) + "/" + (l.winterUtil == null ? "?" : l.winterUtil) + "€</span>"
      : "";

    return '<article class="' + cls.join(" ") + '" data-id="' + esc(l.id) + '" tabindex="0">' +
      '<div class="shot' + (n ? "" : " is-empty") + '"' + (n ? ' data-photos="' + n + '"' : "") + ">" +
        (n ? '<img loading="lazy" decoding="async" src="' + esc(thumb) + '" alt="" draggable="false">' : '<span class="nophoto">no photo</span>') +
        (n > 1 ? '<span class="shotcount">' + n + "</span>" : "") +
        (l.isNew ? '<span class="flag flag-new">new</span>' : "") +
        (seen ? '<span class="flag flag-seen">seen</span>' : "") +
      "</div>" +
      '<div class="body">' +
        '<div class="headline">' +
          '<span class="price">' + esc(l.price == null ? "—" : l.price) + '<i>€</i></span>' +
          '<span class="ppm">' + esc(l.pricePerM2 == null ? "" : l.pricePerM2 + " €/m²") + "</span>" +
        "</div>" +
        '<button class="addr" type="button" title="Show on the map"' +
          (l.lat != null ? ' data-geo="' + (l.geoPrec || "house") + '"' : "") + ">" +
          esc(l.street || l.district || "—") + "</button>" +
        (grp
          ? '<button class="sameaddr" type="button" data-addr="' + esc(grp.key) + '">+' + grp.others.length +
            " more here" + (function () {
              var lo = l.price;
              grp.others.forEach(function (x) { if (x.price != null && (lo == null || x.price < lo)) lo = x.price; });
              return lo != null && lo !== l.price ? " · from " + lo + "€" : "";
            })() + '</button>'
          : inOpen
            ? '<button class="sameaddr is-open" type="button" data-addr="' + esc(akey) + '">same address</button>'
            : "") +
        '<div class="facts">' +
          (l.rooms != null ? '<span class="fact">' + esc(l.rooms) + " rooms</span>" : "") +
          (l.area != null ? '<span class="fact">' + esc(l.area) + " m²</span>" : "") +
          (l.floor ? '<span class="fact">fl. ' + esc(l.floor) + "</span>" : "") +
          // the whole report is the centre — naming the district 400 times says
          // nothing; only a non-default district (Vecrīga, Klusais centrs) speaks
          (l.district && l.district !== "Centrs" ? '<span class="fact">' + esc(l.district) + "</span>" : "") +
          util +
        "</div>" +
        (function () { var t = knownTags(l); return t ? '<div class="tags">' + t + "</div>" : ""; })() +
        '<div class="foot">' +
          '<span class="when">' + fmtDate(l.date) + '</span>' +
          '<span class="srcs"><span class="src">' + esc(l.source) + "</span>" + alts + "</span>" +
        "</div>" +
        '<div class="acts">' +
          '<button class="act a-like' + (v === "like" ? " on" : "") + '" data-cat="like" title="Like (L)">Like</button>' +
          '<button class="act a-maybe' + (v === "maybe" ? " on" : "") + '" data-cat="maybe" title="Maybe (M)">Maybe</button>' +
          '<button class="act a-discard' + (v === "discard" ? " on" : "") + '" data-cat="discard" title="Discard (D)">Discard</button>' +
          '<a class="act a-open" href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener" title="Open the original ad (O)">Open</a>' +
        "</div>" +
      "</div>" +
    "</article>";
  }

  function drawBatch() {
    if (drawn >= rows.length) { if (io && sentinel) io.unobserve(sentinel); sentinel.hidden = true; return; }
    var end = Math.min(drawn + BATCH, rows.length);
    var html = "";
    for (var i = drawn; i < end; i++) html += cardHTML(rows[i]);
    sentinel.insertAdjacentHTML("beforebegin", html);
    drawn = end;
    if (drawn >= rows.length) { sentinel.hidden = true; if (io) io.unobserve(sentinel); }
  }

  // IntersectionObserver only fires when intersection CHANGES. If one batch is
  // not enough to push the sentinel past the fold — a tall window, a wide grid,
  // a filter that leaves few rows — it stays visible and no further callback
  // ever arrives, stranding the list at one batch. So after every batch, keep
  // drawing until the sentinel is safely below the viewport, then hand back to
  // the observer for real scrolling.
  function pump() {
    if (drawn >= rows.length) return;
    var r = sentinel.getBoundingClientRect();
    if (r.top < (window.innerHeight || 800) + 900) {
      drawBatch();
      requestAnimationFrame(pump);
    }
  }

  function render() {
    readFilters();
    rows = DATA.filter(match);
    rows.sort(cmp);
    if (F.groupAddr) rows = groupByAddress(rows);
    else addrGroups = {};
    grid.innerHTML = "";
    grid.appendChild(sentinel);
    sentinel.hidden = false;
    drawn = 0;
    drawBatch();
    if (io) { io.unobserve(sentinel); io.observe(sentinel); }
    pump();
    paintCounts();
  }

  // How many of the folded-away filters are doing something right now — shown
  // on the Filters button so a hidden filter can never silently eat listings.
  function activeFilterCount() {
    var n = 0;
    if (F.street) n++;
    if (F.pmin != null || F.pmax != null) n++;
    if (F.amin != null || F.amax != null) n++;
    if (F.fmin != null || F.fmax != null) n++;
    if (F.rooms.length) n++;
    if (F.util) n++;
    if (F.cond) n++;
    if (F.furn) n++;
    if (F.src) n++;
    if (F.district) n++;
    if (F.newOnly) n++;
    if (F.hideSeen) n++;
    if (F.withPhotos) n++;
    if (areaPoly) n++; // the area drawn on the map counts as a filter too
    return n;
  }
  function paintFiltersBtn() {
    var b = $("#filtersBtn");
    if (!b) return;
    var open = $(".controls").classList.contains("open");
    var n = activeFilterCount();
    b.textContent = open ? "Hide filters" : n ? "Filters · " + n : "Filters";
    b.classList.toggle("active", n > 0);
  }

  function paintCounts() {
    var tally = { like: 0, maybe: 0, discard: 0 };
    for (var i = 0; i < DATA.length; i++) {
      var v = verdictOf(DATA[i]);
      if (v) tally[v]++;
    }
    var folded = 0;
    for (var k in addrGroups) folded += addrGroups[k].others.length;
    $("#count").textContent = rows.length + " of " + DATA.length +
      (folded ? " · " + folded + " folded by address" : "");
    $("#tally").innerHTML =
      '<span class="pip p-like" title="liked">♥ ' + tally.like + "</span>" +
      '<span class="pip p-maybe" title="maybe">? ' + tally.maybe + "</span>" +
      '<span class="pip p-discard" title="discarded">✕ ' + tally.discard + "</span>";
    paintFiltersBtn();
  }

  // Re-render just one card in place, so tagging a flat does not rebuild the grid
  // (which would scroll-jump and re-request images).
  function repaintCard(el, l) {
    var next = document.createElement("div");
    next.innerHTML = cardHTML(l);
    var fresh = next.firstChild;
    el.className = fresh.className;
    var acts = $(".acts", el), freshActs = $(".acts", fresh);
    // Replacing .acts destroys whatever inside it had focus, which drops the
    // user out of the keyboard flow entirely: after one click on Like, j/k and
    // L/M/D go dead because activeElement has fallen back to <body>. Remember
    // where focus was and put it back on the equivalent new control.
    var focusSel = null;
    if (acts && document.activeElement && acts.contains(document.activeElement)) {
      var cls = document.activeElement.className.match(/a-(like|maybe|discard|open)/);
      focusSel = cls ? ".a-" + cls[1] : null;
    }
    if (acts && freshActs) acts.innerHTML = freshActs.innerHTML;
    if (focusSel) {
      var again = $(focusSel, el);
      if (again) again.focus();
      else el.focus();
    }
    var shot = $(".shot", el), freshShot = $(".shot", fresh);
    if (shot && freshShot) {
      // keep the already-loaded <img>, only refresh the overlaid flags
      $$(".flag", shot).forEach(function (n) { n.remove(); });
      $$(".flag", freshShot).forEach(function (n) { shot.appendChild(n); });
    }
    paintCounts();
  }

  function listingOfId(id) {
    for (var i = 0; i < DATA.length; i++) if (DATA[i].id === id) return DATA[i];
    return null;
  }
  function listingOf(el) {
    return listingOfId(el.getAttribute("data-id"));
  }

  // -------------------------------------------------------------------------
  // Lightbox — every photo of a listing, with a filmstrip and preloading
  // -------------------------------------------------------------------------
  var lb, lbImg, lbStrip, lbList = null, lbIdx = 0, lbPre = [];
  function openLB(l, idx) {
    if (!l.img || !l.img.p || !l.img.p.length) return;
    lbList = l; lbIdx = idx || 0;
    lb.hidden = false;
    document.body.classList.add("lb-open");
    document.body.classList.add("panel-open");
    buildStrip();
    showLB();
    lb.focus();
  }
  function closeLB() {
    lb.hidden = true; lbList = null;
    document.body.classList.remove("lb-open");
    document.body.classList.remove("panel-open");
  }
  function buildStrip() {
    var l = lbList, h = "";
    for (var i = 0; i < l.img.p.length; i++)
      h += '<button class="frame" data-i="' + i + '"><img loading="lazy" decoding="async" src="' + esc(imgUrl(l.img.k, l.img.p[i], "tiny")) + '" alt=""></button>';
    lbStrip.innerHTML = h;
  }
  function showLB() {
    var l = lbList; if (!l) return;
    var n = l.img.p.length;
    lbImg.src = imgUrl(l.img.k, l.img.p[lbIdx], "full");
    $("#lbCount").textContent = (lbIdx + 1) + " / " + n;
    $("#lbCap").innerHTML =
      "<b>" + (l.price == null ? "—" : l.price) + "€</b> · " +
      (l.rooms != null ? l.rooms + " rooms · " : "") +
      (l.area != null ? l.area + " m² · " : "") +
      esc(l.street || l.district || "") +
      ' <a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener">open the ad ↗</a>';
    $$(".frame", lbStrip).forEach(function (b, i) { b.classList.toggle("on", i === lbIdx); });
    var on = $(".frame.on", lbStrip); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "center" });
    // preload the neighbours so paging feels instant
    lbPre = [];
    [1, -1, 2].forEach(function (d) {
      var j = (lbIdx + d + n) % n, im = new Image();
      im.src = imgUrl(l.img.k, l.img.p[j], "full"); lbPre.push(im);
    });
    $("#lbPrev").hidden = $("#lbNext").hidden = n < 2;
  }
  function navLB(d) {
    if (!lbList) return;
    var n = lbList.img.p.length;
    lbIdx = (lbIdx + d + n) % n;
    showLB();
  }

  // -------------------------------------------------------------------------
  // Map — Leaflet is inlined at build time (lib/vendor); only the OSM tiles
  // come off the network, exactly like the listing photos do. Two modes:
  //   * one flat  (click its address)          — a single marker
  //   * overview  (the Map button up top)      — every filtered flat, coloured
  //     by verdict, so the geography of your likes becomes visible
  // -------------------------------------------------------------------------
  var HAS_MAP = typeof L !== "undefined" && typeof L.map === "function";
  var map = null, mapLayer = null, mapEl = null;
  var RIGA = [56.9496, 24.1052];

  function cssVar(n) {
    return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  }
  function ensureMap() {
    if (map || !HAS_MAP) return map;
    map = L.map("mapCanvas", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
    wireDrawing();
    return map;
  }
  function openMapPanel() {
    mapEl.hidden = false;
    document.body.classList.add("panel-open");
    document.body.classList.add("lb-open");
    ensureMap();
    // Leaflet measured the container while it was display:none — remeasure.
    setTimeout(function () { if (map) map.invalidateSize(); }, 60);
  }
  function closeMap() {
    mapEl.hidden = true;
    document.body.classList.remove("panel-open");
    document.body.classList.remove("lb-open");
    // verdicts made on the map may change what the active filters admit
    if (mapChanged) { mapChanged = false; render(); }
  }
  function mapsLinks(lat, lon, q) {
    var g, o;
    if (lat != null) {
      g = "https://www.google.com/maps/search/?api=1&query=" + lat + "," + lon;
      o = "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=17/" + lat + "/" + lon;
    } else {
      var e = encodeURIComponent((q || "") + ", Rīga");
      g = "https://www.google.com/maps/search/?api=1&query=" + e;
      o = "https://www.openstreetmap.org/search?query=" + e;
    }
    $("#mapGmaps").href = g;
    $("#mapOsmLink").href = o;
  }

  // price-pill markers — a number is legible where a coloured dot is not
  var mapPins = {}, mapChanged = false;
  function pinIcon(l, v) {
    return L.divIcon({
      className: "pinbox",
      html: '<span class="pin pin-' + (v || "none") + (l.geoPrec === "street" ? " pin-approx" : "") + '">' +
        (l.price == null ? "—" : esc(l.price) + "€") + "</span>",
      iconSize: [0, 0],
    });
  }
  function addPin(l) {
    var m = L.marker([l.lat, l.lon], { icon: pinIcon(l, verdictOf(l)) });
    m.bindPopup(function () { return popupHTML(l); }, { maxWidth: 300, closeButton: false });
    m.addTo(mapLayer);
    mapPins[l.id] = m;
    return m;
  }

  function openMapOne(l) {
    // No Leaflet baked in (vendor files were missing at build): still honour
    // the click, in the least surprising way available.
    if (!HAS_MAP) {
      var e = l.lat != null ? l.lat + "," + l.lon : encodeURIComponent((l.street || l.district || "") + ", Rīga");
      window.open("https://www.google.com/maps/search/?api=1&query=" + e, "_blank", "noopener");
      return;
    }
    openMapPanel();
    mapLayer.clearLayers();
    mapPins = {};
    $("#mapLegend").hidden = true;
    mapsLinks(l.lat, l.lon, l.street || l.district);
    var note = l.lat == null ? " · no exact position — showing the centre" :
      l.geoPrec === "street" ? " · street-level position (approximate)" : "";
    $("#mapTitle").textContent =
      (l.street || l.district || "—") + " · " + (l.price == null ? "—" : l.price) + "€" + note;
    if (l.lat != null) {
      map.setView([l.lat, l.lon], l.geoPrec === "street" ? 15 : 17);
      addPin(l).openPopup();
    } else {
      map.setView(RIGA, 13);
    }
  }

  // the popup is a full miniature listing: photo, facts, tags, blurb, verdict
  // buttons — the flat can be judged without ever leaving the map
  function popupHTML(l) {
    var v = verdictOf(l);
    var n = (l.img && l.img.p && l.img.p.length) || 0;
    var facts = [];
    if (l.rooms != null) facts.push(esc(l.rooms) + " rooms");
    if (l.area != null) facts.push(esc(l.area) + " m²");
    if (l.pricePerM2 != null) facts.push(esc(l.pricePerM2) + " €/m²");
    if (l.floor) facts.push("fl. " + esc(l.floor));
    if (l.district) facts.push(esc(l.district));
    facts.push(fmtDate(l.date));
    return '<div class="mpop' + (v ? " is-" + v : "") + '" data-id="' + esc(l.id) + '">' +
      (n
        ? '<div class="mpop-shot" title="Open all photos">' +
          '<img src="' + esc(imgUrl(l.img.k, l.img.p[0], "grid")) + '" alt="" loading="lazy">' +
          (n > 1 ? '<span class="mpop-count">▣ ' + n + "</span>" : "") +
          "</div>"
        : "") +
      '<div class="mpop-b">' +
        '<div class="mpop-head"><b>' + (l.price == null ? "—" : esc(l.price)) + "€</b>" +
          '<span class="mpop-street">' + esc(l.street || l.district || "") + "</span></div>" +
        '<div class="mpop-facts">' + facts.join(" · ") + "</div>" +
        (function () { var t = knownTags(l); return t ? '<div class="mpop-tags">' + t + "</div>" : ""; })() +
        ((l.title || l.description) ? '<p class="mpop-blurb">' + esc(l.title || l.description) + "</p>" : "") +
        '<div class="mpop-acts">' +
          '<button class="act a-like mpop-act' + (v === "like" ? " on" : "") + '" data-cat="like">Like</button>' +
          '<button class="act a-maybe mpop-act' + (v === "maybe" ? " on" : "") + '" data-cat="maybe">Maybe</button>' +
          '<button class="act a-discard mpop-act' + (v === "discard" ? " on" : "") + '" data-cat="discard">Discard</button>' +
        "</div>" +
        '<div class="mpop-links"><a class="mpop-card" href="#">show card</a>' +
        '<a class="mpop-open" href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener">open ad ↗</a></div>' +
      "</div></div>";
  }

  // re-plot every pin the current filters admit; keeps the drawn area visible
  function replotPins() {
    mapLayer.clearLayers();
    mapPins = {};
    if (areaLayer) areaLayer.addTo(mapLayer);
    var pts = [];
    rows.forEach(function (l) {
      if (l.lat == null) return;
      addPin(l);
      pts.push([l.lat, l.lon]);
    });
    $("#mapTitle").textContent =
      pts.length + " of " + rows.length + " filtered flats have a position" +
      (areaPoly ? " · inside your drawn area" : "");
    return pts;
  }

  function openMapAll() {
    if (!HAS_MAP) return;
    openMapPanel();
    $("#mapLegend").hidden = false;
    mapsLinks(RIGA[0], RIGA[1]);
    var pts = replotPins();
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
    else map.setView(RIGA, 13);
  }

  // -------------------------------------------------------------------------
  // Draw-an-area filter. Freehand: press, drag a line around the part of the
  // city you care about, release — the polygon closes itself and from then on
  // the LIST shows only flats inside it (cards, counts, pins — everything).
  // -------------------------------------------------------------------------
  var areaPoly = null;   // [[lat,lon], …] — the active filter, read by match()
  var areaLayer = null;  // the polygon drawn on the map
  var drawArm = false;   // "next press starts drawing"
  var drawPts = null, drawLine = null;

  function pointInArea(lat, lon) {
    var p = areaPoly, inside = false;
    for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
      var yi = p[i][0], xi = p[i][1], yj = p[j][0], xj = p[j][1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  function paintDrawBtn() {
    var b = $("#drawBtn");
    if (!b) return;
    b.textContent = drawArm ? "… draw now" : areaPoly ? "✕ Clear area" : "✏ Draw area";
    b.classList.toggle("active", drawArm || !!areaPoly);
  }

  function armDraw() {
    if (!map) return;
    drawArm = true;
    map.dragging.disable();
    if (map.touchZoom) map.touchZoom.disable();
    map.getContainer().classList.add("drawing");
    map.closePopup();
    paintDrawBtn();
  }
  function disarmDraw() {
    drawArm = false;
    drawPts = null;
    if (drawLine) { map.removeLayer(drawLine); drawLine = null; }
    if (map) {
      map.dragging.enable();
      if (map.touchZoom) map.touchZoom.enable();
      map.getContainer().classList.remove("drawing");
    }
    paintDrawBtn();
  }
  function clearArea() {
    areaPoly = null;
    areaLayer = null;
    disarmDraw();
    render();
    if (mapEl && !mapEl.hidden) replotPins();
  }
  function finishDraw() {
    var pts = drawPts;
    disarmDraw();
    if (!pts || pts.length < 3) return; // a tap, not a shape
    areaPoly = pts;
    areaLayer = L.polygon(pts.map(function (p) { return [p[0], p[1]]; }), {
      color: cssVar("--accent"), weight: 2, fillColor: cssVar("--accent"), fillOpacity: 0.07,
      dashArray: "6 4", interactive: false,
    });
    render();
    replotPins();
    map.fitBounds(areaLayer.getBounds(), { padding: [40, 40] });
    paintDrawBtn();
  }
  function wireDrawing() {
    var c = map.getContainer();
    function toLatLng(e) {
      var r = c.getBoundingClientRect();
      return map.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    }
    c.addEventListener("pointerdown", function (e) {
      if (!drawArm || !e.isPrimary) return;
      e.preventDefault();
      var ll = toLatLng(e);
      drawPts = [[ll.lat, ll.lng]];
      drawLine = L.polyline([[ll.lat, ll.lng]], { color: cssVar("--accent"), weight: 2.5 }).addTo(map);
      if (c.setPointerCapture) try { c.setPointerCapture(e.pointerId); } catch (err) {}
    });
    c.addEventListener("pointermove", function (e) {
      if (!drawArm || !drawPts) return;
      e.preventDefault();
      var ll = toLatLng(e);
      var last = drawPts[drawPts.length - 1];
      var lp = map.latLngToContainerPoint([last[0], last[1]]);
      var np = map.latLngToContainerPoint(ll);
      if (lp.distanceTo(np) < 5) return; // thin the path
      drawPts.push([ll.lat, ll.lng]);
      drawLine.setLatLngs(drawPts.map(function (p) { return [p[0], p[1]]; }));
    });
    c.addEventListener("pointerup", function () {
      if (drawArm && drawPts) finishDraw();
    });
    c.addEventListener("pointercancel", function () {
      if (drawArm) disarmDraw();
    });
  }

  // The card a popup points at may not be drawn yet — the grid renders in
  // batches — so draw forward until it exists, then hand focus to it.
  function showCardById(id) {
    var idx = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    while (drawn <= idx && drawn < rows.length) drawBatch();
    var el = $('.card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]', grid);
    if (!el) return;
    cursor = idx;
    el.scrollIntoView({ block: "center" });
    el.focus();
  }

  // -------------------------------------------------------------------------
  // Keyboard: this is a tool, so it should be drivable without the mouse
  // -------------------------------------------------------------------------
  var cursor = -1;
  function cards() { return $$(".card", grid); }
  function focusCard(i) {
    var c = cards();
    if (!c.length) return;
    cursor = Math.max(0, Math.min(i, c.length - 1));
    // drawing more may be needed to reach the requested card
    if (cursor >= c.length - 2 && drawn < rows.length) { drawBatch(); c = cards(); }
    c[cursor].focus();
    c[cursor].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function currentCard() { var c = cards(); return cursor >= 0 && cursor < c.length ? c[cursor] : null; }

  document.addEventListener("keydown", function (e) {
    // Never shadow a browser or OS shortcut. Ctrl/Cmd+L is "focus the address
    // bar" and Ctrl+D is "bookmark"; without this check those keystrokes were
    // being read as Like and Discard and silently rewrote a verdict on whichever
    // card happened to hold focus.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (!lb.hidden) {
      if (e.key === "Escape") { closeLB(); e.preventDefault(); }
      else if (e.key === "ArrowRight" || e.key === " ") { navLB(1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { navLB(-1); e.preventDefault(); }
      return;
    }
    if (mapEl && !mapEl.hidden) {
      if (e.key === "Escape") {
        if (drawArm) disarmDraw(); else closeMap();
        e.preventDefault();
      }
      return;
    }
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.key === "/") { $("#q").focus(); e.preventDefault(); return; }
    if (e.key === "j" || e.key === "ArrowDown") { focusCard(cursor + 1); e.preventDefault(); return; }
    if (e.key === "k" || e.key === "ArrowUp") { focusCard(cursor - 1); e.preventDefault(); return; }

    var active = document.activeElement;
    var el = active && active.closest ? active.closest(".card") : null;
    if (!el) return;
    var l = listingOf(el);
    if (!l) return;

    // Enter belongs to whatever is focused. Swallowing it unconditionally meant
    // a keyboard user who tabbed to the Like button got the photo gallery
    // instead, leaving the pile buttons unreachable without a mouse.
    var onControl = active !== el && !!active.closest("button, a, input, select");

    var k = e.key.toLowerCase();
    if (k === "l" || k === "m" || k === "d") {
      setVerdict(l, k === "l" ? "like" : k === "m" ? "maybe" : "discard");
      repaintCard(el, l); e.preventDefault();
    } else if (k === "o") {
      markSeen(l); repaintCard(el, l);
      window.open(safeUrl(l.url), "_blank", "noopener"); e.preventDefault();
    } else if (k === "enter" && !onControl) {
      openLB(l, 0); e.preventDefault();
    }
  });

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  function boot() {
    grid = $("#grid");
    sentinel = document.createElement("div");
    sentinel.id = "more";
    sentinel.className = "sentinel";

    lb = $("#lb"); lbImg = $("#lbImg"); lbStrip = $("#lbStrip");

    // room checkboxes, from whatever room counts actually appear
    var roomVals = [];
    DATA.forEach(function (l) { if (l.rooms != null && roomVals.indexOf(l.rooms) < 0) roomVals.push(l.rooms); });
    roomVals.sort(function (a, b) { return a - b; });
    $("#rooms").innerHTML = "<span class='flabel'>Rooms</span>" + roomVals.map(function (r) {
      return '<label class="chip"><input type="checkbox" value="' + r + '"><span>' + r + "</span></label>";
    }).join("");

    // source filter
    var srcs = [];
    DATA.forEach(function (l) { if (l.source && srcs.indexOf(l.source) < 0) srcs.push(l.source); });
    $("#src").innerHTML = '<option value="">Any source</option>' +
      srcs.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + "</option>"; }).join("");

    // district filter, with per-district counts so the city reads at a glance
    var dCount = {};
    DATA.forEach(function (l) { if (l.district) dCount[l.district] = (dCount[l.district] || 0) + 1; });
    var dNames = Object.keys(dCount).sort(function (a, b) { return dCount[b] - dCount[a]; });
    $("#districtF").innerHTML = '<option value="">All districts</option>' +
      dNames.map(function (d) {
        return '<option value="' + esc(d) + '">' + esc(d) + " (" + dCount[d] + ")</option>";
      }).join("");

    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(function (ents) {
        if (ents.some(function (x) { return x.isIntersecting; })) pump();
      }, { rootMargin: "800px 0px" });
    }
    // Belt and braces: if the observer never fires — no IO support, an odd
    // embedding, a viewport the browser reports as zero-height — the grid would
    // silently strand at the first batch with most of the results unreachable.
    // A passive scroll listener costs nothing and guarantees forward progress.
    window.addEventListener("scroll", pump, { passive: true });
    window.addEventListener("resize", pump, { passive: true });

    var ctl = $(".controls");
    ctl.addEventListener("input", debounce(render, 120));
    ctl.addEventListener("change", render);

    $("#sort").addEventListener("change", function () {
      var v = this.value.split(":");
      sortKey = v[0]; sortDir = +(v[1] || 1);
      render();
    });

    grid.addEventListener("click", function (e) {
      var el = e.target.closest(".card"); if (!el) return;
      var l = listingOf(el); if (!l) return;
      cursor = cards().indexOf(el);

      var sa = e.target.closest("button.sameaddr");
      if (sa) {
        var k = sa.getAttribute("data-addr");
        if (expandedAddrs.has(k)) expandedAddrs.delete(k); else expandedAddrs.add(k);
        saveSet("rr.addrOpen", expandedAddrs);
        render();
        return;
      }
      var addr = e.target.closest("button.addr");
      if (addr) { openMapOne(l); return; }
      var shot = e.target.closest(".shot");
      if (shot) { openLB(l, 0); return; }
      var act = e.target.closest("button.act");
      if (act) { setVerdict(l, act.dataset.cat); repaintCard(el, l); return; }
      var open = e.target.closest("a.a-open");
      if (open) { markSeen(l); setTimeout(function () { repaintCard(el, l); }, 0); return; }
    });

    // broken photo → fall back to the tiny rendition, then give up gracefully
    grid.addEventListener("error", function (e) {
      var im = e.target;
      if (!im || im.tagName !== "IMG" || im.dataset.fallback) return;
      im.dataset.fallback = "1";
      var el = im.closest(".card"); var l = el && listingOf(el);
      if (l && l.img && l.img.p.length) im.src = imgUrl(l.img.k, l.img.p[0], "tiny");
      else { im.remove(); }
    }, true);

    lb.addEventListener("click", function (e) {
      if (e.target === lb || e.target.id === "lbClose") { closeLB(); return; }
      var f = e.target.closest(".frame");
      if (f) { lbIdx = +f.dataset.i; showLB(); return; }
    });
    $("#lbPrev").addEventListener("click", function () { navLB(-1); });
    $("#lbNext").addEventListener("click", function () { navLB(1); });

    // touch: swipe through photos, swipe down to dismiss
    var swX = null, swY = null;
    lb.addEventListener("touchstart", function (e) {
      if (e.touches.length === 1) { swX = e.touches[0].clientX; swY = e.touches[0].clientY; }
      else swX = null; // a pinch is not a swipe
    }, { passive: true });
    lb.addEventListener("touchend", function (e) {
      if (swX == null || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - swX, dy = e.changedTouches[0].clientY - swY;
      swX = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) navLB(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.4) closeLB();
    }, { passive: true });

    // map panel
    mapEl = $("#map");
    var mapBtn = $("#mapBtn");
    var anyGeo = DATA.some(function (l) { return l.lat != null; });
    var mapFab = $("#mapFab");
    if (!HAS_MAP || !anyGeo) {
      mapBtn.hidden = true;
      if (mapFab) mapFab.hidden = true;
    } else {
      mapBtn.addEventListener("click", openMapAll);
      if (mapFab) mapFab.addEventListener("click", openMapAll);
    }
    $("#mapClose").addEventListener("click", closeMap);
    var drawBtn = $("#drawBtn");
    if (drawBtn) drawBtn.addEventListener("click", function () {
      if (drawArm) disarmDraw();          // pressed again mid-arm: cancel
      else if (areaPoly) clearArea();     // an area exists: clear it
      else armDraw();                     // otherwise: start drawing
    });
    $("#mapCanvas").addEventListener("click", function (e) {
      var pop = e.target.closest(".mpop");
      var lp = pop && listingOfId(pop.getAttribute("data-id"));
      // A click inside the popup must not reach Leaflet's map handler — its
      // close-on-click would shut the popup under the user's finger. This
      // listener was registered before Leaflet's (boot runs before the map is
      // created), so stopping here really does starve it.
      if (pop) e.stopImmediatePropagation();
      var card = e.target.closest("a.mpop-card");
      if (card) {
        e.preventDefault();
        if (lp) { closeMap(); showCardById(lp.id); }
        return;
      }
      var act = e.target.closest("button.mpop-act");
      if (act && lp) {
        setVerdict(lp, act.dataset.cat);
        mapChanged = true;
        var mk = mapPins[lp.id];
        if (mk) {
          // setIcon rebuilds the marker element, which closes its popup as a
          // side effect — refresh the content AND make sure it is open again,
          // so the user can keep judging from the map without re-clicking pins
          mk.setIcon(pinIcon(lp, verdictOf(lp)));
          if (mk.getPopup()) mk.getPopup().setContent(popupHTML(lp));
          if (!mk.isPopupOpen()) mk.openPopup();
        }
        // keep the grid card behind the map in step, if it is drawn
        var cardEl = $('.card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(lp.id) : lp.id) + '"]', grid);
        if (cardEl) repaintCard(cardEl, lp); else paintCounts();
        return;
      }
      var shot = e.target.closest(".mpop-shot");
      if (shot && lp) { openLB(lp, 0); return; }
      var openA = e.target.closest("a.mpop-open");
      if (openA && lp) markSeen(lp);
    });

    // the full filter set folds away behind one button, on every screen size
    var fBtn = $("#filtersBtn");
    if (fBtn) fBtn.addEventListener("click", function () {
      var open = ctl.classList.toggle("open");
      fBtn.setAttribute("aria-expanded", open ? "true" : "false");
      paintFiltersBtn();
    });

    // the ⋯ menu: close on an outside click, and after choosing an item
    var menu = $("#moreMenu");
    if (menu) {
      document.addEventListener("click", function (e) {
        if (menu.open && !menu.contains(e.target)) menu.removeAttribute("open");
      });
      $$(".menu-list button", menu).forEach(function (b) {
        b.addEventListener("click", function () { menu.removeAttribute("open"); });
      });
    }

    $("#exportBtn").addEventListener("click", exportState);
    $("#importBtn").addEventListener("click", importState);
    $("#syncBtn").addEventListener("click", connectDisk);
    $("#resetBtn").addEventListener("click", function () {
      $$(".controls input").forEach(function (i) { if (i.type === "checkbox") i.checked = false; else i.value = ""; });
      $$(".controls select").forEach(function (s) { s.selectedIndex = 0; });
      sortKey = "smart"; sortDir = 1;
      if (areaPoly) clearArea(); // the drawn area is a filter like any other
      render();
    });

    var themeBtn = $("#themeBtn");
    themeBtn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", cur);
      try { localStorage.setItem(LS_THEME, cur); } catch (e) {}
      themeBtn.textContent = cur === "light" ? "Dark" : "Light";
    });
    themeBtn.textContent = document.documentElement.getAttribute("data-theme") === "light" ? "Dark" : "Light";

    // reconnect a previously granted file handle, when the page is served over http
    if (fsAvail) {
      idbGet("stateFile").then(function (h) {
        if (!h) return;
        h.queryPermission({ mode: "readwrite" }).then(function (p) {
          if (p === "granted") { fileHandle = h; diskOk = true; setSyncLabel("synced"); paintDirty(); }
        }).catch(function () {});
      });
    }
    // served by serve.js? then verdicts save themselves — tell the user so
    if (httpMode) {
      fetch("/api/ping").then(function (r) {
        if (r.ok) { apiOk = true; diskOk = true; setSyncLabel("synced"); }
        else { apiOk = false; }
        paintDirty();
      }).catch(function () { apiOk = false; paintDirty(); });
    }

    // A scheduled task rebuilds this file twice a day. A tab left open adopts
    // the fresh build by itself: reload once the tab is hidden, at least an
    // hour old, and holding nothing unsaved. Verdicts ride across in
    // localStorage, so a reload can never lose one.
    var born = Date.now();
    setInterval(function () {
      if (!document.hidden) return;
      if (dirty > 0 && !diskOk) return;
      if ((lb && !lb.hidden) || (mapEl && !mapEl.hidden)) return;
      if (Date.now() - born < 60 * 60 * 1000) return;
      location.reload();
    }, 10 * 60 * 1000);

    // Crossing the phone/desktop breakpoint changes which photo rendition the
    // cards should request. Watch for it two ways, because a matchMedia change
    // event is not guaranteed to arrive in every embedding: the event when it
    // does fire, and a debounced resize check that compares the ANSWER rather
    // than the width — so a redraw happens exactly once per real crossing and
    // never on an ordinary resize tick.
    var lastShot = shotSize();
    var checkBP = function () {
      var now = shotSize();
      if (now !== lastShot) { lastShot = now; render(); }
    };
    if (narrowMQ) {
      if (narrowMQ.addEventListener) narrowMQ.addEventListener("change", checkBP);
      else if (narrowMQ.addListener) narrowMQ.addListener(checkBP);
    }
    window.addEventListener("resize", debounce(checkBP, 200), { passive: true });
    window.addEventListener("orientationchange", checkBP, { passive: true });

    render();
    paintDirty();
  }

  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
