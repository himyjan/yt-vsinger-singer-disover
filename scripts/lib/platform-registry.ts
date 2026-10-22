/**
 * Platform registry.
 *
 * Assembles the concrete adapters. YouTube and Twitch need their API clients
 * (and, for Twitch, credentials); Bilibili, Niconico and VK work without
 * credentials but degrade gracefully.
 *
 * The registry is the only place that knows how to construct an adapter, so
 * the sync stays platform-agnostic.
 */

import { YouTubeClient } from "./youtube";
import { TwitchClient, extractTwitchLogin } from "./twitch";
import { BilibiliAdapter } from "./platforms/bilibili";
import { NiconicoAdapter } from "./platforms/niconico";
import { VkAdapter } from "./platforms/vk";
import { ChzzkAdapter } from "./platforms/chzzk";
import { KickAdapter } from "./platforms/kick";
import { classifyItem } from "./classify";
import { pickThumbnail, parseIsoDuration } from "./youtube";
import type { CountRef, PlatformId } from "./types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "./platforms";

/* -------------------------------------------------------------------------- */
/* YouTube                                                                    */
/* -------------------------------------------------------------------------- */

class YouTubeAdapter implements PlatformAdapter {
  readonly id: PlatformId = "youtube";
  readonly label = "YouTube";
  readonly color = "#ff0000";

  constructor(private readonly client: YouTubeClient) {}

  isConfigured(): boolean {
    return true;
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const handle = query.trim().replace(/^@+/, "");
    if (!handle) return null;
    const users = await this.client.resolveHandles([handle]);
    const raw = users[0];
    if (!raw) return null;

    const snippet = raw.snippet ?? {};
    const stats = raw.statistics ?? {};
    const subscribers = stats.subscriberCount
      ? { tag: "has" as const, count: Number(stats.subscriberCount) }
      : { tag: "hidden" as const };

    return {
      platform: "youtube",
      id: raw.id,
      handle: snippet.customUrl ? snippet.customUrl.replace(/^@/, "") : handle,
      name: snippet.title ?? null,
      url: `https://www.youtube.com/channel/${raw.id}`,
      subscribers,
      avatar: pickThumbnail(snippet.thumbnails, "high"),
      description: snippet.description ?? null,
      tags: snippet.tags ?? [],
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    const playlistId = channel.id.startsWith("UC")
      ? `UU${channel.id.slice(2)}`
      : null;
    if (!playlistId) return [];

    const entries = await this.client.playlistItems(playlistId, limit);
    const ids = entries
      .map((e: any) => e?.snippet?.resourceId?.videoId)
      .filter((v: string | undefined): v is string => !!v);
    const details = ids.length ? await this.client.videos(ids) : [];

    return details.slice(0, limit).map((raw: any) => {
      const snippet = raw.snippet ?? {};
      const live = raw.liveStreamingDetails ?? {};
      const duration = parseIsoDuration(raw.contentDetails?.duration);
      const scheduledStart = live.scheduledStartTime ?? null;
      const actualStart = live.actualStartTime ?? null;
      const actualEnd = live.actualEndTime ?? null;
      const status: PlatformUpload["status"] =
        actualStart && actualEnd
          ? "past"
          : actualStart
            ? "live"
            : scheduledStart
              ? "upcoming"
              : "past";

      const classified = classifyItem({
        title: snippet.title ?? "",
        description: snippet.description ?? null,
        tags: snippet.tags ?? [],
        channelKind: "virtual",
        status,
        isShort: false,
        durationSeconds: duration,
        channelRegion: "unknown",
      });

      return {
        platform: "youtube",
        id: raw.id,
        channelId: channel.id,
        title: snippet.title ?? "",
        description: snippet.description ?? null,
        thumbnail: pickThumbnail(snippet.thumbnails, "high"),
        publishedAt: snippet.publishedAt ?? null,
        scheduledStart,
        duration,
        status,
        category: classified.category,
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: raw.statistics?.viewCount
          ? Number(raw.statistics.viewCount)
          : null,
        url: `https://www.youtube.com/watch?v=${raw.id}`,
      } satisfies PlatformUpload;
    });
  }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    const broadcasts = await this.client.liveBroadcasts([channel.id]);
    return broadcasts.map((b: any) => {
      const snippet = b.snippet ?? {};
      const life = b.status?.lifeCycleStatus ?? "unknown";
      const status: PlatformUpload["status"] =
        life === "live" ? "live" : life === "upcoming" ? "upcoming" : "past";
      return {
        platform: "youtube",
        id: b.id,
        channelId: channel.id,
        title: snippet.title ?? "",
        description: snippet.description ?? null,
        thumbnail: pickThumbnail(snippet.thumbnails, "high"),
        publishedAt: snippet.publishedAt ?? null,
        scheduledStart: b.contentDetails?.scheduledStartTime ?? null,
        duration: null,
        status,
        category: status === "upcoming" ? "premiere" : "live",
        songTitle: null,
        originalArtist: null,
        viewCount: null,
        url: `https://www.youtube.com/watch?v=${b.id}`,
      } satisfies PlatformUpload;
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Twitch                                                                     */
/* -------------------------------------------------------------------------- */

class TwitchAdapter implements PlatformAdapter {
  readonly id: PlatformId = "twitch";
  readonly label = "Twitch";
  readonly color = "#9146ff";

  constructor(private readonly client: TwitchClient) {}

  isConfigured(): boolean {
    return true;
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const login = extractTwitchLogin(query) ?? query.trim().replace(/^@+/, "");
    if (!login) return null;
    const users = await this.client.users([login]);
    const user = users[0];
    if (!user) return null;

    let subscribers: CountRef = { tag: "hidden" };
    try {
      subscribers = await this.client.followers(user.id);
    } catch {
      /* keep hidden */
    }

    return {
      platform: "twitch",
      id: user.id,
      handle: user.login,
      name: user.display_name ?? user.login,
      url: `https://www.twitch.tv/${user.login}`,
      subscribers,
      avatar: user.profile_image_url ?? null,
      description: user.description ?? null,
      tags: [],
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    // Twitch only exposes live streams, no VOD list without a token scope.
    return this.live(channel).then((list) => list.slice(0, limit));
  }

  /** The follower count, straight from the Helix API. */
  async followers(channel: PlatformChannel): Promise<CountRef | null> {
    if (!channel.id) return null;
    try {
      return await this.client.followers(channel.id);
    } catch {
      return null;
    }
  }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    const streams = await this.client.streams([channel.id]);
    return streams.map((stream: any) => ({
      platform: "twitch" as PlatformId,
      id: stream.id,
      channelId: channel.id,
      title: stream.title ?? "",
      description: stream.description ?? null,
      thumbnail: stream.thumbnail_url
        ? stream.thumbnail_url.replace("{width}", "640").replace("{height}", "360")
        : null,
      publishedAt: stream.started_at ?? null,
      scheduledStart: stream.started_at ?? null,
      duration: null,
      status: "live" as const,
      category: "live" as const,
      songTitle: null,
      originalArtist: null,
      viewCount: stream.viewer_count ?? null,
      url: `https://www.twitch.tv/${channel.handle}`,
    }));
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export interface RegistryOptions {
  youtubeClient: YouTubeClient | null;
  twitchClient: TwitchClient | null;
}

/** Builds every adapter that can run in this environment. */
export function createAdapters(opts: RegistryOptions): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [];

  if (opts.youtubeClient) {
    adapters.push(new YouTubeAdapter(opts.youtubeClient));
  }
  if (opts.twitchClient) {
    adapters.push(new TwitchAdapter(opts.twitchClient));
  }

  const bili = new BilibiliAdapter();
  if (bili.isConfigured()) adapters.push(bili);

  const nico = new NiconicoAdapter();
  if (nico.isConfigured()) adapters.push(nico);

  const vk = new VkAdapter();
  if (vk.isConfigured()) adapters.push(vk);

  // CHZZK — Naver's platform, and the biggest Korean VTuber scene.
  const chzzk = new ChzzkAdapter();
  if (chzzk.isConfigured()) adapters.push(chzzk);

  // KICK.
  const kick = new KickAdapter();
  if (kick.isConfigured()) adapters.push(kick);

  return adapters;
}

/** Human-readable platform labels, for the UI. */
export const PLATFORM_LABELS: Record<PlatformId, string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  bilibili: "Bilibili",
  niconico: "Niconico",
  vk: "VK",
  chzzk: "CHZZK",
  kick: "KICK",
};
