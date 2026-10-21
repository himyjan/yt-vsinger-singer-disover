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
  /** Discovers channels by keyword. Used by the discovery sweep. */
  search?(query: string, limit: number): Promise<PlatformChannel[]>;
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
    ["youtube", /(?:youtube\.com\/channel\/|youtu\.be\/|youtube\.com\/@)([A-Za-z0-9_-]{6,})/],
    ["twitch", /twitch\.tv\/([A-Za-z0-9_]{3,30})/],
    ["bilibili", /(?:space\.bilibili\.com\/|bilibili\.com\/)(?:(\d+)|([A-Za-z0-9_-]+))/],
    ["niconico", /nicovideo\.jp\/user\/(\d+)/],
    ["vk", /vk\.com\/([A-Za-z0-9_.]+)/],
  ];

  for (const [platform, re] of patterns) {
    const m = re.exec(value);
    if (!m) continue;
    const id = m[1] ?? m[2];
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
