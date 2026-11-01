/**
 * VTuber-index discovery source.
 *
 * vtuber-index.com publishes VTuber channel data via a public JSON API:
 *   POST https://www.vtuber-index.com/index.cgi with body `api=get_channels`
 *
 * Each entry carries a YouTube channel id, name, group, country, debut date,
 * subscriber count, video count, and more. No authentication required.
 *
 *   npm run data:vtuber-index              # harvest VTuber candidates
 *
 * Nothing here writes data/ — adding the channels is a separate step
 * through `npm run data:vtuber-index-import`.
 */

import { fetchJson } from "../io";
import type { Candidate } from "../identity";
import type { DebutSource } from "./types";
import type { RegionCode } from "../types";

const API_URL = "https://www.vtuber-index.com/index.cgi";

interface VtuberIndexEntry {
  id: string;
  channel_id: string;
  name: string;
  group: string;
  subscriber: number;
  view_count: number;
  video_count: number;
  video_live_count: number;
  spc_data_count: number;
  country: string;
  member_fee: string;
  image_url: string;
  first_video_date: string;
  last_video_date: string | null;
  retirement_date: string | null;
}

export class VtuberIndexSource implements DebutSource {
  readonly id = "vtuber-index";
  readonly label = "VTuber Index";

  constructor(private readonly limit = 200) {}

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async fetch(_since: string | null): Promise<Candidate[]> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
        Accept: "application/json",
      },
      body: "api=get_channels",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as VtuberIndexEntry[];
    const candidates: Candidate[] = [];
    for (const ch of data.slice(0, this.limit)) {
      if (!ch.channel_id) continue;

      candidates.push({
        id: `vtuber-index:${ch.channel_id}`,
        name: ch.name || null,
        handle: null,
        region: (ch.country ?? null) as RegionCode | null | undefined,
        affiliation: (ch.group ?? null) as string | null,
        debutDate: entryToDebutDate(ch),
        graduateDate: entryToGradDate(ch),
        externals: { youtube: [ch.channel_id] },
        wikiPage: null,
        source: this.id,
      });
    }

    return candidates;
  }
}

/** Converts debutDate string to ISO date string, or null if missing. */
function entryToDebutDate(ch: VtuberIndexEntry): string | null {
  if (!ch.first_video_date) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(ch.first_video_date);
  if (!m) return null;
  const [, y, mo, d] = m;
  const yNum = Number(y);
  const mNum = Number(mo);
  const dNum = Number(d);
  if (!yNum || !mNum || !dNum || mNum > 12 || dNum > 31) return null;
  return new Date(Date.UTC(yNum, mNum - 1, dNum)).toISOString().slice(0, 10);
}

/** Converts graduation/retirement date to ISO date string, or null if missing. */
function entryToGradDate(ch: VtuberIndexEntry): string | null {
  if (!ch.retirement_date) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(ch.retirement_date);
  if (!m) return null;
  const [, y, mo, d] = m;
  const yNum = Number(y);
  const mNum = Number(mo);
  const dNum = Number(d);
  if (!yNum || !mNum || !dNum || mNum > 12 || dNum > 31) return null;
  return new Date(Date.UTC(yNum, mNum - 1, dNum)).toISOString().slice(0, 10);
}
