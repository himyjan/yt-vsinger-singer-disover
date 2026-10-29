/**
 * VK adapter.
 *
 * VK (ВКонтакте) hosts a large Russian-speaking VTuber scene. The official
 * API needs a service token; without one the adapter still works in a
 * reduced mode using the public `vk.com` endpoints, which return HTML rather
 * than JSON — so the reduced mode only resolves basic profile facts.
 *
 * With `VK_ACCESS_TOKEN` set, the full API is used:
 *
 *   GET https://api.vk.com/method/users.get?user_ids=...&access_token=...
 *   GET https://api.vk.com/method/video.get?owner_id=...&access_token=...
 *   GET https://api.vk.com/method/users.getFollowers?owner_id=...
 */

import { classifyItem } from "../classify";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import { REQUEST_TIMEOUT_MS } from "../io";

const API = "https://api.vk.com/method";

interface VkUser {
  id: number;
  screen_name: string;
  first_name?: string;
  last_name?: string;
  photo_200?: string;
  followers_count?: number;
  video_count?: number;
  verified?: number;
  status?: string;
}

interface VkVideo {
  id: number;
  owner_id: number;
  title: string;
  description?: string;
  photo_200?: string;
  photo_100?: string;
  date: number;
  duration?: number;
  views?: number;
  player?: string;
}

export class VkAdapter implements PlatformAdapter {
  readonly id: PlatformId = "vk";
  readonly label = "VK";
  readonly color = "#0077ff";

  /** VK reports `video_count` on the user record. */
  readonly reportsVideoCount = true;

  private readonly token: string | null;
  private readonly onLog: (message: string) => void;

  constructor(
    token: string | null = process.env.VK_ACCESS_TOKEN ?? null,
    onLog: (message: string) => void = () => {},
  ) {
    this.token = token;
    this.onLog = onLog;
  }

  isConfigured(): boolean {
    // Reduced mode (profile facts only) still works without a token.
    return true;
  }

  /** True when the full API is available. */
  get hasToken(): boolean {
    return !!this.token;
  }

  private async call<T>(method: string, params: Record<string, string>): Promise<T | null> {
    if (!this.token) return null;
    try {
      const url = new URL(`${API}/${method}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      url.searchParams.set("access_token", this.token);
      url.searchParams.set("v", "5.199");
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        this.onLog(`vk: ${method} returned HTTP ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { response?: T; error?: unknown };
      if (json.error) {
        this.onLog(`vk: ${method} returned an API error`);
        return null;
      }
      return json.response ?? null;
    } catch (error) {
      this.onLog(`vk: ${method} request failed: ${(error as Error).message}`);
      return null;
    }
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const handle = query.trim().replace(/^@+/, "").replace(/^https?:\/\/vk\.com\//, "");
    if (!handle) return null;

    const users = await this.call<VkUser[]>("users.get", {
      user_ids: handle,
      fields: "screen_name,photo_200,followers_count,verified,status,sex",
    });
    if (!users?.length) {
      // Reduced mode: we only know the screen name.
      return {
        platform: "vk",
        id: handle,
        handle,
        name: handle,
        url: `https://vk.com/${handle}`,
        subscribers: { tag: "hidden" },
        avatar: null,
        description: null,
        tags: [],
      };
    }

    const user = users[0]!;
    const followers = user.followers_count ?? 0;
    const subscribers: CountRef =
      followers > 0 ? { tag: "has", count: followers } : { tag: "no" };

    return {
      platform: "vk",
      id: String(user.id),
      handle: user.screen_name,
      name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.screen_name,
      url: `https://vk.com/${user.screen_name}`,
      subscribers,
      avatar: user.photo_200 ?? null,
      description: user.status ?? null,
      tags: [],
      videoCount: user.video_count ?? null,
    };
  }

  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    const needle = query.trim();
    if (!needle || limit <= 0 || !this.token) return [];
    const result = await this.call<{ items?: VkUser[] }>("users.search", {
      q: needle,
      count: String(Math.min(limit, 100)),
      fields: "screen_name,photo_200,followers_count,verified,status,video_count",
    });
    return (result?.items ?? []).map((user) => {
      const name =
        [user.first_name, user.last_name].filter(Boolean).join(" ") ||
        user.screen_name;
      const followers = user.followers_count ?? 0;
      return {
        platform: "vk",
        id: String(user.id),
        handle: user.screen_name,
        name,
        url: `https://vk.com/${user.screen_name}`,
        subscribers:
          followers > 0
            ? { tag: "has" as const, count: followers }
            : { tag: "no" as const },
        avatar: user.photo_200 ?? null,
        description: user.status ?? null,
        tags: [],
        videoCount: user.video_count ?? null,
      };
    });
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    const response = await this.call<
      VkVideo[] | { items?: VkVideo[] }
    >("video.get", {
      owner_id: channel.id,
      count: String(Math.min(100, limit)),
      order: "-date",
    });
    const videos = Array.isArray(response) ? response : response?.items ?? [];
    if (!videos?.length) return [];

    return videos.slice(0, limit).map((video) => {
      const classified = classifyItem({
        title: video.title,
        description: video.description ?? null,
        tags: [],
        channelKind: "virtual",
        status: "past",
        isShort: false,
        durationSeconds: video.duration ?? null,
        channelRegion: "unknown",
      });
      return {
        platform: "vk",
        id: String(video.id),
        channelId: channel.id,
        title: video.title,
        description: video.description ?? null,
        thumbnail: video.photo_200 ?? video.photo_100 ?? null,
        publishedAt: video.date ? new Date(video.date * 1000).toISOString() : null,
        scheduledStart: null,
        duration: video.duration ?? null,
        status: "past",
        category: classified.category,
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: video.views ?? null,
        url: `https://vk.com/video${video.owner_id}_${video.id}`,
      } satisfies PlatformUpload;
    });
  }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    if (!this.hasToken || !channel.id) return [];

    const response = await this.call<{ items?: VkVideo[] }>("video.get", {
      owner_id: channel.id,
      live: "1",
      count: "10",
    });

    const videos = response?.items ?? [];
    if (!videos?.length) return [];

    return videos.map((video) => {
      const classified = classifyItem({
        title: video.title,
        description: video.description ?? null,
        tags: [],
        channelKind: "virtual",
        status: "live",
        isShort: false,
        durationSeconds: video.duration ?? null,
        channelRegion: "unknown",
      });
      return {
        platform: "vk",
        id: String(video.id),
        channelId: channel.id,
        title: video.title,
        description: video.description ?? null,
        thumbnail: video.photo_200 ?? video.photo_100 ?? null,
        publishedAt: video.date
          ? new Date(video.date * 1000).toISOString()
          : null,
        scheduledStart: null,
        duration: video.duration ?? null,
        status: "live",
        category: "live",
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: video.views ?? null,
        url: `https://vk.com/video${video.owner_id}_${video.id}`,
      } satisfies PlatformUpload;
    });
  }

  /** The follower count. */
  async followers(channel: PlatformChannel): Promise<CountRef | null> {
    const json = await this.call<{ followers_count?: number }>("users.get", {
      user_ids: channel.id,
      fields: "followers_count",
    });
    const count = json?.followers_count;
    if (count === undefined) return null;
    return count > 0 ? { tag: "has", count } : { tag: "no" };
  }
}
