/**
 * CI.ME Open API channel profile adapter.
 *
 * The public channel lookup requires application Client ID and Client Secret
 * credentials. It accepts known channel IDs; the API does not document a
 * public handle search or live-list endpoint, so this adapter only refreshes
 * profile details.
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

export class CiMeAdapter implements PlatformAdapter {
  readonly id: PlatformId = "ci.me";
  readonly label = "CI.ME";
  readonly color = "#7b34f3";

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly onLog: (message: string) => void;

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

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    void channel;
    return [];
  }

}
