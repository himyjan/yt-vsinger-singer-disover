/**
 * CI.ME Open API channel profile adapter.
 *
 * The public channel lookup requires application Client ID and Client Secret
 * credentials. It accepts known channel IDs; the API does not document a
 * public handle search, so this adapter only refreshes profile details.
 *
 * Live streaming is available through the unofficial `cime-sdk`, which wraps
 * CI.ME's official OpenAPI. `client.live.getLives()` is a public endpoint that
 * returns the current live stream list — fetched once per run and matched
 * against known CI.ME channel IDs, the same pattern Bilibili and Niconico use.
 *
 * API: https://developers.ci.me/docs/api-channels
 */

import { REQUEST_TIMEOUT_MS } from "../io";
import type { PlatformAdapter, PlatformChannel, PlatformUpload } from "../platforms";
import type { PlatformId } from "../types";

const API = "https://ci.me/api/openapi/open/v1/channels";

interface CiMeChannel {
  channelId?: string;
  channelName?: string;
  channelHandle?: string;
  channelImageUrl?: string | null;
  channelDescription?: string;
  followerCount?: number;
}

interface CiMeResponse {
  code?: number;
  content?: {
    data?: CiMeChannel[];
  };
}

export interface CiMeOptions {
  clientId?: string;
  clientSecret?: string;
  onLog?: (message: string) => void;
}

/** Live streams found by the last `live()` call — populated once per run. */
interface CiMeLive {
  channelId?: string;
  channelName?: string;
  channelHandle?: string;
  title?: string;
  viewerCount?: number;
  liveId?: string;
  thumbnailUrl?: string;
  startedAt?: string;
  categoryName?: string;
}

export class CiMeAdapter implements PlatformAdapter {
  readonly id: PlatformId = "ci.me";
  readonly label = "CI.ME";
  readonly color = "#7b34f3";

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly onLog: (message: string) => void;
  /** Live streams found by the last `live()` call — cached once per run. */
  liveUploads: PlatformUpload[] = [];

  constructor(options: CiMeOptions = {}) {
    this.clientId = options.clientId ?? process.env.CI_ME_CLIENT_ID ?? "";
    this.clientSecret =
      options.clientSecret ?? process.env.CI_ME_CLIENT_SECRET ?? "";
    this.onLog = options.onLog ?? (() => {});
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const channelId = query
      .trim()
      .replace(/^https?:\/\/(?:www\.)?ci\.me\/(?:channel\/)?/i, "")
      .split(/[/?#]/)[0]!;
    if (!channelId || !this.isConfigured()) return null;

    const url = new URL(API);
    url.searchParams.set("channelIds", channelId);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "Client-Id": this.clientId,
          "Client-Secret": this.clientSecret,
        },
      });
    } catch (error) {
      this.onLog(`ci.me: channel lookup failed: ${(error as Error).message}`);
      return null;
    }

    if (!response.ok) {
      this.onLog(`ci.me: channel lookup returned HTTP ${response.status}`);
      return null;
    }

    let payload: CiMeResponse;
    try {
      payload = (await response.json()) as CiMeResponse;
    } catch (error) {
      this.onLog(`ci.me: invalid channel response: ${(error as Error).message}`);
      return null;
    }

    if (payload.code !== 200) {
      this.onLog(`ci.me: channel lookup returned API code ${payload.code ?? "unknown"}`);
      return null;
    }

    const channel = payload.content?.data?.find(
      (entry) => entry.channelId === channelId,
    );
    if (!channel?.channelId) return null;

    const followers = channel.followerCount;
    return {
      platform: "ci.me",
      id: channel.channelId,
      handle: channel.channelHandle ?? null,
      name: channel.channelName ?? null,
      url: `https://ci.me/${encodeURIComponent(channel.channelHandle ?? channel.channelId)}`,
      subscribers:
        typeof followers === "number" && Number.isFinite(followers)
          ? { tag: "has", count: followers }
          : { tag: "hidden" },
      avatar: channel.channelImageUrl ?? null,
      description: channel.channelDescription ?? null,
      tags: [],
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    void channel;
    void limit;
    return [];
  }

  /**
   * CI.ME live streams are fetched from `client.live.getLives()` once per run
   * and cached in `liveUploads`. The endpoint is global — it returns live
   * programs platform-wide, not per-channel — so the first call fetches and
   * subsequent calls return the cached list.
   *
   * Requires `cime-sdk` (npm install cime-sdk) and CI_ME_CLIENT_ID /
   * CI_ME_CLIENT_SECRET environment variables.
   */
  async live(_channel: PlatformChannel): Promise<PlatformUpload[]> {
    if (this.liveUploads.length > 0) return this.liveUploads;

    if (!this.isConfigured()) {
      this.onLog("ci.me: live check unavailable — configure CI_ME_CLIENT_ID and CI_ME_CLIENT_SECRET");
      return [];
    }

    try {
      // Dynamic import so the SDK is only loaded when live checking runs.
      const { CimeClient } = await import("cime-sdk");
      const client = new CimeClient({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });

      const lives = await client.live.getLives({ size: 100 });
      const liveList: CiMeLive[] = lives.data ?? [];

      const uploads: PlatformUpload[] = [];
      for (const stream of liveList) {
        if (!stream.channelId) continue;

        const classified = this.classifyLiveItem(stream.title ?? "");

        uploads.push({
          platform: "ci.me",
          id: stream.liveId ?? stream.channelId,
          channelId: stream.channelId,
          title: stream.title ?? "",
          description: null,
          thumbnail: stream.thumbnailUrl ?? null,
          publishedAt: stream.startedAt ?? null,
          scheduledStart: null,
          duration: null,
          status: "live",
          category: "live",
          songTitle: classified.songTitle,
          originalArtist: classified.originalArtist,
          viewCount: stream.viewerCount ?? null,
          url: `https://ci.me/${stream.channelId}`,
        });
      }

      this.liveUploads = uploads;
      this.onLog?.(`ci.me: ${uploads.length} live stream(s) found`);
      return uploads;
    } catch (error) {
      this.onLog(`ci.me: live check failed: ${(error as Error).message}`);
      return [];
    }
  }

  private classifyLiveItem(title: string): {
    songTitle: string | null;
    originalArtist: string | null;
  } {
    // Minimal classification — CI.ME live titles rarely carry song metadata.
    return { songTitle: null, originalArtist: null };
  }
}
