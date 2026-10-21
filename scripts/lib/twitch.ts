/**
 * Twitch Helix API client.
 *
 * The project is "YouTube *and* Twitch": many VTubers stream on both, and
 * singing streams often happen on Twitch first. This client is deliberately
 * optional — the whole pipeline runs without it, and it only activates when
 * `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are present in the
 * environment (set them as GitHub Actions secrets).
 *
 * Endpoints used:
 *   - OAuth app token  (`POST https://id.twitch.tv/oauth2/token`)
 *   - Get Users        (`GET  /helix/users?login=...`)
 *   - Get Channels     (`GET  /helix/channels?broadcaster_id=...`)
 *   - Get Streams      (`GET  /helix/streams?user_id=...`)
 *   - Get Followers    (`GET  /helix/channels/followers?broadcaster_id=...`)
 *
 * Twitch follower counts are *always* public, so they map to the `has` tag of
 * `CountRef` without a `hidden` case.
 */

import fs from "node:fs";
import path from "node:path";
import type { CountRef } from "./types";

const HELIX = "https://api.twitch.tv/helix";
const OAUTH = "https://id.twitch.tv/oauth2/token";

export interface TwitchClientOptions {
  clientId: string;
  clientSecret: string;
  /** Directory for the on-disk response cache. */
  cacheDir?: string;
  /** Disable caching. */
  noCache?: boolean;
  onLog?: (message: string) => void;
}

export class TwitchClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly cacheDir: string;
  private readonly noCache: boolean;
  private readonly onLog: (message: string) => void;

  constructor(opts: TwitchClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.cacheDir = opts.cacheDir ?? path.resolve(process.cwd(), ".cache/twitch");
    this.noCache = opts.noCache ?? false;
    this.onLog = opts.onLog ?? (() => {});
  }

  /** True when both credentials are present. */
  static isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
  }

  /** Creates a client from the environment, or returns null when unconfigured. */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    cacheDir?: string,
  ): TwitchClient | null {
    if (!TwitchClient.isConfigured(env)) return null;
    return new TwitchClient({
      clientId: env.TWITCH_CLIENT_ID!,
      clientSecret: env.TWITCH_CLIENT_SECRET!,
      cacheDir,
    });
  }

  /** Fetches (and caches) an app access token. */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }
    const res = await fetch(OAUTH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      throw new Error(`Twitch OAuth failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this.token!;
  }

  private cachePath(endpoint: string, params: Record<string, string>): string {
    const key = Buffer.from(
      `${endpoint}?${Object.entries(params)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join("&")}`,
    ).toString("base64url");
    return path.join(this.cacheDir, `${key}.json`);
  }

  private async request<T = any>(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<T> {
    const file = this.cachePath(endpoint, params);
    if (!this.noCache && fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as T;
      } catch {
        /* fall through to the network */
      }
    }

    const token = await this.getToken();
    const url = new URL(`${HELIX}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      headers: {
        "Client-Id": this.clientId,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twitch ${endpoint} failed: HTTP ${res.status} ${text}`);
    }
    const json = (await res.json()) as T;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
    } catch {
      /* cache writes are best effort */
    }
    this.onLog(`ok     twitch ${endpoint}`);
    return json;
  }

  /** Resolves Twitch logins to user records. */
  async users(logins: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < logins.length; i += 100) {
      const chunk = logins.slice(i, i + 100);
      const res = await this.request<{ data?: any[] }>("users", {
        login: chunk.join(","),
      });
      out.push(...(res.data ?? []));
    }
    return out;
  }

  /** Channel metadata (title, category, language) for broadcasters. */
  async channels(broadcasterIds: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < broadcasterIds.length; i += 100) {
      const chunk = broadcasterIds.slice(i, i + 100);
      const res = await this.request<{ data?: any[] }>("channels", {
        broadcaster_id: chunk.join(","),
      });
      out.push(...(res.data ?? []));
    }
    return out;
  }

  /** Live streams for the given user ids. */
  async streams(userIds: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100);
      const res = await this.request<{ data?: any[] }>("streams", {
        user_id: chunk.join(","),
      });
      out.push(...(res.data ?? []));
    }
    return out;
  }

  /** Total follower count for a broadcaster. */
  async followers(broadcasterId: string): Promise<CountRef> {
    const res = await this.request<{ total?: number }>(
      "channels/followers",
      { broadcaster_id: broadcasterId },
    );
    const total = res.total ?? 0;
    return total > 0 ? { tag: "has", count: total } : { tag: "no" };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Extracts a Twitch login from arbitrary text (a channel description, etc.). */
export function extractTwitchLogin(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /twitch\.tv\/([A-Za-z0-9_]{3,25})/.exec(text);
  if (!m) return null;
  const login = m[1]!.toLowerCase();
  // Skip common non-user paths.
  if (["directory", "videos", "p", "jobs", "settings", "downloads"].includes(login)) {
    return null;
  }
  return login;
}

/** Extracts other platform handles from a channel description. */
export function extractExternalLinks(
  text: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;

  const patterns: [string, RegExp][] = [
    ["twitter", /(?:twitter|x)\.com\/([A-Za-z0-9_]{2,20})/i],
    ["instagram", /instagram\.com\/([A-Za-z0-9_.]{2,30})/i],
    ["tiktok", /tiktok\.com\/@([A-Za-z0-9_.]{2,30})/i],
    ["bilibili", /bilibili\.com\/([A-Za-z0-9]{1,30})/i],
    ["niconico", /nicovideo\.jp\/user\/(\d+)/i],
    ["discord", /discord\.gg\/([A-Za-z0-9]+)/i],
    ["spotify", /open\.spotify\.com\/artist\/([A-Za-z0-9]+)/i],
  ];

  for (const [platform, re] of patterns) {
    const m = re.exec(text);
    if (m?.[1]) out[platform] = m[1];
  }
  return out;
}
