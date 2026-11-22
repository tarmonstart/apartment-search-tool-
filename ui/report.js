/* eslint-env browser */
// ---------------------------------------------------------------------------
// Report front-end. Injected into listings.html together with DATA, SAVED, META
// and the image-rule helper (imgUrl). No frameworks.
//
// The model is deliberately simple:
//   * every flat is unviewed, viewed, liked (👍) or disliked (👎)
//   * four tabs show exactly those four piles. A flat becomes "viewed" when
//     you open it (its photos, the original ad, or its spot on the map), and
//     judging it moves it out of both, so nothing has to be looked at twice
//   * a handful of filters, all in one sheet, remembered between visits
//   * signed in with Google (when Firebase is configured), votes and views
//     live in your account and follow you between devices; otherwise they
//     stay in this browser
//
// Verdict storage is compatible with the earlier like/maybe/discard report
// (same localStorage keys, same state-file shape); an old "maybe" counts as 👍.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ------------------------------------------------------------------ state
  var LS_PILE = "rr.pile", LS_SEEN = "rr.visited", LS_CLEARED = "rr.cleared";
  var LS_FILTERS = "rr2.filters", LS_TAB = "rr2.tab";

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var pile = load(LS_PILE, {}) || {};
  var visited = new Set(load(LS_SEEN, []) || []);
  var cleared = new Set(load(LS_CLEARED, []) || []);

  // The state baked into this build only fills gaps: the browser has already
  // absorbed every earlier build, and an id it lacks was either never judged or
  // deliberately cleared (recorded in `cleared`).
  (function mergeSaved() {
    var sp = (SAVED && SAVED.pile) || {};
    for (var id in sp) if (!pile[id] && !cleared.has(id)) pile[id] = sp[id];
    ((SAVED && SAVED.visited) || []).forEach(function (i) { visited.add(i); });
    ((SAVED && SAVED.cleared) || []).forEach(function (i) { if (!pile[i]) cleared.add(i); });
    save(LS_PILE, pile); save(LS_SEEN, Array.from(visited)); save(LS_CLEARED, Array.from(cleared));
  })();

  function idsOf(l) { return l.ids && l.ids.length ? l.ids : [l.id]; }
  // A card can stand for several posts of one flat. 👍 anywhere wins, so a flat
  // liked on one site is never hidden because its re-post was rejected.
  function verdictOf(l) {
    var ids = idsOf(l), best = null;
    for (var i = 0; i < ids.length; i++) {
      var v = pile[ids[i]];
      if (v === "like" || v === "maybe") return "like";
      if (v === "discard") best = "discard";
    }
    return best;
  }
  function snapshot(l) { var o = {}; idsOf(l).forEach(function (i) { o[i] = pile[i] || null; }); return o; }
  function restore(snap) {
    for (var i in snap) {
      if (snap[i]) { pile[i] = snap[i]; cleared.delete(i); } else { delete pile[i]; cleared.add(i); }
      cloudPile(i, snap[i] || "");
    }
    persist();
  }
  function setVerdict(l, v) {
    idsOf(l).forEach(function (i) {
      if (v) { pile[i] = v; cleared.delete(i); } else { delete pile[i]; cleared.add(i); }
      cloudPile(i, v || "");
    });
    persist();
  }
  function seenOf(l) {
    var ids = idsOf(l);
    for (var i = 0; i < ids.length; i++) if (visited.has(ids[i])) return true;
    return false;
  }
  // unviewed · viewed · like · discard: the four tabs
  function stateOf(l) { return verdictOf(l) || (seenOf(l) ? "seen" : "todo"); }

  // Opening a flat marks it viewed. It stays where it is in the list you are
  // looking at (keepHere) until you switch tabs, so nothing jumps mid-scroll.
  var keepHere = new Set();
  function markSeen(l) {
    if (!l) return;
    var ch = false;
    idsOf(l).forEach(function (i) { if (!visited.has(i)) { visited.add(i); cloudSeen(i, true); ch = true; } });
    if (!ch) return;
    if (tab === "todo") keepHere.add(l.id);
    save(LS_SEEN, Array.from(visited)); pushState();
    // after the click has done its job (a link must still open)
    setTimeout(function () { repaintCard(l); paintCountsOnly(); }, 0);
  }
  function markUnseen(l) {
    idsOf(l).forEach(function (i) { if (visited.has(i)) { visited.delete(i); cloudSeen(i, false); } });
    save(LS_SEEN, Array.from(visited)); pushState();
  }
  function stateObj() { return { pile: pile, visited: Array.from(visited), cleared: Array.from(cleared) }; }
  function persist() {
    save(LS_PILE, pile); save(LS_CLEARED, Array.from(cleared));
    pushState();
  }

  // Served by serve.js on the home network, verdicts also go straight to
  // state/user-state.json. On GitHub Pages there is no such API: the browser's
  // own storage holds them, and the backup buttons move them between devices.
  var api = null; // null unknown · true serve.js answers · false static hosting
  var pushTimer = null;
  function pushState() {
    if (api === false || !/^https?:$/.test(location.protocol)) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stateObj()) })
        .then(function (r) { api = r.ok; paintSaveNote(); })
        .catch(function () { api = false; paintSaveNote(); });
    }, 400);
  }
  function paintSaveNote() {
    $("#saveNote").textContent = api
      ? "Your votes are saved straight to this computer (state/user-state.json)."
      : "Your votes are saved in this browser. Use a backup to move them to another device.";
  }

  // ---------------------------------------------------------------- filters
  // zones: areas drawn on the map, each a ring of [lat, lon] points
  var DEFAULT_F = { max: null, rooms: [], area: null, districts: [], zones: [], flags: [], q: "", sort: "new" };
  function freshF() { return JSON.parse(JSON.stringify(DEFAULT_F)); }
  // a fresh copy, so toggling a filter never edits the defaults that "Clear" restores
  var F = Object.assign(freshF(), load(LS_FILTERS, {}) || {});
  if (!Array.isArray(F.zones)) F.zones = [];
  var tab = load(LS_TAB, "todo");
  if (["todo", "seen", "like", "discard"].indexOf(tab) < 0) tab = "todo";

  function fold(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  DATA.forEach(function (l) {
    l._hay = fold([l.street, l.district, l.title, l.description, l.source].join(" "));
    l._fresh = Date.parse(l.firstSeen || l.date || 0) || 0;
  });

  function passes(l) {
    if (F.max != null && l.price != null && l.price > F.max) return false;
    if (F.rooms.length) {
      var r = l.rooms == null ? null : Math.min(l.rooms, 4);
      if (r == null || F.rooms.indexOf(r) < 0) return false;
    }
    if (F.area != null && (l.area == null || l.area < F.area)) return false;
    if (F.districts.length && F.districts.indexOf(l.district || "") < 0) return false;
    // a drawn area admits only flats with a known position inside it
    if (F.zones.length && (l.lat == null || !inZones(l.lat, l.lon))) return false;
    for (var i = 0; i < F.flags.length; i++) {
      var f = F.flags[i];
      if (f === "fresh" && Date.now() - l._fresh > 3 * 864e5) return false;
      if (f === "util" && l.utilities !== "included") return false;
      if (f === "reno" && l.renovation !== "renovated") return false;
      if (f === "furn" && l.furnished !== "furnished") return false;
      if (f === "photos" && !(l.img && l.img.p && l.img.p.length)) return false;
    }
    if (F.q) {
      var words = fold(F.q).split(/\s+/).filter(Boolean);
      for (var w = 0; w < words.length; w++) if (l._hay.indexOf(words[w]) < 0) return false;
    }
    return true;
  }
  var SORTS = {
    new: function (a, b) { return b._fresh - a._fresh || (Date.parse(b.date || 0) || 0) - (Date.parse(a.date || 0) || 0); },
    cheap: function (a, b) { return (a.price == null ? 1e9 : a.price) - (b.price == null ? 1e9 : b.price); },
    ppm: function (a, b) { return (a.pricePerM2 == null ? 1e9 : a.pricePerM2) - (b.pricePerM2 == null ? 1e9 : b.pricePerM2); },
    big: function (a, b) { return (b.area || 0) - (a.area || 0); },
  };

  function activeCount() {
    return (F.max != null) + (F.rooms.length > 0) + (F.area != null) + (F.districts.length > 0) +
      (F.zones.length > 0) + F.flags.length + (!!F.q);
  }

  // ray casting: is [lat, lon] inside any drawn ring?
  function inRing(p, lat, lon) {
    var inside = false;
    for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
      var yi = p[i][0], xi = p[i][1], yj = p[j][0], xj = p[j][1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inZones(lat, lon) {
    for (var i = 0; i < F.zones.length; i++) if (inRing(F.zones[i], lat, lon)) return true;
    return false;
  }
  function zonesLabel() {
    return F.zones.length === 1 ? "drawn area" : F.zones.length + " drawn areas";
  }

  // ------------------------------------------------------------- rendering
  var listEl = $("#list"), sentinel = $("#sentinel");
  var rows = [], drawn = 0, BATCH = 24;
  var byId = {};
  DATA.forEach(function (l) { byId[l.id] = l; });

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function safeUrl(u) { var s = String(u || "").trim(); return /^https?:\/\//i.test(s) ? s : "#"; }
  function ago(s) {
    var t = Date.parse(s || ""); if (!t) return "";
    var d = Math.floor((Date.now() - t) / 864e5);
    if (d <= 0) return "today";
    if (d === 1) return "yesterday";
    if (d < 31) return d + " days ago";
    var m = Math.round(d / 30);
    return m < 12 ? (m === 1 ? "a month ago" : m + " months ago") : "over a year ago";
  }
  function roomsTxt(n) { return n === 1 ? "1 room" : n + " rooms"; }
  // stroke icons (never emoji: they render differently on every phone)
  var ICON = {
    pin: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    x: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    heart: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  };
  var narrow = window.matchMedia ? window.matchMedia("(max-width: 640px)") : { matches: false };
  function photos(l) { return (l.img && l.img.p) || []; }

  function cardHTML(l) {
    var v = verdictOf(l), ps = photos(l), size = narrow.matches ? "card" : "grid";
    var shown = ps.slice(0, 12);
    var gallery = shown.length
      ? shown.map(function (p, i) {
          return '<img src="' + esc(imgUrl(l.img.k, p, size)) + '"' + (i ? ' loading="lazy"' : "") +
            ' decoding="async" alt="" draggable="false" data-i="' + i + '">';
        }).join("")
      : '<div class="nophoto">no photos</div>';
    var tags = [];
    if (l.utilities === "included") tags.push('<span class="tag good">utilities included</span>');
    else if (l.summerUtil != null || l.winterUtil != null)
      tags.push('<span class="tag">+ utilities ' + (l.summerUtil == null ? "?" : l.summerUtil) + "–" + (l.winterUtil == null ? "?" : l.winterUtil) + " €</span>");
    else if (l.utilities === "excluded") tags.push('<span class="tag">+ utilities</span>');
    if (l.renovation === "renovated") tags.push('<span class="tag good">renovated</span>');
    if (l.renovation === "old") tags.push('<span class="tag warn">needs work</span>');
    if (l.furnished === "furnished") tags.push('<span class="tag">furnished</span>');
    if (l.furnished === "unfurnished") tags.push('<span class="tag">unfurnished</span>');

    var links = [{ source: l.source, url: l.url }].concat(l.alts || []);
    var seenUrl = {}, perSrc = {};
    links = links.filter(function (a) { if (seenUrl[a.url]) return false; seenUrl[a.url] = 1; return true; });
    // a re-post on the same site is labelled "ss.lv 2", not counted as another site
    links.forEach(function (a) { perSrc[a.source] = (perSrc[a.source] || 0) + 1; a.label = a.source + (perSrc[a.source] > 1 ? " " + perSrc[a.source] : ""); });
    var nSites = Object.keys(perSrc).length;

    var facts = [];
    if (l.rooms != null) facts.push(roomsTxt(l.rooms));
    if (l.area != null) facts.push(l.area + " m²");
    if (l.floor) facts.push("floor " + esc(l.floor));

    var seen = !v && seenOf(l);
    return '<article class="card' + (v ? " is-" + v : "") + (seen ? " is-seen" : "") + '" data-id="' + esc(l.id) + '">' +
      '<div class="gal" data-n="' + ps.length + '">' +
        '<div class="gal-track">' + gallery + "</div>" +
        (ps.length > 1 ? '<span class="gal-count">1/' + ps.length + "</span>" : "") +
        (seen ? '<span class="pill seen">Viewed</span>' : l.isNew ? '<span class="pill new">New</span>' : "") +
        (nSites > 1 ? '<span class="pill multi" title="The same flat on several sites">' + nSites + " sites</span>" : "") +
      "</div>" +
      '<div class="info">' +
        '<div class="row1"><span class="price">' + (l.price == null ? "—" : esc(l.price) + " €") + "</span>" +
          (l.pricePerM2 != null ? '<span class="ppm">' + esc(l.pricePerM2) + " €/m²</span>" : "") +
          '<span class="age">' + esc(ago(l.firstSeen || l.date)) + "</span></div>" +
        '<div class="facts">' + facts.join(" · ") + "</div>" +
        '<button class="addr" type="button"' + (l.lat != null ? "" : " disabled") + ">" +
          ICON.pin + esc(l.street || "no address") + (l.district && l.district !== "Rīga" ? ", " + esc(l.district) : "") + "</button>" +
        (tags.length ? '<div class="tags">' + tags.join("") + "</div>" : "") +
        (l.description ? '<p class="desc">' + esc(l.description) + "</p>" : "") +
        '<div class="links">' + links.map(function (a) {
          return '<a href="' + esc(safeUrl(a.url)) + '" target="_blank" rel="noopener">' + esc(a.label) + " ↗</a>";
        }).join("") +
          (v ? "" : '<button class="seentoggle" type="button">' + (seen ? "mark unviewed" : "mark viewed") + "</button>") +
        "</div>" +
      "</div>" +
      '<div class="vote">' +
        '<button class="no' + (v === "discard" ? " on" : "") + '" type="button" data-v="discard">' + ICON.x + "<span>Pass</span></button>" +
        '<button class="yes' + (v === "like" ? " on" : "") + '" type="button" data-v="like">' + ICON.heart + "<span>" + (v === "like" ? "Liked" : "Like") + "</span></button>" +
      "</div>" +
    "</article>";
  }

  function drawMore() {
    if (drawn >= rows.length) return;
    var html = "";
    var end = Math.min(rows.length, drawn + BATCH);
    for (var i = drawn; i < end; i++) html += cardHTML(rows[i]);
    listEl.insertAdjacentHTML("beforeend", html);
    drawn = end;
  }

  var counts = { todo: 0, seen: 0, like: 0, discard: 0 };
  function render(keepScroll) {
    var all = DATA.filter(passes);
    counts = { todo: 0, seen: 0, like: 0, discard: 0 };
    var mine = [];
    all.forEach(function (l) {
      var st = stateOf(l);
      counts[st]++;
      if (st === tab || (tab === "todo" && st === "seen" && keepHere.has(l.id))) mine.push(l);
    });
    mine.sort(SORTS[F.sort] || SORTS.new);
    rows = mine;
    filtered = all;
    drawn = 0;
    var y = window.scrollY;
    listEl.innerHTML = "";
    drawMore();
    if (keepScroll) { while (drawn < rows.length && listEl.scrollHeight < y + innerHeight) drawMore(); window.scrollTo(0, y); }
    paintCounts();
    paintChips();
    paintEmpty();
    if (!$("#map").hidden) plotMap();
    if (typeof pump === "function") pump();
  }
  var filtered = [];

  // after a flat is opened: move one count from Unviewed to Viewed, no re-render
  function paintCountsOnly() {
    counts = { todo: 0, seen: 0, like: 0, discard: 0 };
    filtered.forEach(function (l) { counts[stateOf(l)]++; });
    paintCounts();
  }
  function repaintCard(l) {
    var el = listEl.querySelector('.card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(l.id) : l.id) + '"]');
    if (!el) return;
    var tr = el.querySelector(".gal-track"), x = tr ? tr.scrollLeft : 0;
    el.outerHTML = cardHTML(l);
    var fresh = listEl.querySelector('.card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(l.id) : l.id) + '"] .gal-track');
    if (fresh) fresh.scrollLeft = x;
  }
  function paintCounts() {
    $("#nTodo").textContent = counts.todo;
    $("#nSeen").textContent = counts.seen;
    $("#nLike").textContent = counts.like;
    $("#nDiscard").textContent = counts.discard;
    $$(".tab").forEach(function (t) { t.classList.toggle("on", t.dataset.tab === tab); });
    var n = activeCount(), b = $("#filterCount");
    b.hidden = !n; b.textContent = n;
  }
  function paintEmpty() {
    var e = $("#empty");
    if (rows.length) { e.hidden = true; return; }
    e.hidden = false;
    e.innerHTML = tab === "todo"
      ? (filtered.length ? "<b>All caught up.</b>New flats arrive twice a day." : "<b>No matches.</b>Try loosening the filters.")
      : tab === "seen" ? "Nothing viewed but undecided with these filters. A flat lands here when you open its photos, its ad or its map pin."
      : tab === "like" ? "No liked flats with these filters yet."
      : "No disliked flats with these filters.";
  }

  // Active filters as one-tap-removable chips, so nothing is ever hidden silently.
  function paintChips() {
    var c = [];
    if (F.max != null) c.push(["max", "≤ " + F.max + " €"]);
    if (F.rooms.length) c.push(["rooms", F.rooms.map(function (r) { return r === 4 ? "4+" : r; }).join(", ") + " rooms"]);
    if (F.area != null) c.push(["area", "≥ " + F.area + " m²"]);
    if (F.zones.length) c.push(["zones", zonesLabel()]);
    if (F.districts.length) c.push(["districts", F.districts.length > 2 ? F.districts.slice(0, 2).join(", ") + " +" + (F.districts.length - 2) : F.districts.join(", ")]);
    var FL = { fresh: "last 3 days", util: "utilities incl.", reno: "renovated", furn: "furnished", photos: "has photos" };
    F.flags.forEach(function (f) { c.push(["flag:" + f, FL[f] || f]); });
    if (F.q) c.push(["q", "“" + F.q + "”"]);
    var sortTxt = { new: "newest", cheap: "cheapest", ppm: "€/m²", big: "biggest" }[F.sort];
    $("#chips").innerHTML = c.map(function (x) {
      return '<button class="chip" type="button" data-k="' + esc(x[0]) + '">' + esc(x[1]) + ' <b>×</b></button>';
    }).join("") + '<button class="chip sort" type="button" data-k="sort">↕ ' + esc(sortTxt) + "</button>";
  }

  // ---------------------------------------------------------------- voting
  var toastTimer = null, undoSnap = null;
  function toast(msg, snap) {
    undoSnap = snap || null;
    $("#toastMsg").textContent = msg;
    $("#toastUndo").hidden = !snap;
    var t = $("#toast"); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; undoSnap = null; }, 4500);
  }

  function vote(card, v) {
    var l = byId[card.dataset.id]; if (!l) return;
    var snap = snapshot(l), cur = verdictOf(l);
    var next = cur === v ? null : v; // tapping the active verdict clears it
    setVerdict(l, next);
    var leaves = stateOf(l) !== tab;
    if (leaves) {
      card.classList.add(next === "like" ? "fly-right" : next === "discard" ? "fly-left" : "fly-up");
      setTimeout(function () { render(true); }, 260);
    } else {
      render(true);
    }
    toast(next === "like" ? "Saved to Liked" : next === "discard" ? "Moved to Disliked" : "Back in " + (seenOf(l) ? "Viewed" : "Unviewed"), snap);
  }

  // ------------------------------------------------------------- lightbox
  var lb = $("#lb"), lbTrack = $("#lbTrack"), lbL = null;
  function openLB(l, i) {
    lbL = l;
    var ps = photos(l);
    if (!ps.length) return;
    markSeen(l);
    lbTrack.innerHTML = ps.map(function (p, k) {
      return '<figure><img ' + (Math.abs(k - i) > 1 ? 'loading="lazy" ' : "") + 'src="' + esc(imgUrl(l.img.k, p, "full")) + '" alt="" decoding="async"></figure>';
    }).join("");
    lb.hidden = false;
    document.body.classList.add("noscroll");
    lbTrack.scrollLeft = i * lbTrack.clientWidth;
    lbCount();
  }
  function lbCount() {
    var n = photos(lbL || {}).length;
    var i = Math.round(lbTrack.scrollLeft / Math.max(1, lbTrack.clientWidth));
    $("#lbCount").textContent = (i + 1) + " / " + n;
  }
  function closeLB() { lb.hidden = true; lbTrack.innerHTML = ""; document.body.classList.remove("noscroll"); }
  lbTrack.addEventListener("scroll", lbCount, { passive: true });
  $("#lbClose").addEventListener("click", closeLB);

  // ------------------------------------------------------------------ map
  var map = null, layer = null, zoneLayer = null;
  function ensureMap() {
    if (map || typeof L === "undefined") return map;
    map = L.map("mapCanvas", { preferCanvas: true, zoomControl: true }).setView([56.951, 24.113], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    layer = L.layerGroup().addTo(map);
    wireDrawing();
    return map;
  }
  var COL = (META.brand && META.brand.pins) || { like: "#16a34a", discard: "#9ca3af", todo: "#2563eb", seen: "#7c3aed" };
  function popupHTML(l) {
    var ps = photos(l), v = verdictOf(l);
    return '<div class="mpop" data-id="' + esc(l.id) + '">' +
      (ps.length ? '<img src="' + esc(imgUrl(l.img.k, ps[0], "grid")) + '" alt="">' : "") +
      "<b>" + (l.price == null ? "—" : esc(l.price) + " €") + "</b> · " +
      [l.rooms != null ? roomsTxt(l.rooms) : "", l.area != null ? l.area + " m²" : ""].filter(Boolean).join(" · ") +
      "<br><small>" + esc(l.street || "") + "</small>" +
      '<div class="mvote"><button data-v="discard" class="' + (v === "discard" ? "on" : "") + '">Pass</button>' +
      '<button data-v="like" class="' + (v === "like" ? "on" : "") + '">Like</button>' +
      '<a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener">open ↗</a></div></div>';
  }
  var mapOnly = null;
  function plotMap() {
    if (!ensureMap()) return;
    layer.clearLayers();
    zoneLayer.clearLayers();
    F.zones.forEach(function (z) {
      L.polygon(z, { color: "#2563eb", weight: 2, fillOpacity: 0.08, dashArray: "6 4", interactive: false }).addTo(zoneLayer);
    });
    paintDrawBtns();
    var pts = [];
    var src = mapOnly ? [mapOnly] : rows;
    src.forEach(function (l) {
      if (l.lat == null) return;
      var v = stateOf(l);
      var m = L.circleMarker([l.lat, l.lon], {
        radius: mapOnly ? 10 : 7, weight: 2, color: "#fff", fillColor: COL[v], fillOpacity: 0.95,
      });
      m.bindPopup(function () { return popupHTML(l); }, { maxWidth: 240 });
      m.on("popupopen", function () { markSeen(l); });
      m.addTo(layer);
      pts.push([l.lat, l.lon]);
    });
    var noGeo = src.length - pts.length;
    $("#mapTitle").textContent = mapOnly
      ? (mapOnly.street || "Location")
      : pts.length + (pts.length === 1 ? " flat" : " flats") + " on the map" +
        (noGeo ? " · " + noGeo + " without a location" : "");
    if (noFit) return;
    if (pts.length === 1) map.setView(pts[0], 16);
    else if (pts.length) map.fitBounds(coreBounds(pts), { padding: [24, 24], maxZoom: 15 });
    else if (F.zones.length) map.fitBounds([].concat.apply([], F.zones), { padding: [24, 24] });
  }
  var noFit = false; // keep the view still right after the user draws an area
  // Frame where the flats actually are: a handful of listings out in the
  // suburbs would otherwise zoom the whole city out to a speck.
  function coreBounds(pts) {
    if (pts.length < 20) return pts;
    var la = pts.map(function (p) { return p[0]; }).sort(function (a, b) { return a - b; });
    var lo = pts.map(function (p) { return p[1]; }).sort(function (a, b) { return a - b; });
    var q = function (arr, f) { return arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))]; };
    return [[q(la, 0.04), q(lo, 0.04)], [q(la, 0.96), q(lo, 0.96)]];
  }

  // ------------------------------------------------------------ draw area
  // Press "Draw area", drag a line around any part of the city, let go: the
  // shape closes itself and becomes a filter. The list, the counts and the
  // pins then show only flats inside it. Several areas add up; "Clear" drops them.
  var drawArmed = false, drawPts = null, drawLine = null;
  function paintDrawBtns() {
    var b = $("#drawBtn"), c = $("#clearZonesBtn"), h = $("#drawHint");
    b.textContent = drawArmed ? "Cancel" : F.zones.length ? "Add area" : "Draw area";
    b.classList.toggle("primary", !drawArmed && !F.zones.length);
    c.hidden = !F.zones.length || drawArmed;
    h.hidden = !drawArmed;
    $("#map").classList.toggle("is-drawing", drawArmed);
  }
  function armDraw() {
    if (!ensureMap()) return;
    mapOnly = null;
    drawArmed = true;
    map.closePopup();
    map.dragging.disable();
    if (map.touchZoom) map.touchZoom.disable();
    if (map.doubleClickZoom) map.doubleClickZoom.disable();
    paintDrawBtns();
  }
  function disarmDraw() {
    drawArmed = false;
    drawPts = null;
    if (drawLine && map) { drawLine.remove(); drawLine = null; }
    if (map) {
      map.dragging.enable();
      if (map.touchZoom) map.touchZoom.enable();
      if (map.doubleClickZoom) map.doubleClickZoom.enable();
    }
    paintDrawBtns();
  }
  function finishDraw() {
    var pts = drawPts;
    disarmDraw();
    if (!pts || pts.length < 4) { toast("Drag a line around the area you want"); return; }
    // at most ~120 points at 5 decimals (about 1 m): plenty for a hand-drawn shape
    var step = Math.max(1, Math.ceil(pts.length / 120));
    var ring = pts.filter(function (_, i) { return i % step === 0; }).map(function (p) {
      return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
    });
    F.zones.push(ring);
    save(LS_FILTERS, F);
    noFit = true;
    render();
    noFit = false;
    var n = rows.length;
    toast("Area added · " + n + (n === 1 ? " flat" : " flats") + " inside");
  }
  function wireDrawing() {
    var c = map.getContainer();
    function toLatLng(e) {
      var r = c.getBoundingClientRect();
      return map.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    }
    c.addEventListener("pointerdown", function (e) {
      if (!drawArmed || !e.isPrimary) return;
      e.preventDefault();
      e.stopPropagation();
      var ll = toLatLng(e);
      drawPts = [[ll.lat, ll.lng]];
      drawLine = L.polyline([[ll.lat, ll.lng]], { color: "#2563eb", weight: 3 }).addTo(map);
      if (c.setPointerCapture) try { c.setPointerCapture(e.pointerId); } catch (err) {}
    }, true);
    c.addEventListener("pointermove", function (e) {
      if (!drawArmed || !drawPts) return;
      e.preventDefault();
      var ll = toLatLng(e);
      var last = drawPts[drawPts.length - 1];
      if (map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 6) return;
      drawPts.push([ll.lat, ll.lng]);
      drawLine.setLatLngs(drawPts);
    }, true);
    c.addEventListener("pointerup", function () { if (drawArmed && drawPts) finishDraw(); }, true);
    c.addEventListener("pointercancel", function () { if (drawArmed) disarmDraw(); }, true);
  }
  $("#drawBtn").addEventListener("click", function () { if (drawArmed) disarmDraw(); else armDraw(); });
  $("#clearZonesBtn").addEventListener("click", function () {
    F.zones = []; save(LS_FILTERS, F); render(); toast("Areas cleared");
  });
  function openMap(one) {
    mapOnly = one || null;
    $("#map").hidden = false;
    document.body.classList.add("noscroll");
    ensureMap();
    setTimeout(function () { if (map) { map.invalidateSize(); plotMap(); } }, 30);
  }
  function closeMap() {
    if (drawArmed) disarmDraw();
    $("#map").hidden = true; document.body.classList.remove("noscroll"); mapOnly = null;
  }
  $("#mapClose").addEventListener("click", closeMap);
  $("#mapCanvas").addEventListener("click", function (e) {
    var b = e.target.closest(".mvote button"); if (!b) return;
    var box = b.closest(".mpop"), l = byId[box.dataset.id]; if (!l) return;
    var snap = snapshot(l), next = verdictOf(l) === b.dataset.v ? null : b.dataset.v;
    setVerdict(l, next);
    if (map) map.closePopup();
    render(true);
    toast(next === "like" ? "Saved to Liked" : next === "discard" ? "Moved to Disliked" : "Back in " + (seenOf(l) ? "Viewed" : "Unviewed"), snap);
  });

  // ---------------------------------------------------------- filter sheet
  var sheet = $("#sheet");
  function districtList() {
    var cnt = {};
    DATA.forEach(function (l) { if (l.district && l.district !== "Rīga") cnt[l.district] = (cnt[l.district] || 0) + 1; });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a] || a.localeCompare(b); })
      .map(function (d) { return [d, cnt[d]]; });
  }
  function buildSheet() {
    $$(".presets").forEach(function (p) {
      p.innerHTML = p.dataset.vals.split(",").map(function (v) { return '<button type="button" data-v="' + v + '">' + v + "</button>"; }).join("");
    });
    $("#fDistricts").innerHTML = districtList().map(function (d) {
      return '<button type="button" data-v="' + esc(d[0]) + '">' + esc(d[0]) + " <small>" + d[1] + "</small></button>";
    }).join("");
  }
  function paintSheet() {
    $("#fMax").value = F.max == null ? "" : F.max;
    $("#fArea").value = F.area == null ? "" : F.area;
    $("#fQ").value = F.q || "";
    $("#fSort").value = F.sort;
    $$('.presets[data-for="fMax"] button').forEach(function (b) { b.classList.toggle("on", +b.dataset.v === F.max); });
    $$('.presets[data-for="fArea"] button').forEach(function (b) { b.classList.toggle("on", +b.dataset.v === F.area); });
    $$("#fRooms button").forEach(function (b) { b.classList.toggle("on", F.rooms.indexOf(+b.dataset.v) >= 0); });
    $$("#fDistricts button").forEach(function (b) { b.classList.toggle("on", F.districts.indexOf(b.dataset.v) >= 0); });
    $$("#fFlags button").forEach(function (b) { b.classList.toggle("on", F.flags.indexOf(b.dataset.v) >= 0); });
    $("#zoneInfo").textContent = F.zones.length
      ? "Showing only flats inside your " + zonesLabel() + "."
      : "Draw one or more areas on the map to search only there.";
    $("#zoneDraw").textContent = F.zones.length ? "Add another area" : "Draw on map";
    $("#zoneClear").hidden = !F.zones.length;
    var n = DATA.filter(passes).filter(function (l) { return stateOf(l) === tab; }).length;
    $("#applyBtn").textContent = "Show " + n + (n === 1 ? " flat" : " flats");
  }
  function changed() { save(LS_FILTERS, F); paintSheet(); render(); }
  function toggleIn(arr, v) { var i = arr.indexOf(v); if (i < 0) arr.push(v); else arr.splice(i, 1); }
  function numOrNull(v) { v = parseFloat(v); return isFinite(v) && v > 0 ? v : null; }

  sheet.addEventListener("click", function (e) {
    if (e.target.closest("[data-close]")) { sheet.hidden = true; document.body.classList.remove("noscroll"); return; }
    var b = e.target.closest("button[data-v]"); if (!b) return;
    var box = b.parentNode, v = b.dataset.v;
    if (box.classList.contains("presets")) {
      var key = box.dataset.for === "fMax" ? "max" : "area";
      F[key] = F[key] === +v ? null : +v;
    } else if (box.id === "fRooms") toggleIn(F.rooms, +v);
    else if (box.id === "fDistricts") toggleIn(F.districts, v);
    else if (box.id === "fFlags") toggleIn(F.flags, v);
    changed();
  });
  var debounce = function (fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; };
  $("#fMax").addEventListener("input", debounce(function () { F.max = numOrNull($("#fMax").value); changed(); }, 300));
  $("#fArea").addEventListener("input", debounce(function () { F.area = numOrNull($("#fArea").value); changed(); }, 300));
  $("#fQ").addEventListener("input", debounce(function () { F.q = $("#fQ").value.trim(); changed(); }, 300));
  $("#fSort").addEventListener("change", function () { F.sort = $("#fSort").value; changed(); });
  $("#resetBtn").addEventListener("click", function () {
    F = freshF(); changed();
  });
  function openSheet(focus) {
    $("#toast").hidden = true;
    paintSheet(); sheet.hidden = false; document.body.classList.add("noscroll");
    if (focus) setTimeout(function () { var el = $(focus); if (el) el.scrollIntoView({ block: "center" }); }, 50);
  }
  $("#filterBtn").addEventListener("click", function () { openSheet(); });
  function closeSheet() { sheet.hidden = true; document.body.classList.remove("noscroll"); }
  $("#zoneDraw").addEventListener("click", function () {
    closeSheet();
    openMap(null);
    setTimeout(armDraw, 80);
  });
  $("#zoneClear").addEventListener("click", function () { F.zones = []; changed(); });

  $("#chips").addEventListener("click", function (e) {
    var c = e.target.closest(".chip"); if (!c) return;
    var k = c.dataset.k;
    if (k === "sort") { openSheet("#fSort"); return; }
    if (k.indexOf("flag:") === 0) toggleIn(F.flags, k.slice(5));
    else if (k === "rooms" || k === "districts" || k === "zones") F[k] = [];
    else if (k === "q") F.q = "";
    else F[k] = null;
    changed();
  });

  // ----------------------------------------------------------------- tabs
  $$(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      tab = t.dataset.tab; save(LS_TAB, tab); keepHere.clear(); render(); window.scrollTo(0, 0);
    });
  });

  // ------------------------------------------------------------ card events
  listEl.addEventListener("click", function (e) {
    var card = e.target.closest(".card"); if (!card) return;
    var l = byId[card.dataset.id];
    var vb = e.target.closest(".vote button");
    if (vb) { vote(card, vb.dataset.v); return; }
    if (e.target.closest(".addr")) { if (l && l.lat != null) { markSeen(l); openMap(l); } return; }
    if (e.target.closest(".seentoggle")) {
      if (seenOf(l)) { markUnseen(l); keepHere.delete(l.id); render(true); toast("Back in Unviewed"); }
      else markSeen(l);
      return;
    }
    var a = e.target.closest(".links a");
    if (a) { markSeen(l); return; }
    var img = e.target.closest(".gal img");
    if (img) { openLB(l, +img.dataset.i || 0); return; }
    if (e.target.closest(".desc")) e.target.closest(".desc").classList.toggle("open");
  });
  // the photo counter follows a swipe through the card gallery
  listEl.addEventListener("scroll", function (e) {
    var tr = e.target;
    if (!tr.classList || !tr.classList.contains("gal-track")) return;
    var gal = tr.parentNode, c = $(".gal-count", gal); if (!c) return;
    var i = Math.round(tr.scrollLeft / Math.max(1, tr.clientWidth));
    c.textContent = (i + 1) + "/" + gal.dataset.n;
  }, true);
  // a missing photo just drops out of the gallery
  listEl.addEventListener("error", function (e) {
    if (e.target.tagName === "IMG") e.target.remove();
  }, true);

  $("#toastUndo").addEventListener("click", function () {
    if (!undoSnap) return;
    restore(undoSnap); undoSnap = null; $("#toast").hidden = true; render(true);
  });

  $("#mapBtn").addEventListener("click", function () { openMap(null); });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!lb.hidden) closeLB();
      else if (!$("#map").hidden) { if (drawArmed) disarmDraw(); else closeMap(); }
      else if (!sheet.hidden) { sheet.hidden = true; document.body.classList.remove("noscroll"); }
    }
    if (!lb.hidden && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      lbTrack.scrollBy({ left: (e.key === "ArrowRight" ? 1 : -1) * lbTrack.clientWidth, behavior: "smooth" });
    }
  });

  // ---------------------------------------------------------------- backup
  $("#exportBtn").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(stateObj(), null, 1)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "user-state.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    toast("Backup downloaded");
  });
  $("#importBtn").addEventListener("click", function () {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var d = JSON.parse(r.result), n = 0;
          // merging only fills gaps, it never wipes a verdict made here
          for (var id in d.pile || {}) if (!pile[id]) { pile[id] = d.pile[id]; cleared.delete(id); n++; }
          (d.visited || []).forEach(function (i) { visited.add(i); });
          save(LS_SEEN, Array.from(visited)); persist(); render();
          toast(n + (n === 1 ? " vote" : " votes") + " restored");
        } catch (err) { toast("Could not read that file"); }
      };
      r.readAsText(f);
    };
    inp.click();
  });

  // ----------------------------------------------------------- cloud sync
  // With META.firebase set (config.json → "firebase"), a "Sign in" button
  // appears. Signed in with Google, votes and views live in one Firestore
  // document per person, users/{uid}:
  //   pile: { listingId: "like" | "discard" | "" }   ("" = cleared)
  //   seen: { listingId: true | false }
  // Every device that signs in to the same account reads and writes that one
  // document live, so the browser is only a cache. Without Firebase config the
  // page simply keeps using this browser's storage, as before.
  var FB = META.firebase || null;
  var cloud = { user: null, ref: null, unsub: null };
  var outPile = {}, outSeen = {}, outTimer = null;
  function cloudPile(id, v) { if (!cloud.ref) return; outPile[id] = v; flushSoon(); }
  function cloudSeen(id, v) { if (!cloud.ref) return; outSeen[id] = v; flushSoon(); }
  function flushSoon() { clearTimeout(outTimer); outTimer = setTimeout(flushCloud, 500); }
  function flushCloud() {
    if (!cloud.ref) return;
    var body = { updated: firebase.firestore.FieldValue.serverTimestamp() };
    if (Object.keys(outPile).length) body.pile = outPile;
    if (Object.keys(outSeen).length) body.seen = outSeen;
    outPile = {}; outSeen = {};
    // merge:true merges the nested maps key by key, so two devices never
    // overwrite each other's other votes
    cloud.ref.set(body, { merge: true }).catch(function (e) { paintSync("Sync error: " + (e && e.code || e)); });
  }
  // the cloud copy wins: it is what every device agrees on
  function applyRemote(d) {
    var changed = false, id;
    var rp = (d && d.pile) || {}, rs = (d && d.seen) || {};
    for (id in rp) {
      var v = rp[id];
      if (v) { if (pile[id] !== v) { pile[id] = v; cleared.delete(id); changed = true; } }
      else if (pile[id]) { delete pile[id]; cleared.add(id); changed = true; }
    }
    for (id in rs) {
      if (rs[id] && !visited.has(id)) { visited.add(id); changed = true; }
      else if (!rs[id] && visited.has(id)) { visited.delete(id); changed = true; }
    }
    if (changed) {
      save(LS_PILE, pile); save(LS_CLEARED, Array.from(cleared)); save(LS_SEEN, Array.from(visited));
      render(true);
    }
  }
  function paintSync(msg) {
    var b = $("#authBtn");
    if (!b) return;
    b.hidden = !FB;
    if (cloud.user) {
      b.textContent = (cloud.user.displayName || cloud.user.email || "Signed in").split(" ")[0];
      b.classList.add("signed");
      b.title = "Synced to " + (cloud.user.email || "your account") + " · tap to sign out";
      $("#saveNote").textContent = msg || ("Your votes and views are saved to your Google account (" +
        (cloud.user.email || "signed in") + ") and sync between your devices.");
    } else {
      b.textContent = "Sign in";
      b.classList.remove("signed");
      b.title = "Sign in with Google to keep your votes in your account";
      if (msg) $("#saveNote").textContent = msg; else paintSaveNote();
    }
  }
  function startCloud(user) {
    cloud.user = user;
    cloud.ref = firebase.firestore().collection("users").doc(user.uid);
    paintSync("Syncing…");
    // First, hand the cloud anything this browser knew that the account did
    // not (e.g. votes made before signing in). Then follow it live.
    cloud.ref.get().then(function (snap) {
      var d = snap.exists ? snap.data() : {};
      var rp = d.pile || {}, rs = d.seen || {}, up = { pile: {}, seen: {} }, n = 0;
      Object.keys(pile).forEach(function (id) { if (!(id in rp)) { up.pile[id] = pile[id] === "maybe" ? "like" : pile[id]; n++; } });
      visited.forEach(function (id) { if (!(id in rs)) { up.seen[id] = true; n++; } });
      return n ? cloud.ref.set(up, { merge: true }) : null;
    }).then(function () {
      cloud.unsub = cloud.ref.onSnapshot(function (snap) {
        applyRemote(snap.exists ? snap.data() : {});
        paintSync();
      }, function (e) { paintSync("Sync error: " + (e && e.code || e)); });
    }).catch(function (e) { paintSync("Sync error: " + (e && e.code || e)); });
  }
  function stopCloud() {
    if (cloud.unsub) cloud.unsub();
    cloud = { user: null, ref: null, unsub: null };
    paintSync();
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var sc = document.createElement("script");
      sc.src = src; sc.onload = res; sc.onerror = rej;
      document.head.appendChild(sc);
    });
  }
  function initCloud() {
    if (!FB || !FB.apiKey) return;
    var v = "https://www.gstatic.com/firebasejs/10.12.2/";
    $("#authBtn").hidden = false;
    loadScript(v + "firebase-app-compat.js")
      .then(function () { return Promise.all([loadScript(v + "firebase-auth-compat.js"), loadScript(v + "firebase-firestore-compat.js")]); })
      .then(function () {
        firebase.initializeApp(FB);
        firebase.auth().onAuthStateChanged(function (u) { if (u) startCloud(u); else stopCloud(); });
        // a sign-in that had to fall back to a full-page redirect lands here
        firebase.auth().getRedirectResult().catch(function () {});
      })
      .catch(function () { paintSync("Could not load sign-in (offline?). Votes are kept in this browser for now."); });
    $("#authBtn").addEventListener("click", function () {
      if (typeof firebase === "undefined") return;
      if (cloud.user) {
        if (confirm("Signed in as " + (cloud.user.email || "you") + ". Sign out on this device?")) firebase.auth().signOut();
        return;
      }
      var prov = new firebase.auth.GoogleAuthProvider();
      firebase.auth().signInWithPopup(prov).catch(function (e) {
        if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment"))
          firebase.auth().signInWithRedirect(prov);
        else if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
          toast("Sign-in failed: " + (e.message || e.code));
      });
    });
  }

  // ----------------------------------------------------------------- boot
  buildSheet();
  render();
  // keep drawing while the end of the list is within ~2 screens
  var pumping = false;
  function pump() {
    if (pumping) return;
    pumping = true;
    requestAnimationFrame(function () {
      pumping = false;
      if (drawn < rows.length && sentinel.getBoundingClientRect().top < innerHeight * 2.5) { drawMore(); pump(); }
    });
  }
  window.addEventListener("scroll", pump, { passive: true });
  window.addEventListener("resize", pump, { passive: true });
  pump();
  if (/^https?:$/.test(location.protocol)) {
    fetch("/api/ping").then(function (r) { api = r.ok; paintSaveNote(); }).catch(function () { api = false; paintSaveNote(); });
  }
  paintSaveNote();
  initCloud();

  // A tab left open picks up the next build by itself, when it is not in use.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !/^https?:$/.test(location.protocol)) return;
    if (Date.now() - META.builtAt < 3 * 3600e3) return;
    fetch(location.href, { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (t) {
      var m = /builtAt":(\d+)/.exec(t);
      if (m && +m[1] > META.builtAt) location.reload();
    }).catch(function () {});
  });
})();
