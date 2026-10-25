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
   * Whether to read the about page for the country and the channel's published
   * external links.
   *
   * It costs one extra request, so it is opt-in for detail and import passes.
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

export interface InnerTubeRelease {
  /** YouTube Music playlist id. */
  id: string;
  /** Release title. */
  title: string;
  /** Cover art URL. */
  thumbnail: string | null;
}

/** One video returned by InnerTube's public search. */
export interface InnerTubeSearchVideo {
  /** The video id. */
  id: string;
  /** The title shown in the search result. */
  title: string;
  /** The description snippet YouTube includes with the result. */
  description: string | null;
  /** The channel that owns the video, when YouTube exposes it. */
  channelId: string | null;
  /** The channel's display name. */
  channelTitle: string | null;
  /** The thumbnail URL. */
  thumbnail: string | null;
  /** The view count, when the result shows one. */
  views: number | null;
}

/** A live or upcoming stream from a channel's Live tab. */
export interface InnerTubeLive {
  /** The video id of the broadcast. */
  id: string;
  /** The broadcast title. */
  title: string;
  /** The thumbnail URL. */
  thumbnail: string | null;
  /** Whether the broadcast is live now or scheduled. */
  status: "live" | "upcoming";
  /** The scheduled start, for an upcoming broadcast. */
  scheduledStart: string | null;
}

export interface InnerTubeChannelCatalog {
  uploads: InnerTubeUpload[];
  releases: InnerTubeRelease[];
  officialArtist: boolean;
}

const YOUTUBE_CHANNEL_ID = /^UC[\w-]{20,}$/;

function collectChannelIds(
  value: unknown,
  found: Set<string>,
  visited: WeakSet<object>,
  depth = 0,
): void {
  if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) {
    return;
  }
  visited.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ["id", "channel_id", "channelId", "browseId"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && YOUTUBE_CHANNEL_ID.test(candidate)) {
      found.add(candidate);
    }
  }
  for (const child of Object.values(record)) {
    collectChannelIds(child, found, visited, depth + 1);
  }
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
 * Reads the plain text out of an InnerTube node.
 *
 * The parser wraps strings in `Text` objects, and some renderers expose the
 * same value as a plain string depending on the endpoint. Both shapes are
 * normalised here so the callers can treat the result as text.
 */
function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const record = value as { text?: unknown; toString?: () => string };
    if (typeof record.text === "string") return record.text;
    if (typeof record.toString === "function") {
      const text = record.toString();
      if (text && text !== "[object Object]") return text;
    }
  }
  return null;
}

/** Picks the largest thumbnail an InnerTube node exposes. */
function thumbnailOf(item: any): string | null {
  const url =
    item?.content_image?.image?.at(-1)?.url ??
    item?.thumbnails?.at(-1)?.url ??
    item?.thumbnail?.contents?.at(-1)?.url ??
    item?.rich_thumbnail?.image?.at(-1)?.url ??
    null;
  return typeof url === "string" && url ? url.split("?")[0]! : null;
}

/** Parses a view-count label such as `12万回` or `1.2M views`. */
function viewsOf(value: unknown): number | null {
  const text = textOf(value);
  if (!text) return null;
  const match = text
    .replace(/,/g, "")
    .match(/([\d.]+)\s*([万萬億亿KMB천만억])?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const suffix = (match[2] ?? "").toUpperCase();
  const multiplier =
    suffix === "万" || suffix === "萬" || suffix === "만"
      ? 10_000
      : suffix === "億" || suffix === "亿" || suffix === "억"
        ? 100_000_000
        : suffix === "천"
          ? 1_000
          : suffix === "K"
            ? 1_000
            : suffix === "M"
              ? 1_000_000
              : suffix === "B"
                ? 1_000_000_000
                : 1;
  const total = Math.round(amount * multiplier);
  return total > 0 ? total : null;
}

/** The badges on a Live-tab card, across both card renderers. */
function lockupBadges(item: any): any[] {
  const badgeLists = [
    item?.content_image?.overlays,
    item?.content_image?.primary_thumbnail?.overlays,
    item?.thumbnail_overlays,
  ];
  const badges: any[] = [];
  for (const overlays of badgeLists) {
    if (!Array.isArray(overlays)) continue;
    for (const overlay of overlays) {
      if (Array.isArray(overlay?.badges)) badges.push(...overlay.badges);
      if (overlay?.text) badges.push(overlay);
    }
  }
  return badges;
}

/** The title of a grid-video or lockup-view card. */
function titleOf(item: any): string {
  return (
    textOf(item?.metadata?.title) ??
    textOf(item?.title) ??
    ""
  );
}

/**
 * The state of a Live-tab entry.
 *
 * The Live tab mixes **currently live**, **upcoming** and **finished**
 * broadcasts. Two renderers are involved (`GridVideo` and the newer
 * `LockupView`), so the state is read from both:
 *
 *   • live — the thumbnail badge says `LIVE` / `ライブ` / `생방송` or the
 *     metadata row is a viewer count;
 *   • upcoming — the badge says `配信予定` / `Scheduled` or the row names a
 *     scheduled time;
 *   • finished — the badge is a duration and the row says `配信済み`.
 *
 * Finished broadcasts are ignored here: they are already in the uploads tab.
 */
function liveStatusOf(item: any): "live" | "upcoming" | null {
  if (item?.is_upcoming === true) return "upcoming";
  if (
    item?.upcoming instanceof Date &&
    item.upcoming.getTime() > Date.now()
  ) {
    return "upcoming";
  }
  if (item?.is_live === true) return "live";

  const badges = lockupBadges(item);
  if (
    badges.some(
      (badge) =>
        badge?.icon_name === "LIVE" ||
        /LIVE$/i.test(String(badge?.badge_style ?? "")) ||
        /^(?:live|ライブ|生放送|생방송|直播|實況|实况)$/iu.test(
          String(badge?.text ?? "").trim(),
        ),
    )
  ) {
    return "live";
  }
  if (
    badges.some((badge) =>
      /^(?:配信予定|公開予定|予定|scheduled|upcoming|premiere|예정|即将|即將)$/iu.test(
        String(badge?.text ?? "").trim(),
      ),
    )
  ) {
    return "upcoming";
  }

  const rows: any[] = item?.metadata?.metadata?.metadata_rows ?? [];
  const rowText = rows
    .flatMap((row) =>
      Array.isArray(row?.metadata_parts)
        ? row.metadata_parts.map(
            (part: any) => textOf(part?.text) ?? "",
          )
        : [],
    )
    .join(" ");
  if (/(?:視聴中|watching|viewers?|人が視聴|正在观看|正在觀看|시청자|시청 중)/iu.test(rowText)) {
    return "live";
  }
  if (/(?:公開予定|配信予定|待機中|scheduled|upcoming|premieres|예정|即将|即將)/iu.test(rowText)) {
    return "upcoming";
  }
  return null;
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
   * Discovers channel ids from YouTube's public channel search results.
   * This uses InnerTube rather than `search.list`, so it does not consume
   * YouTube Data API quota.
   */
  async searchChannels(query: string, limit = 25): Promise<string[]> {
    if (!this.client || !query.trim() || limit <= 0) return [];
    try {
      await this.throttle();
      const result: any = await withTimeout(
        this.client.search(query, { type: "channel" }),
        REQUEST_TIMEOUT_MS,
      );
      if (!result) return [];
      const found = new Set<string>();
      const visited = new WeakSet<object>();
      for (const entry of (result.results ?? []).slice(0, limit)) {
        collectChannelIds(entry, found, visited);
      }
      this.limiter.reward();
      return [...found].slice(0, limit);
    } catch (err) {
      const message = (err as Error).message;
      if (!isNotRateLimited(message)) this.limiter.penalise();
      this.onLog(`innertube: channel search failed for "${query}" — ${message}`);
      return [];
    }
  }

  /**
   * Discovers videos from YouTube's public search results.
   *
   * This is the quota-free counterpart of `search.list?type=video`. The search
   * result carries the owning channel id, the title and a description snippet,
   * which is exactly the evidence the discovery gate needs — and unlike the
   * Data API it costs no quota.
   */
  async searchVideos(
    query: string,
    limit = 25,
    options: { liveOnly?: boolean } = {},
  ): Promise<InnerTubeSearchVideo[]> {
    if (!this.client || !query.trim() || limit <= 0) return [];
    try {
      await this.throttle();
      const result: any = await withTimeout(
        this.client.search(query, {
          type: "video",
          ...(options.liveOnly ? { features: ["live"] } : {}),
        }),
        REQUEST_TIMEOUT_MS,
      );
      if (!result) return [];
      const out: InnerTubeSearchVideo[] = [];
      const seen = new Set<string>();
      for (const entry of (result.results ?? []).slice(0, limit)) {
        const id = entry?.video_id ?? entry?.content_id ?? entry?.id;
        if (typeof id !== "string" || !id || seen.has(id)) continue;
        const title = textOf(entry?.title);
        if (!title) continue;
        seen.add(id);
        const author = entry?.author ?? {};
        const authorId =
          typeof author.id === "string" && YOUTUBE_CHANNEL_ID.test(author.id)
            ? author.id
            : null;
        out.push({
          id,
          title,
          description:
            textOf(entry?.description_snippet) ??
            textOf(entry?.snippets?.[0]?.text) ??
            null,
          channelId: authorId,
          channelTitle:
            typeof author.name === "string" && author.name ? author.name : null,
          thumbnail: thumbnailOf(entry),
          views: viewsOf(entry?.view_count) ?? viewsOf(entry?.short_view_count),
        });
      }
      this.limiter.reward();
      return out;
    } catch (err) {
      const message = (err as Error).message;
      if (!isNotRateLimited(message)) this.limiter.penalise();
      this.onLog(`innertube: video search failed for "${query}" — ${message}`);
      return [];
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
      /**
       * The count the channel page actually shows.
       *
       * The microformat has no `subscriberCount` on the current layout, and
       * youtubei.js does not lift it out of the header, so it stayed `null`
       * and the record kept `subscribers: hidden` even after a successful
       * profile fetch. The header is a list of text rows — `8 subscribers`,
       * `登録者1.2万人` — read here and parsed with the same compact-count
       * parser the view labels use.
       */
      const headerSubscriberText = (() => {
        const rows = channel?.header?.content?.metadata?.metadata_rows ?? [];
        for (const row of rows) {
          for (const part of row?.metadata_parts ?? []) {
            const text = textOf(part?.text);
            if (text && /subscriber|訂閱|订阅|登録者|구독/i.test(text)) {
              return text;
            }
          }
        }
        return null;
      })();
      const subscribers = (() => {
        if (typeof rawSubscribers === "number") return rawSubscribers;
        if (rawSubscribers && typeof rawSubscribers === "object") {
          return viewsOf(
            String(
              (rawSubscribers as { text?: unknown }).text ?? "",
            ),
          );
        }
        return viewsOf(headerSubscriberText);
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
          const aboutLinks = [
            ...(about?.primary_links ?? []),
            ...(about?.metadata?.links ?? []),
          ];
          for (const link of aboutLinks) {
            const endpoint =
              link?.endpoint ?? link?.link?.endpoint ?? link?.title?.endpoint;
            const url =
              endpoint?.toURL?.() ??
              endpoint?.metadata?.url ??
              endpoint?.payload?.url ??
              link?.url ??
              link?.href;
            if (typeof url !== "string") continue;
            try {
              const parsed = new URL(url, "https://www.youtube.com");
              const destination =
                parsed.searchParams.get("q") ??
                parsed.searchParams.get("url");
              links.push(destination ?? parsed.toString());
            } catch {
              this.onLog(`innertube: ignored invalid channel link for ${channelId}`);
            }
          }
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
    return (await this.channelCatalog(channelId, limit)).uploads;
  }

  /**
   * The channel's uploads and, for an Official Artist Channel, its YouTube
   * Music releases. The badge and both tabs come from one channel fetch.
   */
  async channelCatalog(
    channelId: string,
    uploadLimit = 30,
    releaseLimit = 12,
  ): Promise<InnerTubeChannelCatalog> {
    const empty: InnerTubeChannelCatalog = {
      uploads: [],
      releases: [],
      officialArtist: false,
    };
    if (!this.client) return empty;
    try {
      await this.throttle();
      const channel: any = await withTimeout(
        this.client.getChannel(channelId),
        REQUEST_TIMEOUT_MS,
      );
      if (!channel) return empty;
      const officialArtist = hasAudioBadge(channel.header);
      const uploads: InnerTubeUpload[] = [];
      try {
        const grid: any = await withTimeout(
          channel.getVideos(),
          REQUEST_TIMEOUT_MS,
        );
        const list: any[] = grid?.videos ?? [];
        for (const item of list.slice(0, uploadLimit)) {
          const id = item?.content_id ?? item?.id;
          if (typeof id !== "string" || !id) continue;
          const title = item?.metadata?.title?.text ?? item?.title?.text ?? "";
          const thumbnail =
            item?.content_image?.image?.at(-1)?.url ??
            item?.thumbnails?.at(-1)?.url ??
            null;
          uploads.push({
            id,
            title,
            thumbnail: thumbnail ? thumbnail.split("?")[0]! : null,
            published: null,
            views: null,
          });
        }
      } catch (err) {
        this.onLog(
          `innertube: uploads failed for ${channelId} — ${(err as Error).message}`,
        );
      }

      const releases: InnerTubeRelease[] = [];
      if (officialArtist) {
        try {
          await this.throttle();
          const releaseTab: any = await withTimeout(
            channel.getReleases(),
            REQUEST_TIMEOUT_MS,
          );
          const releaseList: any[] =
            releaseTab?.playlists ?? releaseTab?.videos ?? releaseTab?.items ?? [];
          for (const item of releaseList.slice(0, releaseLimit)) {
            const id =
              item?.content_id ??
              item?.playlist_id ??
              item?.playlistId ??
              item?.id;
            if (typeof id !== "string" || !id) continue;
            const title =
              item?.metadata?.title?.text ??
              item?.title?.text ??
              item?.title ??
              "";
            const thumbnail =
              item?.content_image?.image?.at(-1)?.url ??
              item?.thumbnails?.at(-1)?.url ??
              item?.thumbnail?.contents?.at(-1)?.url ??
              null;
            if (!title) continue;
            releases.push({
              id,
              title: typeof title === "string" ? title : title.toString(),
              thumbnail: thumbnail ? thumbnail.split("?")[0]! : null,
            });
          }
        } catch (err) {
          this.onLog(
            `innertube: releases failed for ${channelId} — ${(err as Error).message}`,
          );
        }
      }

      this.limiter.reward();
      return { uploads, releases, officialArtist };
    } catch (err) {
      // A channel with no videos tab, or one that is only Shorts, is normal.
      const message = (err as Error).message;
      if (!/Tab .* not found/.test(message)) this.limiter.penalise();
      if (!/Tab .* not found/.test(message)) {
        this.onLog(
          `innertube: uploads failed for ${channelId} — ${message}`,
        );
      }
      return empty;
    }
  }

  /**
   * The channel's live and upcoming streams.
   *
   * Returns `null` when the channel could not be checked at all (network or
   * rate-limit failure) and `[]` when the check succeeded but nothing is live.
   * The distinction lets the caller retire stale live items only when it knows
   * the Live tab was actually read.
   */
  async liveStreams(channelId: string): Promise<InnerTubeLive[] | null> {
    if (!this.client) return null;
    try {
      await this.throttle();
      const channel: any = await withTimeout(
        this.client.getChannel(channelId),
        REQUEST_TIMEOUT_MS,
      );
      if (!channel) return null;
      const grid: any = await withTimeout(
        channel.getLiveStreams(),
        REQUEST_TIMEOUT_MS,
      );
      if (!grid) return null;
      const list: any[] = grid?.videos ?? grid?.items ?? [];

      const out: InnerTubeLive[] = [];
      for (const item of list.slice(0, 30)) {
        const id = item?.video_id ?? item?.content_id ?? item?.id;
        if (typeof id !== "string" || !id) continue;
        const status = liveStatusOf(item);
        if (!status) continue;
        const scheduledStart =
          item?.upcoming instanceof Date
            ? item.upcoming.toISOString()
            : null;
        out.push({
          id,
          title: titleOf(item),
          thumbnail: thumbnailOf(item),
          status,
          scheduledStart: status === "upcoming" ? scheduledStart : null,
        });
      }
      this.limiter.reward();
      return out;
    } catch (err) {
      const message = (err as Error).message;
      // A channel that has never streamed has no Live tab. That is a fact
      // about the channel, not a reason to slow the limiter down.
      if (/Tab .* not found/i.test(message)) return [];
      if (!isNotRateLimited(message)) this.limiter.penalise();
      this.onLog(`innertube: live lookup failed for ${channelId} — ${message}`);
      return null;
    }
  }
}
