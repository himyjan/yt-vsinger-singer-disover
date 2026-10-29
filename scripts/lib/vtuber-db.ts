/**
 * VtuberDB (vtuberdb.com) — a Japanese VTuber database wiki.
 *
 * The site runs MediaWiki with the Cargo extension. The `Vtubers` table
 * carries the performer's name, kana reading, affiliation and debut date;
 * `StatusHistory` carries the activity status (active / graduated / …).
 *
 * The Cargo API does NOT publish social media links (YouTube, Twitter, etc.),
 * so every entry needs a YouTube name search to find its `UC…` channel id.
 * That search costs Data API quota (or an InnerTube request), which is why
 * vtuberdb is a supplementary source, not a primary one.
 *
 * API: https://vtuberdb.com/api.php
 */

import { classifyChannel } from "./classify";
import { profileLanguage } from "./regions";
import { splitName } from "./names";
import { isPlaceholderName } from "./platforms";
import type { Channel } from "./types";
import { toCountRef } from "./types";

const API_HOST = "vtuberdb.com";
const USER_AGENT = "VSingerSingerTracker/1.0 (dataset builder; +https://github.com/)";

interface CargoResponse {
  cargoquery?: Array<{ title: Record<string, string> }>;
  error?: { code: string; info: string };
}

/** One performer from the Vtubers table. */
export interface VtuberDbEntry {
  pageName: string;
  displayName: string | null;
  kana: string | null;
  affiliation: string | null;
  debutDate: string | null;
  status: string | null;
  statusStartDate: string | null;
  statusEndDate: string | null;
}

/**
 * One MediaWiki Cargo API call.
 */
async function cargoApi(params: Record<string, string>): Promise<CargoResponse | null> {
  const url = new URL(`https://${API_HOST}/api.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as CargoResponse;
  } catch {
    return null;
  }
}

/**
 * Harvests all VTubers from the Cargo tables.
 *
 * Queries Vtubers joined with StatusHistory, filtering to performers whose
 * status period is currently open (EndDate IS NULL or empty), i.e. active
 * or graduated-but-not-replaced entries.
 */
export async function harvestVtuberDb(limit: number): Promise<VtuberDbEntry[]> {
  const offsetStep = 50;
  const entries: VtuberDbEntry[] = [];
  let offset = 0;

  while (entries.length < limit) {
    const res = await cargoApi({
      action: "cargoquery",
      tables: "Vtubers,StatusHistory",
      join_on: "Vtubers._pageID=StatusHistory._pageID",
      fields:
        "Vtubers.DisplayName,Vtubers.Kana,Vtubers.Affiliation,Vtubers.DebutDate," +
        "StatusHistory.Status,StatusHistory.StartDate,StatusHistory.EndDate",
      where: "(StatusHistory.EndDate IS NULL OR StatusHistory.EndDate = '')",
      order_by: "Vtubers.DebutDate DESC",
      limit: String(Math.min(offsetStep, limit - entries.length)),
      offset: String(offset),
      format: "json",
    });

    const rows = res?.cargoquery ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      const t = row.title;
      entries.push({
        pageName: t._pageName ?? "",
        displayName: t.DisplayName ?? null,
        kana: t.Kana ?? null,
        affiliation: t.Affiliation ?? null,
        debutDate: t.DebutDate ?? null,
        status: t.Status ?? null,
        statusStartDate: t.StartDate ?? null,
        statusEndDate: t.EndDate ?? null,
      });
    }

    offset += offsetStep;
    if (rows.length < offsetStep) break;
  }

  return entries.slice(0, limit);
}

/**
 * Converts a VtuberDbEntry into a Channel record skeleton.
 *
 * vtuberdb has no YouTube id, so the record is keyed by `vtuber-db:<pageName>`
 * and must be matched to a YouTube channel through a name search (see
 * `scripts/import-vtuber-db.ts`).
 */
export function vtuberDbEntryToChannel(
  e: VtuberDbEntry,
  now: string,
): Partial<Channel> {
  const name = e.displayName ?? e.pageName;
  if (!name || isPlaceholderName(name)) return {} as Partial<Channel>;

  const id = `vtuber-db:${e.pageName}`;
  const aliases: string[] = [];
  if (e.kana && e.kana !== name) aliases.push(e.kana);

  const classification = classifyChannel({
    name,
    description: null,
    tags: [],
    country: null,
    platform: "vtuber-db",
    virtualClaim: "roster",
    hasAvatar: false,
  });

  const gender =
    classification.gender !== "unknown" ? classification.gender : "unknown";

  return {
    id,
    name,
    nameSource: "roster",
    aliases: aliases.slice(0, 12),
    handle: null,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    regionSource: "roster",
    languages: classification.languages,
    statedLanguages: classification.statedLanguages,
    agency: classification.agency ?? null,
    affiliation: e.affiliation
      ? (e.affiliation.toLowerCase().includes("independent")
        ? "independent"
        : "group")
      : "unknown",
    avatar: null,
    banner: null,
    description: null,
    subscribers: { tag: "hidden" },
    videoCount: null,
    viewCount: null,
    uploadsPlaylistId: null,
    country: null,
    tags: [],
    isSinging: classification.isSinging,
    gender,
    isAi: classification.isAi,
    isOfficialArtist: false,
    officialArtistCheckedAt: null,
    variant: classification.variant,
    verification: null,
    source: "api",
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: null,
    activity: e.status?.includes("卒") || e.status?.includes("graduated")
      ? "graduated"
      : e.status?.includes("活動")
        ? "active"
        : "unknown",
    debutDate: e.debutDate ?? null,
    graduateDate: null,
    platforms: [],
    externals: {},
    popularVideoId: null,
  };
}
