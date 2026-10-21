/**
 * Classification heuristics.
 *
 * Turns raw YouTube API payloads into the normalised `kind` / `role` /
 * `region` / `category` fields used across the dataset. Everything here is
 * deterministic and offline — no network calls, no model calls — so the same
 * input always produces the same output (important for a committed dataset).
 *
 * Every heuristic returns a confidence so the UI can surface uncertain
 * classifications and so manual overrides can outrank automatic guesses.
 */

import type {
  Activity,
  ArtistKind,
  ArtistRole,
  Gender,
  ItemCategory,
  RegionCode,
  Variant,
} from "./types";
import {
  AGENCY_REGION,
  AGENCY_SUBREGION,
  COUNTRY_REGION,
  detectLanguage,
  languageToRegion,
  regionFromLocaleHints,
} from "./regions";

/* -------------------------------------------------------------------------- */
/* Text helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Lower-cases and strips full-width variants so matching is stable. */
export function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[！-～]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    );
}

function has(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/* -------------------------------------------------------------------------- */
/* Channel classification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Marker tiers.
 *
 * `STRONG` markers are unambiguous — a channel that says "VTuber" *is* one.
 * `WEAK` markers are circumstantial and must never outweigh a strong marker
 * of the opposite kind: a channel describing itself as "Vocaloid producer and
 * virtual singer" is a producer, not a VTuber.
 */
const VIRTUAL_STRONG = [
  "vtuber",
  "v tubers",
  "vtubers",
  "virtual youtuber",
  "virtual youTuber",
  "hololive",
  "ホロライブ",
  "にじさんじ",
  "nijisanji",
  "vsinger",
  "v singer",
  "virtual singer",
  "virtual idol",
  "バーチャルyoutuber",
  "vtuber agency",
  "歌い手vtuber",
  "vtuber singer",
  "vshojo",
  "vspo",
  "kamitsubaki",
  "電音部",
  "upd8",
  "kizuna ai",
  "virtual idol project",
  "hololivecn",
  "にじさんじ",
  " reacting to",
];

const VIRTUAL_WEAK = [
  "live2d",
  "lives2d",
  "virtual avatar",
  "virtual character",
  "anime vtuber",
  "kawaii",
  "にじさんじ",
  "ホロ",
  "uber",
  "oshis",
];

const REAL_STRONG = [
  "singer-songwriter",
  "songwriter",
  "music producer",
  "record producer",
  "vocal producer",
  "composer",
  "arranger",
  "ボカロp",
  "vocaloid producer",
  "編曲家",
  "作詞家",
  "作曲家",
  "singer and songwriter",
  "歌手兼",
  "ボーカリスト兼",
  "singer / producer",
];

const REAL_WEAK = [
  "singer",
  "vocalist",
  "musician",
  "artist",
  "singing voice",
  "歌手",
  "シンガー",
  "音楽家",
  "ボーカリスト",
  "ギタリスト",
  "pianist",
  "instrumentalist",
  "vocaloid",
  "lead singer",
];

/**
 * Channels that aggregate other people's content rather than performing.
 * They must never be classified as performers.
 */
const AGGREGATOR_MARKERS = [
  "compilation",
  "compilations",
  "best of",
  "clips",
  "clip channel",
  "clipper",
  "mirroring",
  "mirror",
  "archive",
  "videos of",
  "song requests",
  "まとめ",
  "精选",
  "合集",
  "歌集",
  "pv集",
  "字幕",
  "fansub",
  "reaction to",
];

/**
 * Patterns that only make sense as a whole word in a channel name.
 * Used for words that are too short or too generic for substring matching.
 */
const AGGREGATOR_NAME_PATTERNS: RegExp[] = [
  /\bsubs?\b/i,
  /\bcompilations?\b/i,
  /\bclips?\b/i,
  /\bmirror(ing)?\b/i,
  /\bvideos\b/i,
  /\bfan\s?(compilation|edit|edit)\b/i,
  /\bReaction\s?Channel\b/i,
  /\bArchive\b/,
];

const SINGING_MARKERS = [
  "歌",
  "singer",
  "singing",
  "sing",
  "vocal",
  "music",
  "musical",
  "song",
  "vocaloid",
  "歌回",
  "歌枠",
  "歌い手",
  "cover",
  "mv",
  "music video",
  "concert",
  "live",
  "ライブ",
  "ライブ配信",
  "カラオケ",
  "弾き語り",
  "Mv",
];

/**
 * Agencies, with the region each branch belongs to.
 * A longer needle wins, so `hololive id` beats `hololive`.
 */
const AGENCY_KEYS: string[] = [
  "hololive english",
  "hololive indonesia",
  "hololive dev ism",
  "hololivecn",
  "nijisanji en",
  "nijisanji id",
  "nijisanji kr",
  "nijisanji cn",
  "hololive",
  "nijisanji",
  "v-spo",
  "vshojo",
  "kamitsubaki",
  "電音部",
  "voms",
  "prism project",
  "first wind",
  "phase connect",
  "v4mirai",
  "specialite",
  "idle",
  "unlimited inc",
  "774inc",
  "upd8",
  "re:act",
  "kaela",
  "nori pro",
  "あにまーれ",
  "honey strap",
  "vgproject",
  "virtual music lab",
  "song4u",
];

export interface ChannelSignals {
  name: string;
  description: string | null;
  tags: string[];
  country: string | null;
  /**
   * A short sample of the channel's own uploads, used **only** for region
   * detection. It is deliberately excluded from the virtual/real decision,
   * because upload titles mention "vsinger" so often that they drown out
   * every other signal.
   */
  localeHints?: string | null;
  /** Curated overrides, keyed by channel id. Always wins. */
  override?: {
    kind?: ArtistKind;
    role?: ArtistRole;
    region?: RegionCode;
    agency?: string | null;
    isSinging?: boolean;
  };
}

export interface ChannelClassification {
  kind: ArtistKind;
  role: ArtistRole;
  region: RegionCode;
  language: string | null;
  agency: string | null;
  isSinging: boolean;
  confidence: number;
  /** True when the channel looks like an aggregator rather than a performer. */
  isAggregator: boolean;
  /** Self-described gender. */
  gender: Gender;
  /** True when the performer is AI-generated. */
  isAi: boolean;
  /** Combined label, e.g. `female_vtuber`. */
  variant: Variant;
}

/**
 * Classifies a channel.
 *
 * ## Scoring
 *
 * The channel name is weighted highest (it is what a performer chose to be
 * known by), then the opening of the description (where channels put their
 * one-line identity), then the rest. This matters because a channel
 * description usually says something like:
 *
 *   "VTuber / VSinger / Illustrator. I sing covers on Sundays!"
 *
 * — the first line is the identity, the rest is noise.
 */
export function classifyChannel(signals: ChannelSignals): ChannelClassification {
  const name = normalize(signals.name);
  const description = normalize(signals.description);
  const tags = normalize(signals.tags.join(" "));

  // The first 320 characters of a description are the "identity line".
  const intro = description.slice(0, 320);
  const body = description.slice(320);

  /* --- agency ----------------------------------------------------------- */
  let agency: string | null = null;
  let agencyRegion: RegionCode | null = null;
  for (const key of AGENCY_KEYS) {
    const needle = normalize(key);
    if (!intro.includes(needle) && !name.includes(needle) && !body.includes(needle)) {
      continue;
    }
    if (!agency || key.length > agency.length) {
      agency = key;
      agencyRegion = AGENCY_REGION[key] ?? null;
    }
  }
  if (agency) {
    const sub = AGENCY_SUBREGION[agency];
    if (sub) agencyRegion = sub;
  }

  /* --- aggregator detection --------------------------------------------- */
  const isAggregator =
    countHits(name, AGGREGATOR_MARKERS) > 0 ||
    countHits(intro, AGGREGATOR_MARKERS) > 0 ||
    AGGREGATOR_NAME_PATTERNS.some((re) => re.test(signals.name ?? ""));

  /* --- virtual vs real --------------------------------------------------- */
  const virtualScore =
    3 * countHits(name, VIRTUAL_STRONG) +
    2 * countHits(intro, VIRTUAL_STRONG) +
    countHits(body, VIRTUAL_STRONG) +
    countHits(tags, VIRTUAL_STRONG) +
    1 * countHits(name, VIRTUAL_WEAK) +
    countHits(intro, VIRTUAL_WEAK);

  const realScore =
    3 * countHits(name, REAL_STRONG) +
    2 * countHits(intro, REAL_STRONG) +
    countHits(body, REAL_STRONG) +
    countHits(tags, REAL_STRONG) +
    1 * countHits(name, REAL_WEAK) +
    countHits(intro, REAL_WEAK);

  let kind: ArtistKind;
  let kindScore: number;
  if (virtualScore === 0 && realScore === 0) {
    // No evidence either way. A dataset built around VTuber content is more
    // likely to be virtual, but the confidence stays low so the UI can flag it.
    kind = "virtual";
    kindScore = 0.3;
  } else if (virtualScore >= realScore) {
    kind = "virtual";
    kindScore = virtualScore;
  } else {
    kind = "real";
    kindScore = realScore;
  }

  /* --- role -------------------------------------------------------------- */
  let role: ArtistRole = "unknown";
  if (isAggregator) {
    role = "unknown";
  } else if (kind === "virtual") {
    if (has(all(name, intro, body, tags), ["vsinger", "virtual singer", "歌い手"])) {
      role = "vsinger";
    } else if (virtualScore > 0) {
      role = "vtuber";
    }
  } else {
    if (has(all(name, intro, body, tags), ["producer", "ボカロp", "vocaloid producer", "作詞", "作曲", "編曲"])) {
      role = "producer";
    } else if (has(all(name, intro, body, tags), ["composer", "作曲家"])) {
      role = "composer";
    } else if (has(all(name, intro, body, tags), ["singer", "歌手", "シンガー", "vocalist", "ボーカリスト", "vocal"])) {
      role = "singer";
    } else if (has(all(name, intro, body, tags), ["musician", "ギタリスト", "pianist", "instrumentalist", "音楽家"])) {
      role = "musician";
    }
  }

  /* --- region ------------------------------------------------------------ */
  let region: RegionCode = "unknown";
  let regionScore = 0;

  if (agencyRegion) {
    region = agencyRegion;
    regionScore = 0.9;
  }

  const country = signals.country?.toUpperCase() ?? null;
  if (regionScore < 0.75 && country && COUNTRY_REGION[country]) {
    region = COUNTRY_REGION[country];
    regionScore = 0.8;
  }

  const lang = detectLanguage(
    `${signals.name ?? ""} ${signals.description ?? ""} ${signals.tags.join(" ")}`,
  );
  const langRegion = languageToRegion(lang);
  if (langRegion && regionScore < 0.7) {
    region = langRegion;
    regionScore = 0.65;
  }

  const strongRegion = detectStrongRegion(all(name, intro, body, tags));
  if (strongRegion) {
    region = strongRegion.code;
    regionScore = strongRegion.score;
  }

  // Locale hints from the channel's own uploads disambiguate kanji-only
  // names, which are otherwise guessed from the description alone.
  const hintRegion = regionFromLocaleHints(signals.localeHints ?? null);
  if (hintRegion && regionScore < 0.85) {
    region = hintRegion;
    regionScore = 0.85;
  }

  /* --- singing ----------------------------------------------------------- */
  const singingHits =
    countHits(name, SINGING_MARKERS) +
    countHits(intro, SINGING_MARKERS) +
    countHits(tags, SINGING_MARKERS);
  const isSinging =
    !isAggregator && (singingHits > 0 || role === "vsinger" || role === "singer");

  /* --- overrides --------------------------------------------------------- */
  const ov = signals.override ?? {};
  if (ov.kind) kind = ov.kind;
  if (ov.role) role = ov.role;
  if (ov.region) {
    region = ov.region;
    regionScore = 1;
  }
  if (ov.agency !== undefined) agency = ov.agency;

  const confidence = ov.kind || ov.role
    ? 1
    : Math.max(
        0.15,
        Math.min(1, (kindScore * 0.25 + regionScore * 0.6) / 1.2),
      );

  const gender = detectGender(
    signals.name,
    signals.description,
    signals.tags,
  );
  const isAi = detectAi(
    signals.name,
    signals.description,
    signals.tags,
  );

  return {
    kind,
    role,
    region,
    language: lang,
    agency,
    isSinging,
    confidence,
    isAggregator,
    gender,
    isAi,
    variant: deriveVariant(role, gender, isAi),
  };
}

/** Joins the weighted text segments used by the classifier. */
function all(...parts: string[]): string {
  return parts.join(" ");
}

/** Counts how many needles from a list appear in the haystack. */
function countHits(haystack: string, needles: string[]): number {
  let hits = 0;
  for (const n of needles) {
    const nn = normalize(n);
    if (nn && haystack.includes(nn)) hits++;
  }
  return hits;
}

/** Very explicit region markers that should win over inference. */
function detectStrongRegion(
  all: string,
): { code: RegionCode; score: number } | null {
  const explicit: [RegionCode, string[]][] = [
    ["jp", ["hololive jp", "ホロライブ", "にじさんじ", "nijisanji jp", "日本", "vspo"]],
    ["cn", ["hololivecn", "哔哩哔哩", "bilibili", "中国"]],
    ["tw", ["台灣", "taiwan", "台湾", "繁体"]],
    ["hk", ["香港", "hong kong"]],
    ["kr", ["한국", "korea", "한국어", "버추얼"]],
    ["id", ["indonesia", "indonesian", "Indonesia", " holomorphic"]],
    ["my", ["malaysia", "malaysian"]],
  ];
  for (const [code, needles] of explicit) {
    if (has(all, needles)) return { code, score: 0.92 };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Item classification                                                        */
/* -------------------------------------------------------------------------- */

const COVER_MARKERS = [
  "cover",
  "cover song",
  "歌ってみた",
  "カバー",
  "cover by",
  "翻唱",
  "翻唱自",
  "演唱",
  "カバ",
  "covered by",
  "유커버",
  "cover ver",
  "cover version",
];

const MV_MARKERS = [
  "music video",
  "mv",
  "m/v",
  "pv",
  "pv版",
  "mv版",
  "mv.",
  "mv ",
  "mv_",
  "-mv",
  "mv【",
  "official mv",
  "pv Newly",
  "pv full",
  "pv full ver",
];

const ORIGINAL_MARKERS = [
  "original song",
  "original mv",
  "original",
  "オリジナル曲",
  "オリジナル",
  "自作詞",
  "オリジナルミュージックビデオ",
  "初投稿",
  "新曲",
  "原创曲",
  "原创",
];

const LIVE_MARKERS = [
  "歌枠",
  "ライブ",
  "live",
  "concert",
  "コンサート",
  "生放送",
  "生配信",
  "歌いsing",
  "karaoke",
  "カラオケ",
  "sing along",
  "singalong",
  "sing-along",
  "singalong live",
  "acoustic live",
  "全曲",
  "全曲うた",
  "歌唱会",
  "session",
  "セッション",
  "unplugged",
  "弾き語り",
  "セッションライブ",
  "nightlive",
  "歌い定期",
];

const PERFORMANCE_MARKERS = [
  "performance",
  "パフォーマンス",
  "演奏",
  "生演奏",
  "piano",
  "ピアノ",
  "guitar",
  "ギター",
  "arrangement",
  "アレンジ",
  "instrumental",
  "絵 Compte",
  "合奏",
];

const COLLAB_MARKERS = [
  "collab",
  "コラボ",
  "duet",
  "デュエット",
  "feat.",
  "with ",
  "共演",
  "合作",
  "joint",
  "w/",
];

/**
 * Singing while playing an instrument.
 *
 * 弾き語り (Japanese), 彈唱 / 自弹自唱 (Chinese), acoustic (English). These
 * uploads are usually covers as well, so this is detected as a *flag* and not
 * as a category — the user wants to filter for them without losing the
 * cover / original classification.
 */
const ACOUSTIC_MARKERS = [
  "弾き語り",
  "弹き語り",
  "彈唱",
  "弹唱",
  "自弹自唱",
  "弹唱自弹",
  "acoustic cover",
  "acoustic version",
  "acoustic ver",
  "acoustic performance",
  "acoustic guitar",
  "acoustic live",
  "アコoustic",
  "acoustic",
  "吉他弹唱",
  "钢琴弹唱",
  "鋼琴彈唱",
  "弹吉他",
  "fingerstyle",
  "finger pick",
  "unplugged cover",
  "弾き.Compare",
];

/** Prefixes/titles that mark a channel as a "clip" style upload. */
const CLIP_MARKERS = ["shorts", "#shorts", "short"];

export interface ItemSignals {
  title: string;
  description: string | null;
  tags: string[];
  channelKind: ArtistKind;
  /** `live` | `upcoming` | `past` | `unknown`, from the API. */
  status: "live" | "upcoming" | "past" | "unknown";
  isShort: boolean;
  durationSeconds: number | null;
  /** The performing channel's region, used as a fallback. */
  channelRegion: RegionCode;
}

export interface ItemClassification {
  category: ItemCategory;
  songTitle: string | null;
  originalArtist: string | null;
  isCollab: boolean;
  /** Singing while playing an instrument (弾き語り / 彈唱 / acoustic). */
  isAcoustic: boolean;
  confidence: number;
}

export function classifyItem(signals: ItemSignals): ItemClassification {
  const title = normalize(signals.title);
  const description = normalize(signals.description);
  const tags = normalize(signals.tags.join(" "));
  const all = `${title} ${description} ${tags}`;

  const isCover = has(all, COVER_MARKERS);
  const isMv = has(all, MV_MARKERS);
  const isOriginal = has(all, ORIGINAL_MARKERS);
  const isLive = has(all, LIVE_MARKERS);
  const isPerformance = has(all, PERFORMANCE_MARKERS);
  const isCollab = has(all, COLLAB_MARKERS);
  const isAcoustic = has(all, ACOUSTIC_MARKERS);

  let category: ItemCategory = "other";
  if (isCover) category = "cover";
  else if (isOriginal && !isMv) category = "original";
  else if (isMv) category = "mv";
  else if (isLive) category = "live";
  else if (isPerformance) category = "performance";
  else if (signals.status === "upcoming") category = "premiere";

  // A live/upcoming item on a singing channel is a live performance even when
  // the title has no live marker.
  if (category === "other" && signals.status === "live") category = "live";
  if (
    category === "other" &&
    signals.status === "upcoming" &&
    signals.channelKind === "virtual"
  ) {
    category = "premiere";
  }

  const { songTitle, originalArtist } = extractSongInfo(
    signals.title,
    signals.description,
    signals.tags,
  );

  const hits =
    (isCover ? 1 : 0) +
    (isMv ? 1 : 0) +
    (isOriginal ? 1 : 0) +
    (isLive ? 1 : 0) +
    (isPerformance ? 1 : 0);

  return {
    category,
    songTitle,
    originalArtist,
    isCollab,
    isAcoustic,
    confidence: Math.min(1, 0.4 + hits * 0.15),
  };
}

/* -------------------------------------------------------------------------- */
/* Song extraction                                                            */
/* -------------------------------------------------------------------------- */

const SONG_PATTERNS: RegExp[] = [
  // 【Cover】Title / Artist   |  【歌】Title - Artist
  /[【\[（(]\s*(?:cover|歌|歌唱|歌枠|うた|カバ|mv|pv)\s*[】\]）)]\s*[:：\-—]?\s*(.+)/i,
  // Cover: Title - Artist
  /^\s*cover\s*[:\-—]\s*(.+)$/i,
  // Title / Artist  (J-Pop style separators)
  /^[^/｜|]{1,120}\s*[/｜|]\s*[^/｜|]{1,80}$/,
  // Title - Artist
  /^(.+?)\s+[-–—]\s+(.+)$/,
];

const ARTIST_PATTERNS: RegExp[] = [
  // `歌い手：Artist` / `Artist：Title`
  /(?:歌い手|歌唱|歌手|artist|performer|original artist|原曲|原作)\s*[:：]\s*([^\s|/｜,，]{1,60})/i,
  /by\s+([A-Za-z0-9_.\- ]{2,40})/i,
];

/**
 * Best-effort extraction of the performed song title and the original artist.
 * Returns `null` when nothing confident can be extracted.
 */
export function extractSongInfo(
  title: string | null | undefined,
  description: string | null | undefined,
  tags: string[] | null | undefined,
): { songTitle: string | null; originalArtist: string | null } {
  const rawTitle = (title ?? "").trim();
  const rawDesc = (description ?? "").trim();
  const rawTags = (tags ?? []).join(" ");

  let songTitle: string | null = null;
  let originalArtist: string | null = null;

  for (const re of SONG_PATTERNS) {
    const m = re.exec(rawTitle);
    if (!m) continue;
    const first = m[1]?.trim() ?? "";
    const second = m[2]?.trim() ?? "";
    if (second && first) {
      songTitle = stripNoise(first);
      originalArtist = stripNoise(second);
    } else if (first) {
      songTitle = stripNoise(first);
    }
    if (songTitle) break;
  }

  for (const re of ARTIST_PATTERNS) {
    const m = re.exec(rawDesc) ?? re.exec(rawTags);
    if (!m) continue;
    originalArtist = stripNoise(m[1]);
    if (originalArtist) break;
  }

  // Hashtags frequently carry the song name.
  if (!songTitle) {
    const tagSong = rawTags.match(/#([^#\s]{2,40})/);
    if (tagSong && !/shorts?|vtuber|vsinger|歌い手|cover|mv/i.test(tagSong[1])) {
      songTitle = stripNoise(tagSong[1]);
    }
  }

  return { songTitle, originalArtist };
}

/** Removes decorative prefixes/suffixes from a title fragment. */
export function stripNoise(value: string): string {
  return value
    .replace(/^[\s\-–—_=|:：]+/, "")
    .replace(/[\s\-–—_=|:：]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the item looks like a Shorts upload. */
export function isShortItem(
  title: string,
  durationSeconds: number | null,
  description: string | null,
): boolean {
  const t = normalize(title);
  if (t.includes("#shorts")) return true;
  if (normalize(description).includes("#shorts")) return true;
  if (durationSeconds !== null && durationSeconds > 0 && durationSeconds <= 60) {
    // 60s or shorter AND the channel title has no long-form marker → Short.
    return true;
  }
  return false;
}

/** Exposed for tests. */
export const MARKERS = {
  VIRTUAL_STRONG,
  VIRTUAL_WEAK,
  REAL_STRONG,
  REAL_WEAK,
  AGGREGATOR_MARKERS,
  SINGING_MARKERS,
  COVER_MARKERS,
  MV_MARKERS,
  ORIGINAL_MARKERS,
  LIVE_MARKERS,
  PERFORMANCE_MARKERS,
  COLLAB_MARKERS,
  CLIP_MARKERS,
};

/* -------------------------------------------------------------------------- */
/* Gender                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Explicit self-descriptions of gender. These are the reliable signals —
 * a channel that says "female VTuber" *is* one.
 */
const FEMALE_MARKERS = [
  "female vtuber",
  "female vTuber",
  "female singer",
  "female vocalist",
  "she/her",
  "she / her",
  "girl",
  "woman",
  "female",
  "女性vtuber",
  "女性vocaloid",
  "女性",
  "女の子",
  "女声",
  "女子",
  "女生",
  "女孩子",
  "女声优",
  "娘娘",
  "少女",
  "she's",
  "hers",
  "女神",
  "少女",
];

const MALE_MARKERS = [
  "male vtuber",
  "male vTuber",
  "male singer",
  "male vocalist",
  "he/him",
  "he / him",
  "boy",
  "man",
  "male",
  "男性vtuber",
  "男性",
  "男の子",
  "男声",
  "男子",
  "男生",
  "男孩子",
  "男声优",
  "哥哥",
  "少年",
  "he's",
  "his",
  "lojikon",
  "皇帝",
];

/**
 * Weak signals from Japanese honorifics, which appear in fan-facing names
 * and channel titles.
 *
 * These are only used when there is no explicit statement, and a mismatch
 * between two weak signals cancels out.
 */
const FEMALE_WEAK = ["ちゃん", "さん", "姉", "姉貴", "妹", "姉", "嬢", "ねえ"];
const MALE_WEAK = ["くん", "君", "兄", "兄貴", "俺", " dude", " bruh"];

/**
 * Detects the performer's gender from a channel's self-description.
 *
 * Returns `unknown` when nothing conclusive is found — which is the common
 * case and is stored as such rather than guessed.
 */
export function detectGender(
  name: string | null | undefined,
  description: string | null | undefined,
  tags: string[] | null | undefined,
): Gender {
  const all = normalize(
    `${name ?? ""} ${description ?? ""} ${(tags ?? []).join(" ")}`,
  );
  if (!all) return "unknown";

  // Explicit statements win outright.
  const femaleExplicit = countHits(all, FEMALE_MARKERS);
  const maleExplicit = countHits(all, MALE_MARKERS);
  if (femaleExplicit > 0 && femaleExplicit > maleExplicit) return "female";
  if (maleExplicit > 0 && maleExplicit > femaleExplicit) return "male";

  // Fall back to honorifics, but only if one side clearly dominates.
  const femaleWeak = countHits(all, FEMALE_WEAK);
  const maleWeak = countHits(all, MALE_WEAK);
  if (femaleWeak > maleWeak && femaleWeak > 0) return "female";
  if (maleWeak > femaleWeak && maleWeak > 0) return "male";

  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* AI content                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Markers for AI-generated performers and content.
 *
 * "AI" on its own is far too common a token to match (it appears inside
 * words like "Rain" or "Air"), so every pattern requires AI to sit next to
 * a relevant noun.
 */
const AI_MARKERS = [
  "ai vtuber",
  "aivtuber",
  "ai vTuber",
  "ai singer",
  "ai歌い手",
  "ai singer",
  "ai voice",
  "ai voice actor",
  "ai-generated",
  "ai generated",
  "ai-generated song",
  "ai song",
  "ai music",
  "ai cover",
  "ai cover song",
  "ai uta",
  "aiuta",
  "ai 歌声",
  "ai 歌声合成",
  "ai歌声",
  "ai 歌唱",
  "ai歌唱",
  "ai 翻唱",
  "ai翻唱",
  "ai 原创",
  "ai原创",
  "ai 作曲",
  "ai作曲",
  "ai-generated vtuber",
  "synthesizer v",
  "synthesizerv",
  "cevio ai",
  "cevioai",
  "voice avoid",
  "neutrino",
  "diffsinger",
  "deepfake",
  "ai music video",
  "ai mv",
  "ai 拟真",
  "ai拟真",
  "ai 虚拟主播",
  "ai虚拟主播",
  "ai singer vtuber",
  "voice ai",
  "ai voice synthesis",
  "ai歌声合成",
  "ai歌生成",
  "歌生成ai",
  "ai original song",
  "ai original",
  "ai channel",
  "ai model",
  "vocaloid ai",
  "歌声合成",
];

/**
 * Detects AI-generated performers or content.
 *
 * @param name        the channel / item title
 * @param description the description
 * @param tags        declared keywords
 */
export function detectAi(
  name: string | null | undefined,
  description: string | null | undefined,
  tags: string[] | null | undefined,
): boolean {
  const all = normalize(
    `${name ?? ""} ${description ?? ""} ${(tags ?? []).join(" ")}`,
  );
  if (!all) return false;

  if (has(all, AI_MARKERS)) return true;

  // A standalone "ai" only counts when it is a word, next to a relevant noun.
  if (/(^|[^a-z])ai([^a-z]|$)/.test(all)) {
    if (
      has(all, [
        "vtuber",
        "singer",
        "voice",
        "song",
        "music",
        "cover",
        "vocaloid",
        "歌",
        "音乐",
        "音",
      ])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the combined variant label.
 *
 * The AI flag takes precedence over the gender, because "AI VTuber" is the
 * more useful distinction — an AI performer has no meaningful gender.
 */
export function deriveVariant(
  role: ArtistRole,
  gender: Gender,
  isAi: boolean,
): Variant {
  const base: Variant =
    role === "vtuber" || role === "vsinger" || role === "singer"
      ? role
      : role === "producer" || role === "composer" || role === "musician"
        ? role
        : "unknown";

  if (isAi) {
    if (base === "vtuber") return "ai_vtuber";
    if (base === "vsinger") return "ai_vsinger";
    if (base === "singer") return "ai_singer";
    if (base === "producer") return "ai_producer";
    if (base === "composer") return "ai_composer";
    if (base === "musician") return "ai_musician";
    return "ai_vsinger";
  }

  if (base === "vtuber") {
    if (gender === "female") return "female_vtuber";
    if (gender === "male") return "male_vtuber";
    return "vtuber";
  }
  if (base === "vsinger") {
    if (gender === "female") return "female_vsinger";
    if (gender === "male") return "male_vsinger";
    return "vsinger";
  }
  if (base === "singer") {
    if (gender === "female") return "female_singer";
    if (gender === "male") return "male_singer";
    return "singer";
  }
  if (base === "producer") {
    if (gender === "female") return "female_producer";
    if (gender === "male") return "male_producer";
    return "producer";
  }
  if (base === "composer") {
    if (gender === "female") return "female_composer";
    if (gender === "male") return "male_composer";
    return "composer";
  }
  if (base === "musician") {
    if (gender === "female") return "female_musician";
    if (gender === "male") return "male_musician";
    return "musician";
  }
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                   */
/* -------------------------------------------------------------------------- */

/** Markers that indicate a performer has retired or rebranded. */
const GRADUATED_MARKERS = [
  "卒業",
  "graduated",
  "graduation",
  "retired",
  "farewell",
  "last stream",
  "活動終了",
  "活動終了のお知らせ",
  "休眠",
  " hiatus",
  "最終配信",
  "卒業のお知らせ",
  "卒業しました",
];

const PREPARING_MARKERS = [
  "デビュー予定",
  "デビューします",
  "debut",
  "preparing",
  "coming soon",
  "まもなくデビュー",
  "activities start",
  "新Vtuber",
  "新人vtuber",
];

/**
 * Derives the streaming activity status of a channel.
 *
 * Precedence: explicit graduation markers → explicit debut-pending markers →
 * recency of the newest upload → `unknown`.
 *
 * @param newestUploadAt ISO timestamp of the most recent known upload.
 */
export function detectActivity(
  name: string | null | undefined,
  description: string | null | undefined,
  newestUploadAt: string | null | undefined,
): Activity {
  const all = normalize(`${name ?? ""} ${description ?? ""}`);

  if (has(all, GRADUATED_MARKERS)) return "graduated";
  if (has(all, PREPARING_MARKERS)) return "preparing";

  if (newestUploadAt) {
    const ts = Date.parse(newestUploadAt);
    if (Number.isFinite(ts)) {
      const days = (Date.now() - ts) / (24 * 60 * 60 * 1000);
      if (days > 365) return "graduated";
      if (days > 120) return "unknown";
      return "active";
    }
  }

  return "unknown";
}
