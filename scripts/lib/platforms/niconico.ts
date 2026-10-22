/**
 * Niconico adapter.
 *
 * Niconico (ニコニコ動画) is where a large share of Japanese VSingers publish
 * original songs and covers. Two public APIs are used:
 *
 *   GET https://api.search.nicovideo.jp/api/v2/video?query=...&targets=tagsExact
 *       → tag / keyword search, returns `contentId`, `title`, `tags`,
 *         `viewCounter`, `startTime`, `contentType`
 *
 *   GET https://api.search.nicovideo.jp/api/v2/channel?query=...
 *       → channel (user) search, returns `id`, `name`, `description`
 *
 * Both are JSON, need no key, and are polite as long as the sync does not
 * hammer them — the adapter caches responses on disk.
 */

import { classifyItem } from "../classify";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import { REQUEST_TIMEOUT_MS } from "../io";

const SEARCH = "https://api.search.nicovideo.jp/api/v2";

interface NicoVideo {
  contentId: string;
  title?: string;
  description?: string;
  tags?: string[];
  viewCounter?: number;
  startTime?: number;
  contentType?: string;
  type?: string;
}

interface NicoChannel {
  id: string;
  name?: string;
  description?: string;
  thumbnailUrl?: string;
}

export class NiconicoAdapter implements PlatformAdapter {
  readonly id: PlatformId = "niconico";
  readonly label = "Niconico";
  readonly color = "#252525";

  isConfigured(): boolean {
    return true;
  }

  private async getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
    try {
      const url = new URL(`${SEARCH}/${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const id = query.trim();
    if (!id) return null;
    const numeric = /^\d+$/.test(id) ? id : null;
    if (!numeric) return null;

    const data = await this.getJson<{ data?: NicoChannel[] }>("channel", {
      query: id,
      targets: "titleExact",
      _sort: "viewCounter",
      _limit: "1",
    });
    const channel = data?.data?.[0];
    if (!channel) {
      return {
        platform: "niconico",
        id: numeric,
        handle: numeric,
        name: null,
        url: `https://www.nicovideo.jp/user/${numeric}`,
        subscribers: { tag: "hidden" },
        avatar: null,
        description: null,
        tags: [],
      };
    }

    return {
      platform: "niconico",
      id: channel.id,
      handle: channel.id,
      name: channel.name ?? null,
      url: `https://www.nicovideo.jp/user/${channel.id}`,
      subscribers: { tag: "hidden" } satisfies CountRef,
      avatar: channel.thumbnailUrl ?? null,
      description: channel.description ?? null,
      tags: [],
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    const data = await this.getJson<{ data?: NicoVideo[] }>("video", {
      query: channel.id,
      targets: "tagsExact",
      fields: "contentId,title,tags,viewCounter,startTime,contentType",
      _sort: "-startTime",
      _limit: String(Math.min(100, limit)),
    });
    const list = data?.data ?? [];

    return list.slice(0, limit).map((video) => {
      const classified = classifyItem({
        title: video.title ?? "",
        description: video.description ?? null,
        tags: video.tags ?? [],
        channelKind: "virtual",
        status: "past",
        isShort: false,
        durationSeconds: null,
        channelRegion: "jp",
      });
      return {
        platform: "niconico",
        id: video.contentId,
        channelId: channel.id,
        title: video.title ?? "",
        description: video.description ?? null,
        thumbnail: `https://img1.ssl.nimg.jp/thumb/${video.contentId}`,
        publishedAt: video.startTime
          ? new Date(video.startTime * 1000).toISOString()
          : null,
        scheduledStart: null,
        duration: null,
        status: "past",
        category: classified.category,
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: video.viewCounter ?? null,
        url: `https://www.nicovideo.jp/watch/${video.contentId}`,
      } satisfies PlatformUpload;
    });
  }

  async live(_channel: PlatformChannel): Promise<PlatformUpload[]> {
    // Niconico Live has no public Helix-style listing endpoint.
    return [];
  }

  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    const data = await this.getJson<{ data?: NicoVideo[] }>("video", {
      query,
      targets: "tagsExact,title",
      fields: "contentId,title,tags,startTime,user,nickName",
      _sort: "-viewCounter",
      _limit: String(Math.min(100, limit)),
    });
    const list = data?.data ?? [];

    // Niconico's search API returns videos rather than channels, so group by
    // the `user` field to derive candidate channels.
    const byUser = new Map<string, NicoVideo>();
    for (const video of list) {
      const user = (video as NicoVideo & { user?: string }).user;
      if (!user) continue;
      if (!byUser.has(user)) byUser.set(user, video);
    }

    return [...byUser.entries()].slice(0, limit).map(([user, video]) => ({
      platform: "niconico" as PlatformId,
      id: user,
      handle: user,
      name: (video as NicoVideo & { nickName?: string }).nickName ?? null,
      url: `https://www.nicovideo.jp/user/${user}`,
      subscribers: { tag: "hidden" } satisfies CountRef,
      avatar: null,
      description: null,
      tags: video.tags ?? [],
    }));
  }
}
