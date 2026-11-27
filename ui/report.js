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
    basket: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h16l-1.6 9.2a2 2 0 0 1-2 1.8H7.6a2 2 0 0 1-2-1.8z"/><path d="M9 9l3-5 3 5"/></svg>',
    sort: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5"/></svg>',
    ext: '<svg class="ic ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
    up: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
    left: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  };
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }
  var narrow = window.matchMedia ? window.matchMedia("(max-width: 640px)") : { matches: false };
  function photos(l) { return (l.img && l.img.p) || []; }

  // "Rimi 140 m · T 320 m · B 90 m": what is round the corner
  function dist(m) { return m < 1000 ? m + " m" : (m / 1000).toFixed(1) + " km"; }
  function nearHTML(l) {
    var n = l.near; if (!n) return "";
    var bits = [];
    if (n.g) bits.push('<span class="near-i" title="Nearest big supermarket">' + ICON.basket + esc(n.g[0]) + " <b>" + dist(n.g[1]) + "</b></span>");
    if (n.t) bits.push('<span class="near-i" title="Nearest tram stop' + (n.t[0] ? ": " + esc(n.t[0]) : "") + '"><i class="poi-dot t">T</i><b>' + dist(n.t[1]) + "</b></span>");
    if (n.b) bits.push('<span class="near-i" title="Nearest bus stop' + (n.b[0] ? ": " + esc(n.b[0]) : "") + '"><i class="poi-dot b">B</i><b>' + dist(n.b[1]) + "</b></span>");
    return bits.length ? '<div class="near">' + bits.join("") + "</div>" : "";
  }
  function cardHTML(l) {
    // the large rendition everywhere: the small one was blurry on desktop
    // and retina screens; only the visible photo and the next one load
    var v = verdictOf(l), size = "card";
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
      deckHTML(l, size, false,
        (seen ? '<span class="pill seen">Viewed</span>' : l.isNew ? '<span class="pill new">New</span>' : "") +
        (nSites > 1 ? '<span class="pill multi" title="The same flat on several sites">' + nSites + " sites</span>" : "")) +
      '<div class="info">' +
        '<div class="row1"><span class="price">' + (l.price == null ? "—" : esc(l.price) + " €") + "</span>" +
          (l.pricePerM2 != null ? '<span class="ppm">' + esc(l.pricePerM2) + " €/m²</span>" : "") +
          '<span class="age">' + esc(ago(l.firstSeen || l.date)) + "</span></div>" +
        '<div class="facts">' + facts.join(" · ") + "</div>" +
        '<button class="addr" type="button"' + (l.lat != null ? "" : " disabled") + ">" +
          ICON.pin + esc(l.street || "no address") + (l.district && l.district !== "Rīga" ? ", " + esc(l.district) : "") + "</button>" +
        nearHTML(l) +
        (tags.length ? '<div class="tags">' + tags.join("") + "</div>" : "") +
        (l.description ? '<p class="desc">' + esc(l.description) + "</p>" : "") +
        '<div class="links">' + links.map(function (a) {
          return '<a href="' + esc(safeUrl(a.url)) + '" target="_blank" rel="noopener">' + esc(a.label) + ICON.ext + "</a>";
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
    var el = listEl.querySelector('.card[data-id="' + cssEsc(l.id) + '"]');
    if (!el) return;
    var dk = el.querySelector(".deck"), at = dk ? +dk.dataset.i : 0;
    el.outerHTML = cardHTML(l);
    var fresh = listEl.querySelector('.card[data-id="' + cssEsc(l.id) + '"] .deck');
    if (fresh && at) { fresh.dataset.i = at; layoutDeck(fresh); }
  }
  // The tabs and filter chips fold away with the handle under the header (and
  // stay as you left them). Folded, the subtitle says where you are.
  var BAR = load("rr2.bar", "open");
  var TABNAME = { todo: "Unviewed", seen: "Viewed", like: "Liked", discard: "Disliked" };
  function paintBar() {
    var folded = BAR === "closed", b = $("#barToggle");
    $(".top").classList.toggle("folded", folded);
    b.setAttribute("aria-expanded", String(!folded));
    b.setAttribute("aria-label", folded ? "Show tabs and filters" : "Hide tabs and filters");
    b.title = folded ? "Show tabs and filters" : "Hide tabs and filters";
    paintSub();
  }
  function paintSub() {
    var sub = $("#sub");
    if (!sub.dataset.base) sub.dataset.base = sub.textContent;
    var n = activeCount();
    sub.textContent = BAR === "closed"
      ? TABNAME[tab] + " · " + (counts[tab] || 0) + (n ? " · " + n + (n === 1 ? " filter" : " filters") : "")
      : sub.dataset.base;
  }
  function paintCounts() {
    paintSub();
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
    }).join("") + '<button class="chip sort" type="button" data-k="sort">' + ICON.sort + esc(sortTxt) + "</button>";
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
  // ------------------------------------------------------------ photo deck
  // Photos are a stack of cards, never a sliding strip. Swipe left (or tap ›)
  // and the top photo falls away to show the next; swipe right (or ‹) and the
  // previous photo comes back up onto the stack. The same deck runs inside
  // each card and full screen. Vertical swipes stay page scrolls.
  function deckHTML(l, size, big, extra) {
    var ps = photos(l), n = ps.length;
    if (!n) return '<div class="gal deck is-empty"><div class="nophoto">No photos</div>' + (extra || "") + "</div>";
    var imgs = ps.map(function (p, k) {
      var src = esc(imgUrl(l.img.k, p, size));
      return '<img class="ph ' + (k === 0 ? "cur" : k === 1 ? "b1" : k === 2 ? "b2" : "hidden") + '" data-k="' + k + '" ' +
        (k < 2 ? 'src="' + src + '"' : 'data-src="' + src + '"') + ' alt="" draggable="false" decoding="async" loading="lazy">';
    }).join("");
    return '<div class="gal deck' + (big ? " big" : "") + '" data-n="' + n + '" data-i="0">' +
      '<div class="deck-stack">' + imgs + "</div>" + (extra || "") +
      (n > 1
        ? '<span class="gal-count">1 / ' + n + "</span>" +
          '<button class="deck-btn prev" type="button" aria-label="Previous photo" disabled>' + ICON.left + "</button>" +
          '<button class="deck-btn next" type="button" aria-label="Next photo">' + ICON.right + "</button>"
        : "") +
      "</div>";
  }
  function phAt(d, k) { return d.querySelector('.ph[data-k="' + k + '"]'); }
  function loadPh(img) { if (img && img.dataset.src) { img.src = img.dataset.src; img.removeAttribute("data-src"); } }
  function layoutDeck(d) {
    var i = +d.dataset.i, n = +d.dataset.n;
    $$(".ph", d).forEach(function (img) {
      var rel = +img.dataset.k - i, broken = img.classList.contains("broken");
      img.style.transition = ""; img.style.transform = ""; img.style.opacity = ""; img.style.filter = "";
      img.className = "ph " + (rel < 0 ? "gone" : rel === 0 ? "cur" : rel === 1 ? "b1" : rel === 2 ? "b2" : "hidden") + (broken ? " broken" : "");
      if (rel >= -1 && rel <= 1) loadPh(img); // this photo, the next, and the one a swipe back brings
    });
    var c = $(".gal-count", d); if (c) c.textContent = (i + 1) + " / " + n;
    var pb = $(".deck-btn.prev", d), nb = $(".deck-btn.next", d);
    if (pb) pb.disabled = i <= 0;
    if (nb) nb.disabled = i >= n - 1;
    if (d === lbDeck) $("#lbCount").textContent = (i + 1) + " / " + n;
  }
  var FALL = 380;
  function stepDeck(d, dir, fromDrag) {
    if (!d || d.dataset.busy) return;
    var i = +d.dataset.i, n = +d.dataset.n;
    if (dir > 0) {
      if (i >= n - 1) return nudgeDeck(d, -1);
      var top = phAt(d, i), nx = phAt(d, i + 1);
      d.dataset.busy = 1;
      top.style.transition = "transform " + FALL + "ms cubic-bezier(.5,0,.75,.4), opacity " + FALL + "ms ease-in";
      top.style.transform = "translate(-120%, 90px) rotate(-18deg)";
      top.style.opacity = "0";
      if (nx) { nx.style.transform = "none"; nx.style.filter = "none"; } // the next one rises as this one falls
      setTimeout(function () { d.dataset.i = i + 1; delete d.dataset.busy; layoutDeck(d); }, FALL);
    } else {
      if (i <= 0) return nudgeDeck(d, 1);
      var pv = phAt(d, i - 1), cur = phAt(d, i);
      loadPh(pv);
      d.dataset.busy = 1;
      if (!fromDrag) {
        pv.className = "ph incoming";
        pv.style.transition = "none";
        pv.style.transform = "translate(-120%, 90px) rotate(-18deg)";
        pv.style.opacity = "0";
        void pv.offsetWidth;
      }
      pv.style.transition = "transform " + FALL + "ms cubic-bezier(.2,.8,.2,1), opacity " + FALL + "ms ease-out";
      pv.style.transform = "none";
      pv.style.opacity = "1";
      if (cur) { cur.style.transform = "translateY(7px) scale(.955)"; cur.style.filter = "brightness(.9)"; } // sinks one place
      setTimeout(function () { d.dataset.i = i - 1; delete d.dataset.busy; layoutDeck(d); }, FALL);
    }
  }
  function nudgeDeck(d, sign) {
    var top = phAt(d, +d.dataset.i); if (!top) return;
    top.style.transition = "transform 140ms ease-out";
    top.style.transform = "translateX(" + (sign * 16) + "px)";
    setTimeout(function () { top.style.transform = ""; }, 150);
  }

  // dragging: the browser keeps vertical scrolling (touch-action: pan-y);
  // a horizontal drag moves the photo under the finger
  var drag = null, suppressClick = false;
  function quietClicks() { suppressClick = true; setTimeout(function () { suppressClick = false; }, 60); }
  document.addEventListener("pointerdown", function (e) {
    var d = e.target.closest && e.target.closest(".deck");
    if (!d || d.classList.contains("is-empty") || (e.button && e.button !== 0) || e.target.closest(".deck-btn") || d.dataset.busy) return;
    drag = { d: d, x: e.clientX, y: e.clientY, dx: 0, dy: 0, lock: null, id: e.pointerId, t: Date.now() };
  });
  function dragPaint(d, dx) {
    var i = +d.dataset.i, n = +d.dataset.n, w = d.clientWidth || 300, top = phAt(d, i), pv = phAt(d, i - 1);
    if (dx <= 0) {
      if (pv && pv.classList.contains("incoming")) { pv.className = "ph gone"; pv.style.transform = ""; pv.style.opacity = ""; }
      var k = i >= n - 1 ? 0.25 : 1; // the last photo only gives a little
      top.style.transition = "none";
      top.style.transform = "translate(" + dx * k + "px," + Math.abs(dx) * 0.15 * k + "px) rotate(" + dx * k / 24 + "deg)";
    } else {
      top.style.transform = "";
      if (!pv) { top.style.transition = "none"; top.style.transform = "translateX(" + dx * 0.25 + "px)"; return; }
      loadPh(pv);
      var p = Math.min(1, dx / w);
      pv.className = "ph incoming";
      pv.style.transition = "none";
      pv.style.opacity = String(Math.min(1, 0.35 + p));
      pv.style.transform = "translate(" + (-1.2 * w * (1 - p)) + "px," + 90 * (1 - p) + "px) rotate(" + (-18 * (1 - p)) + "deg)";
    }
  }
  document.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y, d = drag.d, big = d.classList.contains("big");
    if (!drag.lock) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.lock = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      if (drag.lock === "x" || big) { try { d.setPointerCapture(e.pointerId); } catch (err) {} }
    }
    drag.dx = dx; drag.dy = dy;
    if (drag.lock === "y") {
      // full screen: pull the photo down to close
      if (big && dy > 0) {
        $("#lbStage").style.transition = "none";
        $("#lbStage").style.transform = "translateY(" + dy + "px) scale(" + Math.max(0.85, 1 - dy / 1600) + ")";
        lb.style.opacity = String(Math.max(0.35, 1 - dy / 500));
      }
      return;
    }
    dragPaint(d, dx);
  });
  function endDrag(e, cancelled) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var g = drag, d = g.d, dt = Math.max(1, Date.now() - g.t);
    drag = null;
    if (!g.lock) return; // a tap: the click handlers deal with it
    quietClicks();
    if (g.lock === "y") {
      if (d.classList.contains("big")) {
        if (!cancelled && g.dy > 110) closeLB();
        else { $("#lbStage").style.transition = ""; $("#lbStage").style.transform = ""; lb.style.opacity = ""; }
      }
      return;
    }
    var w = d.clientWidth || 300, fast = Math.abs(g.dx) / dt > 0.45;
    var go = !cancelled && (Math.abs(g.dx) > w * 0.2 || (fast && Math.abs(g.dx) > 30));
    var i = +d.dataset.i, n = +d.dataset.n;
    if (go && g.dx < 0 && i < n - 1) stepDeck(d, 1, true);
    else if (go && g.dx > 0 && i > 0) stepDeck(d, -1, true);
    else {
      // not far enough: everything settles back where it was
      var top = phAt(d, i), pv = phAt(d, i - 1);
      top.style.transition = "transform 220ms cubic-bezier(.2,.8,.2,1)"; top.style.transform = "";
      if (pv && pv.classList.contains("incoming")) {
        pv.style.transition = "transform 220ms ease-in, opacity 220ms";
        pv.style.transform = "translate(-120%, 90px) rotate(-18deg)"; pv.style.opacity = "0";
        setTimeout(function () { layoutDeck(d); }, 230);
      }
    }
  }
  document.addEventListener("pointerup", function (e) { endDrag(e, false); });
  document.addEventListener("pointercancel", function (e) { endDrag(e, true); });
  // ‹ › buttons (mouse and keyboard); capture phase, so a card never opens underneath
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".deck-btn");
    if (!b) return;
    e.stopPropagation();
    stepDeck(b.closest(".deck"), b.classList.contains("next") ? 1 : -1);
  }, true);

  // ------------------------------------------------------------- lightbox
  var lb = $("#lb"), lbStage = $("#lbStage"), lbL = null, lbDeck = null;
  function openLB(l, i) {
    var ps = photos(l);
    if (!ps.length) return;
    lbL = l;
    markSeen(l);
    lbStage.innerHTML = deckHTML(l, "full", true);
    lbDeck = $(".deck", lbStage);
    lbDeck.dataset.i = Math.max(0, Math.min(ps.length - 1, i || 0));
    lbStage.style.transform = ""; lb.style.opacity = "";
    lb.hidden = false;
    document.body.classList.add("noscroll");
    layoutDeck(lbDeck);
    overlayOpened("lb");
  }
  function closeLB(fromHistory) {
    if (lb.hidden) return;
    // the card's own stack follows to the photo you stopped at
    var cd = lbL && listEl.querySelector('.card[data-id="' + cssEsc(lbL.id) + '"] .deck');
    if (cd && lbDeck) { cd.dataset.i = lbDeck.dataset.i; layoutDeck(cd); }
    lb.hidden = true; lbStage.innerHTML = ""; lbDeck = null;
    document.body.classList.remove("noscroll");
    if (fromHistory !== true) overlayClosedByUI("lb");
  }
  $("#lbClose").addEventListener("click", function () { closeLB(); });
  // tap the photo for the next one; tap the dark area around it to close
  lb.addEventListener("click", function (e) {
    if (suppressClick) return;
    if (e.target.closest(".lb-bar") || e.target.closest(".deck-btn")) return;
    if (e.target.closest(".ph")) { stepDeck(lbDeck, 1); return; }
    closeLB();
  });
  // full screen, each photo is sized to its own proportions inside the stage,
  // so its frame is exactly the picture (and the dark around it is "outside")
  function fitBig(img) {
    if (!img || !img.naturalWidth || !lbDeck) return;
    var W = lbDeck.clientWidth, H = lbDeck.clientHeight;
    var k = Math.min(W / img.naturalWidth, H / img.naturalHeight, 2);
    img.style.width = Math.round(img.naturalWidth * k) + "px";
    img.style.height = Math.round(img.naturalHeight * k) + "px";
  }
  lb.addEventListener("load", function (e) { if (e.target.classList && e.target.classList.contains("ph")) fitBig(e.target); }, true);
  window.addEventListener("resize", function () { if (lbDeck) $$(".ph", lbDeck).forEach(fitBig); });
  lb.addEventListener("error", function (e) { if (e.target.classList && e.target.classList.contains("ph")) e.target.classList.add("broken"); }, true);

  // ------------------------------------------------- back button = close
  // On a phone the back gesture should close the photo viewer, the filters
  // or the map, not leave the page. Each overlay adds a history entry.
  var overlays = [], ignorePop = 0, CLOSERS = {};
  function overlayOpened(name) {
    overlays.push(name);
    try { history.pushState({ rr: name }, ""); } catch (e) {}
  }
  function overlayClosedByUI(name) {
    var at = overlays.lastIndexOf(name);
    if (at < 0) return;
    overlays.splice(at, 1);
    try { if (history.state && history.state.rr === name) { ignorePop++; history.back(); } } catch (e) {}
  }
  window.addEventListener("popstate", function () {
    if (ignorePop) { ignorePop--; return; }
    var name = overlays.pop();
    if (name && CLOSERS[name]) CLOSERS[name](true);
  });

  // ------------------------------------------------------------------ map
  var map = null, layer = null, zoneLayer = null, poiLayer = null, nearLayer = null;

  // ------------------------------------------------- supermarkets & stops layer
  // Only drawn from street level (zoom 14+), and only what is in view, so a
  // phone never has to hold thousands of markers.
  var POI_ON = Object.assign({ g: true, t: true, b: true }, load("rr2.poi", {}) || {});
  var POI_NAME = { g: "Supermarket", t: "Tram stop", b: "Bus stop" };
  var POI_COL = { g: "#3F8A4A", t: "#2F5D8C", b: "#6F7A84" }; // must match .poi-dot in the CSS
  var POI_ICON = {};
  // supermarkets carry their chain's initial: L(idl), R(imi), M(axima)
  function poiLetter(k, name) { return k === "t" ? "T" : k === "b" ? "B" : String(name || "S").charAt(0).toUpperCase(); }
  function poiIcon(k, name) {
    var ch = poiLetter(k, name), key = k + ch;
    if (!POI_ICON[key]) POI_ICON[key] = L.divIcon({
      className: "poi-mk",
      html: '<i class="poi-dot ' + k + '">' + ch + "</i>",
      iconSize: [20, 20], iconAnchor: [10, 10],
    });
    return POI_ICON[key];
  }
  function plotPois() {
    if (!map || !poiLayer) return;
    poiLayer.clearLayers();
    var bar = $("#poiBar");
    bar.hidden = !POIS;
    if (!POIS) return;
    var z = map.getZoom();
    bar.classList.toggle("far", z < 14);
    if (z < 14) return;
    var bb = map.getBounds().pad(0.15);
    ["g", "t", "b"].forEach(function (k) {
      if (!POI_ON[k]) return;
      (POIS[k] || []).forEach(function (p) {
        if (!bb.contains([p[0], p[1]])) return;
        L.marker([p[0], p[1]], { icon: poiIcon(k, p[2]), pane: "pois", keyboard: false, title: (p[2] || POI_NAME[k]) })
          .bindTooltip((p[2] ? esc(p[2]) + " · " : "") + POI_NAME[k], { direction: "top", offset: [0, -8] })
          .addTo(poiLayer);
      });
    });
  }
  // one flat on its own: dashed lines to its nearest supermarket, tram and bus stop
  function plotNear(l) {
    if (!nearLayer) return [];
    nearLayer.clearLayers();
    var spots = [];
    if (!l || !l.near || !POIS || l.lat == null) return spots;
    ["g", "t", "b"].forEach(function (k) {
      if (!l.near[k]) return;
      var best = null, bd = Infinity;
      (POIS[k] || []).forEach(function (p) {
        var d = Math.abs(p[0] - l.lat) + Math.abs(p[1] - l.lon) * 0.55;
        if (d < bd) { bd = d; best = p; }
      });
      if (!best) return;
      L.polyline([[l.lat, l.lon], [best[0], best[1]]], { color: POI_COL[k], weight: 2.5, dashArray: "4 6", opacity: 0.85, interactive: false }).addTo(nearLayer);
      spots.push([best[0], best[1]]);
    });
    return spots;
  }
  $("#poiBar").addEventListener("click", function (e) {
    var b = e.target.closest(".poi-t"); if (!b) return;
    var k = b.dataset.k;
    POI_ON[k] = !POI_ON[k];
    b.classList.toggle("on", POI_ON[k]);
    save("rr2.poi", POI_ON);
    plotPois();
  });
  $$("#poiBar .poi-t").forEach(function (b) { b.classList.toggle("on", !!POI_ON[b.dataset.k]); });
  function ensureMap() {
    if (map || typeof L === "undefined") return map;
    map = L.map("mapCanvas", { preferCanvas: true, zoomControl: true }).setView([56.951, 24.113], 12);
    // A quiet base map (Esri Light / Dark Gray Canvas, no key needed): streets
    // and names only — no shops, cafés or banks of its own — so the only points
    // on it are the flats, the supermarkets and the stops.
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_" + (dark ? "Dark" : "Light") + "_Gray_";
    var tileOpts = { maxNativeZoom: 16, maxZoom: 19 };
    L.tileLayer(esri + "Base/MapServer/tile/{z}/{y}/{x}", Object.assign({
      attribution: '© Esri · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }, tileOpts)).addTo(map);
    L.tileLayer(esri + "Reference/MapServer/tile/{z}/{y}/{x}", tileOpts).addTo(map); // street names
    map.createPane("pois").style.zIndex = 350; // under the flats' canvas (400)
    poiLayer = L.layerGroup().addTo(map);
    nearLayer = L.layerGroup().addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    layer = L.layerGroup().addTo(map);
    map.on("moveend zoomend", plotPois);
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
      nearHTML(l) +
      '<div class="mvote"><button data-v="discard" class="' + (v === "discard" ? "on" : "") + '">Pass</button>' +
      '<button data-v="like" class="' + (v === "like" ? "on" : "") + '">Like</button>' +
      '<a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener">open' + ICON.ext + "</a></div></div>";
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
    var nearSpots = plotNear(mapOnly);
    var noGeo = src.length - pts.length;
    $("#mapTitle").textContent = mapOnly
      ? (mapOnly.street || "Location")
      : pts.length + (pts.length === 1 ? " flat" : " flats") + " on the map" +
        (noGeo ? " · " + noGeo + " without a location" : "");
    if (noFit) return;
    setTimeout(plotPois, 0);
    // one flat: frame it together with its nearest store, tram and bus stop
    if (mapOnly && pts.length === 1 && nearSpots.length) map.fitBounds(pts.concat(nearSpots), { padding: [48, 48], maxZoom: 17 });
    else if (pts.length === 1) map.setView(pts[0], 16);
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
    if ($("#map").hidden) overlayOpened("map");
    $("#map").hidden = false;
    document.body.classList.add("noscroll");
    ensureMap();
    setTimeout(function () { if (map) { map.invalidateSize(); plotMap(); } }, 30);
  }
  function closeMap(fromHistory) {
    if ($("#map").hidden) return;
    if (drawArmed) disarmDraw();
    $("#map").hidden = true; document.body.classList.remove("noscroll"); mapOnly = null;
    if (fromHistory !== true) overlayClosedByUI("map");
  }
  $("#mapClose").addEventListener("click", function () { closeMap(); });
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
    if (e.target.closest("[data-close]")) { closeSheet(); return; }
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
    paintSheet();
    if (sheet.hidden) overlayOpened("sheet");
    sheet.hidden = false; document.body.classList.add("noscroll");
    if (focus) setTimeout(function () { var el = $(focus); if (el) el.scrollIntoView({ block: "center" }); }, 50);
  }
  $("#filterBtn").addEventListener("click", function () { openSheet(); });
  function closeSheet(fromHistory) {
    if (sheet.hidden) return;
    sheet.hidden = true; document.body.classList.remove("noscroll");
    if (fromHistory !== true) overlayClosedByUI("sheet");
  }
  CLOSERS.lb = closeLB; CLOSERS.map = closeMap; CLOSERS.sheet = closeSheet;
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
  // each tab keeps its own scroll position; tapping the open tab goes to the top
  var tabY = {};
  $$(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      if (t.dataset.tab === tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      tabY[tab] = window.scrollY;
      tab = t.dataset.tab; save(LS_TAB, tab); keepHere.clear(); render();
      var y = tabY[tab] || 0;
      while (drawn < rows.length && listEl.offsetTop + listEl.scrollHeight < y + innerHeight) drawMore();
      window.scrollTo(0, y);
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
    var dk = e.target.closest(".deck");
    if (dk) { if (!suppressClick && !dk.classList.contains("is-empty")) openLB(l, +dk.dataset.i || 0); return; }
    if (e.target.closest(".desc")) e.target.closest(".desc").classList.toggle("open");
  });
  // a photo that fails to load is skipped visually (the count stays honest)
  listEl.addEventListener("error", function (e) {
    if (e.target.classList && e.target.classList.contains("ph")) e.target.classList.add("broken");
  }, true);

  // ------------------------------------------- header out of the way, back to top
  // Scrolling down tucks the header away so the flats get the whole screen;
  // the slightest scroll up brings it back. Far down, a button returns to the top.
  var toTop = $("#toTop");
  window.addEventListener("scroll", function () { toTop.hidden = window.scrollY < 1400; }, { passive: true });
  toTop.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });

  $("#toastUndo").addEventListener("click", function () {
    if (!undoSnap) return;
    restore(undoSnap); undoSnap = null; $("#toast").hidden = true; render(true);
  });

  $("#mapBtn").addEventListener("click", function () { openMap(null); });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!lb.hidden) closeLB();
      else if (!$("#map").hidden) { if (drawArmed) disarmDraw(); else closeMap(); }
      else if (!sheet.hidden) closeSheet();
    }
    if (!lb.hidden && (e.key === "ArrowRight" || e.key === "ArrowLeft")) stepDeck(lbDeck, e.key === "ArrowRight" ? 1 : -1);
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
  // Signing in. Firebase's own Google flows run through a helper page on
  // <project>.firebaseapp.com, which hands the result back to this page through
  // storage the two domains share — and phone browsers (all of iOS, Chrome
  // with storage partitioning) no longer share it: the redirect flow ends on a
  // "missing initial state" page. So when a Google client id is configured,
  // Google's own sign-in (Google Identity Services) runs on this page and its
  // token is handed to Firebase directly; nothing crosses domains. Without one,
  // Firebase's popup is used (fine on desktop), and never the redirect.
  var gisClient = null;
  var BLOCKED = "The sign-in window was blocked. Allow pop-ups for this site, then tap Sign in again.";
  function initGis() {
    if (!FB.googleClientId) return Promise.resolve();
    return loadScript("https://accounts.google.com/gsi/client").then(function () {
      gisClient = google.accounts.oauth2.initTokenClient({
        client_id: FB.googleClientId,
        scope: "openid email profile",
        callback: function (r) {
          if (!r || !r.access_token) {
            if (r && r.error && r.error !== "access_denied") toast("Sign-in failed: " + (r.error_description || r.error));
            return;
          }
          firebase.auth().signInWithCredential(firebase.auth.GoogleAuthProvider.credential(null, r.access_token))
            .catch(function (e) { toast("Sign-in failed: " + (e.message || e.code)); });
        },
        error_callback: function (e) { if (e && e.type === "popup_failed_to_open") toast(BLOCKED); },
      });
    }).catch(function () {});
  }
  function initCloud() {
    if (!FB || !FB.apiKey) return;
    var v = "https://www.gstatic.com/firebasejs/10.12.2/";
    $("#authBtn").hidden = false;
    loadScript(v + "firebase-app-compat.js")
      .then(function () { return Promise.all([loadScript(v + "firebase-auth-compat.js"), loadScript(v + "firebase-firestore-compat.js")]); })
      .then(function () {
        firebase.initializeApp({ apiKey: FB.apiKey, authDomain: FB.authDomain, projectId: FB.projectId, appId: FB.appId });
        firebase.auth().onAuthStateChanged(function (u) { if (u) startCloud(u); else stopCloud(); });
        return initGis();
      })
      .catch(function () { paintSync("Could not load sign-in (offline?). Votes are kept in this browser for now."); });
    $("#authBtn").addEventListener("click", function () {
      if (typeof firebase === "undefined" || !firebase.apps.length) { toast("Sign-in is still loading. Try again in a moment."); return; }
      if (cloud.user) {
        if (confirm("Signed in as " + (cloud.user.email || "you") + ". Sign out on this device?")) firebase.auth().signOut();
        return;
      }
      // the window has to open inside this tap, or the browser blocks it
      if (gisClient) { gisClient.requestAccessToken(); return; }
      if (FB.googleClientId) { toast("Sign-in is still loading. Try again in a moment."); return; }
      firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function (e) {
        if (e && e.code === "auth/popup-blocked") toast(BLOCKED);
        else if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
          toast("Sign-in failed: " + (e.message || e.code));
      });
    });
  }

  $("#barToggle").addEventListener("click", function () {
    BAR = BAR === "closed" ? "open" : "closed";
    save("rr2.bar", BAR);
    paintBar();
  });

  // ----------------------------------------------------------------- boot
  buildSheet();
  render();
  paintBar();
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
