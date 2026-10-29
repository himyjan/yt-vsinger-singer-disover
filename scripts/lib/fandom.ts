/**
 * Virtual YouTuber Wiki (Fandom) — full roster import.
 *
 * The wiki exposes a public MediaWiki API — no key, no rate-limit quota of
 * consequence — and every performer page carries a `{{Character}}` infobox
 * with the fields this project needs:
 *
 *   {{Character
 *   | title1        = Sameko Saba
 *   | nick_name     = Mack the Fish Girl
 *   | debut_date    = YouTube: 2025/06/28
 *   | retirement_date =
 *   | affiliation   = Independent
 *   | channel       = [https://www.youtube.com/@SamekoSaba YouTube]
 *   | social_media  = [https://x.com/samekosaba Twitter]
 *   }}
 *
 * `title1` is the performer's name, `channel` is the YouTube channel URL
 * (a `UC…` id or a `@handle`), `social_media` can carry X/Twitter and other
 * links, `debut_date` and `retirement_date` give lifecycle dates, and
 * `affiliation` gives the agency.
 *
 * API: https://virtualyoutuber.fandom.com/api.php
 */

import { classifyChannel } from "./classify";
import { extractPlatformId, normalizeChannelId } from "./platforms";
import { profileLanguage } from "./regions";
import { splitName } from "./names";
import { isPlaceholderName } from "./platforms";
import type { Channel } from "./types";
import { isFanAccountName, detectClipAccount } from "./classify";
import { parseCharacterInfobox, parseWikiDate } from "./debut-sources/fandom";
import { toCountRef } from "./types";

const API_HOST = "virtualyoutuber.fandom.com";
const USER_AGENT = "VSingerSingerTracker/1.0 (dataset builder; +https://github.com/)";

interface WikiPage {
  pageid: number;
  title: string;
  revisions?: { slots: { main: { "*": string } } }[];
}

interface WikiResponse {
  query?: {
    pages?: Record<string, WikiPage>;
    allpages?: { pageid: number; title: string }[];
    continue?: Record<string, string>;
  };
}

/** One performer page from the wiki, reduced to what the dataset uses. */
export interface FandomVtuber {
  pageid: number;
  title: string;
  name: string | null;
  nickName: string | null;
  debutDate: string | null;
  graduateDate: string | null;
  affiliation: string | null;
  youtubeUrl: string | null;
  youtubeId: string | null;
  youtubeHandle: string | null;
  xHandle: string | null;
  socialMedia: string | null;
}

/**
 * Extracts platform ids from a YouTube URL.
 *
 * `youtube.com/channel/UC…` → the id; `youtube.com/@handle` → a handle only.
 */
function parseYouTubeIdentity(url: string | null): {
  youtubeId: string | null;
  youtubeHandle: string | null;
} {
  if (!url) return { youtubeId: null, youtubeHandle: null };
  const id = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(url)?.[1] ?? null;
  if (id) return { youtubeId: id, youtubeHandle: null };
  const handle =
    /youtube\.com\/@([\w.-]+)/i.exec(url)?.[1] ??
    /youtube\.com\/(?:c|user)\/([\w.-]+)/i.exec(url)?.[1] ??
    null;
  return { youtubeId: null, youtubeHandle: handle };
}

/**
 * Extracts X/Twitter handles from the wiki's social_media field.
 *
 * The field is free text, often `[[https://x.com/handle|Twitter]]` or a raw
 * URL. Only X/Twitter is extracted — other platforms are not in the infobox.
 */
function parseXHandle(socialMedia: string | null): string | null {
  if (!socialMedia) return null;
  const m =
    /(?:x|twitter)\.com\/([A-Za-z0-9_]{2,20})/i.exec(socialMedia);
  return m?.[1] ?? null;
}

/**
 * One MediaWiki API call.
 */
async function wikiApi(
  params: Record<string, string>,
): Promise<WikiResponse | null> {
  const url = new URL(`https://${API_HOST}/api.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as WikiResponse;
  } catch {
    return null;
  }
}

/**
 * Lists every page in the wiki main namespace.
 */
export async function listFandomPages(maxPages: number): Promise<WikiPage[]> {
  const out: WikiPage[] = [];
  let apcontinue: string | undefined;

  do {
    const res = await wikiApi({
      action: "query",
      list: "allpages",
      apnamespace: "0",
      aplimit: "100",
      apfilterredir: "nonredirects",
      ...(apcontinue ? { apcontinue } : {}),
      format: "json",
    });
    const pages = res?.query?.allpages ?? [];
    out.push(...pages);
    apcontinue = res?.query?.continue?.apcontinue;
    if (pages.length < 100) break;
    if (out.length >= maxPages) break;
  } while (apcontinue);

  return out.slice(0, maxPages);
}

/**
 * Fetches the wikitext of a batch of page titles.
 */
export async function fetchFandomWikitext(
  titles: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const res = await wikiApi({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: chunk.join("|"),
      format: "json",
    });
    for (const page of Object.values(res?.query?.pages ?? {})) {
      const text = page.revisions?.[0]?.slots?.main?.["*"];
      if (text) out.set(page.title, text);
    }
  }
  return out;
}

/**
 * Harvests all wiki pages into FandomVtuber records.
 *
 * Every page with a `{{Character}}` infobox becomes a candidate. Pages whose
 * infobox has no YouTube link and no name are skipped.
 */
export async function harvestFandom(maxPages: number): Promise<FandomVtuber[]> {
  const pages = await listFandomPages(maxPages);
  if (pages.length === 0) return [];

  const wikitext = await fetchFandomWikitext(
    pages.map((p) => p.title),
  );
  const pageById = new Map(pages.map((p) => [p.pageid, p]));

  const vtubers: FandomVtuber[] = [];
  for (const [title, text] of wikitext) {
    const infobox = parseCharacterInfobox(text);
    if (!infobox) continue;

    const name = infobox.title ?? infobox.nickName ?? title;
    if (!name || isPlaceholderName(name)) continue;

    const { youtubeId, youtubeHandle } = parseYouTubeIdentity(infobox.channel);
    const xHandle = parseXHandle(infobox.socialMedia);
    const debutDate = parseWikiDate(infobox.debutDate);
    const graduateDate = parseWikiDate(infobox.retirementDate);

    const page = [...pageById.entries()].find(
      ([, p]) => p.title === title,
    )?.[1];
    const pageid = page?.pageid ?? 0;

    vtubers.push({
      pageid,
      title,
      name,
      nickName: infobox.nickName,
      debutDate,
      graduateDate,
      affiliation: infobox.affiliation,
      youtubeUrl: infobox.channel,
      youtubeId,
      youtubeHandle,
      xHandle,
      socialMedia: infobox.socialMedia,
    });
  }

  return vtubers;
}

/**
 * Converts a harvested FandomVtuber into a Channel record, using the platform
 * (InnerTube) profile for the name, region, and classification.
 *
 * The wiki is a roster — its `affiliation` is a `virtualClaim`, and the
 * platform's profile is the authority for everything else.
 */
export function fandomVtuberToChannel(
  v: FandomVtuber,
  now: string,
): Partial<Channel> {
  const name = v.name ?? v.title;
  const aliases: string[] = [];
  if (v.nickName && v.nickName !== name) aliases.push(v.nickName);

  const id = v.youtubeId ?? `fandom:${v.pageid}`;
  const handle = v.youtubeHandle ?? v.xHandle ?? null;

  const classification = classifyChannel({
    name,
    description: v.socialMedia ?? null,
    tags: [],
    country: null,
    platform: v.youtubeId ? "youtube" : "fandom",
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
    handle,
    kind: classification.kind,
    role: classification.role,
    region: classification.region,
    regionSource: "roster",
    languages: classification.languages,
    statedLanguages: classification.statedLanguages,
    agency: classification.agency ?? null,
    affiliation: v.affiliation
      ? (v.affiliation.toLowerCase().includes("independent")
        ? "independent"
        : "group")
      : "unknown",
    avatar: null,
    banner: null,
    description: v.socialMedia ?? null,
    subscribers: { tag: "hidden" },
    videoCount: null,
    viewCount: null,
    uploadsPlaylistId: v.youtubeId ? `UU${v.youtubeId.slice(2)}` : null,
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
    activity: v.graduateDate ? "graduated" : "unknown",
    debutDate: v.debutDate ?? null,
    graduateDate: v.graduateDate ?? null,
    platforms: v.youtubeId
      ? [
          {
            platform: "youtube",
            id: v.youtubeId,
            handle: v.youtubeHandle ?? null,
            name,
            url: `https://www.youtube.com/channel/${v.youtubeId}`,
            subscribers: { tag: "hidden" },
            avatar: null,
            lastCheckedAt: now,
          },
        ]
      : [],
    externals: v.xHandle ? { twitter: v.xHandle } : {},
    popularVideoId: null,
  };
}
