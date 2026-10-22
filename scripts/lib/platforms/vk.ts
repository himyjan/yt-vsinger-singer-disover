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

const API = "https://api.vk.com/method";

interface VkUser {
  id: number;
  screen_name: string;
  first_name?: string;
  last_name?: string;
  photo_200?: string;
  followers_count?: number;
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

  private readonly token: string | null;

  constructor(token: string | null = process.env.VK_ACCESS_TOKEN ?? null) {
    this.token = token;
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
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { response?: T; error?: unknown };
      if (json.error) return null;
      return json.response ?? null;
    } catch {
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
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    const videos = await this.call<VkVideo[]>("video.get", {
      owner_id: channel.id,
      count: String(Math.min(100, limit)),
      order: "-date",
    });
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

  async live(_channel: PlatformChannel): Promise<PlatformUpload[]> {
    return [];
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
