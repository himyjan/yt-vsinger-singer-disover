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
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";

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
async function getMixinKey(): Promise<string | null> {
  if (mixinKey && Date.now() - mixinKeyFetchedAt < MIXIN_KEY_TTL) {
    return mixinKey;
  }
  try {
    const res = await fetch(`${API}/x/web-interface/nav`, {
      headers: { "User-Agent": USER_AGENT, Referer: "https://www.bilibili.com/" },
    });
    if (!res.ok) return mixinKey;
    const json = (await res.json()) as {
      data?: { wbi_img?: { img_url?: string; sub_url?: string } };
    };
    const img = json.data?.wbi_img?.img_url;
    const sub = json.data?.wbi_img?.sub_url;
    if (!img || !sub) return mixinKey;

    const raw =
      img.slice(img.lastIndexOf("/") + 1) + sub.slice(sub.lastIndexOf("/") + 1);
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
): Promise<string | null> {
  const key = await getMixinKey();
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
  onLog?: (message: string) => void;
}

export class BilibiliAdapter implements PlatformAdapter {
  readonly id: PlatformId = "bilibili";
  readonly label = "Bilibili";
  readonly color = "#fb7299";

  private readonly partition: number;
  private readonly maxUploads: number;
  private readonly onLog: (message: string) => void;

  constructor(options: BilibiliOptions = {}) {
    this.partition = options.partition ?? VTUBER_PARTITION;
    this.maxUploads = options.maxUploads ?? 30;
    this.onLog = options.onLog ?? (() => {});
  }

  isConfigured(): boolean {
    // Bilibili's public read endpoints need no credentials.
    return true;
  }

  private async getJson<T>(url: string, headers: Record<string, string> = {}) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: "https://www.bilibili.com/",
          ...headers,
        },
      });
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const handle = query.trim();
    if (!handle) return null;

    const fromUrl = /space\.bilibili\.com\/(\d+)/.exec(handle);
    const uid = fromUrl?.[1] ?? (/^\d+$/.test(handle) ? handle : null);
    if (!uid) return null;

    const json = await this.getJson<{
      code: number;
      data?: {
        card?: { name?: string; sign?: string; face?: string; mid?: number };
        follower?: number;
      };
    }>(`${API}/x/web-interface/card?mid=${uid}&photo=false`);

    if (json?.code !== 0 || !json?.data) return null;

    const card = json.data.card ?? {};
    const followers = json.data.follower ?? 0;
    const subscribers: CountRef =
      followers > 0 ? { tag: "has", count: followers } : { tag: "no" };

    return {
      platform: "bilibili",
      id: uid,
      handle: String(card.mid ?? uid),
      name: card.name ?? null,
      url: `https://space.bilibili.com/${uid}`,
      subscribers,
      avatar: absoluteUrl(card.face),
      description: card.sign ?? null,
      tags: [],
    };
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    const query = await signQuery({
      mid: channel.id,
      ps: Math.min(50, limit || this.maxUploads),
      pn: 1,
      order: "pubdate",
      index: 1,
      platform: "web",
      web_location: "1550101",
    });
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
   *   • `online/list?rid=160` — the VTuber streams that are live right now.
   */
  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    const byId = new Map<string, PlatformChannel>();
    const uploads: PlatformUpload[] = [];

    /* --- the live VTuber partition ------------------------------------- */
    const live = await this.getJson<{ data?: BiliLive[] }>(
      `${API}/x/web-interface/online/list?rid=${this.partition}&page=1`,
    );
    for (const stream of live?.data ?? []) {
      const owner = stream.owner;
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
