/* eslint-env browser */
// ---------------------------------------------------------------------------
// Report front-end. Injected into listings.html together with DATA, SAVED, META
// and the image-rule helper (imgUrl). No frameworks.
//
// The model is deliberately simple:
//   * every flat is either untouched, liked (👍) or rejected (👎)
//   * three tabs show exactly those three piles — judging a flat moves it out
//     of "Uudet", so the same flat never has to be looked at twice
//   * a handful of filters, all in one sheet, remembered between visits
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
    }
    persist();
  }
  function setVerdict(l, v) {
    idsOf(l).forEach(function (i) {
      if (v) { pile[i] = v; cleared.delete(i); } else { delete pile[i]; cleared.add(i); }
    });
    persist();
  }
  function markSeen(l) {
    var ch = false;
    idsOf(l).forEach(function (i) { if (!visited.has(i)) { visited.add(i); ch = true; } });
    if (ch) { save(LS_SEEN, Array.from(visited)); pushState(); }
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
      ? "Valintasi tallentuvat suoraan koneelle (state/user-state.json)."
      : "Valintasi tallentuvat tähän selaimeen. Siirrä toiselle laitteelle varmuuskopiolla.";
  }

  // ---------------------------------------------------------------- filters
  var DEFAULT_F = { max: null, rooms: [], area: null, districts: [], flags: [], q: "", sort: "new" };
  var F = Object.assign({}, DEFAULT_F, load(LS_FILTERS, {}) || {});
  var tab = load(LS_TAB, "todo");
  if (["todo", "like", "discard"].indexOf(tab) < 0) tab = "todo";

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
    return (F.max != null) + (F.rooms.length > 0) + (F.area != null) + (F.districts.length > 0) + F.flags.length + (!!F.q);
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
    if (d <= 0) return "tänään";
    if (d === 1) return "eilen";
    if (d < 31) return d + " pv sitten";
    var m = Math.round(d / 30);
    return m < 12 ? m + " kk sitten" : "yli vuosi sitten";
  }
  function roomsTxt(n) { return n === 1 ? "1 huone" : n + " huonetta"; }
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
      : '<div class="nophoto">ei kuvia</div>';
    var tags = [];
    if (l.utilities === "included") tags.push('<span class="tag good">sis. kommunaalit</span>');
    else if (l.summerUtil != null || l.winterUtil != null)
      tags.push('<span class="tag">+ komm. ' + (l.summerUtil == null ? "?" : l.summerUtil) + "–" + (l.winterUtil == null ? "?" : l.winterUtil) + " €</span>");
    else if (l.utilities === "excluded") tags.push('<span class="tag">+ kommunaalit</span>');
    if (l.renovation === "renovated") tags.push('<span class="tag good">remontoitu</span>');
    if (l.renovation === "old") tags.push('<span class="tag warn">vaatii remonttia</span>');
    if (l.furnished === "furnished") tags.push('<span class="tag">kalustettu</span>');
    if (l.furnished === "unfurnished") tags.push('<span class="tag">kalustamaton</span>');

    var links = [{ source: l.source, url: l.url }].concat(l.alts || []);
    var seenUrl = {}, perSrc = {};
    links = links.filter(function (a) { if (seenUrl[a.url]) return false; seenUrl[a.url] = 1; return true; });
    // a re-post on the same site is labelled "ss.lv 2", not counted as another site
    links.forEach(function (a) { perSrc[a.source] = (perSrc[a.source] || 0) + 1; a.label = a.source + (perSrc[a.source] > 1 ? " " + perSrc[a.source] : ""); });
    var nSites = Object.keys(perSrc).length;

    var facts = [];
    if (l.rooms != null) facts.push(roomsTxt(l.rooms));
    if (l.area != null) facts.push(l.area + " m²");
    if (l.floor) facts.push(esc(l.floor) + " krs");

    return '<article class="card' + (v ? " is-" + v : "") + '" data-id="' + esc(l.id) + '">' +
      '<div class="gal" data-n="' + ps.length + '">' +
        '<div class="gal-track">' + gallery + "</div>" +
        (ps.length > 1 ? '<span class="gal-count">1/' + ps.length + "</span>" : "") +
        (l.isNew ? '<span class="pill new">UUSI</span>' : "") +
        (nSites > 1 ? '<span class="pill multi" title="Sama asunto useammalla sivustolla">' + nSites + " sivustoa</span>" : "") +
      "</div>" +
      '<div class="info">' +
        '<div class="row1"><span class="price">' + (l.price == null ? "—" : esc(l.price) + " €") + "</span>" +
          (l.pricePerM2 != null ? '<span class="ppm">' + esc(l.pricePerM2) + " €/m²</span>" : "") +
          '<span class="age">' + esc(ago(l.firstSeen || l.date)) + "</span></div>" +
        '<div class="facts">' + facts.join(" · ") + "</div>" +
        '<button class="addr" type="button"' + (l.lat != null ? "" : " disabled") + ">" +
          "📍 " + esc(l.street || "osoite puuttuu") + (l.district && l.district !== "Rīga" ? ", " + esc(l.district) : "") + "</button>" +
        (tags.length ? '<div class="tags">' + tags.join("") + "</div>" : "") +
        (l.description ? '<p class="desc">' + esc(l.description) + "</p>" : "") +
        '<div class="links">' + links.map(function (a) {
          return '<a href="' + esc(safeUrl(a.url)) + '" target="_blank" rel="noopener">' + esc(a.label) + " ↗</a>";
        }).join("") + "</div>" +
      "</div>" +
      '<div class="vote">' +
        '<button class="no' + (v === "discard" ? " on" : "") + '" type="button" data-v="discard" aria-label="En tykkää">👎<span>Ei</span></button>' +
        '<button class="yes' + (v === "like" ? " on" : "") + '" type="button" data-v="like" aria-label="Tykkään">👍<span>Tykkään</span></button>' +
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

  var counts = { todo: 0, like: 0, discard: 0 };
  function render(keepScroll) {
    var all = DATA.filter(passes);
    counts = { todo: 0, like: 0, discard: 0 };
    var mine = [];
    all.forEach(function (l) {
      var v = verdictOf(l) || "todo";
      counts[v]++;
      if (v === tab) mine.push(l);
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

  function paintCounts() {
    $("#nTodo").textContent = counts.todo;
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
      ? (filtered.length ? "<b>Kaikki käyty läpi! 🎉</b><br>Uusia asuntoja tulee kahdesti päivässä." : "<b>Ei osumia.</b><br>Väljennä suodattimia.")
      : tab === "like" ? "Et ole vielä tykännyt yhdestäkään asunnosta näillä suodattimilla."
      : "Ei hylättyjä asuntoja näillä suodattimilla.";
  }

  // Active filters as one-tap-removable chips, so nothing is ever hidden silently.
  function paintChips() {
    var c = [];
    if (F.max != null) c.push(["max", "≤ " + F.max + " €"]);
    if (F.rooms.length) c.push(["rooms", F.rooms.map(function (r) { return r === 4 ? "4+" : r; }).join(", ") + " h"]);
    if (F.area != null) c.push(["area", "≥ " + F.area + " m²"]);
    if (F.districts.length) c.push(["districts", F.districts.length > 2 ? F.districts.slice(0, 2).join(", ") + " +" + (F.districts.length - 2) : F.districts.join(", ")]);
    var FL = { fresh: "viim. 3 pv", util: "sis. komm.", reno: "remontoitu", furn: "kalustettu", photos: "kuvat" };
    F.flags.forEach(function (f) { c.push(["flag:" + f, FL[f] || f]); });
    if (F.q) c.push(["q", "“" + F.q + "”"]);
    var sortTxt = { new: "uusimmat", cheap: "halvin", ppm: "€/m²", big: "suurin" }[F.sort];
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
    var leaves = (next || "todo") !== tab;
    if (leaves) {
      card.classList.add(next === "like" ? "fly-right" : next === "discard" ? "fly-left" : "fly-up");
      setTimeout(function () { render(true); }, 260);
    } else {
      render(true);
    }
    toast(next === "like" ? "👍 Tallennettu tykättyihin" : next === "discard" ? "👎 Piilotettu" : "Palautettu uusiin", snap);
  }

  // ------------------------------------------------------------- lightbox
  var lb = $("#lb"), lbTrack = $("#lbTrack"), lbL = null;
  function openLB(l, i) {
    lbL = l;
    var ps = photos(l);
    if (!ps.length) return;
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
  var map = null, layer = null;
  function ensureMap() {
    if (map || typeof L === "undefined") return map;
    map = L.map("mapCanvas", { preferCanvas: true, zoomControl: true }).setView([56.951, 24.113], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    return map;
  }
  var COL = { like: "#16a34a", discard: "#9ca3af", todo: "#2563eb" };
  function popupHTML(l) {
    var ps = photos(l), v = verdictOf(l);
    return '<div class="mpop" data-id="' + esc(l.id) + '">' +
      (ps.length ? '<img src="' + esc(imgUrl(l.img.k, ps[0], "grid")) + '" alt="">' : "") +
      "<b>" + (l.price == null ? "—" : esc(l.price) + " €") + "</b> · " +
      [l.rooms != null ? roomsTxt(l.rooms) : "", l.area != null ? l.area + " m²" : ""].filter(Boolean).join(" · ") +
      "<br><small>" + esc(l.street || "") + "</small>" +
      '<div class="mvote"><button data-v="discard" class="' + (v === "discard" ? "on" : "") + '">👎</button>' +
      '<button data-v="like" class="' + (v === "like" ? "on" : "") + '">👍</button>' +
      '<a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener">avaa ↗</a></div></div>';
  }
  var mapOnly = null;
  function plotMap() {
    if (!ensureMap()) return;
    layer.clearLayers();
    var pts = [];
    var src = mapOnly ? [mapOnly] : rows;
    src.forEach(function (l) {
      if (l.lat == null) return;
      var v = verdictOf(l) || "todo";
      var m = L.circleMarker([l.lat, l.lon], {
        radius: mapOnly ? 10 : 7, weight: 2, color: "#fff", fillColor: COL[v], fillOpacity: 0.95,
      });
      m.bindPopup(function () { return popupHTML(l); }, { maxWidth: 240 });
      m.addTo(layer);
      pts.push([l.lat, l.lon]);
    });
    var noGeo = src.length - pts.length;
    $("#mapTitle").textContent = mapOnly
      ? (mapOnly.street || "Sijainti")
      : pts.length + " asuntoa kartalla" + (noGeo ? " (" + noGeo + " ilman sijaintia)" : "");
    if (pts.length === 1) map.setView(pts[0], 16);
    else if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 15 });
  }
  function openMap(one) {
    mapOnly = one || null;
    $("#map").hidden = false;
    document.body.classList.add("noscroll");
    ensureMap();
    setTimeout(function () { if (map) { map.invalidateSize(); plotMap(); } }, 30);
  }
  function closeMap() { $("#map").hidden = true; document.body.classList.remove("noscroll"); mapOnly = null; }
  $("#mapClose").addEventListener("click", closeMap);
  $("#mapCanvas").addEventListener("click", function (e) {
    var b = e.target.closest(".mvote button"); if (!b) return;
    var box = b.closest(".mpop"), l = byId[box.dataset.id]; if (!l) return;
    var snap = snapshot(l), next = verdictOf(l) === b.dataset.v ? null : b.dataset.v;
    setVerdict(l, next);
    if (map) map.closePopup();
    render(true);
    toast(next === "like" ? "👍 Tallennettu" : next === "discard" ? "👎 Piilotettu" : "Palautettu uusiin", snap);
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
    var n = DATA.filter(passes).filter(function (l) { return (verdictOf(l) || "todo") === tab; }).length;
    $("#applyBtn").textContent = "Näytä " + n + " asuntoa";
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
    F = JSON.parse(JSON.stringify(DEFAULT_F)); changed();
  });
  function openSheet(focus) {
    paintSheet(); sheet.hidden = false; document.body.classList.add("noscroll");
    if (focus) setTimeout(function () { var el = $(focus); if (el) el.scrollIntoView({ block: "center" }); }, 50);
  }
  $("#filterBtn").addEventListener("click", function () { openSheet(); });

  $("#chips").addEventListener("click", function (e) {
    var c = e.target.closest(".chip"); if (!c) return;
    var k = c.dataset.k;
    if (k === "sort") { openSheet("#fSort"); return; }
    if (k.indexOf("flag:") === 0) toggleIn(F.flags, k.slice(5));
    else if (k === "rooms" || k === "districts") F[k] = [];
    else if (k === "q") F.q = "";
    else F[k] = null;
    changed();
  });

  // ----------------------------------------------------------------- tabs
  $$(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      tab = t.dataset.tab; save(LS_TAB, tab); render(); window.scrollTo(0, 0);
    });
  });

  // ------------------------------------------------------------ card events
  listEl.addEventListener("click", function (e) {
    var card = e.target.closest(".card"); if (!card) return;
    var l = byId[card.dataset.id];
    var vb = e.target.closest(".vote button");
    if (vb) { vote(card, vb.dataset.v); return; }
    if (e.target.closest(".addr")) { if (l && l.lat != null) openMap(l); return; }
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
      else if (!$("#map").hidden) closeMap();
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
    toast("Varmuuskopio ladattu");
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
          toast(n + " valintaa palautettu");
        } catch (err) { toast("Tiedostoa ei voitu lukea"); }
      };
      r.readAsText(f);
    };
    inp.click();
  });

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
