/**
 * Bilibili adapter.
 *
 * Bilibili is the primary platform for Chinese VTubers, so the dataset needs
 * it. The public web API works without credentials for most read paths:
 *
 *   GET /x/web-interface/ranking/v2?rid=160       VTuber partition ranking
 *   GET /x/web-interface/online/list?rid=160      live VTuber streams
 *   GET /x/space/wbi/acc/info?mid=<uid>           profile (WBI signed)
 *   GET /x/space/arc/search?mid=<uid>&ps=30       uploads (WBI signed)
 *   GET /x/web-interface/view?bvid=<bvid>         video detail
 *   GET /x/web-interface/card?mid=<uid>           profile (unsigned)
 *
 * `rid=160` is Bilibili's 虚拟主播 (VTuber) partition — the same scene the
 * project cares about.
 *
 * ## The WBI signature
 *
 * Since 2023 Bilibili requires most `space/*` endpoints to be signed with a
 * WBI token derived from two rotating keys. The algorithm is:
 *
 * 1. fetch `img_url` and `sub_url` from `/x/web-interface/nav`;
 * 2. concatenate the two file names, permute the characters through a fixed
 *    table, and take the first 32 — that is the `mixin_key`;
 * 3. append `wts=<unix seconds>` to the query, sort the parameters, and
 *    MD5 `query + mixin_key`.
 *
 * The signature is cached for an hour, because the keys rotate slowly.
 */

import crypto from "node:crypto";
import { classifyItem } from "../classify";
import { RateLimiter, detectRateLimit } from "../rate-limit";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";
import { REQUEST_TIMEOUT_MS } from "../io";

const API = "https://api.bilibili.com";

/** Bilibili's 虚拟主播 (VTuber) partition id. */
const VTUBER_PARTITION = 160;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** The permutation table for the WBI mixin key. */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/* -------------------------------------------------------------------------- */
/* WBI signing                                                               */
/* -------------------------------------------------------------------------- */

let mixinKey: string | null = null;
let mixinKeyFetchedAt = 0;
const MIXIN_KEY_TTL = 60 * 60 * 1000;

/** Derives the mixin key from the two rotating key URLs. */
async function getMixinKey(buvid: string | null): Promise<string | null> {
  if (mixinKey && Date.now() - mixinKeyFetchedAt < MIXIN_KEY_TTL) {
    return mixinKey;
  }
  try {
    const res = await fetch(`${API}/x/web-interface/nav`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://www.bilibili.com/",
        Accept: "application/json, text/plain, */*",
        // The same visitor id the rest of the client uses. Without it the
        // risk-control system answers with `-352`, and every signed request
        // is then rejected.
        ...(buvid
          ? { Cookie: `buvid3=${buvid}; b_nut=${Math.floor(Date.now() / 1000)}` }
          : {}),
      },
    });
    if (!res.ok) return mixinKey;
    const json = (await res.json()) as {
      data?: { wbi_img?: { img_url?: string; sub_url?: string } };
    };
    const img = json.data?.wbi_img?.img_url;
    const sub = json.data?.wbi_img?.sub_url;
    if (!img || !sub) return mixinKey;

    /**
     * The two key file names, **without their extensions**.
     *
     * Taking everything after the last `/` leaves the `.jpg` in, and the
     * resulting mixin key is wrong — every signed request is then rejected
     * with `-412 request was banned`.
     */
    const keyOf = (url: string): string =>
      url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("."));
    const raw = keyOf(img) + keyOf(sub);
    mixinKey = MIXIN_KEY_ENC_TAB
      .map((n) => raw[n])
      .join("")
      .slice(0, 32);
    mixinKeyFetchedAt = Date.now();
    return mixinKey;
  } catch {
    return mixinKey;
  }
}

/** Signs a query string with WBI. */
async function signQuery(
  params: Record<string, string | number>,
  buvid: string | null = null,
): Promise<string | null> {
  const key = await getMixinKey(buvid);
  if (!key) return null;

  const wts = Math.floor(Date.now() / 1000);
  const entries: [string, string][] = Object.entries(params).map(
    ([k, v]) => [k, String(v)],
  );
  entries.push(["wts", String(wts)]);
  // Values are URL-encoded before they are sorted and hashed.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const query = entries
    .map(([k, v]) => {
      const encoded = encodeURIComponent(v).replace(/[!'()*]/g, (c) =>
        `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return `${k}=${encoded}`;
    })
    .join("&");

  const signature = crypto
    .createHash("md5")
    .update(query + key)
    .digest("hex");

  return `${query}&w_rid=${signature}`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function biliDurationToSeconds(length: string | number | undefined): number | null {
  if (length === undefined || length === null) return null;
  if (typeof length === "number") return length;
  const parts = length.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

function absoluteUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  return url.startsWith("//") ? `https:${url}` : url;
}

/** Bilibili titles carry the format `【歌】Song / Artist` — reuse the classifier. */
function classifyBili(
  title: string,
  description: string | null,
): {
  category: PlatformUpload["category"];
  songTitle: string | null;
  originalArtist: string | null;
} {
  const result = classifyItem({
    title,
    description,
    tags: [],
    channelKind: "virtual",
    status: "past",
    isShort: false,
    durationSeconds: null,
    channelRegion: "cn",
  });
  return {
    category: result.category,
    songTitle: result.songTitle,
    originalArtist: result.originalArtist,
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

interface BiliOwner {
  mid: number;
  name: string;
  face?: string;
}

interface BiliVideo {
  bvid: string;
  title: string;
  desc?: string;
  pic?: string;
  duration?: string | number;
  pubdate?: number;
  play?: number;
  owner?: BiliOwner;
  tname?: string;
}

interface BiliLive {
  title: string;
  cover?: string;
  owner?: BiliOwner;
  bvid?: string;
  roomid?: number;
  online?: number;
  duration?: number;
  pubtime?: number;
}

export interface BilibiliOptions {
  /** The partition to scan. 160 is 虚拟主播 (VTuber). */
  partition?: number;
  /** How many videos to pull per channel. */
  maxUploads?: number;
  /** The minimum gap between requests, in milliseconds. */
  delayMs?: number;
  onLog?: (message: string) => void;
}

export class BilibiliAdapter implements PlatformAdapter {
  readonly id: PlatformId = "bilibili";
  readonly label = "Bilibili";
  readonly color = "#fb7299";

  private readonly partition: number;
  private readonly maxUploads: number;
  private readonly onLog: (message: string) => void;

  /**
   * The visitor id (`buvid3`).
   *
   * This is Bilibili's equivalent of InnerTube's visitor data: without it
   * the risk-control system answers with HTTP 412. It is fetched once from
   * `x/frontend/finger/spi` and then sent as a cookie, exactly as the
   * browser does.
   */
  private buvid3: string | null = null;
  private buvidFetched = false;

  /** The adaptive limiter — it widens when Bilibili pushes back. */
  private readonly limiter: RateLimiter;

  /**
   * The Bilibili account ids that belong to VTubers.
   *
   * The live endpoint does not honour the partition, so this set is what
   * separates a VTuber stream from the general live feed.
   */
  knownMids: Set<string> | null = null;

  constructor(options: BilibiliOptions = {}) {
    this.partition = options.partition ?? VTUBER_PARTITION;
    this.maxUploads = options.maxUploads ?? 30;
    this.onLog = options.onLog ?? (() => {});
    this.limiter = new RateLimiter({
      minIntervalMs: options.delayMs ?? 400,
      /**
       * The ceiling is low on purpose.
       *
       * Bilibili's risk control answers `-352` or `-412` when it decides a
       * request looks automated, and it keeps answering that way for a while.
       * The breaker therefore has to trip **quickly**: at a 20-second ceiling
       * it took six rejections to get there, and each rejection cost a
       * fifteen-second backoff — so a single blocked channel stalled a whole
       * run for minutes. At eight seconds it trips after four, and the run
       * moves on to the next platform.
       */
      maxIntervalMs: 8_000,
      onLimit: (m) => this.onLog(`bilibili: ${m}`),
      onChange: (ms) =>
        this.onLog(`bilibili: interval → ${Math.round(ms)}ms`),
    });
  }

  /**
   * The visitor id, fetched once and cached for the run.
   */
  private async getBuvid(): Promise<string | null> {
    if (this.buvidFetched) return this.buvid3;
    this.buvidFetched = true;
    try {
      const res = await fetch(`${API}/x/frontend/finger/spi`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT, Referer: "https://www.bilibili.com/" },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { b_3?: string } };
      this.buvid3 = json.data?.b_3 ?? null;
      return this.buvid3;
    } catch {
      return null;
    }
  }

  isConfigured(): boolean {
    // Bilibili's public read endpoints need no credentials.
    return true;
  }

  /**
   * Fetches JSON from the Bilibili API.
   *
   * ## The 412 wall
   *
   * Bilibili answers a burst of requests with **HTTP 412** — a risk-control
   * response, not an error. It lifts again after a pause, so the request is
   * retried with a backoff instead of being treated as "no data".
   *
   * A response that is HTML rather than JSON is the same 412 in disguise, so
   * it is detected by content type as well as by status.
   */
  private async getJson<T>(
    url: string,
    headers: Record<string, string> = {},
    attempt = 0,
  ): Promise<T | null> {
    // The circuit breaker: once Bilibili has pushed back hard enough, stop
    // calling it rather than waiting out the backoff on every channel.
    if (this.limiter.isTripped()) return null;

    await this.limiter.wait();

    const buvid = await this.getBuvid();

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.bilibili.com/",
          // The visitor id — Bilibili's equivalent of InnerTube's visitor
          // data. Without it the risk-control system answers with HTTP 412.
          ...(buvid
            ? { Cookie: `buvid3=${buvid}; b_nut=${Math.floor(Date.now() / 1000)}` }
            : {}),
          ...headers,
        },
      });

      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();
      const limited = detectRateLimit(res.status, text);

      if (limited.limited || !contentType.includes("json")) {
        this.limiter.penalise();
        if (attempt < 2) {
          const wait = 2_000 * 2 ** attempt;
          this.onLog(
            `bilibili: rate limited (${res.status}), waiting ${wait / 1000}s`,
          );
          /**
           * A fresh visitor id.
           *
           * Bilibili's risk control is partly keyed on the visitor id, so
           * the same `buvid3` that was just rejected is unlikely to be
           * accepted on the next attempt.
           */
          this.buvidFetched = false;
          this.buvid3 = null;
          await new Promise((r) => setTimeout(r, wait));
          return this.getJson<T>(url, headers, attempt + 1);
        }
        return null;
      }

      if (!res.ok) return null;
      this.limiter.reward();
      return JSON.parse(text) as T;
    } catch {
      this.limiter.penalise();
      return null;
    }
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const handle = query.trim();
    if (!handle) return null;

    const fromUrl = /space\.bilibili\.com\/(\d+)/.exec(handle);
    const uid = fromUrl?.[1] ?? (/^\d+$/.test(handle) ? handle : null);
    if (!uid) return null;

    /**
     * The profile endpoint carries the name, avatar and signature, but it is
     * the one endpoint Bilibili protects with a captcha wall: a request
     * without a session cookie is answered with HTTP 412.
     *
     * The follower count comes from `x/relation/stat`, which is not
     * protected, so the count still lands. The signature is best-effort —
     * when it is unavailable the record simply has no description.
     */
    const profile = await this.getJson<{
      code: number;
      data?: {
        card?: { name?: string; sign?: string; face?: string; mid?: number };
        follower?: number;
        /** The number of published videos. */
        archive_count?: number;
        /** The total number of likes. */
        like_num?: number;
      };
    }>(`${API}/x/web-interface/card?mid=${uid}&photo=false`);

    const card = profile?.code === 0 ? profile.data : undefined;
    const info = card?.card ?? {};
    /** The published video count, when the endpoint reports it. */
    const archiveCount = card?.archive_count ?? null;
    /** The total likes, when the endpoint reports them. */
    const likeCount = card?.like_num ?? null;

    const followers =
      card?.follower && card.follower > 0
        ? ({ tag: "has", count: card.follower } satisfies CountRef)
        : ((await this.followers(uid)) ?? { tag: "hidden" as const });

    if (!card && followers.tag === "hidden") return null;

    return {
      platform: "bilibili",
      id: uid,
      handle: String(info.mid ?? uid),
      name: info.name ?? null,
      url: `https://space.bilibili.com/${uid}`,
      subscribers: followers,
      avatar: absoluteUrl(info.face),
      description: info.sign ?? null,
      tags: [],
      videoCount: archiveCount,
      likeCount,
    };
  }

  /**
   * The follower count.
   *
   * `x/relation/stat` is the one per-user endpoint that is not behind
   * Bilibili's risk-control wall, so it is the source of the subscriber
   * count.
   */
  async followers(
    channel: PlatformChannel | string,
  ): Promise<CountRef | null> {
    const uid = typeof channel === "string" ? channel : channel.id;
    const json = await this.getJson<{
      code: number;
      data?: { follower?: number };
    }>(`${API}/x/relation/stat?vmid=${uid}`);
    if (json?.code !== 0 || !json?.data) return null;
    const count = json.data.follower ?? 0;
    return count > 0 ? { tag: "has", count } : { tag: "no" };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    const query = await signQuery(
      {
        mid: channel.id,
        ps: Math.min(50, limit || this.maxUploads),
        pn: 1,
        order: "pubdate",
        index: 1,
        platform: "web",
        web_location: "1550101",
      },
      await this.getBuvid(),
    );
    if (!query) return [];

    const json = await this.getJson<{
      code: number;
      data?: { list?: { vlist?: BiliVideo[] } };
    }>(`${API}/x/space/arc/search?${query}`);

    const list = json?.data?.list?.vlist ?? [];
    if (json?.code !== 0) return [];

    return list.slice(0, limit || this.maxUploads).map((arc) => {
      const classified = classifyBili(arc.title, arc.desc ?? null);
      return {
        platform: "bilibili",
        id: arc.bvid,
        channelId: channel.id,
        title: arc.title,
        description: arc.desc ?? null,
        thumbnail: absoluteUrl(arc.pic),
        publishedAt: arc.pubdate
          ? new Date(arc.pubdate * 1000).toISOString()
          : null,
        scheduledStart: null,
        duration: biliDurationToSeconds(arc.duration),
        status: "past",
        category: classified.category,
        songTitle: classified.songTitle,
        originalArtist: classified.originalArtist,
        viewCount: arc.play ?? null,
        url: `https://www.bilibili.com/video/${arc.bvid}`,
      } satisfies PlatformUpload;
    });
  }

  async live(_channel: PlatformChannel): Promise<PlatformUpload[]> {
    /**
     * Bilibili's live list is partition-wide rather than per-channel, so the
     * live streams are collected by `search()` and stored on the channel
     * record instead.
     */
    return [];
  }

  /**
   * Discovers VTuber channels from Bilibili's VTuber partition.
   *
   * Two endpoints are used:
   *   • `ranking/v2?rid=160` — the popular videos in the VTuber partition,
   *     which reveals the channels that publish there;
   *   • `online/list?rid=160` — the streams that are live right now.
   *
   * **The live endpoint is not filtered by partition.** Asked for the VTuber
   * partition it still returns the general live feed — gaming, news, tech
   * reviews — so the streams are matched against the known VTuber roster
   * instead. `knownMids` is that roster.
   */
  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    const byId = new Map<string, PlatformChannel>();
    const uploads: PlatformUpload[] = [];

    /* --- the live feed -------------------------------------------------- */
    const live = await this.getJson<{ data?: BiliLive[] }>(
      `${API}/x/web-interface/online/list?rid=${this.partition}&page=1`,
    );
    for (const stream of live?.data ?? []) {
      const owner = stream.owner;
      if (!owner?.mid) continue;
      // Only keep the streams that belong to a known VTuber.
      if (this.knownMids && !this.knownMids.has(String(owner.mid))) continue;
      if (!byId.has(String(owner.mid))) {
        byId.set(String(owner.mid), {
          platform: "bilibili",
          id: String(owner.mid),
          handle: String(owner.mid),
          name: owner.name,
          url: `https://space.bilibili.com/${owner.mid}`,
          subscribers: { tag: "hidden" },
          avatar: absoluteUrl(owner.face),
          description: null,
          tags: [],
        });
      }
      if (stream.bvid) {
        uploads.push({
          platform: "bilibili",
          id: stream.bvid,
          channelId: String(owner.mid),
          title: stream.title ?? "",
          description: null,
          thumbnail: absoluteUrl(stream.cover),
          publishedAt: stream.pubtime
            ? new Date(stream.pubtime * 1000).toISOString()
            : null,
          scheduledStart: null,
          duration: stream.duration ?? null,
          status: "live",
          category: "live",
          songTitle: null,
          originalArtist: null,
          viewCount: stream.online ?? null,
          url: `https://www.bilibili.com/video/${stream.bvid}`,
        });
      }
    }

    /* --- the VTuber ranking -------------------------------------------- */
    const ranking = await this.getJson<{
      code: number;
      data?: { list?: BiliVideo[] };
    }>(`${API}/x/web-interface/ranking/v2?rid=${this.partition}&type=all`);

    for (const video of ranking?.data?.list ?? []) {
      const owner = video.owner;
      if (!owner?.mid) continue;
      if (!byId.has(String(owner.mid))) {
        byId.set(String(owner.mid), {
          platform: "bilibili",
          id: String(owner.mid),
          handle: String(owner.mid),
          name: owner.name,
          url: `https://space.bilibili.com/${owner.mid}`,
          subscribers: { tag: "hidden" },
          avatar: absoluteUrl(owner.face),
          description: null,
          tags: [],
        });
      }
    }

    this.onLog(
      `bilibili: ${byId.size} channel(s) in the VTuber partition, ${uploads.length} live`,
    );
    this.liveUploads = uploads;
    return [...byId.values()].slice(0, limit || 100);
  }

  /** The live streams found by the last `search()` call. */
  liveUploads: PlatformUpload[] = [];
}
