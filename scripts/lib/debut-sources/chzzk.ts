/**
 * CHZZK discovery source.
 *
 * CHZZK exposes channel listings:
 *   GET https://api.chzzk.naver.com/service/v1.0/channels?categoryCode=...&size=...
 * Returns channels with channelId, channelName, profileImage, followerCount, etc.
 *
 * No authentication required for basic channel listing.
 *
 * Multiple category codes are tried (GAME, MUSIC, ETC) so music and variety
 * VTubers are not missed. Only channels whose names contain VTuber/VSinger
 * keywords are admitted — real singers are excluded.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";

const CHZZK_API = "https://api.chzzk.naver.com/service/v1.0";

/** Category codes to harvest — GAME plus MUSIC/ETC for music VTubers. */
const CATEGORY_CODES = ["GAME", "MUSIC", "ETC"];

/** VTuber / VSinger keywords — only channels matching these are kept. */
const VTUBER_KEYWORDS = [
  "vtuber",
  "vsinger",
  "버튜버",
  "버추얼",
  "가상",
  "노래방",
  "노래",
  "음악",
  "라이브",
  "커버",
  "버추얼유튜버",
  "가상유튜버",
  "버츄얼",
  "virtual youtuber",
  "virtual singer",
];

interface ChzzkChannel {
  channelId: string;
  channelName: string;
  channelImageUrl?: string;
  followerCount?: number;
  categoryValue?: string;
}

/** True when the channel looks like a VTuber / VSinger (not a real singer). */
function isVtuberChannel(ch: ChzzkChannel): boolean {
  const haystack = ch.channelName.toLowerCase();
  return VTUBER_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

export class ChzzkSource implements DebutSource {
  readonly id = "chzzk";
  readonly label = "CHZZK";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const allChannels: ChzzkChannel[] = [];
    const seen = new Set<string>();

    for (const categoryCode of CATEGORY_CODES) {
      const res = await this.fetchJson<{ content: ChzzkChannel[] }>(
        `${CHZZK_API}/channels?categoryCode=${categoryCode}&size=${this.limit}`,
      );
      if (!res?.content) continue;

      for (const ch of res.content) {
        if (!ch.channelId || seen.has(ch.channelId)) continue;
        seen.add(ch.channelId);
        allChannels.push(ch);
      }
    }

    // Filter to VTuber/VSinger only — real singers are excluded.
    const candidates: Candidate[] = [];
    for (const ch of allChannels) {
      if (!isVtuberChannel(ch)) continue;

      candidates.push({
        id: `chzzk:${ch.channelId}`,
        name: ch.channelName || null,
        handle: null,
        region: null,
        affiliation: null,
        debutDate: null,
        graduateDate: null,
        externals: { chzzk: [ch.channelId] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${CHZZK_API}/${path}`, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
          Accept: "application/json",
        },
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
