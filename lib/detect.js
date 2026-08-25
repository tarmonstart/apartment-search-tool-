"use strict";
// ---------------------------------------------------------------------------
// Text classifiers over listing copy, which is a mix of Latvian, Russian and
// English — often all three in one ad. These patterns are tuned against real
// ss.lv / city24 / pp.lv wording; change them only with examples in hand.
// ---------------------------------------------------------------------------

const stripTags = (s) =>
  (s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, " ")
    .trim();

// Numbers arrive as "1 250", "1250", "48,5", "48.5", "1 250,50 EUR". Spaces (and
// non-breaking spaces) are thousands separators here; a comma or dot is a decimal
// point only when followed by one or two digits that end the number. The old
// implementation stripped every comma, silently turning a 48,5 m² flat into 485 m².
const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/[\s ]/g, "");
  const m = t.match(/-?\d[\d.,]*/);
  if (!m) return null;
  let v = m[0].replace(/[.,]+$/, "");
  if (/[.,]\d{1,2}$/.test(v)) {
    const sep = v.slice(v.search(/[.,]\d{1,2}$/), v.search(/[.,]\d{1,2}$/) + 1);
    const head = v.slice(0, v.lastIndexOf(sep)).replace(/[.,]/g, "");
    const tail = v.slice(v.lastIndexOf(sep) + 1);
    v = head + "." + tail;
  } else {
    v = v.replace(/[.,]/g, "");
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// --- utilities included in the rent? ----------------------------------------
const RE_INCLUDED =
  /(komun[aā]l\w*\s+(maksājumi\s+)?(ir\s+)?iek[lļ]aut)|(iek[lļ]aut\w*\s+komun)|(ieskaitot\s+komun)|(iesk\.?\s*komun)|(viss\s+iek[lļ]auts)|(cena\s+ar\s+komun)|(ar\s+visiem\s+komun)|(all[\s-]*inclusive)|(utilities\s+included)|(bills?\s+included)|(including\s+utilities)|(коммунальн\w*\s+включ)|(включая\s+коммунал)/i;
const RE_EXCLUDED =
  /(\+\s*komun)|(komun[aā]l\w*\s+(maksājumi\s+)?(atsevi|papildus|nav\s+iek|apmaksā))|(papildus\s+komun)|(plus\s+komun)|(bez\s+komun)|(komun[aā]l\w*[^.]{0,40}(vasarā|ziemā))|(utilities\s+(not\s+included|separate|on\s+top))|(коммунальн\w*\s+(отдельно|дополнительно|не\s+включ))/i;

function detectUtilities(text) {
  const t = (text || "").toLowerCase();
  if (!t) return "unknown";
  if (RE_INCLUDED.test(t)) return "included";
  if (RE_EXCLUDED.test(t)) return "excluded";
  return "unknown";
}

// --- condition: renovated / needs work / unknown -----------------------------
const RE_RENOV =
  /(renov[aāeē]\w*)|(p[eē]c\s+(kapit[aā]l|remont|renov))|(kapit[aā]l\w*\s+remont)|(jaun\w*\s+projekt)|(jaunb[uū]v)|(izremont[eē]\w*)|(dizain\w*\s+remont)|(pilnīb[aā]\s+(atjaunot|izremont))|(new\s+project)|(newly\s+renovated)|(fully\s+renovated)|(after\s+renovation)|(luxur)|(евроремонт)|(после\s+ремонта)/i;
const RE_OLD =
  /(vajag\w*\s+\w{0,8}\s*remont)|(nepiecie[sš]\w*\s+\w{0,8}\s*remont)|(bez\s+remont)|(pa[dt]omju)|(hru[sš][cč])|(requires?\s+renovation)|(needs?\s+renovation)|(под\s+ремонт)|(требует\s+ремонта)|(av[aā]rij)/i;

function detectRenovation(text) {
  const t = (text || "").toLowerCase();
  if (!t) return "unknown";
  if (RE_RENOV.test(t)) return "renovated";
  if (RE_OLD.test(t)) return "old";
  return "unknown";
}

// "renovated" wins over "old" wins over "unknown"
function mergeReno(...vals) {
  if (vals.includes("renovated")) return "renovated";
  if (vals.includes("old")) return "old";
  return "unknown";
}

// --- furnished --------------------------------------------------------------
const RE_UNFURNISHED = /(bez\s+m[eē]bel)|(nav\s+m[eē]bel)|(unfurnished)|(without\s+furniture)|(без\s+мебел)/i;
const RE_FURNISHED = /(m[eē]bel[eē]t)|(ar\s+m[eē]bel)|(furnished)|(меблир)|(с\s+мебель)|(aprīkot\w*\s+ar\s+m[eē]bel)/i;
function detectFurnished(text) {
  const t = (text || "").toLowerCase();
  if (!t) return "unknown";
  if (RE_UNFURNISHED.test(t)) return "unfurnished"; // negatives first
  if (RE_FURNISHED.test(t)) return "furnished";
  return "unknown";
}

// --- seasonal utility costs quoted in free text (EUR) -----------------------
// Note the season words are matched with [^\s]* rather than \w*: JS \w is ASCII
// only, so "vasarā" / "ziemā" would otherwise stop dead at the diacritic.
const SUMMER = "(?:vasar[^\\s,.;]*|летом|лето)";
const WINTER = "(?:ziem[^\\s,.;]*|зимой|зима)";
const MONEY = "(?:€|eur|euro)";

// The gap between the season word and its amount must not cross a clause
// boundary. Without that, "75 EUR vasarā, 210 EUR ziemā" reads the winter figure
// as the summer one by hopping over the comma.
function seasonCost(text, season) {
  if (!text) return null;
  // "vasarā ap 80 EUR"
  let m = text.match(new RegExp(season + "[^0-9€,;.]{0,22}?(\\d{2,4})\\s*" + MONEY, "i"));
  // "80 EUR vasarā"
  if (!m) m = text.match(new RegExp("(\\d{2,4})\\s*" + MONEY + "[^0-9,;.]{0,18}?" + season, "i"));
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return v >= 20 && v <= 900 ? v : null;
}

function extractSeasonUtils(text) {
  return {
    summerUtil: seasonCost(text, SUMMER),
    winterUtil: seasonCost(text, WINTER),
  };
}

// --- short-term / per-night rentals we never want ---------------------------
const RE_SHORTTERM =
  /(par\s+dienu)|(diennakt)|(\/\s*dien)|(ned[eē][lļ]a?\s*\/|\/\s*ned[eē][lļ]|per\s+week|\/\s*week)|(per\s+night)|(īstermiņ)|(short[\s-]*term)|(посуточно)/i;
function isShortTerm(text) {
  return RE_SHORTTERM.test(text || "");
}

module.exports = {
  stripTags,
  num,
  detectUtilities,
  detectRenovation,
  mergeReno,
  detectFurnished,
  extractSeasonUtils,
  isShortTerm,
};
