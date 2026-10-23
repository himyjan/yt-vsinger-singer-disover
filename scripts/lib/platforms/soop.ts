/**
 * SOOP's public live-broadcast list. It can surface channels only while they
 * appear in the paginated global live feed; SOOP does not expose a verified
 * public channel-profile endpoint for offline lookups.
 */

import { classifyItem } from "../classify";
import { REQUEST_TIMEOUT_MS } from "../io";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import type { PlatformId } from "../types";

const LIVE_API = "https://live.sooplive.co.kr/api/main_broad_list_api.php";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface SoopBroadcast {
  user_id?: string;
  user_nick?: string;
  broad_no?: string | number;
  broad_title?: string;
  current_view_cnt?: string | number;
  broad_start?: string;
  is_password?: string | number;
}

interface SoopLiveResponse {
  broad?: SoopBroadcast[];
}

export interface SoopOptions {
  onLog?: (message: string) => void;
}

export class SoopAdapter implements PlatformAdapter {
  readonly id: PlatformId = "soop";
  readonly label = "SOOP";
  readonly color = "#ff6a00";

  private readonly onLog: (message: string) => void;
  liveUploads: PlatformUpload[] = [];
  private cachedBroadcasts: SoopBroadcast[] | null = null;
  private cacheExpiresAt = 0;

  constructor(options: SoopOptions = {}) {
    this.onLog = options.onLog ?? (() => {});
  }

  isConfigured(): boolean {
    return true;
  }

  private async livePage(page: number): Promise<SoopBroadcast[]> {
    if (this.cachedBroadcasts && Date.now() < this.cacheExpiresAt) {
      return this.cachedBroadcasts;
    }
    const url = new URL(LIVE_API);
    url.search = new URLSearchParams({
      selectType: "action",
      selectValue: "all",
      orderType: "view_cnt",
      pageNo: String(page),
      lang: "ko_KR",
    }).toString();

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          Referer: "https://www.sooplive.com/",
        },
      });
      if (!response.ok) {
        this.onLog(`soop: live list returned HTTP ${response.status}`);
        this.cacheFailure();
        return [];
      }
      const payload = (await response.json()) as SoopLiveResponse;
      if (!Array.isArray(payload.broad)) {
        this.onLog("soop: live list response did not contain broadcasts");
        this.cacheFailure();
        return [];
      }
      this.cachedBroadcasts = payload.broad;
      this.cacheExpiresAt = Date.now() + 60_000;
      return payload.broad;
    } catch (error) {
      this.onLog(`soop: live list failed: ${(error as Error).message}`);
      this.cacheFailure();
      return [];
    }
  }

  private cacheFailure(): void {
    this.cachedBroadcasts = [];
    this.cacheExpiresAt = Date.now() + 30_000;
  }

  private channelFromBroadcast(
    broadcast: SoopBroadcast,
  ): PlatformChannel | null {
    const id = broadcast.user_id?.trim();
    if (!id) return null;
    return {
      platform: "soop",
      id,
      handle: id,
      name: broadcast.user_nick?.trim() || null,
      url: `https://www.sooplive.com/station/${encodeURIComponent(id)}`,
      subscribers: { tag: "hidden" },
      avatar: null,
      description: null,
      tags: [],
    };
  }

  private uploadFromBroadcast(
    broadcast: SoopBroadcast,
  ): PlatformUpload | null {
    if (["1", "y", "yes", "true"].includes(
      String(broadcast.is_password ?? "").toLowerCase(),
    )) {
      return null;
    }
    const channel = this.channelFromBroadcast(broadcast);
    const broadNo = String(broadcast.broad_no ?? "").trim();
    if (!channel || !broadNo) return null;

    const title = broadcast.broad_title?.trim() ?? "";
    const classified = classifyItem({
      title,
      description: null,
      tags: [],
      channelKind: "virtual",
      status: "live",
      isShort: false,
      durationSeconds: null,
      channelRegion: "unknown",
    });
    const viewers = Number(broadcast.current_view_cnt);
    const startedAt = parseSoopDate(broadcast.broad_start);

    return {
      platform: "soop",
      id: `${channel.id}:${broadNo}`,
      channelId: channel.id,
      title,
      description: null,
      thumbnail: null,
      publishedAt: startedAt,
      scheduledStart: startedAt,
      duration: null,
      status: "live",
      category: "live",
      songTitle: classified.songTitle,
      originalArtist: classified.originalArtist,
      viewCount: Number.isFinite(viewers) ? viewers : null,
      url: `https://play.sooplive.com/${encodeURIComponent(channel.id)}/${encodeURIComponent(broadNo)}`,
      region: "unknown",
    };
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const userId = query
      .trim()
      .replace(/^https?:\/\/(?:www\.)?sooplive\.com\/station\//i, "")
      .replace(/^https?:\/\/(?:www\.)?ch\.sooplive\.co\.kr\//i, "")
      .split(/[/?#]/)[0]!;
    if (!userId) return null;

    const broadcasts = await this.livePage(1);
    for (const broadcast of broadcasts) {
      if (broadcast.user_id?.toLowerCase() !== userId.toLowerCase()) continue;
      return this.channelFromBroadcast(broadcast);
    }
    return null;
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    return (await this.live(channel)).slice(0, limit);
  }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> {
    if (!channel.id) return [];
    const broadcasts = await this.livePage(1);
    const uploads = broadcasts
      .filter((broadcast) => broadcast.user_id === channel.id)
      .map((broadcast) => this.uploadFromBroadcast(broadcast))
      .filter((upload): upload is PlatformUpload => upload !== null);
    return uploads;
  }

  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || limit <= 0) return [];

    const broadcasts = await this.livePage(1);
    const matches = broadcasts
      .filter((broadcast) =>
        `${broadcast.user_id ?? ""} ${broadcast.user_nick ?? ""} ${broadcast.broad_title ?? ""}`
          .toLocaleLowerCase()
          .includes(needle),
      )
      .slice(0, limit);
    const uploads = matches
      .map((broadcast) => this.uploadFromBroadcast(broadcast))
      .filter((upload): upload is PlatformUpload => upload !== null);
    this.liveUploads = [
      ...new Map(
        [...this.liveUploads, ...uploads].map((upload) => [upload.id, upload]),
      ).values(),
    ];

    return matches
      .map((broadcast) => this.channelFromBroadcast(broadcast))
      .filter((channel): channel is PlatformChannel => channel !== null)
      .slice(0, limit);
  }
}

function parseSoopDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(`${value.replace(" ", "T")}+09:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
