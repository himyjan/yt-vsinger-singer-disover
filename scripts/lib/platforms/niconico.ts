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
import { RateLimiter, detectRateLimit } from "../rate-limit";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import { REQUEST_TIMEOUT_MS } from "../io";

const SEARCH = "https://api.search.nicovideo.jp/api/v2";

/** Niconico rate-limits aggressively — one request per second at minimum. */
const REQUEST_INTERVAL_MS = 1_000;

interface NicoVideo {
  contentId: string;
  title?: string;
  description?: string;
  tags?: string[];
  viewCounter?: number;
  startTime?: number;
  contentType?: string;
  type?: string;
  liveStatus?: string;
  user?: string;
  nickName?: string;
}

interface NicoChannel {
  id: string;
  name?: string;
  description?: string;
  thumbnailUrl?: string;
}

export interface NiconicoOptions {
  onLog?: (message: string) => void;
}

export class NiconicoAdapter implements PlatformAdapter {
  readonly id: PlatformId = "niconico";
  readonly label = "Niconico";
  readonly color = "#252525";
  discoveredUploads: PlatformUpload[] = [];
  /** Live streams found by the last live() call — populated once per run. */
  liveUploads: PlatformUpload[] = [];
  private readonly onLog: (message: string) => void;
  /** Adaptive limiter — Niconico blocks bursts, so requests are spaced out. */
  private readonly limiter: RateLimiter;

  constructor(options: NiconicoOptions = {}) {
    this.onLog = options.onLog ?? (() => {});
    this.limiter = new RateLimiter({
      minIntervalMs: REQUEST_INTERVAL_MS,
      maxIntervalMs: 60_000,
      onLimit: (m) => this.onLog(`niconico: ${m}`),
      onChange: (ms) => this.onLog(`niconico: interval → ${Math.round(ms)}ms`),
    });
  }

  isConfigured(): boolean {
    return true;
  }

  private async getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
    // Circuit breaker: if Niconico has pushed back hard enough, stop calling it.
    if (this.limiter.isTripped()) {
      this.onLog(`niconico: rate limiter tripped, skipping ${path}`);
      return null;
    }

    await this.limiter.wait();

    try {
      const url = new URL(`${SEARCH}/${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          // Niconico blocks requests that look like scripts — a real browser UA
          // and a Referer are needed.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://www.nicovideo.jp/",
        },
      });
      const text = await res.text();
      const limited = detectRateLimit(res.status, text);

      if (limited.limited || !res.ok) {
        this.limiter.penalise();
        this.onLog(`niconico: ${path} returned HTTP ${res.status}`);
        return null;
      }

      this.limiter.reward();
      return JSON.parse(text) as T;
    } catch (error) {
      this.limiter.penalise();
      this.onLog(`niconico: ${path} request failed: ${(error as Error).message}`);
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
      targets: "userId",
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
    /**
     * Niconico Live streams are fetched from the Content Search API v2 once per
     * run and cached in `liveUploads`. The endpoint is global — it returns
     * live programs matching a query, not per-channel — so the first call
     * fetches and subsequent calls return the cached list.
     *
     * `filters[liveStatus][0]=onair` returns streams live right now;
     * `reserved` would return scheduled upcoming streams.
     */
    if (this.liveUploads.length > 0) return this.liveUploads;

    const data = await this.getJson<{
      data?: NicoVideo[];
      meta?: { status: number };
    }>("search", {
      q: "",
      targets: "title,description,tags",
      fields: "contentId,title,viewCounter,commentCounter,startTime,liveStatus,user,nickName",
      "filters[liveStatus][0]": "onair",
      _sort: "-viewCounter",
      _limit: "100",
      _context: "vsinger-singer-tracker",
    });

    const list = data?.data ?? [];
    const uploads: PlatformUpload[] = [];

    for (const video of list) {
      if (!video.contentId || video.liveStatus !== "onair") continue;
      const user = (video as NicoVideo & { user?: string }).user;
      const classified = classifyItem({
        title: video.title ?? "",
        description: null,
        tags: video.tags ?? [],
        channelKind: "virtual",
        status: "live",
        isShort: false,
        durationSeconds: null,
        channelRegion: "jp",
      });
      uploads.push({
        platform: "niconico",
        id: video.contentId,
        channelId: user ?? "",
        title: video.title ?? "",
        description: null,
        thumbnail: `https://img1.ssl.nimg.jp/thumb/${video.contentId}`,
        publishedAt: video.startTime
          ? new Date(video.startTime * 1000).toISOString()
          : null,
        scheduledStart: null,
        duration: null,
        status: "live",
        category: "live",
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: video.viewCounter ?? null,
        url: `https://www.nicovideo.jp/watch/${video.contentId}`,
      } satisfies PlatformUpload);
    }

    this.liveUploads = uploads;
    this.onLog?.(`niconico: ${uploads.length} live stream(s) found`);
    return uploads;
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
    const discoveredUploads = list.flatMap((video) => {
      const author = (video as NicoVideo & { user?: string }).user;
      if (!author || !video.contentId) return [];
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
      return [{
        platform: "niconico" as const,
        id: video.contentId,
        channelId: author,
        title: video.title ?? "",
        description: video.description ?? null,
        thumbnail: `https://img1.ssl.nimg.jp/thumb/${video.contentId}`,
        publishedAt: video.startTime
          ? new Date(video.startTime * 1000).toISOString()
          : null,
        scheduledStart: null,
        duration: null,
        status: "past" as const,
        category: classified.category,
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: video.viewCounter ?? null,
        url: `https://www.nicovideo.jp/watch/${video.contentId}`,
      } satisfies PlatformUpload];
    });
    this.discoveredUploads = [
      ...new Map(
        [...this.discoveredUploads, ...discoveredUploads].map((upload) => [
          upload.id,
          upload,
        ]),
      ).values(),
    ];

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
