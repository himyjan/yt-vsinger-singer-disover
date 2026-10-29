/**
 * CI.ME Open API channel profile adapter.
 *
 * CI.ME (씨미) is a Korean streaming platform, and its Open API publishes a
 * channel's profile: the name, the handle, the image, the bio and the
 * follower count.
 *
 *   GET https://ci.me/api/openapi/open/v1/channels?channelIds=12345,67890
 *
 * The channel lookup takes **channel ids** — there is no handle search — and
 * answers at most 20 ids per request, which is why the adapter also offers
 * `resolveMany()`: the details pass hands it a batch and spends one request
 * instead of twenty. It requires an application Client ID and Client Secret.
 *
 * Live status is a **separate, public** endpoint, so checking a stream costs
 * no credentials at all:
 *
 *   GET https://ci.me/api/openapi/v1/{channelId}/live-status
 *
 * API: https://developers.ci.me/docs/api-channels
 */

import { classifyItem } from "../classify";
import { REQUEST_TIMEOUT_MS } from "../io";
import type { PlatformAdapter, PlatformChannel, PlatformUpload } from "../platforms";
import type { PlatformId } from "../types";

const API = "https://ci.me/api/openapi/open/v1/channels";
const LIVE_STATUS = "https://ci.me/api/openapi/v1";

/** The most ids one channel lookup accepts. */
const MAX_IDS_PER_REQUEST = 20;

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
  message?: string;
  content?: {
    data?: CiMeChannel[];
  };
}

/** The public live-status answer — no credentials are sent. */
interface CiMeLiveStatus {
  code?: number;
  content?: {
    isLive?: boolean;
    title?: string | null;
    openedAt?: string | null;
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

  /**
   * CI.ME publishes the follower count but no upload total, so a record on it
   * never has a video count to fill.
   */
  readonly reportsVideoCount = false;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly onLog: (message: string) => void;
  /** Live status by channel id, so one run asks each channel once. */
  private readonly liveStatus = new Map<string, PlatformUpload[]>();

  constructor(options: CiMeOptions = {}) {
    this.clientId = options.clientId ?? process.env.CI_ME_CLIENT_ID ?? "";
    this.clientSecret =
      options.clientSecret ?? process.env.CI_ME_CLIENT_SECRET ?? "";
    this.onLog = options.onLog ?? (() => {});
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** The channel id a handle or a profile URL refers to. */
  private channelIdOf(query: string): string {
    return query
      .trim()
      .replace(/^https?:\/\/(?:www\.)?ci\.me\/(?:channel\/)?/i, "")
      .replace(/^@+/, "")
      .split(/[/?#]/)[0]!;
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const channelId = this.channelIdOf(query);
    if (!channelId || !this.isConfigured()) return null;
    const found = await this.resolveMany([query]);
    return found.get(query) ?? null;
  }

  /**
   * Resolves a batch of channel ids in one request.
   *
   * The endpoint takes `channelIds` as a comma-separated list of at most 20,
   * so the caller's batch is chunked here. The result is keyed by **what was
   * asked**, and an id the platform does not know maps to `null` — so the
   * caller can tell "asked and absent" from "not asked", and never asks a
   * second time.
   */
  async resolveMany(
    queries: string[],
  ): Promise<Map<string, PlatformChannel | null>> {
    const result = new Map<string, PlatformChannel | null>();
    if (!this.isConfigured()) return result;

    /** The answers by channel id, for the queries that asked for them. */
    const answers = new Map<string, PlatformChannel>();
    const asked = [...new Set(queries.map((query) => this.channelIdOf(query)))]
      .filter(Boolean);
    /**
     * The ids the API actually answered for.
     *
     * A request that failed says nothing about whether a channel exists, so
     * only a **successful** answer may mark an id as absent — otherwise a
     * timeout would be remembered as "this channel is gone".
     */
    const answered = new Set<string>();

    for (let i = 0; i < asked.length; i += MAX_IDS_PER_REQUEST) {
      const chunk = asked.slice(i, i + MAX_IDS_PER_REQUEST);
      const url = new URL(API);
      url.searchParams.set("channelIds", chunk.join(","));

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
        continue;
      }

      if (!response.ok) {
        this.onLog(`ci.me: channel lookup returned HTTP ${response.status}`);
        continue;
      }

      let payload: CiMeResponse;
      try {
        payload = (await response.json()) as CiMeResponse;
      } catch (error) {
        this.onLog(`ci.me: invalid channel response: ${(error as Error).message}`);
        continue;
      }

      if (payload.code !== 200) {
        this.onLog(
          `ci.me: channel lookup returned API code ${payload.code ?? "unknown"}`,
        );
        continue;
      }

      for (const channel of payload.content?.data ?? []) {
        if (!channel.channelId) continue;
        answers.set(
          this.channelIdOf(String(channel.channelId)),
          this.toPlatformChannel(channel),
        );
      }
      for (const id of chunk) answered.add(id);
    }

    for (const query of queries) {
      const id = this.channelIdOf(query);
      const answer = answers.get(id);
      if (answer) result.set(query, answer);
      else if (answered.has(id)) result.set(query, null);
    }
    return result;
  }

  private toPlatformChannel(channel: CiMeChannel): PlatformChannel {
    const followers = channel.followerCount;
    const handle = (channel.channelHandle ?? "").trim().replace(/^@+/, "");
    const id = String(channel.channelId);
    return {
      platform: "ci.me",
      id,
      handle: handle || null,
      name: channel.channelName ?? null,
      // Profiles live at `ci.me/@handle`; the id form is the fallback for a
      // channel that has not chosen one.
      url: handle
        ? `https://ci.me/@${encodeURIComponent(handle)}`
        : `https://ci.me/${encodeURIComponent(id)}`,
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
   * The channel's live stream, from the **public** live-status endpoint.
   *
   * `GET /api/openapi/v1/{channelId}/live-status` needs no application
   * credentials, so CI.ME live checking works in a run that has none — unlike
   * the platform-wide live list, which is behind the client ID. It is also
   * per channel, which is what the adapter interface promises: the previous
   * implementation cached the platform-wide list and answered every channel
   * with all of it, so every CI.ME channel looked live whenever anyone was.
   */
  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    const channelId = this.channelIdOf(channel.id || channel.handle || "");
    if (!channelId) return [];
    const cached = this.liveStatus.get(channelId);
    if (cached) return cached;

    let payload: CiMeLiveStatus | null = null;
    try {
      const response = await fetch(
        `${LIVE_STATUS}/${encodeURIComponent(channelId)}/live-status`,
        {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        if (response.status !== 404) {
          this.onLog(`ci.me: live status returned HTTP ${response.status}`);
        }
        this.liveStatus.set(channelId, []);
        return [];
      }
      payload = (await response.json()) as CiMeLiveStatus;
    } catch (error) {
      this.onLog(`ci.me: live status failed: ${(error as Error).message}`);
      this.liveStatus.set(channelId, []);
      return [];
    }

    const status = payload?.content;
    if (!status?.isLive || !status.title) {
      this.liveStatus.set(channelId, []);
      return [];
    }

    const openedAt = status.openedAt ?? null;
    const classified = classifyItem({
      title: status.title,
      description: null,
      tags: [],
      channelKind: "virtual",
      status: "live",
      isShort: false,
      durationSeconds: null,
      channelRegion: "unknown",
    });

    const uploads: PlatformUpload[] = [
      {
        platform: "ci.me",
        // The channel id and the opening time identify **this** stream: the
        // live-status endpoint publishes no stream id.
        id: `ci.me:${channelId}:${openedAt ?? "live"}`,
        channelId,
        title: status.title,
        description: null,
        thumbnail: null,
        publishedAt: openedAt,
        scheduledStart: openedAt,
        duration: null,
        status: "live",
        category: "live",
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: null,
        url: channel.url || `https://ci.me/${channelId}`,
      },
    ];

    this.liveStatus.set(channelId, uploads);
    return uploads;
  }
}
