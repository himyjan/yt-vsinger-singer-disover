/**
 * One YouTube channel's current state, read through `youtubei.js`.
 *
 * This is the server half of the subscription cards' detail fetch. The
 * pipeline already uses the same client for the committed dataset; this module
 * is deliberately small and separate because the bridge needs:
 *
 *   • the 🎵 Official Artist badge from the channel **header** — the only
 *     place YouTube exposes it, and the Data API does not expose it at all;
 *   • the current live/upcoming stream, when one exists;
 *   • the Releases tab (albums and singles), which is YouTube Music's
 *     catalogue rather than the channel's ordinary uploads.
 *
 * `getChannel()` costs one request and returns the header, so the badge sync
 * is one request per channel. Live/upcoming/releases are opt-in because they
 * need more requests and are only wanted when a card is opened.
 *
 * The client is not signed in, so no token or cookie is involved. Every call
 * has a timeout; a channel that is deleted, private or rate-limited throws and
 * the caller reports it rather than hanging.
 */

import { hasAudioBadge } from "./youtubei";
import type {
  YouTubeChannelItem,
  YouTubeChannelSnapshot,
} from "./types";

const REQUEST_TIMEOUT_MS = 20_000;

/** Abandons a request that never answers. */
function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Plain text of a YouTube text node (`{ simpleText }` / `{ runs }` / `{ text }`). */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as {
    simpleText?: unknown;
    text?: unknown;
    runs?: Array<{ text?: unknown }>;
  };
  if (typeof node.simpleText === "string") return node.simpleText;
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.runs)) {
    return node.runs
      .map((run) => (typeof run?.text === "string" ? run.text : ""))
      .join("");
  }
  return "";
}

/** The largest thumbnail a renderer exposes, without the expiring query string. */
function thumbnailOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;

  const candidates: unknown[] = [];
  const image = node.image;
  if (Array.isArray(image)) candidates.push(...image);
  const thumbnails = node.thumbnails;
  if (Array.isArray(thumbnails)) candidates.push(...thumbnails);
  const renderer = node.thumbnail_renderer as
    | { thumbnail?: { image?: unknown[] } }
    | undefined;
  if (renderer?.thumbnail?.image && Array.isArray(renderer.thumbnail.image)) {
    candidates.push(...renderer.thumbnail.image);
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const entry = candidates[i] as { url?: unknown } | undefined;
    if (typeof entry?.url === "string") {
      return entry.url.startsWith("//")
        ? `https:${entry.url}`
        : entry.url.split("?")[0]!;
    }
  }
  return null;
}

interface BadgeInfo {
  text: string;
  style: string;
  icon: string;
}

/**
 * Every badge-like node attached to an item.
 *
 * YouTube spells the live/upcoming state differently by renderer: sometimes a
 * `ThumbnailBadgeView` with `icon_name: "LIVE"`, sometimes a localized
 * `text`, sometimes a `badge_style`. Collecting all three lets the caller
 * decide without relying on one layout.
 */
function badgesOf(value: unknown): BadgeInfo[] {
  const out: BadgeInfo[] = [];
  /**
   * The parser classes expose badge fields through getters, so enumerate a
   * plain copy. A live tab has at most a few dozen items, so the copy is
   * cheap and it keeps the detection independent of the parser's shape.
   */
  let root = value;
  try {
    root = JSON.parse(JSON.stringify(value));
  } catch {
    /* keep the original value if it cannot be serialised */
  }
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    const style = typeof record.badge_style === "string" ? record.badge_style : "";
    const icon = typeof record.icon_name === "string" ? record.icon_name : "";
    if (text || style || icon) {
      if (
        record.type === "ThumbnailBadgeView" ||
        record.type === "BadgeView" ||
        style ||
        icon
      ) {
        out.push({ text, style, icon });
      }
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
}

function isLiveBadge(badges: BadgeInfo[]): boolean {
  return badges.some(
    (badge) =>
      /LIVE/i.test(badge.style) ||
      badge.text.trim().toUpperCase() === "LIVE" ||
      badge.icon.trim().toUpperCase() === "LIVE",
  );
}

function isUpcomingBadge(badges: BadgeInfo[]): boolean {
  return badges.some((badge) => {
    const haystack = `${badge.style} ${badge.text} ${badge.icon}`;
    return /UPCOMING|SCHEDULE|PREMIERE/i.test(haystack);
  });
}

function itemId(item: Record<string, unknown>): string {
  const direct = item.content_id ?? item.id;
  if (typeof direct === "string" && direct) return direct;
  const endpoint = item.endpoint as
    | { payload?: { videoId?: unknown; playlistId?: unknown } }
    | undefined;
  const videoId = endpoint?.payload?.videoId;
  if (typeof videoId === "string") return videoId;
  const playlistId = endpoint?.payload?.playlistId;
  if (typeof playlistId === "string") return playlistId;
  const viewPlaylist = item.view_playlist as { content_id?: unknown } | undefined;
  return typeof viewPlaylist?.content_id === "string" ? viewPlaylist.content_id : "";
}

function itemTitle(item: Record<string, unknown>): string {
  const metadata = item.metadata as { title?: unknown } | undefined;
  return textOf(metadata?.title) || textOf(item.title) || textOf(item.headline);
}

function itemThumbnail(item: Record<string, unknown>): string | null {
  return (
    thumbnailOf(item.content_image) ??
    thumbnailOf(item) ??
    thumbnailOf(item.thumbnail_renderer) ??
    null
  );
}

function parseVideo(item: Record<string, unknown>): YouTubeChannelItem | null {
  const id = itemId(item);
  const title = itemTitle(item);
  if (!id || !title) return null;
  return { id, title, thumbnail: itemThumbnail(item), kind: "video" };
}

function parseRelease(item: Record<string, unknown>): YouTubeChannelItem | null {
  const id = itemId(item);
  const title = itemTitle(item);
  if (!id || !title) return null;
  return { id, title, thumbnail: itemThumbnail(item), kind: "playlist" };
}

/** A compact count such as `6.96K` → 6960. */
function compactCount(text: string): number | null {
  const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const multiplier =
    match[2]?.toUpperCase() === "B"
      ? 1_000_000_000
      : match[2]?.toUpperCase() === "M"
        ? 1_000_000
        : match[2]?.toUpperCase() === "K"
          ? 1_000
          : 1;
  return Math.round(base * multiplier);
}

/** Subscriber counts arrive as a number or a `{ text }` pair. */
function subscriberCount(meta: Record<string, unknown>): number | null {
  const raw = meta.subscriberCount ?? meta.subscriber_count ?? null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object") {
    return compactCount(String((raw as { text?: unknown }).text ?? ""));
  }
  return null;
}

/**
 * New channel pages put the subscriber count in the header, not in the
 * microformat metadata. It is a localized human string (`6.96K subscribers`),
 * so it is only a display value; the dataset uses the Data API when it has
 * one.
 */
function headerSubscriberCount(header: unknown): number | null {
  try {
    const json = JSON.stringify(header);
    const match = json.match(/([\d.,]+)\s*([KMB])?\s+subscribers?/i);
    if (!match) return null;
    const compact = `${match[1]}${match[2] ?? ""}`;
    return compactCount(compact);
  } catch {
    return null;
  }
}

/**
 * Reads one channel.
 *
 * `detail` adds the live/upcoming and Releases tabs. Those tabs make one or
 * more additional browse requests, so the badge-only sync never asks for them.
 */
export async function fetchYouTubeChannelSnapshot(
  client: { getChannel(id: string): Promise<unknown> },
  channelId: string,
  detail = false,
): Promise<YouTubeChannelSnapshot> {
  const channel = (await withTimeout(
    client.getChannel(channelId),
  )) as Record<string, any> | null;
  if (!channel) throw new Error("YouTube did not answer for this channel");

  const meta = (channel.metadata ?? {}) as Record<string, unknown>;
  const endpoint = (channel.current_tab?.endpoint?.payload ?? {}) as {
    browseId?: unknown;
    canonicalBaseUrl?: unknown;
  };
  const canonical =
    typeof endpoint.browseId === "string"
      ? endpoint.browseId
      : typeof channel.id === "string"
        ? channel.id
        : channelId;
  const vanity =
    typeof endpoint.canonicalBaseUrl === "string"
      ? endpoint.canonicalBaseUrl
      : null;
  const handle = vanity
    ? vanity.replace(/^\/?@?/, "").split("/")[0] || null
    : null;

  const avatar =
    (channel.avatar as { url?: unknown } | undefined)?.url ??
    (Array.isArray(meta.avatar)
      ? (meta.avatar[0] as { url?: unknown } | undefined)?.url
      : null) ??
    null;

  const snapshot: YouTubeChannelSnapshot = {
    id: canonical,
    title: typeof meta.title === "string" ? meta.title : null,
    handle,
    avatar: typeof avatar === "string" ? avatar : null,
    /* The header parse is only needed by the opened-card view. */
    subscribers:
      subscriberCount(meta) ??
      (detail ? headerSubscriberCount(channel.header) : null),
    officialArtist: hasAudioBadge(channel.header),
    live: null,
    upcoming: null,
    releases: [],
    releaseCount: 0,
  };

  if (!detail) return snapshot;

  /**
   * The channel's Live tab lists live now, upcoming and past streams. The
   * badge says which is which; a past stream only has a duration.
   */
  try {
    const liveTab = (await withTimeout(channel.getLiveStreams())) as
      | { videos?: unknown[]; items?: unknown[] }
      | null;
    const items = liveTab?.videos ?? liveTab?.items ?? [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = parseVideo(raw as Record<string, unknown>);
      if (!item) continue;
      const badges = badgesOf(raw);
      if (isLiveBadge(badges) && !snapshot.live) snapshot.live = item;
      if (isUpcomingBadge(badges) && !snapshot.upcoming) snapshot.upcoming = item;
    }
  } catch {
    /* no Live tab, or YouTube changed it — the profile is still useful */
  }

  /**
   * The Releases tab is YouTube Music's catalogue: albums and singles,
   * rendered as playlists. A channel with no releases tab simply returns none.
   */
  try {
    const releasesTab = (await withTimeout(channel.getReleases())) as
      | { playlists?: unknown[]; videos?: unknown[]; items?: unknown[] }
      | null;
    const items =
      releasesTab?.playlists ?? releasesTab?.videos ?? releasesTab?.items ?? [];
    snapshot.releaseCount = items.length;
    snapshot.releases = items
      .map((raw) =>
        raw && typeof raw === "object"
          ? parseRelease(raw as Record<string, unknown>)
          : null,
      )
      .filter((item): item is YouTubeChannelItem => item !== null)
      .slice(0, 12);
  } catch {
    /* no Releases tab — normal for an ordinary uploader */
  }

  return snapshot;
}

/** True when the failure is the channel itself, not the request rate. */
export function isChannelNotFound(message: string): boolean {
  return /does not exist|not found|404|removed|terminated|status code 400|存在しません|削除されました|停止しました|利用できません|不存在|已被删除|已删除|不存在该用户|존재하지 않습니다|삭제되었습니다/i.test(
    message,
  );
}

/** True when YouTube asked us to slow down. */
export function isRateLimited(message: string): boolean {
  return /429|rate.?limit|too many requests|quota|temporarily blocked|try again later/i.test(
    message,
  );
}
