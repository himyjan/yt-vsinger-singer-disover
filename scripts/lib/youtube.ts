/**
 * YouTube Data API v3 client with explicit quota accounting.
 *
 * Design constraints this file satisfies:
 *
 *  1. **Free-tier budget.** A default project gets 10,000 units/day. The client
 *     tracks spend per run and refuses calls that would blow the budget, so a
 *     misconfigured cron can never silently burn the quota.
 *  2. **Cost awareness.** `search.list` costs 100 units; everything else costs
 *     1. Callers use `expensive()` to check before running a search sweep.
 *  3. **Idempotent & resumable.** Every response is cached on disk under
 *     `.cache/` keyed by the request URL. Re-running the sync re-uses cached
 *     responses and only spends quota on genuinely new data.
 *  4. **No native dependencies.** The whole pipeline runs on plain Node in
 *     GitHub Actions — no better-sqlite3, no headless browser.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Quota                                                                      */
/* -------------------------------------------------------------------------- */

/** Official quota cost per request, in units. */
export const API_COST = {
  search: 100,
  channels: 1,
  videos: 1,
  playlists: 1,
  playlistItems: 1,
  liveBroadcasts: 1,
  subscriptions: 1,
  activities: 1,
} as const;

export type ApiCostKey = keyof typeof API_COST;

export const DEFAULT_DAILY_QUOTA = 10_000;

/** Tracks quota spend for one process run and persists it across runs. */
export class QuotaBudget {
  private spent = 0;
  private readonly quotaLimit: number;
  private readonly statePath: string;

  constructor(statePath: string, limit = DEFAULT_DAILY_QUOTA) {
    this.statePath = statePath;
    this.quotaLimit = limit;
    this.spent = this.readState();
  }

  private readState(): number {
    try {
      if (!fs.existsSync(this.statePath)) return 0;
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as {
        date?: string;
        used?: number;
      };
      const today = new Date().toISOString().slice(0, 10);
      // Quota resets daily; ignore yesterday's spend.
      if (raw.date !== today) return 0;
      return typeof raw.used === "number" ? raw.used : 0;
    } catch {
      return 0;
    }
  }

  private writeState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(
          { date: new Date().toISOString().slice(0, 10), used: this.used },
          null,
          2,
        ),
      );
    } catch {
      /* best effort: the cache dir may be read-only in some sandboxes */
    }
  }

  get used(): number {
    return this.spent;
  }

  get limit(): number {
    return this.quotaLimit;
  }

  get remaining(): number {
    return Math.max(0, this.quotaLimit - this.spent);
  }

  /** True when a call of `cost` units still fits in the budget. */
  canAfford(cost: number): boolean {
    return this.spent + cost <= this.quotaLimit;
  }

  /** Records spend. Returns false when the budget was already exhausted. */
  spend(cost: number): boolean {
    if (!this.canAfford(cost)) return false;
    this.spent += cost;
    this.writeState();
    return true;
  }

  /** Overrides the persisted counter (used by tests and `--quota` seeding). */
  overrideUsed(value: number): void {
    this.spent = value;
    this.writeState();
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class QuotaExceededError extends Error {
  constructor(message = "YouTube API quota exhausted") {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface YouTubeClientOptions {
  apiKey: string;
  /** Directory used for the on-disk response cache. */
  cacheDir?: string;
  /** Quota budget shared across calls. */
  budget?: QuotaBudget;
  /** Disable the cache (used when you always want fresh data). */
  noCache?: boolean;
  /** Base URL override (for tests). */
  baseUrl?: string;
  /** Milliseconds before a request is aborted. */
  timeoutMs?: number;
  /** Retries for transient failures (429 / 5xx / network). */
  maxRetries?: number;
  /** Called for every request, for logging. */
  onLog?: (message: string) => void;
}

const DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3";

export class YouTubeClient {
  private readonly apiKey: string;
  private readonly cacheDir: string;
  private readonly budget: QuotaBudget | null;
  private readonly noCache: boolean;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onLog: (message: string) => void;

  constructor(opts: YouTubeClientOptions) {
    this.apiKey = opts.apiKey;
    this.cacheDir = opts.cacheDir ?? path.resolve(process.cwd(), ".cache/youtube");
    this.budget = opts.budget ?? null;
    this.noCache = opts.noCache ?? false;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.onLog = opts.onLog ?? (() => {});
  }

  /* ---------------------------------------------------------------------- */
  /* Low level                                                              */
  /* ---------------------------------------------------------------------- */

  private cacheKey(endpoint: string, params: Record<string, unknown>): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${String(params[k])}`)
      .join("&");
    return crypto
      .createHash("sha1")
      .update(`${endpoint}?${sorted}`)
      .digest("hex");
  }

  private cachePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  private readCache(key: string): any | null {
    if (this.noCache) return null;
    const p = this.cachePath(key);
    try {
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }

  private writeCache(key: string, value: unknown): void {
    if (this.noCache) return;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(this.cachePath(key), JSON.stringify(value));
    } catch {
      /* cache writes are best effort */
    }
  }

  /**
   * Performs one API request.
   *
   * @param endpoint  e.g. `videos.list`
   * @param params    query parameters
   * @param cost      quota units this call consumes
   * @param useCache  whether a cached response may be reused
   */
  async request<T = any>(
    endpoint: string,
    params: Record<string, unknown>,
    cost: number,
    useCache = true,
  ): Promise<T | null> {
    const key = this.cacheKey(endpoint, params);
    const cached = this.readCache(key);
    if (cached) {
      this.onLog(`cache  ${endpoint}`);
      return cached as T;
    }

    if (this.budget && !this.budget.canAfford(cost)) {
      throw new QuotaExceededError(
        `Refusing ${endpoint}: ${cost} units would exceed the ${this.budget.limit} unit budget (${this.budget.used} used).`,
      );
    }

    const url = new URL(`${this.baseUrl}/${endpoint}`);
    url.searchParams.set("key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        const text = await res.text();

        if (res.ok) {
          const json = JSON.parse(text) as T;
          this.writeCache(key, json);
          this.budget?.spend(cost);
          this.onLog(`ok     ${endpoint} (-${cost}u)`);
          return json;
        }

        // Quota / permission problems are not retryable.
        let reason = "unknown";
        let message = `HTTP ${res.status}`;
        try {
          const err = JSON.parse(text) as {
            error?: { errors?: { reason?: string; message?: string }[] };
          };
          const first = err?.error?.errors?.[0];
          if (first?.reason) reason = first.reason;
          if (first?.message) message = first.message;
        } catch {
          /* keep the generic message */
        }

        if (
          reason === "quotaExceeded" ||
          reason === "dailyLimitExceeded" ||
          reason === "accessNotConfigured" ||
          reason === "forbidden" ||
          reason === "insufficientPermissions" ||
          reason === "keyInvalid"
        ) {
          if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
            this.budget?.overrideUsed(this.budget.limit);
          }
          throw new YouTubeApiError(message, res.status, reason, text);
        }

        if (res.status === 429 || res.status >= 500) {
          lastError = new YouTubeApiError(message, res.status, reason, text);
          const backoff = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
          this.onLog(
            `retry  ${endpoint} (${res.status}) in ${backoff}ms [${attempt + 1}/${this.maxRetries}]`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        throw new YouTubeApiError(message, res.status, reason, text);
      } catch (err) {
        if (err instanceof YouTubeApiError) throw err;
        lastError = err as Error;
        const backoff = 2 ** attempt * 1000 + Math.floor(Math.random() * 500);
        this.onLog(
          `retry  ${endpoint} (${(err as Error).message}) in ${backoff}ms [${attempt + 1}/${this.maxRetries}]`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error(`Request failed: ${endpoint}`);
  }

  /* ---------------------------------------------------------------------- */
  /* Typed helpers                                                          */
  /* ---------------------------------------------------------------------- */

  /** `search.list` — 100 units. Returns an empty array when unaffordable. */
  async search(
    params: Record<string, unknown>,
    budget?: QuotaBudget,
  ): Promise<any[]> {
    const b = budget ?? this.budget;
    if (b && !b.canAfford(API_COST.search)) {
      this.onLog(`skip   search.list (budget exhausted)`);
      return [];
    }
    const res = await this.request<any>(
      "search",
      { part: "snippet", maxResults: 50, ...params },
      API_COST.search,
    );
    return res?.items ?? [];
  }

  /**
   * Runs a paginated list endpoint, following `nextPageToken`.
   * `maxItems` caps the total number of records pulled.
   */
  async listAll(
    endpoint: string,
    params: Record<string, unknown>,
    cost: number,
    maxItems = 500,
  ): Promise<any[]> {
    const out: any[] = [];
    let pageToken: string | undefined;
    do {
      const res: any = await this.request(
        endpoint,
        {
          maxResults: Math.min(50, maxItems - out.length),
          ...params,
          ...(pageToken ? { pageToken } : {}),
        },
        cost,
      );
      if (!res) break;
      const items = res.items ?? [];
      out.push(...items);
      pageToken = res.nextPageToken;
      if (!items.length) break;
    } while (pageToken && out.length < maxItems);
    return out.slice(0, maxItems);
  }

  /** `channels.list` — 1 unit per call, up to 50 ids per call. */
  async channels(ids: string[], parts = "snippet,contentDetails,statistics,brandingSettings"): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res: any = await this.request(
        "channels",
        { part: parts, id: chunk.join(",") },
        API_COST.channels,
      );
      out.push(...(res?.items ?? []));
    }
    return out;
  }

  /** Resolves `@handle`s / legacy usernames to canonical channel records. */
  async resolveHandles(handles: string[]): Promise<any[]> {
    const out: any[] = [];
    for (const handle of handles) {
      const h = handle.replace(/^@/, "");
      const res: any = await this.request(
        "channels",
        { part: "snippet,contentDetails,statistics,brandingSettings", forHandle: `@${h}` },
        API_COST.channels,
      );
      if (res?.items?.length) out.push(...res.items);
    }
    return out;
  }

  /** `videos.list` — 1 unit per call, up to 50 ids per call. */
  async videos(ids: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res: any = await this.request(
        "videos",
        {
          part: "snippet,statistics,contentDetails,liveStreamingDetails,status",
          id: chunk.join(","),
        },
        API_COST.videos,
      );
      out.push(...(res?.items ?? []));
    }
    return out;
  }

  /** `liveBroadcasts.list` — 1 unit per call, up to 50 ids per call. */
  async liveBroadcasts(ids: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res: any = await this.request(
        "liveBroadcasts",
        { part: "snippet,contentDetails,status", broadcastStatus: "all", id: chunk.join(",") },
        API_COST.liveBroadcasts,
      );
      out.push(...(res?.items ?? []));
    }
    return out;
  }

  /** `playlistItems.list` for an uploads playlist. */
  async playlistItems(playlistId: string, maxItems = 200): Promise<any[]> {
    return this.listAll(
      "playlistItems",
      { playlistId, part: "snippet,contentDetails" },
      API_COST.playlistItems,
      maxItems,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Normalisation helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Extracts a plain URL from YouTube's thumbnail bag. */
export function pickThumbnail(
  thumbs: any,
  preferred: "max" | "high" | "medium" | "default" = "high",
): string | null {
  if (!thumbs) return null;
  const list = Array.isArray(thumbs) ? thumbs : [];
  if (!list.length) return null;
  const order = ["max", "standard", "high", "medium", "default"];
  if (preferred !== "default") {
    const found = list.find((t: any) => t?.url && order.indexOf(t.width) === order.indexOf(preferred));
    if (found) return found.url;
  }
  const largest = list.reduce((a: any, b: any) => ((b?.width ?? 0) > (a?.width ?? 0) ? b : a), list[0]);
  return largest?.url ?? null;
}

/** Parses an ISO-8601 duration (`PT1H2M3S`) into seconds. */
export function parseIsoDuration(duration: string | undefined | null): number | null {
  if (!duration) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (!m) return null;
  const [, d, h, min, s] = m;
  if (!d && !h && !min && !s) return null;
  return (
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0)
  );
}

/** YouTube's `UU` uploads-playlist trick, only valid for `UC` channel ids. */
export function uploadsPlaylistId(channelId: string): string | null {
  if (!channelId.startsWith("UC")) return null;
  return `UU${channelId.slice(2)}`;
}
