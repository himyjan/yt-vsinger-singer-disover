/**
 * Region and agency metadata.
 *
 * "Region" is the geographic / linguistic area a performer belongs to. It is
 * the primary axis used to split the dataset (JP, CN, EN, ID, KR, TW, ...) and
 * is stored on every channel and item so the web UI can filter without a join.
 */

import type { RegionCode, RegionMeta } from "./types";
import {
  SIMPLIFIED_ONLY_CHARS,
  TRADITIONAL_ONLY_CHARS,
} from "./chinese-scripts";

export const REGION_META: Record<
  RegionCode,
  { label: string; badge: string; languages: string[] }
> = {
  jp: { label: "Japan", badge: "🇯🇵", languages: ["ja", "en"] },
  cn: { label: "China", badge: "🇨🇳", languages: ["zh-Hans"] },
  tw: { label: "Taiwan", badge: "🇹🇼", languages: ["zh-Hant"] },
  hk: { label: "Hong Kong", badge: "🇭🇰", languages: ["yue", "zh-Hant", "en"] },
  kr: { label: "Korea", badge: "🇰🇷", languages: ["ko", "en"] },
  en: { label: "English", badge: "🌐", languages: ["en"] },
  id: { label: "Indonesia", badge: "🇮🇩", languages: ["id", "en"] },
  my: { label: "Malaysia", badge: "🇲🇾", languages: ["ms", "en", "zh-Hant"] },
  sea: { label: "SEA", badge: "🌏", languages: ["en", "id", "th", "vi"] },
  unknown: { label: "Unknown", badge: "❔", languages: [] },
};

/**
 * Agency → region. The key is a lowercase needle matched against the channel
 * description, tags and name.
 */
export const AGENCY_REGION: Record<string, RegionCode> = {
  hololive: "jp",
  "hololive english": "en",
  hololive_indonesia: "id",
  hololive_dev_ism: "id",
  hololivecn: "cn",
  hololivecn_hy: "cn",
  nijisanji: "jp",
  "nijisanji en": "en",
  "nijisanji id": "id",
  "nijisanji kr": "kr",
  "nijisanji cn": "cn",
  "nijisanji inc": "jp",
  vspo: "jp",
  "v-spo": "jp",
  vshojo: "en",
  "vshojo japan": "jp",
  kkamitsu: "jp",
  kamitsubaki: "jp",
  "KMvs": "jp",
  "電音部": "jp",
  "響屋": "jp",
  "ReAcT": "jp",
  "Re:AcT": "jp",
  voms: "jp",
  noripro: "jp",
  "774 inc": "jp",
  "unlimited inc": "jp",
  "VGProduction": "jp",
  "VIRTUAL MUSIC LAB": "jp",
  "RIOT MUSIC": "jp",
  "HoneyStrap": "jp",
  "upd8": "jp",
  "のりプロ": "jp",
  "ハニーストラップ": "jp",
  "有閑喫茶あにまーれ": "jp",
  "深層組": "jp",
  "ムーンライト": "jp",
  "Paramount": "jp",
  "ClanS": "jp",
  "LaRa": "jp",
  "Phase-1": "jp",
  "tetrark": "jp",
  "SING4D": "jp",
  "Marinasu": "jp",
  "ESP": "jp",
  "Varium": "jp",
  "PRISM Project": "en",
  "Idle": "en",
  "IS": "en",
  "Phase Connect": "en",
  "V4Mirai": "en",
  "First Wind": "en",
  "Zenith": "en",
  "Specialite": "en",
  "Indie Live": "id",
  "NijiVerse": "en",
  "Aogiri High School": "jp",
  "Kaleido": "jp",
  "Anime Trending": "en",
  "Society": "en",
  "UniVIRTUAL": "jp",
  "CyberV": "jp",
  "Marble": "jp",
  "Vstar": "jp",
  "Blend S": "jp",
  "GEMS COMPANY": "jp",
  "KAMITSUBAKI STUDIO": "jp",
  "Steve N' Steve": "jp",
  "DAMS": "jp",
};

/**
 * Per-agency overrides for the sub-language of an English-language agency.
 * E.g. hololive ID branches are Indonesian even though the parent is EN.
 */
export const AGENCY_SUBREGION: Record<string, RegionCode> = {
  hololive_indonesia: "id",
  hololive_dev_ism: "id",
  "nijisanji id": "id",
  "hololivecn": "cn",
  "hololivecn_hy": "cn",
  "nijisanji cn": "cn",
  "nijisanji kr": "kr",
  hololive: "jp",
  nijisanji: "jp",
  vshojo: "en",
};

/**
 * The agencies that now operate under one name.
 *
 * On 2026-09-07 COVER announced that hololive would stop operating as
 * regional and group brands — hololive English, hololive Indonesia,
 * hololive DEV_IS and the rest — and become one “hololive”. The sources this
 * dataset reads still spell the old branches, so every agency goes through
 * this before it is read or written.
 *
 * The match is a prefix, because the announcement is about the whole brand:
 * a branch a source invents tomorrow is still hololive. “hololive
 * production” is the parent company, not the talent brand, so it is left
 * alone; holostars is a separate brand and is not touched either.
 */
export function canonicalAgency(
  agency: string | null | undefined,
): string | null {
  if (!agency || !agency.trim()) return null;
  const key = agency
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
  if (
    key === "hololive production" ||
    key === "hololiveproduction" ||
    key === "ホロライブプロダクション"
  ) {
    return agency;
  }
  if (key.startsWith("hololive") || key.startsWith("ホロライブ")) {
    return "hololive";
  }
  return agency;
}

/** Region → YouTube search keyword hints used by the discovery sweep. */
export const REGION_KEYWORDS: Record<RegionCode, string[]> = {
  jp: [
    "VTuber 歌い手",
    "vsinger 歌い手",
    "ホロライブ 歌",
    "にじさんじ 歌い手",
    "歌ってみた VTuber",
    "VOCALOID 歌い手",
  ],
  cn: ["虚拟主播 唱歌", "虚拟歌姬", "中文 虚拟主播 唱歌", "VOCALOID 中文 翻唱"],
  tw: ["台灣 虛擬主播 唱歌", "VTuber 歌回 中文", "台V 唱歌"],
  hk: ["香港 VTuber 唱歌", "VTuber 中文 廣東話"],
  kr: ["VTuber 노래", "버추얼 유튜버 노래", "가수 VTuber"],
  en: ["vtuber singer original song", "vsinger music video", "vtuber cover song", "singer songwriter original song"],
  id: ["vtuber indonesia nyanyi", "vtuber cover lagu", "idvtuber nyanyi"],
  my: ["vtuber malaysia nyanyi", "malaysian vtuber singing"],
  sea: ["vtuber SEA cover song", "filipino vtuber singing cover"],
  unknown: [],
};

/** ISO country code → region. */
export const COUNTRY_REGION: Record<string, RegionCode> = {
  JP: "jp",
  CN: "cn",
  TW: "tw",
  HK: "hk",
  MO: "tw",
  KR: "kr",
  US: "en",
  GB: "en",
  AU: "en",
  CA: "en",
  SG: "sea",
  MY: "my",
  ID: "id",
  TH: "sea",
  VN: "sea",
  PH: "sea",
  IN: "sea",
};

/**
 * The country names YouTube publishes, in the languages the pipeline asks for.
 *
 * The Data API returns an ISO code, but InnerTube's about page returns the
 * country **as a label in the session's language** — 「日本」, "Japan",
 * "일본". Without this table the only country a record could ever carry is
 * one the Data API supplied, and the API needs a key.
 *
 * Only the countries in `COUNTRY_REGION` are listed: a country nobody has a
 * region for is not worth guessing at.
 */
const COUNTRY_LABELS: Record<string, string[]> = {
  JP: ["japan", "日本", "일본"],
  CN: ["china", "中国", "中國", "중국"],
  TW: ["taiwan", "台湾", "台灣", "대만"],
  HK: ["hong kong", "香港", "홍콩"],
  MO: ["macao", "macau", "マカオ", "澳门", "澳門", "마카오"],
  KR: ["south korea", "korea", "韓国", "韩国", "韓國", "대한민국", "한국"],
  US: [
    "united states",
    "united states of america",
    "アメリカ合衆国",
    "アメリカ",
    "美国",
    "美國",
    "미국",
  ],
  GB: ["united kingdom", "イギリス", "英国", "英國", "영국"],
  AU: ["australia", "オーストラリア", "澳大利亚", "澳洲", "오스트레일리아"],
  CA: ["canada", "カナダ", "加拿大", "캐나다"],
  SG: ["singapore", "シンガポール", "新加坡", "싱가포르"],
  MY: ["malaysia", "マレーシア", "马来西亚", "馬來西亞", "말레이시아"],
  ID: ["indonesia", "インドネシア", "印度尼西亚", "印尼", "인도네시아"],
  TH: ["thailand", "タイ", "泰国", "泰國", "태국"],
  VN: ["vietnam", "ベトナム", "越南", "베트남"],
  PH: ["philippines", "フィリピン", "菲律宾", "菲律賓", "필리핀"],
  IN: ["india", "インド", "印度", "인도"],
};

const COUNTRY_LABEL_INDEX: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_LABELS).flatMap(([code, labels]) =>
    labels.map((label) => [label.toLowerCase(), code] as const),
  ),
);

/**
 * Reads a country however a source wrote it.
 *
 * The Data API writes `JP`; InnerTube's about page writes 「日本」. Both mean
 * the same thing, and both are facts, so both are accepted — anything else
 * is `null` rather than a guess.
 */
export function normalizeCountry(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_LABEL_INDEX[trimmed.toLowerCase()] ?? null;
}

/**
 * True when the text contains kana — Japanese, and nothing else.
 *
 * Two characters, not one: a single の or め in an otherwise Chinese name is
 * a stylisation (「猫の神様」, 「屁屁桃も」), not a Japanese name, and there
 * are enough of them to matter. Two kana in a row are a word — 「るる」,
 * 「なっつ」, 「イリス」 — and a word is evidence.
 */
export function hasKana(text: string | null | undefined): boolean {
  const kana = (text ?? "").match(/[\u3040-\u309F\u30A0-\u30FF]/g);
  return (kana?.length ?? 0) >= 2;
}

/**
 * Additional agency branches, merged into `AGENCY_REGION` below.
 *
 * Kept separate so the main map above stays readable; the classifier matches
 * the *longest* needle, so `hololive indonesia` always beats `hololive`.
 */
const EXTRA_AGENCY_REGION: Record<string, RegionCode> = {
  "774inc": "jp",
  "virtual music lab": "jp",
  "prism project": "en",
  "phase connect": "en",
  "v4mirai": "en",
  "first wind": "en",
  "specialite": "en",
  "honey strap": "jp",
  "あにまーれ": "jp",
  kaela: "jp",
  song4u: "jp",
};

Object.assign(AGENCY_REGION, EXTRA_AGENCY_REGION);

/* -------------------------------------------------------------------------- */
/* Script detection                                                           */
/* -------------------------------------------------------------------------- */

const JP_RE = /[\u3040-\u309F\u30A0-\u30FF]/; // hiragana + katakana
const HANT_RE = /[\u4E00-\u9FFF]/; // CJK ideographs (needs a second check for simplified)
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF]/;
/**
 * Characters that exist only in one of the two Chinese scripts.
 *
 * The sets are large — they cover the high-frequency simplified and
 * traditional forms — because a single discriminating character is what
 * separates a Chinese name from a Japanese one.
 */
const SIMPLIFIED_ONLY = SIMPLIFIED_ONLY_CHARS;
const TRAD_MARKERS = TRADITIONAL_ONLY_CHARS;

/**
 * Guesses the primary language of a blob of text.
 *
 * ## Language code vs. region code
 *
 * These are two different standards and the project keeps them apart:
 *
 * | | Standard | Japanese | Chinese (Simplified) | Korean |
 * | --- | --- | --- | --- | --- |
 * | **Language** | ISO 639-1 | `ja` | `zh-Hans` | `ko` |
 * | **Country/region** | ISO 3166-1 alpha-2 | `jp` | `cn` | `kr` |
 *
 * `ja` is the language code — it appears in a `lang` attribute, a locale tag
 * or a subtitle track. `jp` is the country code — it appears in a domain
 * suffix (`.jp`) or a country field. A Japanese VTuber is `language: "ja"`
 * and `region: "jp"`.
 *
 * Returns `null` when the text is mostly latin or otherwise ambiguous.
 */
export function detectLanguage(text: string | null | undefined): string | null {
  if (!text) return null;
  if (HANGUL_RE.test(text)) return "ko";
  // Kana is unambiguous — Japanese.
  if (JP_RE.test(text)) return "ja";
  if (HANT_RE.test(text)) {
    // Distinguish Traditional vs Simplified by looking for characters that
    // exist in one script only.
    let traditional = 0;
    let simplified = 0;
    for (const ch of text) {
      if (TRAD_MARKERS.has(ch)) traditional++;
      if (SIMPLIFIED_ONLY.has(ch)) simplified++;
    }
    if (traditional > simplified) return "zh-Hant";
    if (simplified > traditional) return "zh-Hans";
    // Kanji only, with no script-specific character. This is the common case
    // for Japanese names such as 「二口魔菜」 or 「錦野楓夜」, which use kanji
    // that happens to be shared with Chinese. Defaulting to Japanese matters:
    // a VTuber dataset is full of kanji-only Japanese names.
    return "ja";
  }
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = text.replace(/\s/g, "").length || 1;
  if (latin / total > 0.8) return "en";
  return null;
}

/**
 * The language a region implies.
 *
 * The region says which scene the performer is in, and the language says what
 * they perform in — and for a VTuber the second follows the first. A
 * Taiwanese performer writes a Japanese-style stage name all the time, and
 * the kana in it says nothing about the language they sing in.
 */
export const REGION_LANGUAGE: Record<RegionCode, string | null> = {
  jp: "ja",
  cn: "zh-Hans",
  tw: "zh-Hant",
  // Hong Kong's primary language is Cantonese, which is a separate language
  // from written Mandarin — `yue` is its ISO 639-3 code.
  hk: "yue",
  kr: "ko",
  en: "en",
  id: "id",
  my: "ms",
  sea: "en",
  unknown: null,
};

/**
 * Normalises the `languages` field.
 *
 * The field accepts a single code or a list, and this is the one place that
 * knows it.
 *
 * The field is a single code **or** a list, because some sources only ever
 * name one language. Everything internal uses the list form.
 */
export function toLanguageList(
  value: string | string[] | null | undefined,
): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((l) => l.trim()).filter(Boolean);
}

/**
 * Merges two language lists, keeping the order and dropping the duplicates.
 */
export function mergeLanguages(
  a: string | string[] | null | undefined,
  b: string | string[] | null | undefined,
): string[] {
  return [...new Set([...toLanguageList(a), ...toLanguageList(b)])];
}

/**
 * The languages a region implies, as a list.
 */
export function languagesForRegion(
  region: RegionCode,
  fallback: string[] | null = null,
): string[] {
  const language = REGION_LANGUAGE[region];
  if (language) return [language];
  return fallback ? [...fallback] : [];
}

/**
 * Settles a record's language from its region.
 *
 * The region is the authoritative fact; the language follows it. This is
 * applied *after* the region is final, because the region can change at
 * several points — a roster entry, a platform prior, an override — and the
 * language has to follow whichever one won.
 */
export function languageForRegion(
  region: RegionCode,
  fallback: string | null = null,
): string | null {
  return REGION_LANGUAGE[region] ?? fallback;
}

/**
 * Maps an ISO 639-1 language code to the project's region code.
 *
 * The two vocabularies are deliberately separate: `ja` (language) becomes
 * `jp` (country), `ko` becomes `kr`, `zh-Hans` becomes `cn`.
 */
export function languageToRegion(lang: string | null): RegionCode | null {
  if (!lang) return null;
  if (lang === "ja") return "jp";
  if (lang === "ko") return "kr";
  if (lang === "zh-Hant") return "tw";
  if (lang === "zh-Hans" || lang === "zh") return "cn";
  if (lang === "en") return "en";
  if (lang === "id") return "id";
  if (lang === "ms") return "my";
  return null;
}

/**
 * Language-specific tokens that identify a locale unambiguously.
 *
 * These are used as *locale hints* — a short sample of the channel's uploads
 * — to disambiguate kanji-only names. 「歌枠」 is Japanese; 「翻唱」 is
 * Chinese; 「노래」 is Korean.
 */
/**
/**
 * The patterns a performer uses to state their own language.
 *
 * A channel that writes 「主な配信言語: 広東語」 is stating a fact about
 * themselves — a far better signal than anything inferred from the name or
 * the region.
 */
export const LANGUAGE_STATEMENT_PATTERNS: {
  language: string;
  patterns: string[];
}[] = [
  {
    // Cantonese — its own language, not written Mandarin.
    language: "yue",
    patterns: [
      "広東語",
      "廣東語",
      "广东语",
      "粵語",
      "粤语",
      "cantonese",
      "廣州話",
      "广州话",
    ],
  },
  { language: "ja", patterns: ["日本語", "japanese", "日語", "日语"] },
  {
    language: "zh-Hant",
    patterns: ["繁體中文", "繁体中文", "正體中文", "國語", "国语", "mandarin"],
  },
  {
    language: "zh-Hans",
    patterns: ["简体中文", "普通話", "普通话"],
  },
  { language: "ko", patterns: ["한국어", "한국", "korean"] },
  { language: "en", patterns: ["english", "英語", "英语"] },
  { language: "id", patterns: ["bahasa indonesia", "indonesia"] },
  { language: "ms", patterns: ["bahasa melayu", "malay"] },
];

/**
 * The words that introduce a language statement.
 *
 * The pattern has to be a *statement*, not a passing mention — 「中文」 in a
 * sentence about a Chinese song is not a language declaration.
 */
export const LANGUAGE_STATEMENT_LEADS = [
  "主な配信言語",
  "主要配信言語",
  "配信言語",
  "主な言語",
  "主要語言",
  "主要语言",
  "使用言語",
  "使用语言",
  "言語",
  "语言",
  "language",
  "languages",
  "speaks",
  "streaming language",
  "主要使用语言",
];

/**
 * Reads an explicit language statement out of a description.
 *
 * A performer usually streams in **more than one** language —
 * 「主な配信言語: 広東語 / English」 — so this returns every language the
 * statement names, in the order they were written.
 *
 * Returns an empty array when there is no statement; the caller then falls
 * back to the region.
 */
export function detectLanguageStatements(
  text: string | null | undefined,
): string[] {
  if (!text) return [];
  const haystack = text.toLowerCase();

  for (const lead of LANGUAGE_STATEMENT_LEADS) {
    const leadIndex = haystack.indexOf(lead.toLowerCase());
    if (leadIndex < 0) continue;

    // Only look at the text right after the lead — a statement names its
    // languages immediately.
    const window = haystack.slice(leadIndex, leadIndex + lead.length + 40);

    // Collect every match with its position, so the order the performer
    // wrote them in is preserved.
    const found: { language: string; at: number }[] = [];
    for (const { language, patterns } of LANGUAGE_STATEMENT_PATTERNS) {
      for (const pattern of patterns) {
        const at = window.indexOf(pattern.toLowerCase());
        if (at < 0) continue;
        if (found.some((f) => f.language === language)) continue;
        found.push({ language, at });
      }
    }
    if (!found.length) continue;

    found.sort((a, b) => a.at - b.at);
    return found.map((f) => f.language);
  }
  return [];
}

/** The single-language form, for the callers that only need one. */
export function detectLanguageStatement(
  text: string | null | undefined,
): string | null {
  return detectLanguageStatements(text)[0] ?? null;
}

export const CANTONESE_MARKERS = [
  "粵語",
  "粤语",
  "廣東話",
  "广东话",
  "廣州話",
  "广州话",
  "港式",
  "cantonese",
];

/** Whether a text identifies a Cantonese-speaking performer. */
export function detectCantonese(text: string | null | undefined): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return CANTONESE_MARKERS.some((marker) =>
    haystack.includes(marker.toLowerCase()),
  );
}

export const LOCALE_TOKENS: { region: RegionCode; tokens: string[] }[] = [
  {
    region: "cn",
    tokens: [
      // 「翻唱」 is the strongest Chinese marker there is — a Chinese channel
      // covers a song, a Japanese one writes 「カバー」.
      "翻唱",
      "原创曲",
      "原创",
      "虚拟主播",
      "虚拟歌姬",
      "虚拟up主",
      "直播回",
      "直播预告",
      "点歌",
      "新歌",
      "周年",
      "国语",
      "自弹自唱",
      "弹唱",
    ],
  },
  {
    region: "tw",
    tokens: ["繁體", "台灣", "臺灣", "中文翻唱", "繁中"],
  },
  {
    region: "kr",
    tokens: ["노래", "커버", "일정", "방송", "고스트", "자기소개", "브이튜버"],
  },
  {
    region: "id",
    tokens: ["cover lagu", "nyanyi", "jadwal", "streaming", "gambar"],
  },
  {
    region: "my",
    tokens: ["penyiaran", "jadwal", "lagu"],
  },
  {
    region: "jp",
    tokens: [
      // Only tokens that are unambiguously Japanese. 「カバー」, 「歌回」,
      // 「オリジナル曲」 and 「読み」 are all used in Chinese too, so they
      // would misattribute Chinese channels.
      "歌枠",
      "うた",
      "初投稿",
      "生配信",
      "弾き語り",
      "定期配信",
      "まもなく",
      "おしらせ",
      "チャンネル",
      "日本語",
    ],
  },
];

/**
 * Determines the region from a short sample of the channel's own text.
 *
 * Returns `null` when no locale token matched — the caller then falls back
 * to language detection.
 */
export function regionFromLocaleHints(hints: string | null): RegionCode | null {
  if (!hints) return null;
  const haystack = hints.toLowerCase();

  // Score every region rather than taking the first match: a Chinese
  // channel posting a Japanese song title will contain 「初投稿」 as well as
  // 「翻唱」, and first-match would pick the wrong one.
  const scores = new Map<RegionCode, number>();
  for (const { region, tokens } of LOCALE_TOKENS) {
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token.toLowerCase())) score++;
    }
    if (score > 0) scores.set(region, score);
  }
  if (!scores.size) return null;

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0]!;
  const runnerUp = ranked[1]?.[1] ?? 0;

  // Require a clear winner: at least two matching tokens, or a margin of one
  // over the runner-up. Otherwise the hint is not decisive enough to
  // override what the name and description already told us.
  if (bestScore >= 2 && bestScore > runnerUp) return best;
  if (bestScore === 1 && ranked.length === 1) return best;
  return null;
}

/** Builds the `regions` array used in the manifest. */
export function buildRegionMeta(
  counts: Map<RegionCode, { channels: number; items: number }>,
): RegionMeta[] {
  return (Object.keys(REGION_META) as RegionCode[]).map((code) => ({
    code,
    label: REGION_META[code].label,
    badge: REGION_META[code].badge,
    channels: counts.get(code)?.channels ?? 0,
    items: counts.get(code)?.items ?? 0,
  }));
}

/**
 * The language to ask YouTube in for a record of this region.
 *
 * A channel publishes a localized title per UI language, and the English one
 * is often an alias: the Japanese channel 「向葵 / あおい」 answers with
 * `Aoi / Vtuber` in English. The profile is therefore always requested in the
 * language of the record's own region, and this is the mapping.
 */
export function profileLanguage(
  region: string | null | undefined,
): string {
  switch (region) {
    case "jp":
      return "ja";
    case "cn":
      return "zh-CN";
    case "tw":
      return "zh-TW";
    case "hk":
      return "zh-HK";
    case "kr":
      return "ko";
    case "id":
      return "id";
    case "my":
      return "ms";
    default:
      return "en";
  }
}
