/**
 * Platform adapter interface.
 *
 * YouTube and Twitch are the primary platforms, but many performers also
 * appear on Bilibili, Niconico and VK — and for Chinese and Russian VTubers
 * those are often the *primary* platform. Rather than special-casing each
 * site inside the sync, every platform implements this small adapter and the
 * sync treats them uniformly.
 *
 * Every adapter must degrade gracefully: if a platform is unreachable, has
 * changed its API, or needs credentials that are not configured, the adapter
 * reports itself as unavailable and the sync simply skips it. A broken
 * Bilibili endpoint must never take the YouTube sync down with it.
 */

import type {
  Activity,
  CountRef,
  ItemCategory,
  PlatformId,
  RegionCode,
} from "./types";

/** A channel (user / streamer / space) on some platform. */
export interface PlatformChannel {
  platform: PlatformId;
  /** Platform-native id. */
  id: string;
  /** Handle, login, or space id. */
  handle: string | null;
  /** Display name. */
  name: string | null;
  /** Profile / channel URL. */
  url: string;
  /** Subscriber or follower count. */
  subscribers: CountRef;
  /** Avatar URL. */
  avatar: string | null;
  /** Channel description. */
  description: string | null;
  /** Declared tags / keywords. */
  tags: string[];
  /** The number of published videos, when the platform reports it. */
  videoCount?: number | null;
  /** Lifetime views, when the platform reports them. */
  viewCount?: number | null;
  /** The total number of likes, when the platform reports it. */
  likeCount?: number | null;
}

/** A single upload / stream on some platform. */
export interface PlatformUpload {
  platform: PlatformId;
  /** Platform-native content id. */
  id: string;
  /** Owning channel id. */
  channelId: string;
  /** Title. */
  title: string;
  /** Description. */
  description: string | null;
  /** Thumbnail URL. */
  thumbnail: string | null;
  /** ISO publish timestamp. */
  publishedAt: string | null;
  /** ISO scheduled start (upcoming streams). */
  scheduledStart: string | null;
  /** Duration in seconds. */
  duration: number | null;
  /** `live` | `upcoming` | `past` | `unknown`. */
  status: "live" | "upcoming" | "past" | "unknown";
  /** Singing-specific category. */
  category: ItemCategory;
  /** Song title when it could be extracted. */
  songTitle: string | null;
  /** Original artist for covers. */
  originalArtist: string | null;
  /** View count. */
  viewCount: number | null;
  /** Direct watch URL. */
  url: string;
  /** Region suggested by this platform's known primary audience, when any. */
  region?: RegionCode;
}

export interface PlatformAdapter {
  id: PlatformId;
  /** Display name shown in the UI. */
  label: string;
  /** Colour used for the platform badge. */
  color: string;
  /** True when the adapter has everything it needs to run. */
  isConfigured(): boolean;
  /** Resolves a handle, user id or URL to a channel. */
  resolve(query: string): Promise<PlatformChannel | null>;
  /** Lists recent uploads for a channel. */
  uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]>;
  /** Lists live / upcoming streams for a channel. */
  live(channel: PlatformChannel): Promise<PlatformUpload[]>;
  /** Fetch a media thumbnail for a platform-native item id, when supported. */
  thumbnailForItem?(id: string): Promise<string | null>;
  /** Discovers channels by keyword. Used by the discovery sweep. */
  search?(query: string, limit: number): Promise<PlatformChannel[]>;
  /**
   * The follower / subscriber count for a channel.
   *
   * Optional: not every platform publishes one without authentication.
   */
  followers?(channel: PlatformChannel): Promise<CountRef | null>;
}

/* -------------------------------------------------------------------------- */
/* Primary platform                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The order platforms are preferred in, when a record is not tied to one.
 *
 * YouTube first because it is the platform the dataset is keyed on and the
 * one with the widest coverage, then the platforms that are usually a
 * performer's *main* presence.
 */
export const PLATFORM_PRIORITY: PlatformId[] = [
  "youtube",
  "bilibili",
  "niconico",
  "twitch",
  "chzzk",
  "kick",
  "soop",
  "ci.me",
  "vk",
];

/**
 * The platform a channel record is primarily about.
 *
 * The record's id decides it: a `UC…` id is a YouTube channel, a
 * `bilibili:…` id is a Bilibili account. A record that only exists on one
 * platform therefore always takes its avatar and its details from that
 * platform.
 */
export function primaryPlatformOf(channel: {
  id: string;
  platforms?: { platform: PlatformId }[];
}): PlatformId | null {
  if (channel.id.startsWith("UC")) return "youtube";
  const [prefix] = channel.id.split(":");
  if (
    prefix &&
    (PLATFORM_PRIORITY as string[]).includes(prefix)
  ) {
    return prefix as PlatformId;
  }
  // No platform in the id — fall back to the order the record lists them in.
  return channel.platforms?.[0]?.platform ?? null;
}

/**
 * Picks the avatar for a channel.
 *
 * ## The precedence
 *
 * A performer with accounts on several platforms has several avatars, and
 * several sources can supply one. The rule is:
 *
 * 1. **The primary platform's avatar.** The primary platform is the one the
 *    record's id belongs to — a `UC…` id is a YouTube channel, a
 *    `bilibili:…` id is a Bilibili account. The avatar of that platform is
 *    the one the record shows, so it always matches the platform the record
 *    is about.
 * 2. **The record's own avatar.** This is the same thing in practice: every
 *    source attaches its avatar to the platform it came from — the Taiwan VTuber
 *    track list's `imgUrl` is a YouTube avatar and sits on the YouTube link,
 *    Bilibili's `card.face` is a Bilibili avatar and sits on the Bilibili
 *    link. The record's own value is a fallback for records whose primary
 *    platform has no link.
 * 3. **The remaining platforms**, in the fixed priority order.
 *
 * The per-platform avatars always stay on the `PlatformLink`s, so a caller
 * that wants the Bilibili avatar of a YouTube channel can get it.
 */
export function pickAvatar(
  channel: {
    id: string;
    avatar?: string | null;
    platforms?: { platform: PlatformId; avatar?: string | null }[];
  },
): string | null {
  const primary = primaryPlatformOf(channel);
  if (primary) {
    const link = channel.platforms?.find((p) => p.platform === primary);
    if (link?.avatar) return link.avatar;
  }
  // Fall back to the priority order, then to whatever the record has.
  for (const platform of PLATFORM_PRIORITY) {
    const link = channel.platforms?.find((p) => p.platform === platform);
    if (link?.avatar) return link.avatar;
  }
  return channel.avatar ?? null;
}

/**
 * The platform links of a channel, in the order they should be processed.
 *
 * The channel's primary platform comes first, then the rest in the fixed
 * priority order. This makes the pipeline deterministic: the avatar and the
 * details of a record always come from the same platform, instead of from
 * whichever account the source happened to list first.
 */
export function orderPlatformLinks<
  T extends { platform: PlatformId },
>(channel: { id: string; platforms?: T[] }): T[] {
  const links = channel.platforms ?? [];
  const primary = primaryPlatformOf(channel);
  const rank = (link: T): number => {
    if (primary && link.platform === primary) return -1;
    const index = PLATFORM_PRIORITY.indexOf(link.platform);
    return index < 0 ? PLATFORM_PRIORITY.length : index;
  };
  return [...links].sort((a, b) => rank(a) - rank(b));
}

/**
 * Picks the subscriber count for a channel.
 *
 * A performer with accounts on several platforms has several counts, and
 * they are not the same number — a Bilibili channel can have more followers
 * than the same performer's YouTube channel has subscribers. The rule is:
 *
 * 1. the **primary platform's** count — the platform the record is about;
 * 2. **YouTube's**, because it is the platform the dataset is keyed on and
 *    the count people quote;
 * 3. any other platform's.
 *
 * The per-platform counts always stay on the `PlatformLink`s.
 */
/**
 * Records the 🎵 Official Artist Channel badge.
 *
 * The badge is a fact about the **YouTube** channel, so a non-YouTube answer
 * says nothing and is ignored; and every write is stamped with when it was
 * read, because `isOfficialArtist: false` then means "YouTube was asked and
 * said no" rather than "nobody asked yet".
 *
 * Callers pass `null`/`undefined` for a profile that did not report the
 * badge, and the record keeps what it had.
 */
export function applyOfficialArtist(
  channel: {
    isOfficialArtist?: boolean;
    officialArtistCheckedAt?: string | null;
  },
  checked: boolean | null | undefined,
  now: string,
): void {
  if (typeof checked !== "boolean") return;
  channel.isOfficialArtist = checked;
  channel.officialArtistCheckedAt = now;
}

export function pickSubscribers(channel: {
  id: string;
  subscribers?: CountRef;
  platforms?: { platform: PlatformId; subscribers?: CountRef }[];
}): CountRef {
  const primary = primaryPlatformOf(channel);
  if (primary) {
    const link = channel.platforms?.find((p) => p.platform === primary);
    if (link?.subscribers && link.subscribers.tag !== "hidden") {
      return link.subscribers;
    }
  }

  const youtube = channel.platforms?.find((p) => p.platform === "youtube");
  if (youtube?.subscribers && youtube.subscribers.tag !== "hidden") {
    return youtube.subscribers;
  }

  for (const platform of PLATFORM_PRIORITY) {
    const link = channel.platforms?.find((p) => p.platform === platform);
    if (link?.subscribers && link.subscribers.tag !== "hidden") {
      return link.subscribers;
    }
  }

  if (channel.subscribers && channel.subscribers.tag !== "hidden") {
    return channel.subscribers;
  }
  return { tag: "hidden" };
}

/* -------------------------------------------------------------------------- */
/* URL helpers                                                                */
/* -------------------------------------------------------------------------- */

export const PLATFORM_URLS: Record<PlatformId, (id: string) => string> = {
  youtube: (id) => `https://www.youtube.com/channel/${id}`,
  twitch: (id) => `https://www.twitch.tv/${id}`,
  bilibili: (id) => `https://space.bilibili.com/${id}`,
  niconico: (id) => `https://www.nicovideo.jp/user/${id}`,
  vk: (id) => `https://vk.com/${id}`,
  chzzk: (id) => `https://chzzk.naver.com/${id}`,
  kick: (id) => `https://kick.com/${id}`,
  soop: (id) => `https://www.sooplive.com/station/${id}`,
  "ci.me": (id) => `https://ci.me/${id}`,
};

/**
 * Detects which platform a URL or handle refers to.
 * Returns `null` when nothing matches.
 */
export function detectPlatform(input: string): PlatformId | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const rules: [RegExp, PlatformId][] = [
    [/(?:youtube\.com|youtu\.be)/, "youtube"],
    [/(?:twitch\.tv)/, "twitch"],
    [/(?:bilibili\.com|b23\.tv)/, "bilibili"],
    [/(?:nicovideo\.jp|niconico\.com)/, "niconico"],
    [/(?:vk\.com|vkvideo\.ru)/, "vk"],
    [/(?:chzzk\.naver\.com)/, "chzzk"],
    [/(?:kick\.com)/, "kick"],
    [/(?:sooplive\.com|sooplive\.co\.kr)/, "soop"],
    [/(?:https?:\/\/)?(?:www\.)?ci\.me(?:\/|$)/, "ci.me"],
  ];
  for (const [re, platform] of rules) {
    if (re.test(value)) return platform;
  }
  return null;
}

/**
 * Extracts the platform-native identifier from a URL.
 * Returns `null` when the URL has no recognisable id.
 */
export function extractPlatformId(input: string): {
  platform: PlatformId;
  id: string;
} | null {
  const value = input.trim();

  const patterns: [PlatformId, RegExp][] = [
    [
      "youtube",
      /(?:youtube\.com\/(?:channel\/(UC[\w-]{20,})|@([A-Za-z0-9._-]+)|(?:user|c)\/([A-Za-z0-9._-]+)))/i,
    ],
    ["twitch", /twitch\.tv\/([A-Za-z0-9_]{3,30})/],
    ["bilibili", /(?:space\.bilibili\.com\/|bilibili\.com\/)(?:(\d+)|([A-Za-z0-9_-]+))/],
    ["niconico", /nicovideo\.jp\/user\/(\d+)/],
    ["vk", /vk\.com\/([A-Za-z0-9_.]+)/],
    ["chzzk", /chzzk\.naver\.com\/([A-Za-z0-9_-]+)/],
    ["kick", /kick\.com\/([A-Za-z0-9_]+)/],
    ["soop", /(?:sooplive\.com\/station\/|ch\.sooplive\.co\.kr\/)([A-Za-z0-9_-]+)/],
    ["ci.me", /ci\.me\/(?:channel\/)?([A-Za-z0-9_-]+)/],
  ];

  for (const [platform, re] of patterns) {
    const m = re.exec(value);
    if (!m) continue;
    const id =
      platform === "youtube"
        ? m[1] ?? m[2] ?? (m[3] ? `${m[0]!.includes("/user/") ? "user" : "c"}/${m[3]}` : null)
        : (m[1] ?? m[2]);
    if (id) return { platform, id };
  }
  return null;
}

/** Normalises a search term into a plain handle where possible. */
export function normalizeHandle(input: string): string {
  return input
    .trim()
    .replace(/^@+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .split(/[/?#]/)[0]!
    .toLowerCase();
}

/** Default activity for an unknown channel. */
export const UNKNOWN_ACTIVITY: Activity = "unknown";

/**
 * The names a platform uses when a channel no longer exists.
 *
 * A deleted account still answers the profile endpoint, but with a
 * placeholder instead of a name — 「账号已注销」 on Bilibili, 「(알 수 없음)」
 * on CHZZK. Renaming a record to one of those would replace a real name
 * with a tombstone, so they are rejected.
 */
const PLACEHOLDER_NAMES = new Set([
  "账号已注销",
  "帳號已注销",
  "账号注销",
  "(알 수 없음)",
  "알 수 없음",
  "unknown",
  "unknown channel",
  "暂无",
  "no name",
]);

export function isPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return true;
  return PLACEHOLDER_NAMES.has(trimmed.toLowerCase());
}

/**
 * The avatars a platform serves when it has none.
 *
 * Bilibili answers a deleted or avatar-less account with
 * `bfs/face/member/noface.jpg`, and storing that URL makes the card look
 * broken rather than empty — the app renders the same silhouette either way,
 * but the record claims to have an image it does not have.
 */
const PLACEHOLDER_AVATARS = /(?:^|[/_.-])(?:noface|no_face|no-avatar|no_avatar|default[_-]?avatar|avatar[_-]?default)(?:[/_.-]|$)/i;

export function isPlaceholderAvatar(url: string | null | undefined): boolean {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return true;
  return PLACEHOLDER_AVATARS.test(trimmed);
}

/**
 * Cleans a channel id.
 *
 * A few records were built from a channel **URL**, so their id carries the
 * tab: `UC…/featured`, `UC…/videos`. The tab is not part of the id, and an
 * id with a slash in it never resolves to a channel.
 */
export function normalizeChannelId(id: string): string {
  const trimmed = id.trim();
  // `youtube:UC…` and `UC…` are the same channel; the bare form is the one
  // the dataset stores.
  const body = trimmed.startsWith("youtube:")
    ? trimmed.slice("youtube:".length)
    : trimmed;
  const slash = body.indexOf("/");
  if (slash < 0) return trimmed;
  const head = body.slice(0, slash);
  // Only a YouTube channel id can carry a tab: `UC…/featured`, `UC…/videos`.
  return head.startsWith("UC") ? head : trimmed;
}
