/**
 * The VtuberHK directory — `https://vtuber.hk`.
 *
 * A Hong Kong–centred tracker: one page lists every channel it covers, with
 * the channel id, the name, the subscriber count, the video count and the
 * view count, grouped by the state the performer is in. Behind the page it
 * answers **JSON**, and the JSON is what this module prefers.
 *
 * ## The two sources, and why both are read
 *
 * | Endpoint | Shape | What it is good for |
 * | --- | --- | --- |
 * | `GET /data/channels.json` | a `channels.list` dump — `snippet`, `statistics` | the description, the published country, the handle, `viewCount` / `videoCount` / `subscriberCount` |
 * | `GET /data/live-hkv.json` | `[{cid, id, t, s, u, vc, pf}]` | the live and upcoming schedule |
 * | `GET /data/archive-hkv.json` | the same, plus `d` | the recently ended streams and uploads |
 * | `GET /data/featured.json?p=N` | 50 clips a page | the 精華 clip list |
 * | `GET /data/list-hkv-watching.json` | channel ids | the site's own watch list |
 * | `GET /channels/` | server-rendered HTML | **the roster and its state** |
 *
 * The one thing the API does not publish is the state a performer is in —
 * 活動中 / 準備中 / 己引退 are `<section>` lists in the page — so the roster and
 * its status still come from the HTML, and everything the API knows is joined
 * on the channel id.
 *
 * ## What makes it a roster worth reading
 *
 * The site publishes the `UC…` id itself, so there is no name search and no
 * guess: a row is either the channel it names or it is not. That is the same
 * property the vTubie group pages have, and the reason the Hong Kong scene
 * can be filled in without a single fuzzy match.
 *
 * The grouping is a fact about the *performer*, which is what `activity`
 * records: 活動中 (active), 準備中 (preparing), 己引退 (graduated),
 * 觀察中 (watching). 相關組織 (organizations) are agencies rather than
 * performers, so they are parsed and then left out of the import.
 *
 * ## A roster files a region
 *
 * Everything the site lists is part of the Hong Kong scene — that is what the
 * site is for — so a row is a `roster` region claim. It is applied only where
 * the profile itself decided nothing (`classifyChannel()` returned `unknown`):
 * a Japanese performer who streams with a Hong Kong group keeps the `jp` their
 * own country and kana gave them.
 *
 * ## Statistics are the one thing we cannot get for free elsewhere
 *
 * `channels.json` is a YouTube `channels.list` response, so its `statistics`
 * block carries the total channel **view count** — a field the dataset has
 * never filled (InnerTube's profile does not publish it). That is why the
 * harvest keeps the block and the import can write it.
 */

import type { Activity } from "./types";

/** Which list a row was filed under. */
export type VtuberHkStatus =
  | "active"
  | "organization"
  | "preparing"
  | "graduated"
  | "watching";

/** A roster row: the page's channel id, name and state. */
export interface VtuberHkChannel {
  /** The YouTube `UC…` id the site publishes. */
  id: string;
  name: string;
  status: VtuberHkStatus;
  subscribers: number | null;
  videos: number | null;
  views: number | null;
}

/**
 * What `channels.json` says about a channel.
 *
 * It is a `channels.list` item reduced to the fields this project stores or
 * classifies with; the etag, the thumbnails and the related playlists are
 * dropped because a record does not need them.
 */
export interface VtuberHkMeta {
  id: string;
  name: string;
  description: string | null;
  country: string | null;
  handle: string | null;
  publishedAt: string | null;
  avatar: string | null;
  subscribers: number | null;
  /** The channel hides its subscriber count (`hiddenSubscriberCount`). */
  subscribersHidden: boolean;
  videos: number | null;
  views: number | null;
}

/** A stream or a video from the live or the archive endpoint. */
export interface VtuberHkVideo {
  channelId: string;
  channelName: string;
  videoId: string;
  title: string;
  /** `live`, `upcoming` or `past`. */
  state: string;
  /** `broadcast` or `video`. */
  type: string;
  /** Viewers on a live row, null otherwise. */
  viewers: number | null;
  /** Unix seconds the stream starts, when the row carries it. */
  startsAt: number | null;
  /** A runtime such as `2:13:42` on an archive row. */
  duration: string | null;
  /** `yt` or `ttv`. */
  platform: string;
}

/** A Twitch channel the site covers, if the page was harvested too. */
export interface VtuberHkTwitch {
  /** The numeric Twitch id, when the row carries one. */
  id: string | null;
  login: string;
  name: string;
}

export interface VtuberHkSnapshot {
  generatedAt: string;
  source: string;
  counts: {
    total: number;
    byStatus: Record<string, number>;
    twitch: number;
    meta: number;
    live: number;
    archive: number;
  };
  channels: VtuberHkChannel[];
  twitch: VtuberHkTwitch[];
  /** `channels.json`, keyed by channel id. */
  meta: Record<string, VtuberHkMeta>;
  live: VtuberHkVideo[];
  archive: VtuberHkVideo[];
}

/** The `<section id="…">` a row was listed under, mapped to its state. */
const SECTION_STATUS: Record<string, VtuberHkStatus> = {
  "channel-active": "active",
  "channel-organization": "organization",
  "channel-prepare": "preparing",
  "channel-retire": "graduated",
  "channel-watching": "watching",
};

/** The `activity` a row's section implies. */
export function activityOf(status: VtuberHkStatus): Activity {
  switch (status) {
    case "active":
    case "watching":
      return "active";
    case "preparing":
      return "preparing";
    case "graduated":
      return "graduated";
    default:
      return "unknown";
  }
}

/** Strips the markup a title or a count can carry. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberOf(block: string, className: string): number | null {
  const match = new RegExp(
    `<div class="${className}">[\\s\\S]*?<span class="value">([^<]*)</span>`,
  ).exec(block);
  if (!match) return null;
  const value = Number(textOf(match[1] ?? "").replace(/[^0-9]/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** A count that the API stores as a string, or as a number. */
function countOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every channel on the `/channels/` page.
 *
 * The page is a stack of `<section id="channel-…">` lists, and each row is an
 * `<li class="channel" data-cid="UC…">` carrying its title and counts. The
 * parser reads the sections in order so that the list a row sits in becomes
 * its status, and it never trusts the position of a row within the document
 * beyond that.
 */
export function parseVtuberHkChannels(html: string): VtuberHkChannel[] {
  const rows: VtuberHkChannel[] = [];
  const seen = new Set<string>();

  const sectionRe = /<section id="(channel-[a-z]+)">([\s\S]*?)<\/section>/g;
  for (const section of html.matchAll(sectionRe)) {
    const status = SECTION_STATUS[section[1] ?? ""];
    if (!status) continue;
    const body = section[2] ?? "";

    const rowRe =
      /<li class="channel[^"]*"\s+data-cid="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g;
    for (const row of body.matchAll(rowRe)) {
      const id = (row[1] ?? "").trim();
      if (!/^UC[\w-]{20,}$/.test(id) || seen.has(id)) continue;
      const block = row[2] ?? "";
      const name = textOf(
        /<div class="title">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "",
      );
      if (!name) continue;
      seen.add(id);
      rows.push({
        id,
        name,
        status,
        subscribers: numberOf(block, "subscriberCount"),
        videos: numberOf(block, "videoCount"),
        views: numberOf(block, "viewCount"),
      });
    }
  }

  return rows;
}

/**
 * `channels.json` — the metadata the page counts are drawn from.
 *
 * The file is an object keyed by channel id whose values are YouTube
 * `channels.list` items. Only the stored fields are kept: a record needs the
 * description and the country to classify with, the handle to search by, and
 * the three counts to fill a hole the platform adapter leaves.
 */
export function parseVtuberHkMeta(
  json: unknown,
): Record<string, VtuberHkMeta> {
  if (!json || typeof json !== "object") return {};
  const meta: Record<string, VtuberHkMeta> = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const item = value as {
      id?: string;
      snippet?: {
        title?: string;
        description?: string;
        customUrl?: string;
        publishedAt?: string;
        country?: string;
        thumbnails?: Record<string, { url?: string }>;
      };
      statistics?: {
        viewCount?: string | number;
        subscriberCount?: string | number;
        videoCount?: string | number;
        hiddenSubscriberCount?: boolean;
      };
    };
    const id = (item.id ?? key ?? "").trim();
    if (!/^UC[\w-]{20,}$/.test(id)) continue;
    const snippet = item.snippet ?? {};
    const statistics = item.statistics ?? {};
    const thumbnails = snippet.thumbnails ?? {};
    meta[id] = {
      id,
      name: (snippet.title ?? "").trim(),
      description: snippet.description ? snippet.description.slice(0, 1000) : null,
      country: snippet.country ? String(snippet.country).toUpperCase() : null,
      handle: snippet.customUrl ? snippet.customUrl.replace(/^@/, "") : null,
      publishedAt: snippet.publishedAt ?? null,
      avatar:
        thumbnails.medium?.url ?? thumbnails.default?.url ?? thumbnails.high?.url ?? null,
      subscribers: countOf(statistics.subscriberCount),
      subscribersHidden: statistics.hiddenSubscriberCount === true,
      videos: countOf(statistics.videoCount),
      views: countOf(statistics.viewCount),
    };
  }
  return meta;
}

/**
 * `live-hkv.json` and `archive-hkv.json`.
 *
 * The live file is an array; the archive file is an object keyed by an index,
 * which is the order the site displays and the reason it is flattened here.
 */
export function parseVtuberHkVideos(json: unknown): VtuberHkVideo[] {
  const rows: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? Object.values(json as Record<string, unknown>)
      : [];
  const videos: VtuberHkVideo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const videoId = String(entry.id ?? "").trim();
    const channelId = String(entry.cid ?? "").trim();
    if (!videoId || !channelId) continue;
    const key = `${channelId}/${videoId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const starts = Number(entry.u ?? 0);
    videos.push({
      channelId,
      channelName: String(entry.cTi ?? "").trim(),
      videoId,
      title: String(entry.t ?? "").trim(),
      state: String(entry.s ?? "unknown"),
      type: String(entry.ty ?? ""),
      viewers: countOf(entry.vc),
      startsAt: Number.isFinite(starts) && starts > 0 ? starts : null,
      duration: entry.d === undefined ? null : String(entry.d),
      platform: String(entry.pf ?? "yt"),
    });
  }
  return videos;
}

/**
 * Every channel on the `/twitch` page.
 *
 * The page carries no follower count and no channel id in most rows, only the
 * login the profile lives at, so it is harvested as a **candidate list** — the
 * cross-platform work, matching a login to a record that already exists, is
 * `data:links`' job, not this parser's.
 */
export function parseVtuberHkTwitch(html: string): VtuberHkTwitch[] {
  const rows: VtuberHkTwitch[] = [];
  const seen = new Set<string>();
  const rowRe =
    /<li class="channel"[^>]*twitch-id="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g;
  for (const row of html.matchAll(rowRe)) {
    const numeric = (row[1] ?? "").trim();
    const block = row[2] ?? "";
    const login = /twitch\.com\/([A-Za-z0-9_]+)/.exec(block)?.[1] ?? "";
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    rows.push({
      id: /^\d+$/.test(numeric) ? numeric : null,
      login,
      name:
        textOf(/<div class="title">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "") ||
        login,
    });
  }
  return rows;
}

/** The snapshot the import reads. */
export function buildVtuberHkSnapshot(
  channels: VtuberHkChannel[],
  twitch: VtuberHkTwitch[],
  meta: Record<string, VtuberHkMeta>,
  live: VtuberHkVideo[],
  archive: VtuberHkVideo[],
  now: string,
): VtuberHkSnapshot {
  const byStatus: Record<string, number> = {};
  for (const row of channels) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  return {
    generatedAt: now,
    source: "https://vtuber.hk/",
    counts: {
      total: channels.length,
      byStatus,
      twitch: twitch.length,
      meta: Object.keys(meta).length,
      live: live.length,
      archive: archive.length,
    },
    channels,
    twitch,
    meta,
    live,
    archive,
  };
}
