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

// --- one room (or a bed) in a shared flat, not a whole flat -----------------
// These ads sit in the same "flats" category as whole flats, often with the
// flat's room count and area, so only the wording gives them away. Each pattern
// below was checked against real ads; the words that are NOT room rentals are
// as important as the ones that are:
//   "2 istabu dzīvokli", "divistabu", "vannas istaba"      (flat size, bathroom)
//   "2-комнатную квартиру", "ванная комната"                (flat size, bathroom)
//   "2-bedroom apartment with living room for rent"         (a whole flat)
//   "HIDE studios … shared amenities", "premium coliving"   (own studio, shared gym)
// (?<!\p{L}) stands in for \b, which in JS only knows ASCII letters.
const W = "(?<![\\p{L}\\d])"; // start of a word
const NUMWORD = "(?:\\d|vien|div|trīs|tris|četr|cetr|piec|seš|ses|одн|двух|трех|трёх|четыр)";
const ROOM_RENTAL = [
  // Latvian
  // "izīrē istabu (dzīvoklī)", "izīrējam mēbelētu istabu" — not "izīrē 2 istabu dzīvokli"
  W + "(?:iz)?[iī]r[eē]\\p{L}*\\s+(?:(?!" + NUMWORD + ")[^\\s\\d]+\\s+){0,2}?istab(?:u|iņu)(?!\\p{L})(?![\\s-]*dz[iī]vok(?!lī))",
  // "istaba 3-istabu dzīvoklī" (a room in a 3-room flat)
  W + "istab(?:a|u|iņa|iņu)\\s+(?:\\S+\\s+){0,2}?[\\d\\p{L}-]*istab\\p{L}*\\s+dzīvoklī",
  // "istabas īre", "istaba īrei" — not "2 istabas …", nor a whole-flat ad's
  // "iespējama arī atsevišķas istabas īre" (a room is also possible)
  "(?<!(?:\\p{L}|\\d[\\s-]*))(?<!(?<!\\p{L})arī\\s+(?:\\S+\\s+){0,2})istab(?:a|as|u)\\s+(?:[iī]r[eē]|[iī]rei)(?!\\p{L})",
  // "istaba studentam / meitenei"
  W + "istab(?:a|u|iņa|iņu)\\s+(?:studentam|studentei|studentiem|meitenei|puisim|sievietei|vīrietim)",
  // shared kitchen / bathroom: "koplietošanas virtuve", "virtuve un vannas istaba kopīga"
  // ("kopīga virtuve ar dzīvojamo istabu" is an open-plan kitchen, not a shared one)
  W + "(?:koplieto\\p{L}*|kopīg\\p{L}*)\\s+(?:\\p{L}+\\s+){0,2}?(?:virtuv|vannas\\s+istab|tualet|duš|sanmezgl|san\\.?\\s*mezgl)(?!\\p{L}*[\\s,]+(?:ar|un)\\s+(?:dzīvojam|viesistab|istab))(?!\\p{L}*-)",
  // "virtuve un vannas istaba ir kopīga / koplietošanā" — not "virtuves zona kopīgām maltītēm"
  W + "(?:virtuv\\p{L}*|vannas\\s+istab\\p{L}*|tualet\\p{L}*)\\s+(?:\\S+\\s+){0,4}?(?:ir\\s+(?:\\p{L}+\\s+)?kopīg\\p{L}*|koplietošanā|kopīgā\\s+lietošanā)(?!\\p{L})(?!\\s+ar\\s)",
  W + "(?:istab\\p{L}*|dzīvokļa)\\s*biedr", // flatmate
  // a bed, not a room: "izīrē gultas vietu", "gultas vieta istabā" — not "istaba ar gultas vietu"
  W + "(?:iz)?[iī]r[eē]\\p{L}*\\s+(?:\\S+\\s+){0,2}?gultas\\s*viet",
  W + "gultas\\s*viet\\p{L}*\\s+(?:istabā|kopmītn|hostel|[iī]rei|[iī]re)",
  W + "(?:kopmītn|hostel)",
  // Russian
  // "сдаётся комната", "сдаю уютную комнату" — but not "сдаю квартиру, комната …"
  W + "сда\\p{L}*\\s+(?:(?!квартир)\\S+\\s+){0,3}?комнат(?:у|а|ку|ка)(?!\\p{L})",
  W + "комнат(?:а|у|ка|ку)\\s+в\\s+(?:\\S+\\s+){0,2}?[\\d\\p{L}-]*комнатн\\p{L}*\\s+квартир",
  W + "комнат(?:а|у|ка|ку)\\s+для\\s+(?:студент|девушк|парн|одного|одной|женщин|мужчин)",
  // "кухня и туалет общего пользования", "общая кухня" — never "общая площадь" (total area)
  W + "(?:кухн|ванн|туалет|санузел|душ)\\p{L}*\\s+(?:\\S+\\s+){0,4}?(?:общего\\s+пользовани|в\\s+общем\\s+пользовани)",
  W + "общ(?:ая|ие|ий|ей|ую)\\s+(?:кухн|ванн|туалет|санузел)(?!\\p{L}*-)",
  W + "(?:койко|подселени|общежит|хостел)",
  W + "сосед\\p{L}*\\s+по\\s+квартир",
  // English
  // "room for rent", "a room to let" — but not "living room for rent", "2 room for rent"
  "(?<!(?:living|bed|bath|dining|guest|\\d)[\\s-]*)" + W + "rooms?\\s+(?:for|to)\\s+(?:rent|let)(?!\\p{L})",
  W + "(?:rent(?:ing)?|let(?:ting)?)\\s+(?:out\\s+)?a\\s+room(?!\\p{L})(?![\\s-]*(?:apartment|flat|studio))",
  W + "(?:private|single)\\s+room(?!\\p{L})(?![\\s-]*(?:apartment|flat|studio|like))",
  W + "shared\\s+(?:[\\w-]+\\s+){0,2}?(?:apartment|flat|house|accommodation|kitchen|bathroom|toilet)(?!\\p{L})",
  W + "(?:apartment|flat)\\s+is\\s+shared",
  W + "(?:flat|room|house)[\\s-]?mates?(?!\\p{L})",
  W + "(?:for\\s+this\\s+room|one\\s+specific\\s+room|per\\s+room)(?!\\p{L})",
  W + "(?:bed[\\s-]?space|hostel|dormitor)",
].map((s) => new RegExp(s, "iu"));

// the first pattern that matches, as a short quote (for the log); null if none
function roomRentalHit(text) {
  const t = String(text || "").replace(/\s+/g, " ");
  for (const re of ROOM_RENTAL) {
    const m = re.exec(t);
    if (m) return m[0].trim().slice(0, 60);
  }
  return null;
}
const isRoomRental = (text) => roomRentalHit(text) != null;

module.exports = {
  stripTags,
  num,
  detectUtilities,
  detectRenovation,
  mergeReno,
  detectFurnished,
  extractSeasonUtils,
  isShortTerm,
  isRoomRental,
  roomRentalHit,
};
