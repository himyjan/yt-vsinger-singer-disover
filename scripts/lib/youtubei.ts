/**
 * InnerTube (youtubei.js) — the quota-free source.
 *
 * The YouTube Data API v3 costs 1 unit per channel and 1 per 50 videos, and
 * the free tier is 10,000 units a day. For a catalogue of fourteen thousand
 * channels that is roughly three days of API calls, and the descriptions and
 * avatars alone would cost more than a month.
 *
 * The InnerTube client talks to the same endpoints the website uses, so it
 * costs **no quota at all**. It can fetch:
 *
 *   • the channel's **description** — which is where a performer states their
 *     own language, their agency and their links;
 *   • the channel's **avatar** and **subscriber count**;
 *   · the channel's **upload list**, with ids and titles;
 *   • the **live** and **upcoming** streams.
 *
 * The trade-off is stability: InnerTube is an unofficial client and breaks
 * when YouTube changes its responses. So the pipeline uses it as the
 * *primary* source for the cheap metadata and the uploads, and keeps the Data
 * API for the things it does uniquely well — the quota-guaranteed channel
 * statistics and the live-broadcast schedule.
 *
 * With **no API key at all** the pipeline still produces a complete dataset.
 */

import { Innertube } from "youtubei.js";
import { RateLimiter } from "./rate-limit";
import { REQUEST_TIMEOUT_MS } from "./io";

export interface InnerTubeProfile {
  /** The channel id. */
  id: string;
  /** The display name. */
  title: string | null;
  /** The channel description — the richest field in the whole project. */
  description: string | null;
  /** The avatar URL. */
  avatar: string | null;
  /** The subscriber count, when the channel publishes it. */
  subscribers: number | null;
  /** The channel's custom URL handle, when it has one. */
  handle: string | null;
  /** The links the channel publishes. */
  links: string[];
}

export interface InnerTubeUpload {
  /** The video id. */
  id: string;
  /** The title. */
  title: string;
  /** The thumbnail URL. */
  thumbnail: string | null;
  /** The published time, when the listing has it. */
  published: string | null;
  /** The view count, when the listing has it. */
  views: number | null;
}

export interface InnerTubeOptions {
  /** Turn the client off entirely. */
  enabled?: boolean;
  /** Pause between requests, in milliseconds — InnerTube rate-limits. */
  delayMs?: number;
  onLog?: (message: string) => void;
}

/**
 * Abandons a promise that takes too long.
 *
 * InnerTube's client has no timeout of its own, so a request that never
 * answers would hang the run forever. The promise is abandoned instead, and
 * the caller treats the result as "no data".
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export class InnerTubeSource {
  private client: any = null;
  private readonly delayMs: number;
  private readonly enabled: boolean;
  private readonly onLog: (message: string) => void;
  /** The adaptive limiter — it widens when InnerTube pushes back. */
  private readonly limiter: RateLimiter;

  constructor(options: InnerTubeOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.delayMs = options.delayMs ?? 350;
    this.onLog = options.onLog ?? (() => {});
    this.limiter = new RateLimiter({
      minIntervalMs: this.delayMs,
      maxIntervalMs: 15_000,
      onLimit: (m) => this.onLog(`innertube: ${m}`),
      onChange: (ms) => this.onLog(`innertube: interval → ${Math.round(ms)}ms`),
    });
  }

  /** True when the client is available. */
  get isAvailable(): boolean {
    return this.enabled && this.client !== null;
  }

  /**
   * Creates the client. A failure is not fatal — the pipeline falls back to
   * the Data API.
   */
  async connect(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.client) return true;
    try {
      this.client = await Innertube.create();
      this.onLog("innertube: client ready (no API quota)");
      return true;
    } catch (err) {
      this.onLog(`innertube: unavailable — ${(err as Error).message}`);
      this.client = null;
      return false;
    }
  }

  /** Waits between requests so InnerTube does not rate-limit us. */
  private async throttle(): Promise<void> {
    if (this.limiter.isTripped()) return;
    await this.limiter.wait();
  }

  /**
   * The channel's profile: description, avatar, subscriber count and links.
   */
  async profile(channelId: string): Promise<InnerTubeProfile | null> {
    if (!this.client) return null;
    try {
      await this.throttle();
      const channel: any = await withTimeout(
        this.client.getChannel(channelId),
        REQUEST_TIMEOUT_MS,
      );
      if (!channel) return null;
      const meta = channel?.metadata ?? {};

      const avatar =
        channel?.avatar?.url ??
        (Array.isArray(meta.avatar) ? meta.avatar[0]?.url : null) ??
        null;

      // The subscriber count is a number on some channel types and a
      // `{text, content}` pair on others.
      const rawSubscribers =
        meta.subscriberCount ?? meta.subscriber_count ?? null;
      const subscribers = (() => {
        if (typeof rawSubscribers === "number") return rawSubscribers;
        if (rawSubscribers && typeof rawSubscribers === "object") {
          const text = String(rawSubscribers.text ?? "").replace(/[^\d]/g, "");
          const n = Number(text);
          return Number.isFinite(n) && n > 0 ? n : null;
        }
        return null;
      })();

      const links: string[] = [];
      const rawLinks = meta.links ?? channel?.links ?? [];
      for (const link of rawLinks) {
        const url = typeof link === "string" ? link : (link?.url ?? link?.href);
        if (url) links.push(url);
      }

      this.limiter.reward();
      return {
        id: channelId,
        title: meta.title ?? null,
        description: meta.description ?? null,
        avatar: avatar ?? null,
        subscribers,
        handle: meta.canonicalBaseUrl ?? null,
        links,
      };
    } catch (err) {
      this.limiter.penalise();
      this.onLog(
        `innertube: profile failed for ${channelId} — ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The channel's uploads.
   *
   * The grid view carries the id, the title and the thumbnail; the published
   * date and the view count are not in it, and the pipeline leaves those to
   * the Data API when there is one.
   */
  async uploads(
    channelId: string,
    limit = 30,
  ): Promise<InnerTubeUpload[]> {
    if (!this.client) return [];
    try {
      await this.throttle();
      const channel: any = await withTimeout(
        this.client.getChannel(channelId),
        REQUEST_TIMEOUT_MS,
      );
      if (!channel) return [];
      const grid: any = await withTimeout(
        channel.getVideos(),
        REQUEST_TIMEOUT_MS,
      );
      if (!grid) return [];
      const list: any[] = grid?.videos ?? [];

      const out: InnerTubeUpload[] = [];
      for (const item of list.slice(0, limit)) {
        const id = item?.content_id ?? item?.id;
        if (!id) continue;
        const title =
          item?.metadata?.title?.text ?? item?.title?.text ?? "";
        const thumbnail =
          item?.content_image?.image?.[0]?.url ??
          item?.thumbnails?.[0]?.url ??
          null;
        out.push({
          id,
          title,
          thumbnail: thumbnail ? thumbnail.split("?")[0]! : null,
          published: null,
          views: null,
        });
      }
      this.limiter.reward();
      return out;
    } catch (err) {
      // A channel with no videos tab, or one that is only Shorts, is normal.
      this.limiter.penalise();
      const message = (err as Error).message;
      if (!/Tab .* not found/.test(message)) {
        this.onLog(
          `innertube: uploads failed for ${channelId} — ${message}`,
        );
      }
      return [];
    }
  }

  /**
   * The channel's live and upcoming streams.
   */
  async liveStreams(channelId: string): Promise<InnerTubeUpload[]> {
    if (!this.client) return [];
    try {
      await this.throttle();
      const channel: any = await withTimeout(
        this.client.getChannel(channelId),
        REQUEST_TIMEOUT_MS,
      );
      if (!channel) return [];
      const grid: any = await withTimeout(
        channel.getLiveStreams(),
        REQUEST_TIMEOUT_MS,
      );
      if (!grid) return [];
      const list: any[] = grid?.videos ?? grid?.items ?? [];

      const out: InnerTubeUpload[] = [];
      for (const item of list.slice(0, 30)) {
        const id = item?.content_id ?? item?.id;
        if (!id) continue;
        out.push({
          id,
          title: item?.metadata?.title?.text ?? item?.title?.text ?? "",
          thumbnail:
            item?.content_image?.image?.[0]?.url?.split("?")[0] ?? null,
          published: null,
          views: null,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}
