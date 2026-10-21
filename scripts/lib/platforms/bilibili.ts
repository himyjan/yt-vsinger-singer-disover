/**
 * Bilibili adapter.
 *
 * Bilibili is the primary platform for many Chinese VTubers, so the dataset
 * needs it. The public web API works without credentials for most read paths:
 *
 *   GET https://api.bilibili.com/x/space/wbi/acc/info?mid=<uid>
 *   GET https://api.bilibili.com/x/space/arc/search?mid=<uid>&ps=30
 *   GET https://api.bilibili.com/x/web-interface/view?bvid=<bvid>
 *   GET https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=<uid>
 *
 * Note: the `space/arc/search` and `space/wbi/acc/info` endpoints added a
 * WBI signature requirement in 2023. This adapter therefore uses the
 * *legacy, unsigned* endpoints where possible and degrades to "no uploads"
 * when Bilibili rejects a request, rather than crashing the sync.
 */

import { classifyItem } from "../classify";
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";

const API = "https://api.bilibili.com";

interface BiliUserCard {
  card?: {
    name?: string;
    sign?: string;
    face?: string;
    mid?: number;
    official_verify?: { desc?: string };
  };
  follower?: number;
}

interface BiliArc {
  bvid: string;
  title: string;
  description?: string;
  pic?: string;
  length?: string;
  created?: number;
  play?: number;
  author?: { mid?: number; name?: string };
}

interface BiliSearchItem {
  bvid?: string;
  aid?: number;
  title?: string;
  description?: string;
  pic?: string;
  duration?: string;
  pubdate?: number;
  play?: number;
  author?: string;
  mid?: number;
  typename?: string;
}

function biliDurationToSeconds(length: string | undefined): number | null {
  if (!length) return null;
  const parts = length.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

/** Bilibili titles carry the format `【歌】Song / Artist` — reuse the classifier. */
function classifyBili(
  title: string,
  description: string | null,
): { category: PlatformUpload["category"]; songTitle: string | null; originalArtist: string | null } {
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

export class BilibiliAdapter implements PlatformAdapter {
  readonly id: PlatformId = "bilibili";
  readonly label = "Bilibili";
  readonly color = "#fb7299";

  isConfigured(): boolean {
    // Bilibili's public read endpoints need no credentials.
    return true;
  }

  async resolve(query: string): Promise<PlatformChannel | null> {
    const handle = query.trim();
    if (!handle) return null;

    // A Bilibili space URL contains the numeric uid.
    const fromUrl = /space\.bilibili\.com\/(\d+)/.exec(handle);
    const uid = fromUrl?.[1] ?? (/^\d+$/.test(handle) ? handle : null);
    if (!uid) return null;

    try {
      const res = await fetch(`${API}/x/web-interface/card?mid=${uid}&photo=false`, {
        headers: {
          Referer: "https://www.bilibili.com/",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: BiliUserCard; code?: number };
      if (json.code !== 0 || !json.data) return null;

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
        avatar: card.face ?? null,
        description: card.sign ?? null,
        tags: [],
      };
    } catch {
      return null;
    }
  }

  async uploads(
    channel: PlatformChannel,
    limit: number,
  ): Promise<PlatformUpload[]> {
    try {
      const res = await fetch(
        `${API}/x/space/arc/search?mid=${channel.id}&ps=${Math.min(
          50,
          limit,
        )}&pn=1&order=pubdate`,
        {
          headers: {
            Referer: `https://space.bilibili.com/${channel.id}`,
            "User-Agent": "Mozilla/5.0",
          },
        },
      );
      if (!res.ok) return [];
      const json = (await res.json()) as {
        data?: { list?: { vlist?: BiliArc[] } };
        code?: number;
      };
      const list = json.data?.list?.vlist ?? [];
      if (json.code !== 0) return [];

      return list.slice(0, limit).map((arc) => {
        const classified = classifyBili(arc.title, arc.description ?? null);
        return {
          platform: "bilibili",
          id: arc.bvid,
          channelId: channel.id,
          title: arc.title,
          description: arc.description ?? null,
          thumbnail: arc.pic
            ? arc.pic.startsWith("//")
              ? `https:${arc.pic}`
              : arc.pic
            : null,
          publishedAt: arc.created ? new Date(arc.created * 1000).toISOString() : null,
          scheduledStart: null,
          duration: biliDurationToSeconds(arc.length),
          status: "past",
          category: classified.category,
          songTitle: classified.songTitle,
          originalArtist: classified.originalArtist,
          viewCount: arc.play ?? null,
          url: `https://www.bilibili.com/video/${arc.bvid}`,
        } satisfies PlatformUpload;
      });
    } catch {
      return [];
    }
  }

  async live(_channel: PlatformChannel): Promise<PlatformUpload[]> {
    // Bilibili live rooms need the room id, which is not derivable from the
    // space uid without an extra request. Skipping keeps the sync cheap.
    return [];
  }

  async search(query: string, limit: number): Promise<PlatformChannel[]> {
    try {
      const url = `${API}/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(
        query,
      )}&page=1`;
      const res = await fetch(url, {
        headers: {
          Referer: "https://search.bilibili.com/",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        data?: { result?: BiliSearchItem[] };
        code?: number;
      };
      const list = json.data?.result ?? [];
      if (json.code !== 0) return [];

      const out: PlatformChannel[] = [];
      for (const entry of list.slice(0, limit)) {
        if (!entry.mid) continue;
        out.push({
          platform: "bilibili",
          id: String(entry.mid),
          handle: String(entry.mid),
          name: entry.author ?? null,
          url: `https://space.bilibili.com/${entry.mid}`,
          subscribers: { tag: "hidden" },
          avatar: entry.pic
            ? entry.pic.startsWith("//")
              ? `https:${entry.pic}`
              : entry.pic
            : null,
          description: entry.description ?? null,
          tags: [],
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}
