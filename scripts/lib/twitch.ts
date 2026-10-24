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
 *   - Search Channels  (`GET  /helix/search/channels?query=...`)
 *   - Get Followers    (`GET  /helix/channels/followers?broadcaster_id=...`)
 *
 * Twitch follower counts are *always* public, so they map to the `has` tag of
 * `CountRef` without a `hidden` case.
 */

import fs from "node:fs";
import path from "node:path";
import type { CountRef } from "./types";
import { REQUEST_TIMEOUT_MS } from "./io";

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  /** Search public Twitch channels by name or title. */
  async searchChannels(query: string, limit = 10): Promise<any[]> {
    const needle = query.trim();
    if (!needle || limit <= 0) return [];
    const res = await this.request<{ data?: any[] }>("search/channels", {
      query: needle,
      first: String(Math.min(limit, 100)),
    });
    return res.data ?? [];
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

  const patterns: [string, RegExp, (match: RegExpExecArray) => string | null][] = [
    [
      "youtube",
      /(?:youtube\.com\/(channel\/(UC[\w-]{22})|(@[A-Za-z0-9._-]+)|(?:user|c)\/([A-Za-z0-9._-]+)))/i,
      (m) => m[2] ?? m[3] ?? `${m[1]!.startsWith("user/") ? "user" : "c"}/${m[4]}`,
    ],
    [
      "youtube_video",
      /(?:youtu\.be\/([A-Za-z0-9_-]{11})|youtube(?:music)?\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/)([A-Za-z0-9_-]{11}))/i,
      (m) => m[1] ?? m[2]!,
    ],
    [
      "youtube_playlist",
      /youtube(?:music)?\.com\/playlist\?(?:[^#]*&)?list=([A-Za-z0-9_-]+)/i,
      (m) => m[1]!,
    ],
    [
      "twitch",
      /(?:twitch\.tv\/([A-Za-z0-9_]{3,25}))/i,
      (m) =>
        ["directory", "videos", "p", "jobs", "settings", "downloads"].includes(
          m[1]!.toLowerCase(),
        )
          ? null
          : m[1]!.toLowerCase(),
    ],
    ["twitter", /(?:twitter|x)\.com\/([A-Za-z0-9_]{2,20})/i, (m) => m[1]!],
    ["instagram", /instagram\.com\/([A-Za-z0-9_.]{2,30})/i, (m) => m[1]!],
    ["tiktok", /tiktok\.com\/@([A-Za-z0-9_.]{2,30})/i, (m) => m[1]!],
    [
      "bilibili",
      /(?:space\.bilibili\.com\/|bilibili\.com\/space\/)(\d+)/i,
      (m) => m[1]!,
    ],
    [
      "niconico",
      /(?:nicovideo\.jp|nico\.ms)\/user\/(\d+)/i,
      (m) => m[1]!,
    ],
    [
      "discord",
      /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([A-Za-z0-9-]+)/i,
      (m) => m[1]!,
    ],
    [
      "spotify",
      /open\.spotify\.com\/(artist|user)\/([A-Za-z0-9]+)/i,
      (m) => `${m[1]}/${m[2]}`,
    ],
    [
      "ci.me",
      /(?:https?:\/\/)?(?:www\.)?ci\.me\/([A-Za-z0-9_-]+)/i,
      (m) => m[1]!,
    ],
    /**
     * Any other address the performer publishes.
     *
     * The list above only knows the platforms this app has adapters for. A
     * Spotify **album** link, a personal site, a shop — the performer put it
     * in their description and it has to stay a working link, not
     * `https://example.com/<handle>`. `web:<n>` is the key, and the value is
     * the URL itself rather than a handle.
     */
    [
      "web",
      /(?:https?:\/\/)?((?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\.[a-z]{2,}\/[^\s"'<>()]*)/gi,
      (m) => `https://${m[1]!.replace(/[.,;:!?)\]]+$/, "")}`,
    ],
    ["vk", /vk\.com\/((?:id\d+)|[A-Za-z][A-Za-z0-9_.]{1,30})/i, (m) => m[1]!],
    [
      "chzzk",
      /chzzk\.naver\.com\/([A-Za-z0-9_-]{10,})/i,
      (m) => m[1]!,
    ],
    [
      "kick",
      /kick\.com\/([A-Za-z0-9_-]{2,30})/i,
      (m) =>
        ["categories", "video", "videos", "clips", "search", "api"].includes(
          m[1]!.toLowerCase(),
        )
          ? null
          : m[1]!,
    ],
    [
      "soop",
      /(?:sooplive\.com\/station\/|ch\.sooplive\.co\.kr\/|play\.sooplive\.com\/)([A-Za-z0-9_-]+)/i,
      (m) => m[1]!,
    ],
  ];

  /** The address itself, for the keys that keep a URL rather than a handle. */
  const fromUrl = (value: string): string => {
    try {
      const url = new URL(value);
      return `${url.hostname.replace(/^www\./, "")}${url.pathname}${url.search}`;
    } catch {
      return value
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/\/$/, "");
    }
  };

  for (const [platform, re, normalize] of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const matches = [...text.matchAll(new RegExp(re.source, flags))];
    for (const m of matches) {
      const identity = normalize(m);
      if (!identity) continue;
      /** A site is one link: the first address on it wins. */
      if (platform === "web") {
        const url = fromUrl(identity);
        const host = url.split("/")[0] ?? "";
        const key = Object.keys(out).find(
          (existing) =>
            existing.startsWith("web:") && fromUrl(out[existing]!).split("/")[0] === host,
        );
        if (key) continue;
        const n = Object.keys(out).filter((k) => k.startsWith("web:")).length + 1;
        out[`web:${n}`] = url;
        break;
      }
      out[platform] = identity;
      break;
    }
  }

  /**
   * The known platforms are the ones that matter; the plain addresses only
   * fill the gap. Two sites are enough — a description with ten links is a
   * fan page listing, not a performer's own.
   *
   * A site that a known platform already covers — `space.bilibili.com/…`,
   * `open.spotify.com/artist/…` — is the same link twice, so it is dropped
   * rather than shown beside its own badge.
   */
  const hostOf = (value: string): string =>
    value.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
  /**
   * The domains the known platforms live on. A handle is not a URL, so the
   * domain has to come from the table rather than from the stored value.
   */
  const PLATFORM_HOSTS: Record<string, string[]> = {
    youtube: ["youtube.com", "youtu.be", "music.youtube.com"],
    youtube_video: ["youtube.com", "youtu.be"],
    youtube_playlist: ["music.youtube.com", "youtube.com"],
    twitch: ["twitch.tv"],
    twitter: ["twitter.com", "x.com"],
    x: ["twitter.com", "x.com"],
    instagram: ["instagram.com"],
    tiktok: ["tiktok.com"],
    bilibili: ["space.bilibili.com", "bilibili.com"],
    niconico: ["nicovideo.jp", "nico.ms"],
    discord: ["discord.gg", "discord.com"],
    spotify: ["open.spotify.com"],
    vk: ["vk.com"],
    chzzk: ["chzzk.naver.com"],
    kick: ["kick.com"],
    soop: ["sooplive.com", "sooplive.co.kr"],
    "ci.me": ["ci.me"],
  };
  const knownHosts = Object.keys(out)
    .filter((key) => !key.startsWith("web:"))
    .flatMap((key) => PLATFORM_HOSTS[key] ?? []);
  for (const key of Object.keys(out)) {
    if (!key.startsWith("web:")) continue;
    const host = hostOf(out[key]!);
    const covered = knownHosts.some(
      (known) => host === known || host.endsWith(`.${known}`),
    );
    if (covered || Number(key.slice(4)) > 2) delete out[key];
  }
  return out;
}
