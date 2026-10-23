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
import { normalizeCountry } from "./regions";

export interface InnerTubeProfile {
  /**
   * The channel's `UC…` id.
   *
   * Not the id that was asked for: a channel asked for by handle answers with
   * its real one, and that is the only part of a YouTube identity that cannot
   * change — a handle is unique but renameable, so a record has to be keyed
   * by this.
   */
  id: string;
  /** The display name. */
  title: string | null;
  /** The channel description — the richest field in the whole project. */
  description: string | null;
  /** The avatar URL. */
  avatar: string | null;
  /** The subscriber count, when the channel publishes it. */
  subscribers: number | null;
  /** Lifetime channel views, when exposed in channel metadata. */
  views?: number | null;
  /** Number of channel uploads, when exposed in channel metadata. */
  videos?: number | null;
  /** The channel's custom URL handle, when it has one. */
  handle: string | null;
  /** The links the channel publishes. */
  links: string[];
  /**
   * True when YouTube shows the 🎵 **Official Artist Channel** badge.
   *
   * The badge is `AUDIO_BADGE` / `BADGE_STYLE_TYPE_VERIFIED_ARTIST` in the
   * channel page data, and it is the only reliable way to tell an OAC: the
   * Data API does not expose it. It says the artist's releases are managed
   * through YouTube Music — an album/single catalogue rather than uploads.
   */
  officialArtist: boolean;
  /**
   * The country the channel publishes, as an ISO code.
   *
   * Read from the about page, which is the only place YouTube states it. It
   * is the one region fact a **mirror** cannot corrupt: a Japanese channel
   * with a Bilibili account still says `JP` here.
   */
  country: string | null;
}

/** Options for one profile fetch. */
export interface InnerTubeProfileOptions {
  /**
   * The language to ask YouTube in.
   *
   * A channel publishes a **localized** title and description per language,
   * and the default (`en`) is the wrong one for most of this dataset: a
   * Japanese channel shows its English alias — `Aoi / Vtuber` — while the
   * Japanese name is 「向葵 / あおい」. Asking in `ja` returns the name the
   * performer actually uses.
   */
  lang?: string;
  /**
   * Whether to read the about page for the country.
   *
   * It costs one extra request, so it is opt-in: only the details pass needs
   * it.
   */
  about?: boolean;
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
 * True when the failure is about the channel, not about the request rate.
 *
 * A deleted or private channel is a fact about the channel, not a signal
 * about the request rate. Penalising the limiter for it makes the whole run
 * crawl for no reason — a catalogue of 14,000 channels has hundreds of dead
 * ones in it, and a malformed id is the client's fault, not the server's.
 *
 * The message comes back in the **session's language**, so a `ja` client
 * says 「このチャンネルは存在しません」 where an `en` one says "This channel
 * does not exist" — and a Japanese channel is fetched in Japanese.
 */
function isNotRateLimited(message: string): boolean {
  return /does not exist|not found|404|removed|terminated|status code 400|存在しません|削除されました|停止しました|利用できません|不存在|已被删除|已删除|不存在该用户|존재하지 않습니다|삭제되었습니다/i.test(
    message,
  );
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

/**
 * Detects the 🎵 Official Artist Channel badge in a parsed channel header.
 *
 * YouTube renders the badge as an image named `AUDIO_BADGE` and tags the
 * owner with `is_verified_artist` / `BADGE_STYLE_TYPE_VERIFIED_ARTIST`
 * depending on the endpoint, so all three spellings are checked. The header
 * is already fetched for the profile, so this costs no request.
 */
export function hasAudioBadge(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 12) return false;
  const record = value as Record<string, unknown>;
  if (record.imageName === "AUDIO_BADGE") return true;
  if (record.is_verified_artist === true) return true;
  if (record.style === "BADGE_STYLE_TYPE_VERIFIED_ARTIST") return true;

  /**
   * `youtubei.js` parser classes expose much of their parsed data through
   * getters rather than enumerable own properties, so `Object.values()` does
   * not walk the whole header. Serialising once is the reliable walk: the
   * header is small, and the marker is unambiguous.
   */
  if (depth === 0) {
    try {
      const json = JSON.stringify(value);
      if (
        json.includes('"imageName":"AUDIO_BADGE"') ||
        json.includes('"style":"BADGE_STYLE_TYPE_VERIFIED_ARTIST"') ||
        json.includes('"is_verified_artist":true')
      ) {
        return true;
      }
    } catch {
      /* circular or otherwise unserialisable — fall back to enumeration */
    }
  }

  for (const child of Object.values(record)) {
    if (hasAudioBadge(child, depth + 1)) return true;
  }
  return false;
}

export class InnerTubeSource {
  private client: any = null;
  private readonly delayMs: number;
  private readonly enabled: boolean;
  private readonly onLog: (message: string) => void;
  /** The adaptive limiter — it widens when InnerTube pushes back. */
  private readonly limiter: RateLimiter;
  /** Resolved `@handle` → channel id. */
  private readonly handleCache = new Map<string, string | null>();
  /**
   * One client per language.
   *
   * InnerTube keeps the language in its session, so a localized title needs
   * a client created with that language. The clients are cheap to hold and
   * expensive to build, so each language is built once.
   */
  private readonly clientsByLang = new Map<string, any>();

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
   * Resolves a `@handle` to the channel id behind it.
   *
   * The dataset stores a handle-only channel as `youtube:user-<handle>`,
   * because that is all some sources publish. InnerTube's `getChannel`
   * takes a channel id and nothing else, so the handle has to be resolved
   * first — through the same `navigation/resolve_url` endpoint the website
   * uses when you paste a channel URL into the address bar.
   *
   * The answers are cached, because a catalogue has the same handle in it
   * more than once.
   */
  async resolveHandle(handle: string): Promise<string | null> {
    const key = handle.replace(/^@/, "").trim();
    if (!key) return null;
    const cached = this.handleCache.get(key.toLowerCase());
    if (cached !== undefined) return cached;

    if (!this.client) return null;
    try {
      await this.throttle();
      const endpoint: any = await withTimeout(
        this.client.resolveURL(`https://www.youtube.com/@${key}`),
        REQUEST_TIMEOUT_MS,
      );
      const id: string | null =
        endpoint?.browseId ?? endpoint?.payload?.browseId ?? null;
      this.handleCache.set(key.toLowerCase(), id);
      if (id) this.limiter.reward();
      else this.onLog(`innertube: no channel for @${key}`);
      return id;
    } catch (err) {
      const message = (err as Error).message;
      if (!isNotRateLimited(message)) this.limiter.penalise();
      this.handleCache.set(key.toLowerCase(), null);
      this.onLog(`innertube: @${key} did not resolve — ${message}`);
      return null;
    }
  }

  /**
   * The client for a language.
   *
   * `en` is the default client; every other language gets its own, built on
   * first use. A failure falls back to English rather than failing the run.
   */
  private async clientFor(lang: string): Promise<any> {
    if (!lang || lang === "en") return this.client;
    const cached = this.clientsByLang.get(lang);
    if (cached) return cached;
    try {
      const client = await Innertube.create({ lang } as any);
      this.clientsByLang.set(lang, client);
      return client;
    } catch (err) {
      this.onLog(
        `innertube: no ${lang} client — ${(err as Error).message}`,
      );
      return this.client;
    }
  }

  /**
   * The channel's profile: description, avatar, subscriber count and links.
   *
   * `options.lang` asks YouTube for a **localization**: a channel publishes
   * a title and a description per language, and the English one is often an
   * alias — 「向葵 / あおい」 is the Japanese name of the channel whose English
   * title is `Aoi / Vtuber`. `options.about` adds the country from the about
   * page, at the cost of one extra request.
   */
  async profile(
    channelId: string,
    options: InnerTubeProfileOptions = {},
  ): Promise<InnerTubeProfile | null> {
    if (!this.client) return null;
    const client = await this.clientFor(options.lang ?? "en");
    try {
      await this.throttle();
      const channel: any = await withTimeout(
        client.getChannel(channelId),
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
      const countValue = (value: unknown): number | null => {
        const raw =
          typeof value === "object" && value !== null
            ? String(
                (value as { content?: unknown; text?: unknown }).content ??
                  (value as { text?: unknown }).text ??
                  "",
              )
            : String(value ?? "");
        const parsed = Number(raw.replace(/[^\d]/g, ""));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      };

      const links: string[] = [];
      const rawLinks = meta.links ?? channel?.links ?? [];
      for (const link of rawLinks) {
        const url = typeof link === "string" ? link : (link?.url ?? link?.href);
        if (url) links.push(url);
      }

      /**
       * The country, from the about page.
       *
       * It is the one region fact a **mirror** cannot corrupt: a Japanese
       * channel that also posts on Bilibili still says 「日本」 here. The
       * label is in the session's language, so it is normalized to an ISO
       * code; an unreadable about page is not a reason to fail the profile.
       */
      let country: string | null = null;
      if (options.about) {
        try {
          await this.throttle();
          const about: any = await withTimeout(
            channel.getAbout(),
            REQUEST_TIMEOUT_MS,
          );
          const label =
            about?.metadata?.country ?? about?.country ?? null;
          country = normalizeCountry(
            typeof label === "string" ? label : (label?.text ?? null),
          );
        } catch {
          /* the country is optional */
        }
      }

      this.limiter.reward();
      /**
       * The header of a channel response carries the canonical identity in
       * its current tab: `browseId` is the `UC…` id and `canonicalBaseUrl`
       * the `/@handle`. `youtubei.js` exposes neither as `channel.id`.
       */
      const endpoint = channel?.current_tab?.endpoint?.payload ?? {};
      const canonical: string | null =
        endpoint.browseId ?? channel?.id ?? meta?.channelId ?? null;
      const vanity: string | null = endpoint.canonicalBaseUrl ?? null;
      const handle = vanity
        ? vanity.replace(/^\/?@?/, "").split("/")[0] || null
        : null;
      return {
        id: canonical ?? channelId,
        title: meta.title ?? null,
        description: meta.description ?? null,
        avatar: avatar ?? null,
        subscribers,
        views: countValue(meta.viewCount ?? meta.view_count),
        videos: countValue(meta.videoCount ?? meta.video_count),
        handle,
        links,
        country,
        officialArtist: hasAudioBadge(channel?.header),
      };
    } catch (err) {
      const message = (err as Error).message;
      if (!isNotRateLimited(message)) this.limiter.penalise();
      this.onLog(
        `innertube: profile failed for ${channelId} — ${message}`,
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
      const message = (err as Error).message;
      if (!/Tab .* not found/.test(message)) this.limiter.penalise();
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
