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
  hk: { label: "Hong Kong", badge: "🇭🇰", languages: ["zh-Hant", "en"] },
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
 * Returns an IETF tag or `null` when the text is mostly latin/ambiguous.
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

/** Maps a detected language to a region. */
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
