/**
 * Canonical data model for the VSinger & Singer Tracker.
 *
 * Everything in `data/` is described by these types. The same shapes are used
 * by:
 *   - the sync pipeline (scripts/sync.ts) that writes the files
 *   - the web app (src/) that reads them
 *   - the validators (scripts/validate.ts)
 *
 * Keep this file free of runtime dependencies so it can be imported from both
 * Node (tsx) and the browser bundle.
 */

export const SCHEMA_VERSION = 1;

/**
 * How sure a classification is, per axis.
 *
 * `1` means a source stated it outright, `0` means the source is silent,
 * and the values in between mean it was inferred.
 */
/**
 * The record of an actual verification.
 *
 * A computed confidence score is a guess. This is not: it says that a
 * record was **looked up** — in Wikidata, in Wikipedia, by a search-grounded
 * model, or by a human — and what was found. The sources it lists are the
 * citation trail.
 */
export interface Verification {
  /**
   * `verified` — a source confirmed the record.
   * `conflicted` — the sources disagreed with the record.
   * `unverified` — nothing was found.
   */
  status: "verified" | "conflicted" | "unverified";
  /** Where the verification came from. */
  source: "wikidata" | "wikipedia" | "web-search" | "manual";
  /** What was checked. */
  checked: (
    | "kind"
    | "role"
    | "region"
    | "gender"
    | "ai"
    | "affiliation"
    | "description"
  )[];
  /** The verifier's own confidence, 0–1. */
  confidence: number;
  /** ISO timestamp of the verification. */
  at: string;
  /** The URLs that were read. */
  sources: string[];
  /** What was found, in one line. */
  note?: string;
}

/** Virtual performer (VTuber / VSinger / virtual singer) vs. a real human artist. */
export type ArtistKind = "virtual" | "real";

/** What the performer does. `unknown` is a valid, expected value. */
export type ArtistRole =
  | "vsinger"
  | "vtuber"
  | "singer"
  | "musician"
  | "producer"
  | "composer"
  | "unknown";

/** Region / language area. Lower-case ISO-ish codes. */
export type RegionCode =
  | "jp"
  | "cn"
  | "tw"
  | "hk"
  | "kr"
  | "en"
  | "id"
  | "my"
  | "sea"
  | "unknown";

/** Media kind of a collected item. */
export type ItemType = "video" | "short" | "live" | "playlist";

/**
 * Singing-specific classification. `other` means "video on a singing channel
 * that we could not classify further".
 */
export type ItemCategory =
  | "mv"
  | "cover"
  | "original"
  | "live"
  | "premiere"
  | "performance"
  | "other";

/** Where a record originally came from. */
export type RecordSource = "api" | "seed" | "manual";

/**
 * A subscriber / follower count that may or may not be public.
 *
 * Modelled as a discriminated union rather than `number | null`, following the
 * pattern used by the reference `TaiwanVTuberTrackingDataJson` API. YouTube
 * simply *omits* `subscriberCount` when a channel hides it, which makes
 * `null` ambiguous between "hidden", "unknown" and "zero". Keeping the
 * distinction matters here: hidden subscriber counts are common for VTubers
 * and the UI should not render them as `0`.
 */
export type CountRef =
  | { tag: "has"; count: number }
  | { tag: "hidden" }
  | { tag: "no" };

/**
 * Streaming activity status.
 *
 * `graduated` (卒業) is a first-class state for VTubers — a large part of the
 * catalogue has stopped streaming — so it is modelled explicitly instead of
 * being inferred from "no recent uploads".
 */
export type Activity = "active" | "preparing" | "graduated" | "unknown";

/** Streaming platform a record originates from. */
export type PlatformId =
  | "youtube"
  | "twitch"
  | "bilibili"
  | "niconico"
  | "vk";

/**
 * Performer's gender, as self-described.
 *
 * `unknown` is by far the most common value and is a perfectly valid state —
 * it means the channel never said. It is stored as a real field rather than
 * inferred at display time so the dataset can be filtered on it.
 */
/**
 * The performer's business relationship.
 *
 * Most VTubers are independent — a solo performer with no agency behind
 * them — and a large part of the catalogue belongs to a commercial group.
 * Knowing which is which is the difference between "a VTuber" and "a VTuber
 * signed to a company", and it decides how a viewer should follow them.
 *
 * The three-way split comes from the Chinese VTuber scene's "camp" (勢)
 * vocabulary, where a performer's fan community is named after the kind of
 * performer they are: 個人勢 (individual), 企業勢 (corporate) and 社團勢
 * (a fan circle rather than a company).
 */
export type Affiliation = "independent" | "community" | "group" | "unknown";

/**
 * How a channel's region was determined.
 *
 * | Source | Reliability |
 * | --- | --- |
 * | `override` | Curated by hand in `data/overrides.json` — certain |
 * | `roster` | The Taiwan VTuber track list's nationality column — authoritative |
 * | `declared` | The performer listed their own language (vdb) — authoritative |
 * | `platform` | The platform they are on (Bilibili → China, Niconico → Japan) — strong |
 * | `country` | The channel's published country — strong |
 * | `agency` | Their agency's branch — strong |
 * | `script` | The characters in the name — a guess |
 */
export type RegionSource =
  | "override"
  | "roster"
  | "declared"
  | "platform"
  | "country"
  | "agency"
  | "script"
  | "unknown";

export type Gender = "female" | "male" | "unknown";

export const ALL_GENDERS: Gender[] = ["female", "male", "unknown"];

/**
 * The combined, human-readable classification of a performer.
 *
 * The underlying facts are stored separately (`role` says what they do,
 * `gender` says who they are, `isAi` says whether they are synthetic), but
 * almost every consumer wants the one label: "female vtuber", "male vsinger",
 * "ai vtuber". Keeping it as a derived, stored string means the web app can
 * filter on it directly without re-deriving anything.
 */
export type Variant =
  | "female_vtuber"
  | "male_vtuber"
  | "ai_vtuber"
  | "female_vsinger"
  | "male_vsinger"
  | "ai_vsinger"
  | "female_singer"
  | "male_singer"
  | "ai_singer"
  | "female_producer"
  | "male_producer"
  | "ai_producer"
  | "female_musician"
  | "male_musician"
  | "ai_musician"
  | "female_composer"
  | "male_composer"
  | "ai_composer"
  | "vtuber"
  | "vsinger"
  | "singer"
  | "producer"
  | "composer"
  | "musician"
  | "unknown";

export const ALL_VARIANTS: Variant[] = [
  "female_vtuber",
  "male_vtuber",
  "ai_vtuber",
  "female_vsinger",
  "male_vsinger",
  "ai_vsinger",
  "female_singer",
  "male_singer",
  "ai_singer",
  "female_producer",
  "male_producer",
  "ai_producer",
  "female_musician",
  "male_musician",
  "ai_musician",
  "female_composer",
  "male_composer",
  "ai_composer",
  "vtuber",
  "vsinger",
  "singer",
  "producer",
  "composer",
  "musician",
  "unknown",
];

export const ALL_PLATFORMS: PlatformId[] = [
  "youtube",
  "twitch",
  "bilibili",
  "niconico",
  "vk",
];

/**
 * A platform-native identity for a performer.
 *
 * A single performer may exist on several platforms, so a channel record
 * carries a list of these instead of one hard-coded platform. This mirrors the
 * shape used by the reference `TaiwanVTuberTrackingDataJson` API, which keeps
 * `YouTube` and `Twitch` as separate sub-objects under one VTuber.
 */
export interface PlatformLink {
  /** Which platform this identity belongs to. */
  platform: PlatformId;
  /** Platform-native channel id (`UC...`, bilibili `uid`, niconico id, vk id). */
  id: string;
  /** Platform-native handle / login / space id. */
  handle: string | null;
  /** Display name on that platform. */
  name: string | null;
  /** Canonical watch/profile URL. */
  url: string;
  /** Subscriber / follower count on that platform. */
  subscribers: CountRef;
  /** Avatar / profile image. */
  avatar: string | null;
  /** Streaming activity on that platform. */
  activity: Activity;
  /** ISO timestamp of the last successful check. */
  lastCheckedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Channel                                                                    */
/* -------------------------------------------------------------------------- */


export interface Channel {
  /** Canonical YouTube channel id (`UC...`). */
  id: string;
  /** Display name. */
  name: string;
  /** `@handle` without the leading `@`, when known. */
  handle: string | null;
  /** Virtual performer or real human artist. */
  kind: ArtistKind;
  /** Performer role. */
  role: ArtistRole;
  /** Region the artist primarily belongs to. */
  region: RegionCode;
  /**
   * Which source decided the region.
   *
   * The region is inferred from several sources of very different quality, so
   * the provenance is stored alongside it: a reader can tell an authoritative
   * roster entry from a guess.
   */
  regionSource: RegionSource;
  /** BCP-47 language tag detected from the description/tags. */
  language: string | null;
  /** Agency / group, e.g. `hololive`, `nijisanji`, `kmvs`. */
  agency: string | null;
  /**
   * Whether the performer is independent or signed to a business group.
   *
   * `unknown` means the sources do not say — which is different from
   * `independent`, which means they positively are a solo act.
   */
  affiliation: Affiliation;
  /** Channel avatar URL. */
  avatar: string | null;
  /** Channel banner URL. */
  banner: string | null;
  /** Channel description (truncated to 1000 chars upstream). */
  description: string | null;
  /**
   * Subscriber count. `hidden` means the channel deliberately hides it —
   * distinct from an unknown or zero count.
   */
  subscribers: CountRef;
  /** Public video count. */
  videoCount: number | null;
  /** Lifetime view count. */
  viewCount: number | null;
  /** The `UC...` uploads playlist id. */
  uploadsPlaylistId: string | null;
  /** `brandingSettings.country` (ISO-3166 alpha-2) when published. */
  country: string | null;
  /** Declared keywords. */
  tags: string[];
  /** True when the channel publishes singing content. */
  isSinging: boolean;
  /** Self-described gender. */
  gender: Gender;
  /**
   * True when the performer is AI-generated — an AI VTuber, an AI singer, or
   * a synthesised voice such as Synthesizer V / CeVIO AI.
   */
  isAi: boolean;
  /** Combined label, e.g. `female_vtuber` or `ai_vsinger`. */
  variant: Variant;
  /**
   * The verification record — what was actually looked up, and where.
   *
   * `null` means the record has not been verified.
   */
  /**
   * The verification record — what was actually looked up, and where.
   *
   * This is the *fact*. There is deliberately no confidence score: a
   * computed number is a guess, and a record needs to say whether anyone
   * actually checked it.
   */
  verification: Verification | null;
  /** Provenance of the record. */
  source: RecordSource;
  /** ISO timestamp of first sighting. */
  addedAt: string;
  /** ISO timestamp of the last successful refresh. */
  updatedAt: string;
  /**
   * ISO timestamp of the last time this channel's uploads were fetched.
   *
   * The sync uses it to rotate through the catalogue: a channel that has
   * never been fetched comes first, and one that was fetched recently comes
   * last. That is what lets a 14,000-channel catalogue fill in over a few
   * days of scheduled runs.
   */
  lastItemsFetchedAt: string | null;
  /**
   * ISO timestamp of the last time this channel's *profile* was fetched.
   *
   * The profile carries the description, the follower count and the
   * platform-specific fields, and it has to be fetched one channel at a time —
   * so it is rotated the same way the uploads are.
   */
  lastDetailsFetchedAt: string | null;

  /* --- lifecycle (from the reference tracking dataset) ------------------ */

  /** Streaming activity status. */
  activity: Activity;
  /** ISO date of the channel's first stream. */
  debutDate: string | null;
  /** ISO date the performer graduated / stopped streaming. */
  graduateDate: string | null;

  /* --- cross-platform links -------------------------------------------- */

  /**
   * Every platform identity known for this performer. The first entry is the
   * primary platform (usually YouTube).
   */
  platforms: PlatformLink[];
  /**
   * Other platform handles keyed by platform name, harvested from the
   * channel description (`x`, `instagram`, `tiktok`, `discord`, …).
   *
   * Platform *identities* live in `platforms[]` — the Twitch user id, the
   * Bilibili space id and so on are all `PlatformLink`s. Keeping a separate
   * field per platform here would duplicate that state and let the two drift
   * apart.
   */
  externals: Record<string, string>;

  /** A representative upload, handy for profile cards. */
  popularVideoId: string | null;
}

/** A lightweight link to a platform identity, used in list views. */
export interface ChannelLink {
  /** Platform id. */
  p: PlatformId;
  /** Canonical URL. */
  u: string;
  /** Handle / login, when known. */
  h: string | null;
}

/** Compact projection used by list views and the search index. */
export interface ChannelSummary {
  id: string;
  name: string;
  handle: string | null;
  kind: ArtistKind;
  role: ArtistRole;
  region: RegionCode;
  /** Which source decided the region. */
  regionSource: RegionSource;
  /**
   * The language of the channel, as an ISO 639-1 code.
   *
   * Distinct from the region: the region says *where* they are (`jp`), the
   * language says *what they perform in* (`ja`).
   */
  language: string | null;
  agency: string | null;
  /** Independent or signed to a business group. */
  affiliation: Affiliation;
  /** The verification record — what was looked up, and where. */
  verification: Verification | null;
  avatar: string | null;
  subscribers: number | null;
  isSinging: boolean;
  activity: Activity;
  /** True when the subscriber count is known and public. */
  subscribersHidden: boolean;
  twitchLogin: string | null;
  gender: Gender;
  isAi: boolean;
  variant: Variant;
  /** Every platform identity, for the "all links" info block. */
  links: ChannelLink[];
}

/* -------------------------------------------------------------------------- */
/* Item                                                                       */
/* -------------------------------------------------------------------------- */

export interface Item {
  /** Video id (`youtube.com/watch?v=`) or playlist id. */
  id: string;
  /** Media kind. */
  type: ItemType;
  /** Owning channel id. */
  channelId: string;
  /** Owning channel name (denormalised for offline display). */
  channelName: string;
  /** Owning channel kind. */
  channelKind: ArtistKind;
  /** Owning channel region. */
  region: RegionCode;
  /** Owning channel's gender. */
  gender: Gender;
  /** True when the upload is AI-generated. */
  isAi: boolean;
  /** Owning channel's combined variant label. */
  variant: Variant;
  /** Video / playlist title. */
  title: string;
  /** Description, truncated. */
  description: string | null;
  /** Thumbnail URL. */
  thumbnail: string | null;
  /** ISO timestamp the video was published (null for upcoming). */
  publishedAt: string | null;
  /** ISO timestamp a scheduled stream / premiere is set to start. */
  scheduledStart: string | null;
  /** ISO timestamp a stream actually started. */
  actualStart: string | null;
  /** ISO timestamp a stream actually ended. */
  actualEnd: string | null;
  /** Duration in seconds (ISO-8601 duration parsed upstream). */
  duration: number | null;
  /** `live` | `upcoming` | `past` | `unknown`. */
  status: "live" | "upcoming" | "past" | "unknown";
  /** Singing-specific classification. */
  category: ItemCategory;
  /** Song title when the item is a cover / MV / original song. */
  songTitle: string | null;
  /** Performer of the original song for covers. */
  originalArtist: string | null;
  /** True when the upload is a collaboration. */
  isCollab: boolean;
  /**
   * Everyone who performed on this upload, including the uploader.
   *
   * A collaborative MV belongs to several channels at once, so the item is
   * indexed and filtered by all of them.
   */
  collaborators: Collaborator[];
  /**
   * True when the performer is singing while playing an instrument —
   * 弾き語り / 彈唱 / 自弹自唱 / acoustic performance.
   *
   * This is a flag rather than a category because these uploads are very
   * often covers as well, and the user wants to filter for "singing while
   * playing an instrument" without losing the cover/original classification.
   */
  isAcoustic: boolean;
  /** Declared keywords. */
  tags: string[];
  /** View count. */
  viewCount: number | null;
  /** Like count. */
  likeCount: number | null;
  /** Concurrent viewers while the stream was live. */
  concurrentViewers: number | null;
  /** Provenance of the record. */
  source: RecordSource;
  /** ISO timestamp of first sighting. */
  addedAt: string;
  /** ISO timestamp of the last successful refresh. */
  updatedAt: string;
  /**
   * ISO timestamp of the last time this channel's uploads were fetched.
   *
   * The sync uses it to rotate through the catalogue: a channel that has
   * never been fetched comes first, and one that was fetched recently comes
   * last. That is what lets a 14,000-channel catalogue fill in over a few
   * days of scheduled runs.
   */
  lastItemsFetchedAt: string | null;
  /**
   * ISO timestamp of the last time this channel's *profile* was fetched.
   *
   * The profile carries the description, the follower count and the
   * platform-specific fields, and it has to be fetched one channel at a time —
   * so it is rotated the same way the uploads are.
   */
  lastDetailsFetchedAt: string | null;
}

/** Compact projection used by list views and the search index. */
export interface ItemSummary {
  id: string;
  type: ItemType;
  channelId: string;
  channelName: string;
  channelKind: ArtistKind;
  region: RegionCode;
  title: string;
  thumbnail: string | null;
  publishedAt: string | null;
  scheduledStart: string | null;
  status: "live" | "upcoming" | "past" | "unknown";
  category: ItemCategory;
  songTitle: string | null;
  originalArtist: string | null;
}

/* -------------------------------------------------------------------------- */
/* Songs (music-centric projection)                                           */
/* -------------------------------------------------------------------------- */

/**
 * A music-focused view of an item.
 *
 * The `items` dataset is raw — whatever YouTube returned. The `songs`
 * dataset is the *musical* view: one record per performance, carrying the
 * song title, the original artist, whether it is a collaboration or an
 * acoustic performance, and the duration.
 *
 * It is stored separately because "find me every cover of this song" is the
 * question this project actually answers, and it deserves a dataset shaped
 * around that question rather than around YouTube's API.
 */
export interface SongRecord {
  /** YouTube video id. */
  id: string;
  /** Owning channel id. */
  channelId: string;
  /** Owning channel name. */
  channelName: string;
  /** Owning channel kind. */
  channelKind: ArtistKind;
  /** Owning channel region. */
  region: RegionCode;
  /** Owning channel's combined variant, e.g. `female_vsinger`. */
  variant: Variant;
  /** Owning channel's gender. */
  gender: Gender;
  /** True when the performer is AI-generated. */
  isAi: boolean;
  /** The upload's title. */
  title: string;
  /** The performed song. */
  songTitle: string | null;
  /** The original artist of the song. */
  originalArtist: string | null;
  /** `cover` | `mv` | `original` | `performance`. */
  category: ItemCategory;
  /** True when the upload is a collaboration. */
  isCollab: boolean;
  /**
   * Everyone who performed on this upload, including the uploader.
   *
   * A collaborative MV belongs to several channels at once, so the item is
   * indexed and filtered by all of them.
   */
  collaborators: Collaborator[];
  /** True when the performer is singing while playing an instrument. */
  isAcoustic: boolean;
  /** ISO publish timestamp. */
  publishedAt: string | null;
  /** Duration in seconds. */
  duration: number | null;
  /** Thumbnail URL. */
  thumbnail: string | null;
  /** View count. */
  viewCount: number | null;
  /** Canonical watch URL. */
  url: string;
}

export interface SongFile {
  schemaVersion: number;
  generatedAt: string;
  songs: SongRecord[];
}

/* -------------------------------------------------------------------------- */
/* Collaborations                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One performer on a collaborative upload.
 *
 * A song can be performed by three or more VTubers — a duet, a group cover,
 * an anniversary MV. The uploader is the channel that published it
 * (`Item.channelId`); the others are recorded here, so the same performance
 * is discoverable from every participating channel.
 */
export interface Collaborator {
  /** The performing channel's id, when it is known. */
  channelId: string | null;
  /** The performer's display name. */
  name: string;
  /** `virtual` | `real` | `unknown`. */
  kind: ArtistKind | "unknown";
  /** The performer's region, when known. */
  region: RegionCode | "unknown";
}

/* -------------------------------------------------------------------------- */
/* Aggregates                                                                */
/* -------------------------------------------------------------------------- */

export interface RegionMeta {
  code: RegionCode;
  label: string;
  /** Emoji flag / badge shown in the UI. */
  badge: string;
  channels: number;
  items: number;
}

export interface ManifestCounts {
  channels: number;
  channelsVirtual: number;
  channelsReal: number;
  channelsSinging: number;
  items: number;
  itemsLive: number;
  itemsUpcoming: number;
  itemsVideo: number;
  itemsPlaylist: number;
  itemsCover: number;
  itemsMv: number;
  itemsOriginal: number;
}

export interface Manifest {
  schemaVersion: number;
  generatedAt: string;
  counts: ManifestCounts;
  regions: RegionMeta[];
  /** YouTube Data API quota consumed by the run that produced this snapshot. */
  quota: {
    used: number;
    limit: number;
    remaining: number;
  };
  /** Free-text note about the dataset, shown in the UI footer. */
  notes: string;
}

/** A single searchable entry. Flat and string-heavy on purpose: it is shipped
 *  to the browser verbatim and scanned linearly. */
export interface SearchEntry {
  /** `c` = channel, `i` = item. */
  k: "c" | "i";
  id: string;
  /** Lower-cased haystack: name + handle + tags + title + song + artist. */
  t: string;
  /** Display title. */
  n: string;
  /** Region code. */
  r: RegionCode;
  /** Artist kind. */
  g: ArtistKind;
  /** Item category (items only). */
  c?: ItemCategory;
  /** Epoch ms of the most relevant timestamp, for sorting. */
  ts: number;
  /** Channel id the entry belongs to. */
  ch?: string;
}

/* -------------------------------------------------------------------------- */
/* File layout on disk                                                        */
/* -------------------------------------------------------------------------- */

export interface ChannelFile {
  schemaVersion: number;
  generatedAt: string;
  channels: Channel[];
}

export interface ItemFile {
  schemaVersion: number;
  generatedAt: string;
  items: Item[];
}

export interface SearchIndexFile {
  schemaVersion: number;
  generatedAt: string;
  entries: SearchEntry[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export const ALL_REGIONS: RegionCode[] = [
  "jp",
  "cn",
  "tw",
  "hk",
  "kr",
  "en",
  "id",
  "my",
  "sea",
  "unknown",
];

export const ALL_ITEM_CATEGORIES: ItemCategory[] = [
  "mv",
  "cover",
  "original",
  "live",
  "premiere",
  "performance",
  "other",
];

/* -------------------------------------------------------------------------- */
/* Count helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Builds a `CountRef` from a raw API value.
 *
 * - `null` / `undefined` → `hidden` (the platform omitted the field, which
 *   for YouTube means the channel hides its subscriber count).
 * - `"0"` → `no` (the channel exists but reports zero).
 * - a number → `has`.
 */
export function toCountRef(raw: unknown): CountRef {
  if (raw === null || raw === undefined || raw === "") return { tag: "hidden" };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { tag: "hidden" };
  if (n === 0) return { tag: "no" };
  return { tag: "has", count: n };
}

/** The numeric value of a `CountRef`, or `null` when not public. */
export function countValue(ref: CountRef | null | undefined): number | null {
  if (!ref) return null;
  return ref.tag === "has" ? ref.count : null;
}

/** True when the count exists but is deliberately hidden. */
export function countHidden(ref: CountRef | null | undefined): boolean {
  return !!ref && ref.tag === "hidden";
}
