"use strict";
// ---------------------------------------------------------------------------
// Photo handling: which rendition to request, and how to store a gallery cheaply.
//
// Every source publishes several renditions of each photo, and the old report
// picked the largest one for the card grid. Measured cost of that mistake, over
// the 317 cards of the last run: 328 MB of images to paint one screen.
//
// The rules below were established by probing the live CDNs, not from docs:
//
//   ss.lv    .t.jpg  = 174x130, ~4 KB     .800.jpg = long side <=910, ~78 KB
//            .th2.jpg = 90x68, ~2 KB.  Every other suffix returns a 49-byte
//            placeholder WITH HTTP 200, so size, not status, tells you it failed.
//
//   city24   the number after /object/ selects the rendition:
//            15 ~ 9 KB, 14 ~ 18 KB, 13 ~ 26 KB, 22 ~ 199 KB, 21 ~ 5 MB (!).
//            21 was the old default — hence the half-gigabyte grid.
//
//   pp.lv    the path segment is a fixed whitelist of pre-generated sizes
//            ("thumb", "32", "43", "34", "0x500", "0x1080", "original"), and an
//            unknown segment silently falls back to the original. The old code
//            used "21", which is not in the whitelist. Resized renditions are
//            ALSO content-negotiated: the server only returns the small AVIF if
//            the request carries Accept: image/avif. Browsers do this for <img>
//            automatically; anything fetch()ing these URLs must set it by hand.
//            The file extension stays as the API reports it — .avif 404s.
//
// Storage: a gallery is kept as { k: kind, p: [ref, ...] } where a ref is the
// shortest thing that rebuilds a URL — an image id for ss.lv, a path stem for
// city24, a storage id for pp.lv. The report rebuilds URLs with the identical
// rule table, injected once, instead of carrying two absolute URLs per photo.
// ---------------------------------------------------------------------------

const RULES = {
  ss: {
    host: "https://i.ss.lv/gallery/",
    // ss.lv derives a photo's folder from the GLOBAL image id alone:
    //   ceil(id/1e7) / ceil(id/5e4) / ceil(id/200)
    // (from the site's own main.lv.ss.js). Because ids are allocated globally,
    // one ad's photos routinely span several folders — which is exactly what
    // the previous "keep only the thumbnail's folder" filter threw away.
    derive: "id",
    prefix: "flats-riga-centre-",
    sizes: { grid: ".t.jpg", card: ".800.jpg", full: ".800.jpg", tiny: ".th2.jpg" },
  },
  c24: {
    host: "https://static.img-city24.lv/object/",
    derive: "stem",
    sizes: { grid: "14", card: "12", full: "22", tiny: "15" },
  },
  pp: {
    host: "https://img.pp.lv/storage/",
    derive: "sid",
    // "43" is a uniform 252x189 crop, so cards never jump; "0x1080" is the
    // largest rendition worth fetching (0x1440 and 0x2160 return the same bytes).
    sizes: { grid: "43", card: "0x500", full: "0x1080", tiny: "thumb" },
  },
  // varianti.lv: the only renditions are the small_/original_ filename prefixes.
  // ref = the filename with the prefix stripped.
  var: {
    host: "https://media.varianti.lv/",
    derive: "prefix",
    sizes: { grid: "small_", card: "original_", full: "original_", tiny: "small_" },
  },
  // latio.lv: /uploads/products/{pid}/th/c_w410_h300_cm2_v1_{file}.jpeg is the
  // 410x300 thumb; drop the th/ segment for the full-size file.
  // ref = "{pid}|{file}".
  lat: {
    host: "https://latio.lv/uploads/products/",
    derive: "mid",
    // no card tier: latio only offers 410px or the 2000px/1.1MB original, and
    // pulling a megabyte per card on a phone is worse than a soft photo.
    sizes: { grid: "th/c_w410_h300_cm2_v1_", card: "th/c_w410_h300_cm2_v1_", full: "", tiny: "th/c_w410_h300_cm2_v1_" },
  },
  // arcoreal.lv: only the card thumbnail is collected (no per-ad deep read), so
  // the ref is simply the absolute URL.
  arc: {
    host: "",
    derive: "abs",
    sizes: { grid: "", card: "", full: "", tiny: "" },
  },
};

// --- reference extraction (Node side) ---------------------------------------

// ss.lv: the numeric image id is all we need — folder and filename derive from it.
function packSs(url) {
  const m = /\/gallery\/\d+\/\d+\/\d+\/[a-z0-9-]*?(\d+)\.(?:800|t|th2)\.jpg/i.exec(url || "");
  return m ? m[1] : null;
}
// city24: everything after the rendition number, minus the extension.
function packC24(url) {
  const m = /\/object\/[^/]+\/(.+?)\.jpg/i.exec(url || "");
  return m ? m[1] : null;
}
// pp.lv: the storage id; the two leading directory pairs are slices of it.
function packPp(url) {
  const m = /\/storage\/[^/]+\/[^/]+\/([0-9a-f]{8,})\//i.exec(url || "");
  return m ? m[1] : null;
}
// varianti.lv: filename minus the small_/original_ rendition prefix.
function packVar(url) {
  const m = /media\.varianti\.lv\/(?:small_|original_)?(.+\.(?:jpe?g|png|webp))$/i.exec(url || "");
  return m ? m[1] : null;
}
// latio.lv: product id + filename, thumb prefix stripped.
function packLat(url) {
  const m = /\/uploads\/products\/(\d+)\/(?:th\/c_w\d+_h\d+[^/]*_v\d+_)?(.+\.(?:jpe?g|png|webp))$/i.exec(url || "");
  return m ? m[1] + "|" + m[2] : null;
}
// arcoreal.lv: the URL is the ref.
function packArc(url) {
  return /^https?:\/\//i.test(url || "") ? url : null;
}
const PACKERS = { ss: packSs, c24: packC24, pp: packPp, var: packVar, lat: packLat, arc: packArc };

// --- URL building (shared logic; the browser gets the same code as text) -----
const BUILDER_SRC = `function imgUrl(kind, ref, size) {
  var R = IMG_RULES[kind]; if (!R || !ref) return "";
  var s = R.sizes[size || "grid"]; if (s == null) return "";
  if (R.derive === "id") {
    var n = +ref;
    return R.host + Math.ceil(n / 1e7) + "/" + Math.ceil(n / 5e4) + "/" + Math.ceil(n / 200) +
           "/" + R.prefix + n + s;
  }
  if (R.derive === "sid") {
    return R.host + String(ref).slice(0, 2) + "/" + String(ref).slice(2, 4) + "/" + ref + "/" + s + ".jpg";
  }
  if (R.derive === "prefix") { return R.host + s + ref; }
  if (R.derive === "mid") {
    var i = String(ref).indexOf("|");
    if (i < 0) return "";
    return R.host + String(ref).slice(0, i) + "/" + s + String(ref).slice(i + 1);
  }
  if (R.derive === "abs") { return /^https?:\\/\\//.test(String(ref)) ? String(ref) : ""; }
  return R.host + s + "/" + ref + ".jpg";
}`;

// eslint-disable-next-line no-new-func
const imgUrl = new Function("IMG_RULES", BUILDER_SRC + "; return imgUrl;")(RULES);
const expand = (kind, ref, size) => imgUrl(kind, ref, size);

// De-duplicate while preserving order, and cap a runaway gallery so one ad with
// two hundred photos cannot dominate the report payload.
function packGallery(kind, urlsOrRefs, { max = 40, alreadyRefs = false } = {}) {
  const packer = PACKERS[kind];
  const seen = new Set();
  const refs = [];
  for (const u of urlsOrRefs || []) {
    const r = alreadyRefs ? String(u) : packer && packer(u);
    if (!r || seen.has(r)) continue;
    seen.add(r);
    refs.push(r);
    if (refs.length >= max) break;
  }
  return { k: kind, p: refs };
}

const SOURCE_KIND = {
  "ss.lv": "ss", city24: "c24", "pp.lv": "pp",
  "varianti.lv": "var", "latio.lv": "lat", "arcoreal.lv": "arc",
};

// Emitted verbatim into the report, so there is exactly one definition of how a
// reference becomes a URL.
function clientHelper() {
  return "const IMG_RULES=" + JSON.stringify(RULES) + ";\n" + BUILDER_SRC;
}

module.exports = { RULES, PACKERS, packGallery, expand, imgUrl, clientHelper, SOURCE_KIND, BUILDER_SRC };
