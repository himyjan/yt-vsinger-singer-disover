/**
 * CHZZK — Naver's streaming platform, and the biggest Korean VTuber scene.
 *
 * The public API needs no credentials:
 *
 *   GET https://api.chzzk.naver.com/service/v1/channels/{channelId}
 *
 * returns the channel's name, image, description, follower count and whether
 * it is live. A channel id is the slug in the URL — `chzzk.naver.com/abc123`.
 */

import { classifyItem } from "../classify";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import { REQUEST_TIMEOUT_MS } from "../io";

const API = "https://api.chzzk.naver.com/service/v1";
const LIVE_API = "https://api.chzzk.naver.com/service/v3/channels";

export interface ChzzkOptions {
  onLog?: (message: string) => void;
}

export class ChzzkAdapter implements PlatformAdapter {
  readonly id: PlatformId = "chzzk";
  readonly label = "CHZZK";
  readonly color = "#03c75a";

  private readonly onLog: (message: string) => void;

  constructor(options: ChzzkOptions = {}) {
    this.onLog = options.onLog ?? (() => {});
  }

  isConfigured(): boolean {
    return true;
  }

  private async getJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://chzzk.naver.com/",
        },
      });
      if (!res.ok) {
        this.onLog(`chzzk: request returned HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (error) {
      this.onLog(`chzzk: request failed: ${(error as Error).message}`);
      return null;
    }
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const channelId = query
      .trim()
      .replace(/^https?:\/\/chzzk\.naver\.com\//, "")
      .split(/[/?#]/)[0]!;
    if (!channelId) return null;

    const res = await this.getJson<{ code: number; content?: any }>(
      `${API}/channels/${channelId}`,
    );
    const content = res?.content;
    if (!content || res?.code !== 200) return null;
    // CHZZK answers 200 with an empty channel for an unknown id.
    if (!content.channelId && !content.channelName) return null;

    const followers = Number(content.followerCount ?? 0);
    const subscribers: CountRef =
      followers > 0 ? { tag: "has", count: followers } : { tag: "no" };

    return {
      platform: "chzzk",
      id: content.channelId ?? channelId,
      handle: channelId,
      name: content.channelName ?? null,
      url: `https://chzzk.naver.com/${channelId}`,
      subscribers,
      avatar: content.channelImageUrl ?? null,
      description: content.channelDescription ?? null,
      tags: [],
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    // CHZZK publishes no public video list.
    void limit;
    return this.live(channel);
  }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    if (!channel.handle) return [];

    const res = await this.getJson<{ code: number; content?: any }>(
      `${LIVE_API}/${channel.handle}/live-detail`,
    );
    const live = res?.content?.live;
    if (!live) return [];

    const classified = classifyItem({
      title: live.title ?? "",
      description: live.admissionDescription ?? null,
      tags: [],
      channelKind: "virtual",
      status: "live",
      isShort: false,
      durationSeconds: null,
      channelRegion: "kr",
    });

    return [
      {
        platform: "chzzk",
        id: String(live.liveId ?? live.liveKey ?? live.id ?? channel.id),
        channelId: channel.id,
        title: live.title ?? "",
        description: live.admissionDescription ?? null,
        thumbnail:
          live.liveImageUrl ??
          live.defaultThumbnailImageUrl ??
          live.thumbnailImageUrl ??
          null,
        publishedAt: live.openDate ?? null,
        scheduledStart: live.openDate ?? null,
        duration: null,
        status: "live",
        category: "live",
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: live.concurrentUserCount ?? null,
        url: `https://chzzk.naver.com/${channel.handle}`,
      },
    ];
  }

  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    if (!query.trim() || limit <= 0) return [];
    const size = Math.min(limit, 20);
    const url = new URL(`${API}/search/channels`);
    url.search = new URLSearchParams({
      keyword: query,
      offset: "0",
      size: String(size),
    }).toString();
    const response = await this.getJson<{
      code: number;
      content?: { data?: Array<{ channel?: any }> };
    }>(url.toString());
    if (response?.code !== 200) return [];

    return (response.content?.data ?? [])
      .map((entry) => entry.channel)
      .filter((channel) => channel?.channelId)
      .slice(0, limit)
      .map((channel) => {
        const followers = Number(channel.followerCount ?? 0);
        return {
          platform: "chzzk",
          id: channel.channelId,
          handle: channel.channelId,
          name: channel.channelName ?? null,
          url: `https://chzzk.naver.com/${channel.channelId}`,
          subscribers:
            followers > 0
              ? { tag: "has" as const, count: followers }
              : { tag: "no" as const },
          avatar: channel.channelImageUrl ?? null,
          description: channel.channelDescription ?? null,
          tags: [],
        };
      });
  }
}
