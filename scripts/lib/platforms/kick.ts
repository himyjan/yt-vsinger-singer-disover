/**
 * KICK — the streaming platform.
 *
 * KICK has become a significant home for VTubers, and its public API needs
 * no credentials:
 *
 *   GET https://kick.com/api/v2/channels/{login}
 *
 * returns the channel's id, slug, follower count, the live stream and the
 * channel image.
 */

import { classifyItem } from "../classify";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import { REQUEST_TIMEOUT_MS } from "../io";

const API = "https://kick.com/api/v2";

export interface KickOptions {
  /** How many channels to pull per request. */
  limit?: number;
  onLog?: (message: string) => void;
}

export class KickAdapter implements PlatformAdapter {
  readonly id: PlatformId = "kick";
  readonly label = "KICK";
  readonly color = "#53fc18";

  private readonly limit: number;
  private readonly onLog: (message: string) => void;

  constructor(options: KickOptions = {}) {
    this.limit = options.limit ?? 30;
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
          Referer: "https://kick.com/",
        },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const login = query
      .trim()
      .replace(/^@+/, "")
      .replace(/^https?:\/\/kick\.com\//, "")
      .split(/[/?#]/)[0]!;
    if (!login) return null;

    const data = await this.getJson<any>(`${API}/channels/${login}`);
    if (!data?.slug) return null;

    const followers = Number(data.followers_count ?? 0);
    const subscribers: CountRef =
      followers > 0 ? { tag: "has", count: followers } : { tag: "no" };

    return {
      platform: "kick",
      id: String(data.user_id ?? data.id ?? data.slug),
      handle: data.slug,
      name: data.user?.username ?? data.slug,
      url: `https://kick.com/${data.slug}`,
      subscribers,
      avatar: data.user?.profile_image_url ?? data.profilepic ?? null,
      description: data.user?.bio ?? data.bio ?? null,
      tags: [],
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    // KICK has no public video list — only the live stream.
    return this.live(channel).then((list) => list.slice(0, limit));
  }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    if (!channel.handle) return [];
    const data = await this.getJson<any>(`${API}/channels/${channel.handle}`);
    const stream = data?.livestream;
    if (!stream) return [];

    const classified = classifyItem({
      title: stream.session_title ?? "",
      description: null,
      tags: [],
      channelKind: "virtual",
      status: "live",
      isShort: false,
      durationSeconds: null,
      channelRegion: "unknown",
    });

    return [
      {
        platform: "kick",
        id: String(stream.id),
        channelId: channel.id,
        title: stream.session_title ?? "",
        description: null,
        thumbnail: null,
        publishedAt: stream.start_time ?? null,
        scheduledStart: stream.start_time ?? null,
        duration: null,
        status: "live",
        category: "live",
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: stream.viewer_count ?? null,
        url: `https://kick.com/${channel.handle}`,
      },
    ];
  }

  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    // KICK has no public user search, so the search is a no-op; the roster
    // and the account linking are what populate the platform.
    void query;
    void limit;
    return [];
  }
}
