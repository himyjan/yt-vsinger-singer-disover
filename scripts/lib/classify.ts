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
  Affiliation,
  ClassificationConfidence,
  ArtistKind,
  ArtistRole,
  Gender,
  ItemCategory,
  PlatformId,
  RegionCode,
  RegionSource,
  Variant,
} from "./types";
import { computeConfidence } from "./confidence";
import {
  AGENCY_REGION,
  AGENCY_SUBREGION,
  COUNTRY_REGION,
  REGION_LANGUAGE,
  detectLanguage,
  detectLanguageStatements,
  hasKana,
  languageToRegion,
  normalizeCountry,
  regionFromLocaleHints,
} from "./regions";
import {
  AI_TRANSLATED,
  CLIP_CHANNELS,
  COMMUNITY_CAMP,
  CORPORATE_CAMP,
  PERSON_BEHIND,
  PREMIERE,
  REINCARNATION_CAMP,
  SINGING_CAMP,
  SKIN_SUIT,
  SOLO_CAMP,
  STREAM_ARCHIVE,
} from "./vtuber-glossary";

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
  ...CLIP_CHANNELS,
  ...SKIN_SUIT,
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
  "vsinger",
  "v singer",
  "virtual singer",
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
 * The singing markers that are unambiguous enough to look for **anywhere** in
 * a description.
 *
 * The markers above are only read in the first 320 characters of a
 * description — the "identity line" — because the broad ones (`歌`, `live`,
 * `song`) mean something different in the middle of a paragraph about
 * something else.
 *
 * These are different: 「歌勢」 and 「翻唱」 mean the channel sings, in every
 * language and in every position, and they are what the Chinese and
 * Japanese scenes actually write. A channel that says 「翻唱」 in its bio is
 * a singing channel, and it should be marked as one whether the word is in
 * the first line or the last.
 */
const SINGING_DESCRIPTION_MARKERS = [
  /* Chinese — 歌勢 is the term the Chinese scene uses for a singing VTuber */
  "歌勢",
  "歌势",
  "歌唱勢",
  "歌唱势",
  "翻唱",
  "翻唱自",
  "演唱",
  "歌声",
  "唱歌",
  "歌唱",
  "原创歌曲",
  "原創歌曲",
  "原创曲",
  "原創曲",
  "自创曲",
  "虚拟歌手",
  "虛擬歌手",
  "歌姬",
  "歌姫",
  "唱见",
  "點歌",
  "点歌",
  "歌单",
  "歌單",
  "合唱",
  "声乐",
  "聲樂",
  "原创音乐",
  "原創音樂",
  /* Japanese */
  "歌ってみた",
  "歌って",
  "カバー",
  "カバ",
  "弾き語り",
  "オリジナル曲",
  "自作曲",
  "歌い手",
  "シンガー",
  "歌唱",
  "ボカロ",
  "歌枠",
  "歌回",
  "ライブ歌唱",
  /* Korean */
  "노래",
  "커버",
  "보컬",
  "sing",
  "유커버",
  "작곡",
  "노래방",
  /* English */
  "song cover",
  "cover song",
  "covers songs",
  "cover songs",
  "cover of",
  "covers of",
  "acoustic cover",
  "vtuber cover",
  "vocal cover",
  "singing covers",
  "music covers",
  "a cappella",
  "singing stream",
  "original song",
  "original songs",
  "singing vtuber",
  "vtuber singer",
  "virtual singer",
  "voice synthesizer",
  /* Russian */
  "кавер",
  "вокал",
  "припев",
  "поет",
  "поёт",
  "песня",
  "песни",
  "музыка",
  /* Spanish / Portuguese / Italian */
  "canto",
  "cantante",
  "canción",
  "musica",
  "música",
  "voz",
  "acústico",
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
   * The platform the channel was found on.
   *
   * This is a strong region signal: a channel that only exists on Bilibili
   * is mainland Chinese, and one that only exists on Niconico is Japanese —
   * regardless of whether its name happens to use characters shared between
   * the two scripts.
   */
  platform?: PlatformId | null;
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
    /**
     * A curated `kind` outranks the aggregator test.
     *
     * A subscription list that files 「小恐龍烤肉屋【Vtuber中文精華】」 under
     * 「Vtuber」 is a statement by its owner, and a name pattern is a guess.
     * Without this, the sync re-derived `kind` from the description on the
     * next run and the import's whole point was lost.
     */
    curated?: boolean;
  };
}

export interface ChannelClassification {
  kind: ArtistKind;
  role: ArtistRole;
  region: RegionCode;
  /** The languages the performer streams in. */
  languages: string[];
  /**
   * Only the languages the performer **stated** themselves.
   *
   * The distinction matters: a record's languages are the stated ones plus
   * the ones the region implies, and a caller that already knows the region
   * must not have the region applied twice — or with the wrong region.
   */
  statedLanguages: string[];
  agency: string | null;
  isSinging: boolean;
  /** True when the channel looks like an aggregator rather than a performer. */
  isAggregator: boolean;
  /** Which source decided the region. */
  regionSource: RegionSource;
  /**
   * How sure each axis of the classification is.
   *
   * An estimate, not a measurement — it says how much evidence the
   * classifier had. It is used to order the verification queue; the
   * `verification` record is the fact.
   */
  confidence: ClassificationConfidence;
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

  /**
   * No agency from the known list — so read the one the performer states.
   *
   * 「にじさんじ所属」, 「所属：にじさんじ」, 「니지산지 소속」, "affiliated with
   * Nijisanji" all say the same thing, and all of them name a group that the
   * roster never recorded.
   */
  if (!agency) {
    const stated = extractAgency(signals.name, signals.description);
    if (stated) {
      agency = stated;
      /**
       * The region is **not** touched. A description saying 「ホロライブ所属」
       * names the group, not the branch — a Hololive EN member writes the same
       * line — and it is the same mistake as trusting a Bilibili mirror.
       */
    }
  }

  if (agency) {
    const sub = AGENCY_SUBREGION[agency];
    if (sub) agencyRegion = sub;
  }

  /* --- aggregator detection --------------------------------------------- */
  /**
   * A curated record is not re-guessed.
   *
   * `data/overrides.json` can say a channel is virtual — a subscription group
   * did — and a name pattern such as 「小恐龍烤肉屋」 must not overrule a
   * person's own statement. The override still wins below; this only stops
   * the aggregator test from deciding for it.
   */
  const isAggregator =
    !signals.override?.curated &&
    (countHits(name, AGGREGATOR_MARKERS) > 0 ||
      countHits(intro, AGGREGATOR_MARKERS) > 0 ||
      AGGREGATOR_NAME_PATTERNS.some((re) => re.test(signals.name ?? "")) ||
      detectClipAccount(signals.name, signals.description));

  /* --- virtual vs real --------------------------------------------------- */
  const virtualScore =
    3 * countHits(name, VIRTUAL_STRONG) +
    2 * countHits(intro, PERSON_BEHIND) +
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
    } else if (has(all(name, intro, body, tags), SINGING_CAMP)) {
      // 歌勢 — posts MVs and holds singing streams; the community also calls
      // these performers 虛擬歌手 (virtual singers).
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
  /**
   * The region, in the order of what each source actually knows.
   *
   * The order is not the order the sources are tried in — it is what each
   * one is allowed to override:
   *
   * 1. **The agency branch.** Hololive EN is English and VirtuaReal is
   *    Chinese, whatever the name looks like and wherever the person lives.
   * 2. **The channel's own published country.** A stated fact, and the one
   *    source a **mirror** cannot corrupt: a Japanese performer with a
   *    Bilibili account is still Japanese.
   * 3. **Kana in the name.** Evidence, never proof — kana occur in Japanese
   *    and nowhere else, but a Taiwanese performer can use a Japanese stage
   *    name, which is why a country or an agency outranks it.
   * 4. **An explicit region statement** — 「台灣」, 「香港」, 「한국」.
   * 5. **The platform the channel lives on.** A channel that exists *only*
   *    on Bilibili is mainland Chinese. A **link** to Bilibili is not a
   *    statement about origin, which is why the word "bilibili" is not one
   *    of the explicit statements below.
   * 6. **The script of the name and of the uploads.** The weakest guess, and
   *    only used when nothing else is known.
   */
  let region: RegionCode = "unknown";
  let regionScore = 0;
  let regionSource: RegionSource = "unknown";

  if (agencyRegion) {
    region = agencyRegion;
    regionScore = 0.92;
    regionSource = "agency";
  }

  /**
   * The country the channel publishes, as an ISO code.
   *
   * The Data API supplies an ISO code and InnerTube's about page supplies a
   * label in the session's language (「日本」, "Japan"), so both are read.
   */
  const country = normalizeCountry(signals.country);
  if (country && COUNTRY_REGION[country] && regionScore < 0.88) {
    region = COUNTRY_REGION[country];
    regionScore = 0.88;
    regionSource = "country";
  }

  /**
   * Kana in the channel's **own name**.
   *
   * Only the name: a description can quote Japanese without the performer
   * being Japanese, and a Chinese channel frequently does. The aliases are
   * deliberately excluded too — vdb fills the `jp` field with a **kana
   * reading** for Chinese names (「小卯」 → 「コウサギ」), which is a
   * translation, not the performer's own name.
   */
  if (hasKana(signals.name) && regionScore < 0.82) {
    region = "jp";
    regionScore = 0.82;
    regionSource = "name";
  }

  /**
   * The platform a performer is hosted on is a region prior, not a fact.
   *
   * Bilibili's VTuber partition is mostly mainland Chinese and Niconico is
   * Japanese, so a channel that exists *only* there is a reasonable guess.
   * It is deliberately the weakest of the positive signals, because the same
   * Bilibili account can be a mirror of a Japanese channel.
   */
  const platformRegion: Record<string, RegionCode> = {
    bilibili: "cn",
    niconico: "jp",
  };
  const fromPlatform = signals.platform
    ? platformRegion[signals.platform]
    : undefined;
  if (fromPlatform && regionScore < 0.7) {
    region = fromPlatform;
    regionScore = 0.7;
    regionSource = "platform";
  }

  /**
   * The language.
   *
   * It is derived from the **region**, not from the name. A Taiwanese
   * performer very often has a Japanese-style stage name — and the kana in
   * it says nothing about the language they sing in. The region is the
   * authoritative fact; the script of a handle is a coincidence.
   *
   * The name is only used when the region is unknown.
   */
  const scriptLang = detectLanguage(
    `${signals.name ?? ""} ${signals.description ?? ""} ${signals.tags.join(" ")}`,
  );
  const langRegion = languageToRegion(scriptLang);
  if (langRegion && regionScore < 0.6) {
    region = langRegion;
    regionScore = 0.6;
    regionSource = "script";
  }
  /**
   * The languages, in order of authority:
   *
   * 1. **What the performer states.** 「主な配信言語: 広東語 / English」 is a
   *    fact about themselves — it outranks everything else. Performers
   *    usually stream in more than one language, so all of them are kept, in
   *    the order they were written.
   * 2. **The region.** A Taiwanese performer performs in Chinese, whatever
   *    their stage name looks like.
   * 3. **The script of the name.** The weakest signal, and only used when
   *    nothing else is known.
   */
  const statedLangs = detectLanguageStatements(
    `${signals.description ?? ""} ${signals.name ?? ""}`,
  );

  // A performer who states they speak Cantonese and whose region is not
  // otherwise known belongs to the Hong Kong scene.
  if (statedLangs.includes("yue") && region === "unknown") {
    region = "hk";
    regionScore = 0.8;
    regionSource = "declared";
  }

  const statedLanguages = statedLangs;
  const languages = statedLangs.length
    ? statedLangs
    : [REGION_LANGUAGE[region] ?? scriptLang].filter(
        (l): l is string => !!l,
      );

  const strongRegion = detectStrongRegion(all(name, intro, body, tags));
  if (strongRegion && strongRegion.score > regionScore) {
    region = strongRegion.code;
    regionScore = strongRegion.score;
    regionSource = "declared";
  }

  // Locale hints from the channel's own uploads disambiguate kanji-only
  // names, which are otherwise guessed from the description alone.
  const hintRegion = regionFromLocaleHints(signals.localeHints ?? null);
  if (hintRegion && regionScore < 0.55) {
    region = hintRegion;
    regionScore = 0.55;
    regionSource = "script";
  }

  /* --- singing ----------------------------------------------------------- */
  /**
   * The whole description is searched for the unambiguous markers, and the
   * first 320 characters for the broad ones.
   */
  const singingHits =
    countHits(name, SINGING_MARKERS) +
    countHits(intro, SINGING_MARKERS) +
    countHits(tags, SINGING_MARKERS) +
    countHits(description, SINGING_DESCRIPTION_MARKERS);
  /**
   * A curated `kind` also means a curated flag: whoever filed a channel as a
   * virtual performer decided it is one, so an aggregator's `isSinging: false`
   * must not be applied behind their back.
   */
  const isSinging =
    (!isAggregator || !!signals.override?.curated) &&
    (singingHits > 0 || role === "vsinger" || role === "singer");

  /* --- overrides --------------------------------------------------------- */
  const ov = signals.override ?? {};
  if (ov.kind) kind = ov.kind;
  if (ov.role) role = ov.role;
  if (ov.region) {
    region = ov.region;
    regionScore = 1;
    regionSource = "override";
  }
  if (ov.agency !== undefined) agency = ov.agency;


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

  /**
   * The confidence of each axis.
   *
   * The region and the kind drive the overall figure, because a record with
   * the wrong region is in the wrong place and a record with the wrong kind
   * is in the wrong dataset.
   */
  const confidence = computeConfidence({
    kind,
    role,
    region,
    regionSource,
    gender,
    isAi,
    affiliation: detectAffiliation(
      signals.name,
      signals.description,
      agency,
    ),
    activity: "unknown",
    curated: !!(ov.kind || ov.role),
    kindDeclared: kindScore >= 3,
    kindHits: kindScore,
  });

  return {
    kind,
    role,
    region,
    regionSource,
    confidence,
    languages,
    statedLanguages,
    agency,
    isSinging,
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

/**
 * Very explicit region markers that should win over inference.
 *
 * A **link** is not a region statement: a Japanese channel that also posts
 * on Bilibili lists `bilibili.com/…` in its description, so "bilibili" is
 * deliberately not here. A mirror is not an origin — only a channel that
 * exists *only* on Bilibili gets the platform prior.
 *
 * The score sits below a published country and below kana, because both are
 * closer to the performer than a word in a bio.
 */
function detectStrongRegion(
  all: string,
): { code: RegionCode; score: number } | null {
  const explicit: [RegionCode, string[]][] = [
    ["jp", ["hololive jp", "ホロライブ", "にじさんじ", "nijisanji jp", "日本", "vspo"]],
    ["cn", ["hololivecn", "中国"]],
    ["tw", ["台灣", "taiwan", "台湾", "繁体"]],
    ["hk", ["香港", "hong kong"]],
    ["kr", ["한국", "korea", "한국어", "버추얼"]],
    ["id", ["indonesia", "indonesian"]],
    ["my", ["malaysia", "malaysian"]],
  ];
  for (const [code, needles] of explicit) {
    if (has(all, needles)) return { code, score: 0.78 };
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

const PREMIERE_MARKERS = [...PREMIERE];

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
  const isPremiere = has(all, PREMIERE_MARKERS);
  const isPerformance = has(all, PERFORMANCE_MARKERS);
  const isCollab = has(all, COLLAB_MARKERS);
  const isAcoustic = has(all, ACOUSTIC_MARKERS);

  let category: ItemCategory = "other";
  if (isCover) category = "cover";
  else if (isOriginal && !isMv) category = "original";
  else if (isMv) category = "mv";
  else if (isLive) category = "live";
  else if (isPerformance) category = "performance";
  else if (signals.status === "upcoming" || isPremiere) {
    category = "premiere";
  }

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

/**
 * Schedule streams — 日程 / 週表 / スケジュール.
 *
 * A performer announces the coming week with a stream whose **title is the
 * schedule**: 「【週表】07/29~08/04」, 「Weekly Schedule」,
 * 「今週のスケジュール」, 「타임테이블」. Nothing is performed and the item
 * is not an event, so the Upcoming tab fills with announcements rather than
 * streams the user can plan around.
 *
 * The terms are matched against `normalize()`d text, which is why the
 * English ones are word-boundary regexes: `schedule` must not match
 * `scheduled`, and `time table` has to survive the styled spellings
 * (`𝗐𝖾𝖾𝗄𝗅𝗒 𝗌𝖼𝗁𝖾𝖽𝗎𝗅𝖾`) that are already folded to ASCII by NFKC.
 */
const SCHEDULE_TITLE_TERMS = [
  // Chinese — 日程 / 週表 / 排程
  "日程",
  "週表",
  "周表",
  "時間表",
  "直播安排",
  "排程",
  "預定表",
  "预定表",
  "活動表",
  "活动表",
  "節目表",
  "节目表",
  // Japanese — スケジュール / 予定表 / 時間割
  "スケジュール",
  "予定表",
  "時間割",
  "スケ表",
  "週間予定",
  "今週の予定",
  "来週の予定",
  "配信予定",
  "活動予定",
  // Korean — 스케줄 / 타임테이블
  "스케줄",
  "타임테이블",
  "시간표",
  "일정표",
  "주간 일정",
  // Other languages the dataset's performers publish in.
  "расписание",
  "розклад",
  "jadwal",
  "horario",
  "horário",
  "zeitplan",
  "wochenplan",
  "emploi du temps",
  "ตาราง",
  "lịch trình",
];

const SCHEDULE_TITLE_PATTERNS = [
  /\b(?:weekly\s+|stream\s+|live\s+)?schedule\b/,
  /\btimetable\b/,
  /\btime\s+table\b/,
  /\bweekly\s+plan\b/,
];

/** True when an item's title *is* a schedule rather than an event. */
export function isScheduleTitle(title: string | null | undefined): boolean {
  const text = normalize(title);
  if (!text) return false;
  return (
    SCHEDULE_TITLE_TERMS.some((term) => text.includes(term)) ||
    SCHEDULE_TITLE_PATTERNS.some((pattern) => pattern.test(text))
  );
}

/**
 * Markers that identify a **clip or translation channel**.
 *
 * The Chinese scene is full of them: an account that re-uploads a Japanese
 * performer's streams with Chinese subtitles. They are named after the
 * performer they translate — often as `Artist/Original name` — and they are
 * *not* performers. Counting them as VTubers pollutes the dataset with
 * duplicates of the real artist under a second channel.
 */
const CLIP_ACCOUNT_MARKERS = [
  // translation and subtitles
  "翻译组",
  "翻譯組",
  "翻译",
  "翻譯",
  "字幕组",
  "字幕組",
  "轴翻剪校",
  "軸翻剪校",
  // clipping and re-uploading
  "切片",
  "切片man",
  "搬运",
  "搬運",
  "搬运组",
  "搬運組",
  "直播切片",
  "录播",
  "錄播",
  "直送",
  "剪辑",
  "剪輯",
  "精華",
  "精华",
  "烤肉",
  // English
  "unofficial",
  "unofficial fan",
  "non-official",
  "fan translation",
  "fan channel",
  "subtitles by",
  "translated by",
  "on subtitles",
  "clip channel",
  "clip account",
  // a place a performer keeps their own props
  // a place that only exists for someone else
  "工坊",
  "万事屋",
  "万事屋",
  "食堂",
  "专区",
  "專區",
  "神殿",
  "总部",
  "總部",
  "支部",
  "根据地",
  "根據地",
  "后援会",
  "後援會",
  "粉丝团",
  "粉絲團",
  "应援会",
  "應援會",
];

/**
 * The `Hime的万事屋` pattern: a fan account is named after its subject.
 *
 * A 搬运组 is not a performer, but many do not say so in the description —
 * 「Petra的极地考察队」 announces itself only by its name, which is
 * 「<artist>的<place>」. The account takes the artist's name, not its own, so
 * the part before 的 is a **person** and the whole thing is a fan account.
 *
 * It is a name pattern on purpose: the description is where the *performer*
 * writes 「xx的粉丝」 or shares a friend's channel, and those must not count.
 */
const FAN_ACCOUNT_NAME = /^[^的]{1,14}的[^的]{1,14}$/;

/**
 * An account that exists to **archive somebody else's streams**.
 *
 * 「石虎菲爾 ShihHu_Phile.實況存檔」 and 「希爾菲シルフィ ch.」（YT只用來備份存檔）
 * never perform — they keep the recordings. A performer's own channel says
 * 「實況結束之後會上傳到YouTube存檔」, which is the same words about *their own*
 * work, so the test is whether the channel says it is **only** an archive.
 */
const STREAM_ARCHIVE_NAME = /(?:實況|实况|直播|配信)?(?:存檔|存档)(?:號|号|頻道|频道)?$/;

/** ...and the descriptions that say it outright. */
const STREAM_ARCHIVE_MARKERS = [
  "備份存檔",
  "备份存档",
  "只用作存檔",
  "只用作存档",
  "只用於存檔",
  "只用于存档",
  "烤肉中",
  "烤肉频道",
  "烤肉頻道",
  "上傳烤肉",
  "上传烤肉",
  "上傳精華",
  "上传精华",
  "剪輯推廣",
  "剪辑推广",
  "興趣剪輯",
  "兴趣剪辑",
];

/**
 * Whether the channel is a **strict** aggregator: it exists to republish
 * someone else's work.
 *
 * This is the stricter layer on top of `detectClipAccount()` — it looks only
 * at the name and the first characters of the description, and it is used to
 * decide whether an auto-discovered channel may enter the dataset at all.
 * `hypertension` is not in the vocabulary.
 */
export function isStrictAggregator(
  name: string | null | undefined,
  description: string | null | undefined,
): boolean {
  const trimmed = (name ?? "").trim();
  /**
   * A channel whose name **ends** in a work of other people's — 「烤肉實驗室」
   * and 「精華剪輯」 are studios, 「Vtuber中文精華」 is a subtitle channel.
   */
  if (/(?:烤肉|剪輯|剪辑|精華|精华|字幕|搬運|搬运) ?(?:實驗室|实验室|屋|頻道|频道|台|組|组|man|Man)/u.test(trimmed)) {
    return true;
  }
  if (STREAM_ARCHIVE_NAME.test(trimmed)) return true;

  const text = normalize(description ?? "").slice(0, 200);
  if (STREAM_ARCHIVE_MARKERS.some((marker) => text.includes(marker))) return true;
  return false;
}

/**
 * ...but a performer of their own can be named that way too.
 *
 * 「初晴的小葵」 and 「雨蛙的蛙」 are the performers' own stage names — the
 * part after 的 is a name, not a **place, shop or gag** (万事屋, 考察队,
 * 饲养所, 糖罐, 地狱). The vocabularies below decide which it is.
 */
/**
 * The kind of thing a fan account is named after.
 *
 * These are **checked at the end** of the second half. A performer called
 * 「不破湊的甜甜圈工坊」 has 坊 in the middle; a fan account called
 * 「Petra的极地考察队」 ends in 队. The tail is what makes the name a place.
 */
const FAN_ACCOUNT_PLACE_WORDS = [
  "组", "組", "屋", "馆", "館", "铺", "鋪", "店", "坊", "房", "仓", "倉", "库", "庫",
  "社", "部", "所", "室", "监", "監", "园", "園", "场", "場", "会", "會", "队", "隊",
  "军", "軍", "团", "團", "号", "號", "站", "区", "區", "岛", "島", "海", "山", "谷",
  "箱", "罐", "柜", "櫃", "桌", "台", "局", "处", "處", "国", "國", "城", "堡", "宫",
  "宮", "殿", "塔", "井", "庭", "院", "寺", "窝", "窩", "巢", "洞", "狱", "獄", "厂",
  "廠", "间", "間", "角", "摊", "攤", "室", "园", "屋",
];

/**
 * The second half of a **performer's** own `X的Y` name: a pet name, a
 * diminutive, or a name with a small word in it.
 */
const FAN_ACCOUNT_NAME_WORDS = [
  "酱",
  "醬",
  "喵",
  "猫",
  "貓",
  "兔",
  "狐",
  "子",
  "君",
  "ちゃん",
  "くん",
  "様",
];

/**
 * Whether a `X的Y` channel name is a fan account for X.
 *
 * Every hit is reviewed by eye before it is written: the names in the
 * dataset are overwhelmingly people's own stage names, and only a small
 * minority are 搬运组 without a description that says so.
 */
/**
 * The tails that never belong to **either** side cleanly: a 仓库 or a 小号 is
 * where a performer keeps their own second account.
 *
 * 「伊露夏的仓库」 is the same person's side account — redirecting to
 * `@伊露夏Eluthya` — and 「巴老师的小号」 says so outright. They are the
 * performer, not a fan.
 */
const SIDE_ACCOUNT_WORDS = ["仓库", "倉庫", "小号", "小號", "分号", "分號", "备用", "備用", "副号", "副號"];

export function isFanAccountName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  if (!FAN_ACCOUNT_NAME.test(trimmed)) return false;
  const second = trimmed.split("的")[1] ?? "";
  if (!second) return false;
  // 「伊露夏的仓库」 — the performer's own side account.
  if (SIDE_ACCOUNT_WORDS.some((word) => second.includes(word))) return false;
  // 「初晴的小葵」 — the tail is a name, so this is the performer.
  if (FAN_ACCOUNT_NAME_WORDS.some((word) => second.includes(word))) {
    return false;
  }
  // 「Petra的极地考察队」 — the tail is a place or a shop.
  return FAN_ACCOUNT_PLACE_WORDS.some((word) => second.endsWith(word));
}

/**
 * The `Artist/Original name` naming pattern.
 *
 * 「YUA/藤崎由愛」 is a translation account for Yua Mikami. A slash between a
 * romanised name and a CJK name is the signature.
 */
const CLIP_ACCOUNT_NAME = /^[^/]{1,24}\/[^/\s]{1,24}$/;

/**
 * Whether a channel is a clip or translation account rather than a
 * performer.
 */
export function detectClipAccount(
  name: string | null | undefined,
  description: string | null | undefined,
): boolean {
  const text = normalize(description ?? "");
  /**
   * The markers are matched against the **name** and the description.
   *
   * 「Aruka搬运组」 says it in the name and leaves the description empty;
   * 「风太_Fuuta的录播存放处」 says it in both. Only a performer would use
   * 搬运 to describe *themselves* as doing it — and they would then be a
   * re-uploader, which is what this test is for.
   */
  if (has(normalize(name ?? ""), CLIP_ACCOUNT_MARKERS)) return true;
  if (has(text, CLIP_ACCOUNT_MARKERS)) return true;
  if (isFanAccountName(name)) return true;

  const trimmed = (name ?? "").trim();
  if (!trimmed.includes("/")) return false;
  if (!CLIP_ACCOUNT_NAME.test(trimmed)) return false;

  // The part after the slash is the original artist's name, and the part
  // before it is a romanisation of it — or vice versa. Either way, two names
  // for one performer means a fan account.
  const [first, second] = trimmed.split("/").map((p) => p.trim());
  if (!first || !second) return false;
  const firstIsLatin = /^[A-Za-z0-9 ._'-]+$/.test(first);
  const secondIsLatin = /^[A-Za-z0-9 ._'-]+$/.test(second);
  // Both romanised, or both CJK — that is a normal name, not a clip account.
  return firstIsLatin !== secondIsLatin;
}

/**
 * Patterns that introduce a second performer in a title.
 *
 * A collaborative MV names its performers in the title, so the second and
 * third names can be read straight off it.
 */
const COLLAB_TITLE_PATTERNS: RegExp[] = [
  // "A & B", "A x B", "A × B", "A and B"
  /^(.{1,40}?)\s*[&×✕xX]\s*(.{1,40}?)(?:\s*[-–—|:：/／]\s*.*)?$/,
  // "A feat. B", "A ft. B", "A with B"
  /^(.{1,40}?)\s+(?:feat\.?|ft\.?|with)\s+(.{1,40}?)(?:\s*[-–—|:：/／]\s*.*)?$/i,
  // "A vs B", "A vs. B"
  /^(.{1,40}?)\s+vs\.?\s+(.{1,40}?)(?:\s*[-–—|:：/／]\s*.*)?$/i,
  // "A ＆ B" (full width)
  /^(.{1,40}?)\s*[＆]\s*(.{1,40}?)(?:\s*[-–—|:：/／]\s*.*)?$/,
];

/**
 * Extracts the names of the other performers on a collaborative upload.
 *
 * The uploader is not included — the caller adds them.
 */
export function extractCollaboratorNames(
  title: string | null | undefined,
): string[] {
  if (!title) return [];
  const cleaned = title
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const out: string[] = [];
  for (const re of COLLAB_TITLE_PATTERNS) {
    const m = re.exec(cleaned);
    if (!m) continue;
    const first = stripNoise(m[1] ?? "");
    const second = stripNoise(m[2] ?? "");
    // Both halves must look like names, not like a description.
    if (first.length < 2 || second.length < 2) continue;
    if (first.length > 40 || second.length > 40) continue;
    if (/(cover|song|mv|歌|曲|動画|初投稿|配信)/i.test(second)) continue;
    out.push(second);
    break;
  }
  return out;
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
/* Affiliation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The ways a description states who a performer belongs to.
 *
 * The phrasing is different in every language, and the agency sits on the
 * opposite side of the marker in each:
 *
 * | Language | The line | The agency |
 * | --- | --- | --- |
 * | Japanese | 「にじさんじ所属」 | before 所属 |
 * | Chinese | 「所属：にじさんじ」「隶属〇〇」「〇〇旗下」 | after the marker, or before 旗下 |
 * | Korean | 「니지산지 소속」 | before 소속 |
 * | English | "affiliated with Nijisanji" | after the preposition |
 *
 * The capture is deliberately narrow — no spaces, no sentence punctuation, a
 * couple of particles excluded — because whatever matches is written into the
 * `agency` field as a fact.
 */
const AFFILIATION_PATTERNS: RegExp[] = [
  // Japanese: 「〇〇所属」「〇〇に所属」「〇〇事務所所属」.
  /([^\s、。,.|/／()（）\[\]【】「」『』:：;；~〜–—はがをも]{2,26})(?:に|へ)?\s*所属/u,
  // Chinese: 「所属：〇〇」「所属于〇〇」.
  /所属于?\s*[：:]\s*([^\s、。,.|/／()（）\[\]【】「」『』:：;；的]{2,26})/u,
  /所属于\s*([^\s、。,.|/／()（）\[\]【】「」『』:：;；的]{2,26})/u,
  // Chinese: 「隶属〇〇」「隸屬〇〇」.
  /(?:隶属|隸屬)(?:于|於)?\s*[：:]?\s*([^\s、。,.|/／()（）\[\]【】「」『』:：;；的]{2,26})/u,
  // Chinese: 「〇〇旗下」.
  /([^\s、。,.|/／()（）\[\]【】「」『』:：;；]{2,26})\s*旗下/u,
  // Korean: 「〇〇 소속」「소속：〇〇」.
  /([^\s,.|/()\[\]:：;；]{2,26})\s*소속/u,
  /소속\s*[：:]\s*([^\s,.|/()\[\]:：;；]{2,26})/u,
  // English.
  /\baffiliated\s+(?:with|to)\s+([\p{L}\p{N} &'’\-]{2,40})/iu,
  /\b(?:member|part)\s+of\s+([\p{L}\p{N} &'’\-]{2,40})/iu,
  /\bbelongs?\s+to\s+([\p{L}\p{N} &'’\-]{2,40})/iu,
];

/**
 * A capture that is a word about the statement rather than a name.
 *
 * 「無所属」 puts 無 where the agency would be, and a bio that says "member of
 * the channel" says nothing at all.
 */const AGENCY_STOPWORDS = new Set([
  "無",
  "无",
  "非",
  "未",
  "元",
  "現",
  "当",
  "該当",
  "本人",
  "ここ",
  "こちら",
  "個人",
  "个人",
  "個人勢",
  "个人势",
  // Where in the group, not which group.
  "本部",
  "总部",
  "總部",
  "支部",
  "分部",
  "本社",
  "分社",
  "本家",
  // What the group makes, not what it is called.
  "世界观",
  "世界觀",
  "企划",
  "企劃",
  "社团",
  "社團",
  "计划",
  "計劃",
  "vtuber",
  "vtubers",
  "vsinger",
  "v singer",
  "performer",
  "channel",
  "チャンネル",
  "配信者",
  "브이튜버",
  "버튜버",
  "채널",
  "a",
  "an",
  "the",
  "my",
  "this",
  "our",
  "us",
  "me",
  "them",
  "it",
]);

/**
 * The names the big agencies are known by in their own languages.
 *
 * A description in Japanese says 「ホロライブ所属」, in Chinese 「彩虹社」 and
 * in Korean 「니지산지」 — the same three groups the rest of the dataset spells
 * `hololive`, `nijisanji` and `nijisanji`. Without this the `agency` field
 * would hold four spellings of one agency and the grouping would split it.
 */
const AGENCY_ALIASES = new Map<string, string>([
  ["ホロライブ", "hololive"],
  ["ホロライブプロダクション", "hololive"],
  ["にじさんじ", "nijisanji"],
  ["彩虹社", "nijisanji"],
  ["니지산지", "nijisanji"],
  ["ぶいすぽ", "vspo"],
  ["ぶいすぽっ", "vspo"],
  ["ぶいすぽっ!", "vspo"],
  ["神椿", "kamitsubaki"],
  ["バーチャルミュージックラボ", "virtual music lab"],
  ["あにまーれ", "有閑喫茶あにまーれ"],
  ["のりプロ", "noripro"],
  ["ハニーストラップ", "HoneyStrap"],
]);

/** Strips what a capture picks up around a name but that is not the name. */
function cleanAgencyName(raw: string): string | null {
  let name = raw
    .trim()
    /**
     * Decoration, not part of the name: 「✨纸片人计划所属」 and 「<EDEN>旗下」
     * capture the emoji and the brackets with the agency.
     */
    .replace(/^[\s\p{P}\p{S}\p{Extended_Pictographic}]+/u, "")
    .replace(/[\s\p{P}\p{S}\p{Extended_Pictographic}]+$/u, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();
  // 「〇〇事務所所属」 states the agency's legal form, not a different agency.
  name = name.replace(/\s*(?:事務所|事务所)$/u, "").trim();
  /**
   * Japanese puts the particle inside the token: 「ぶいすぽっ！に所属」 is
   * captured as 「ぶいすぽっ！に」, because the greedy match cannot tell the
   * particle from the name.
   */
  name = name.replace(/[にへ]$/u, "").trim();
  if (name.length < 2) return null;
  if (AGENCY_STOPWORDS.has(name.toLowerCase())) return null;
  if (!/[\p{L}\p{N}]/u.test(name)) return null;
  return name;
}

/**
 * Reads the agency out of a name or a description.
 *
 * A performer who writes 「〇〇所属」 has told us two things at once: they are
 * signed to a group (`affiliation: "group"`) and the group is called 〇〇
 * (`agency: "〇〇"`). The rosters do not carry that for most channels, and the
 * description is the one place the performer says it themselves.
 *
 * A known agency is returned in its canonical spelling, so 「ホロライブ」 and
 * "Hololive" both become `hololive`, which is what `AGENCY_REGION` and the
 * UI's grouping understand.
 */
export function extractAgency(
  name: string | null | undefined,
  description: string | null | undefined,
): string | null {
  // Width-normalised but **not** lower-cased: the agency name keeps the case
  // the performer wrote it in.
  const text = `${name ?? ""}\n${description ?? ""}`.normalize("NFKC");
  if (!text.trim()) return null;

  /**
   * 「無所属」「无所属」「非所属」 are the opposite statement — no agency at
   * all — and they contain the very marker the patterns look for. The agency
   * would be read out of the word that denies one.
   */
  if (/[無无]所属|非所属|無隸屬|无隶属/u.test(text)) return null;

  for (const pattern of AFFILIATION_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const cleaned = cleanAgencyName(match[1]);
    if (!cleaned) continue;
    const alias = AGENCY_ALIASES.get(cleaned);
    if (alias) return alias;
    const known = AGENCY_KEYS.find(
      (key) => key.toLowerCase() === cleaned.toLowerCase(),
    );
    return known ?? cleaned;
  }
  return null;
}

/**
 * Markers that positively identify a solo / independent performer.
 *
 * These matter because "no agency listed" is ambiguous: it can mean the
 * performer *is* independent, or that the source simply does not say.
 */
const INDEPENDENT_MARKERS = [
  "independent",
  "indie vtuber",
  "indie virtual",
  "solo project",
  "个人势",
  "個人勢",
  "個人",
  "独立",
  "自主",
  "フリー",
  "freelance",
  "self-produced",
  "個人製作",
  "無所属",
  "无所属",
  "無所屬",
  "非所属",
  "non-affiliated",
];

/**
 * Decides whether a performer is independent or signed to a business group.
 *
 * - an agency name ⇒ `group`
 * - an explicit independence statement ⇒ `independent`
 * - otherwise ⇒ `unknown`
 */
export function detectAffiliation(
  name: string | null | undefined,
  description: string | null | undefined,
  agency: string | null | undefined,
): Affiliation {
  if (agency && agency.trim()) return "group";

  const text = normalize(`${name ?? ""} ${description ?? ""}`);

  /**
   * The camp (勢) vocabulary states the performer's business relationship
   * outright, which is more precise than any heuristic:
   *
   *   個人勢 — a solo performer          → independent
   *   企業勢 — backed by a company       → group
   *   社團勢 — a fan circle              → community
   */
  if (has(text, CORPORATE_CAMP)) return "group";
  if (has(text, SOLO_CAMP)) return "independent";
  if (has(text, COMMUNITY_CAMP)) return "community";

  if (has(text, INDEPENDENT_MARKERS)) return "independent";

  return "unknown";
}
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
  ...AI_TRANSLATED,
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

/**
 * Markers that indicate a performer has retired or rebranded.
 *
 * The list is deliberately multilingual, because the performers are: a
 * Taiwanese channel says 「已畢業」, a Chinese one says 「已停播」, a Japanese
 * one says 「卒業」 or 「活動終了」, a Korean one says 「은퇴」, and a Russian
 * one says «закрыт».
 *
 * The Chinese markers are the important ones here — 「已停播」 and 「已畢業」
 * are what the Chinese scene actually writes, and neither is a substring of
 * the Japanese 「卒業」.
 */
const GRADUATED_MARKERS = [
  /* Japanese */
  "卒業",
  "活動終了",
  "活動終了のお知らせ",
  /**
   * 「活動終了」 with its particles.
   *
   * A channel announces it as 「活動を終了しました」 as often as with the bare
   * noun, and the particle forms were the ones that slipped through: the
   * exact string was there, the inflected one was not.
   */
  "活動を終了",
  "活動は終了",
  "活動を終え",
  "活動終え",
  "休眠",
  "最終配信",
  "卒業のお知らせ",
  "卒業しました",
  "配信終了",
  "活動休止",
  "最後の配信",
  /* Chinese — traditional */
  "已畢業",
  "畢業了",
  "畢業",
  "已停播",
  "停播",
  "已停更",
  "停更",
  "停止更新",
  /* 活動終了 is written in Chinese too — 停止活動 is the same message. */
  "停止活動",
  "停止活动",
  "已結束",
  "結束直播",
  "最後一次直播",
  "正式告別",
  "告別",
  "休息一陣子",
  /* Chinese — simplified */
  "已毕业",
  "毕业了",
  "毕业",
  "已停播",
  "停播了",
  "停更了",
  "停止更新",
  /* The simplified form of 「活動終了」: 活动终了. */
  "活动终了",
  "已结束",
  "结束直播",
  "最后一次直播",
  "正式告别",
  "告别",
  "休息一阵子",
  /* English */
  "graduated",
  "graduation",
  "retired",
  "farewell",
  "last stream",
  "final stream",
  "hiatus",
  "no longer active",
  "channel closed",
  "has ended",
  /* Korean */
  "은퇴",
  "활동 종료",
  "최종 방송",
  "그만",
  /* Russian */
  "закрыт",
  "закрыла",
  "закрытие",
  "завершил",
  "завершение",
  /* Spanish / Portuguese / Italian */
  "se ha retirado",
  "encerrou",
  "si è ritirato",
];

/**
 * The markers above are matched as plain substrings, so an occurrence has to
 * be checked in context before it is believed: 「不會畢業」 and 「不畢業」 both
 * contain 「畢業」, "not graduated" contains "graduated", and
 * 「卒業しません」 contains 「卒業」. This block teaches the check which
 * constructions negate a marker in each language the dataset covers.
 *
 * A negator is not accepted anywhere in the description: it must belong to
 * the marker's own clause, and only a small set of function words, particles
 * and auxiliaries may sit between them. That is what keeps 「我不會後悔畢業」
 * ("I will not regret graduating") and "I did not know she graduated" from
 * cancelling a real graduation.
 */
function clauseBefore(text: string, index: number): string {
  const prefix = text.slice(0, index);
  return prefix.match(/[^,.!?;:\n\r、。，！？；：]*$/)?.[0] ?? prefix;
}

function clauseAfter(text: string, index: number): string {
  return text.slice(index).match(/^[^,.!?;:\n\r、。，！？；：]*/)?.[0] ?? "";
}

/** Chinese / Japanese negators that precede the marker. */
const CJK_NEGATED_BEFORE =
  /(?:不會|不会|沒有|没有|不打算|不準備|不准备|沒有打算|没有打算|不可能|無意|无意|不是|并非|並非|未曾|沒|没|未|不)(?:\s*(?:在|於|于|今年|明年|後年|后年|內|内|近期|最近|現在|现在|目前|這麼快|这么快|那麼快|那么快|這麼早|这么早|那麼早|那么早|再|會|会|要|想|願意|愿意|肯|敢|打算|準備|准备|計劃|计划|預計|预计|马上|馬上|立刻|急著|急着|就|又|也|還|还|才|能|可能|有|是|曾|已|已經|已经|正式|真的|需要|用|必|太|大|怎麼|怎么|至於|至于))*\s*$/u;

/** Japanese negators that can stand immediately before the marker. */
const JA_NEGATED_BEFORE = /(?:未|未だ)\s*$/u;

/** English negators, with only function words allowed before the marker. */
const EN_NEGATED_BEFORE =
  /\b(?:not|never|no|none|without|isn't|isnt|aren't|arent|wasn't|wasnt|weren't|werent|don't|dont|doesn't|doesnt|didn't|didnt|won't|wont|wouldn't|wouldnt|can't|cant|cannot|couldn't|couldnt|shouldn't|shouldnt|hasn't|hasnt|haven't|havent|hadn't|hadnt|ain't|aint)\b(?:\s+(?:the|a|an|on|in|at|to|of|for|with|any|yet|ever|really|actually|officially|currently|longer|going|gonna|plan|plans|planning|intend|intends|intending|intention|intentions|about|soon|be|been|being|get|getting|have|has|had|having|taking|entering|will|would|is|are|was|were|do|does|did|my|your|his|her|their|our|this|that|these|those|fully|completely|technically|formally|considered|official|real|necessarily))*\s*$/i;

/** Russian negators before the marker, e.g. «не будет закрыт». */
const RU_NEGATED_BEFORE =
  /(?:^|[^а-яё])не(?:\s+(?:будет|будут|был|была|было|были|есть|планируется|планируются|планировал|планировала|планировали|планирую|планируем|собирается|собираются|собирался|собиралась|собирались|сейчас|ещё|еще|уже|пока|так|скоро|в|на|до|по|это|является|являлся|являлась|являлись|официально|полностью))*\s*$/u;

/** Romance negators before the marker, e.g. «no se ha retirado». */
const ROMANCE_NEGATED_BEFORE =
  /(?:^|[\s(])(?:no|nunca|jamás|jamas|não|nao|jamais|non|mai)(?:\s+(?:se|ha|han|fue|foi|está|esta|estaba|estavam|è|e|si|sido|estado|retirado|actualmente|todavía|todavia|aún|ainda|ya|già|gia|ancora))*\s*$/u;

/**
 * Chinese negators after the marker, e.g. 「畢業是不可能的」 or
 * 「畢業未定」. The bare 「沒有」 is deliberately not enough here: 「畢業是沒有
 * 問題的」 says graduation is fine, not that it will not happen.
 */
const CN_NEGATED_AFTER =
  /^(?:\s*(?:是|絕對|绝对|完全|根本|當然|当然|也|都|再|會|会|要|想|可能|已經|已经|正式|真的))*\s*(?:不可能(?:發生|发生|舉辦|举办|實現|实现)?|不會(?:發生|发生|舉辦|举办|實現|实现)?|沒有(?:發生|发生|要|打算|計劃|计划|準備|准备|舉辦|举办)|未有(?:發生|发生|打算|計劃|计划|準備|准备)|不存在|未(?:發生|发生|舉辦|举办|確定|确定|定)|尚未(?:發生|发生|舉辦|举办|確定|确定)|免談|免谈)/u;

/** 「畢業日期未定」 is not a graduation that happened. */
const CN_UNCERTAIN_AFTER = /(?:未定|未確定|未确定|尚未確定|尚未确定)/u;

/** Japanese negative predicates, e.g. 「卒業しません」 / 「卒業しない」. */
const JA_NEGATED_AFTER =
  /(?:ません|ない|無い|なし|未定|未確定|予定はありません|つもりはありません|予定はない|つもりはない)/u;

/**
 * Korean negation follows the marker: 「은퇴하지 않습니다」,
 * 「은퇴 안 합니다」, 「은퇴는 없습니다」, 「최종 방송이 아닙니다」.
 *
 * The optional words before the negative form are the ones that can appear in
 * these constructions. They are not a licence to find a stray 없습니다 later
 * in the clause: 「은퇴했지만 미련은 없습니다」 ("retired, but no regrets") must
 * stay retired.
 */
const KO_NEGATED_AFTER =
  /^\s*(?:(?:하|할|한|하는|두|둘|둔|두는|두지|두지는|두지도|하지|하지는|하지도)?\s*(?:않|안\s*하|안\s*합|안\s*해|안\s*할|안\s*함|못\s*하|못\s*합|못\s*해|못\s*했|못\s*할|못\s*함)|(?:은|는|이|가|을|를|도|만)?\s*(?:전혀|정말|진짜|아직|당장|곧|결국|절대|별로|딱히)?\s*(?:없|없습니다|없어요|없다)|(?:할|한|하는|하|둘|둔|두는|두)?\s*(?:계획|생각|예정|소식|것|거)\s*(?:이|은|는|가|도)?\s*(?:전혀|정말|진짜|아직|당장|곧|결국|절대|별로|딱히)?\s*(?:없|없습니다|없어요|없다)|(?:은|는|이|가)?\s*(?:아니|아닙|아닙니다|아니에요|아니야))/u;

/** Russian negation after the marker, e.g. «закрыт не будет». */
const RU_NEGATED_AFTER =
  /^\s*[аоы]?\s*(?:(?:канала|канал|проекта|деятельности|стримов|творчества|контента|аккаунта)\s+)*не(?:\s+(?:будет|будут|был|была|было|были|есть|планируется|планируются|планировал|планировала|планировали|планирую|планируем|собирается|собираются|собирался|собиралась|собирались|сейчас|ещё|еще|уже|пока|так|скоро|в|на|до|по|это|является|являлся|являлась|являлись|официально|полностью|состоится|состоятся))*\s*$/u;

const NEGATED_BEFORE = [
  CJK_NEGATED_BEFORE,
  JA_NEGATED_BEFORE,
  EN_NEGATED_BEFORE,
  RU_NEGATED_BEFORE,
  ROMANCE_NEGATED_BEFORE,
];

const NEGATED_AFTER = [
  CN_NEGATED_AFTER,
  CN_UNCERTAIN_AFTER,
  JA_NEGATED_AFTER,
  KO_NEGATED_AFTER,
  RU_NEGATED_AFTER,
];

/**
 * The longest marker first, so that 「已畢業」 is checked as one phrase rather
 * than twice (once as 「已畢業」 and once as the 「畢業」 inside it). A negated
 * longer phrase also covers the shorter marker it contains.
 */
const GRADUATED_MARKERS_LONGEST_FIRST = [...new Set(GRADUATED_MARKERS)].sort(
  (a, b) => b.length - a.length,
);

function isGraduationMarkerNegated(
  text: string,
  index: number,
  length: number,
): boolean {
  const before = clauseBefore(text, index);
  const after = clauseAfter(text, index + length);
  return (
    NEGATED_BEFORE.some((re) => re.test(before)) ||
    NEGATED_AFTER.some((re) => re.test(after))
  );
}

/**
 * True when at least one graduation marker is not negated.
 *
 * The check is per occurrence, not per description: 「卒業しません。でも、
 * 卒業しました」 still contains a real graduation, and 「不會畢業，但已畢業」
 * still says it happened in the second clause.
 */
function hasUnnegatedGraduationMarker(text: string): boolean {
  const covered: Array<[number, number]> = [];

  for (const marker of GRADUATED_MARKERS_LONGEST_FIRST) {
    let from = 0;
    while (from <= text.length - marker.length) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;

      const end = at + marker.length;
      const inside = covered.some(
        ([start, stop]) => at >= start && end <= stop,
      );

      if (!inside) {
        if (!isGraduationMarkerNegated(text, at, marker.length)) {
          return true;
        }
        covered.push([at, end]);
      }

      from = at + 1;
    }
  }

  return false;
}

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

  if (hasUnnegatedGraduationMarker(all)) return "graduated";
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

/**
 * Combines what a source stated with what the classifier detected.
 *
 * The rules are asymmetric on purpose:
 *
 * - **A graduation always wins.** Whether a performer has retired is a
 *   fact, and every source that states it — a name that says 「已畢業」, a
 *   tracker that says `graduated`, a year without an upload — is right for
 *   the same reason.
 * - **A positive statement is never downgraded to "unknown".** The
 *   classifier's silence is not evidence of anything.
 */
export function mergeActivity(current: Activity, detected: Activity): Activity {
  if (detected === "graduated") return "graduated";
  if (current === "unknown") return detected;
  return current;
}
