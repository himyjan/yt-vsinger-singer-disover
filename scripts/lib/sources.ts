/**
 * The registry of data sources.
 *
 * Every source the project can consume is listed here with what it provides
 * and whether the pipeline actually reads it. It exists for three reasons:
 *
 * 1. **Discoverability.** A new source is one adapter plus one line here.
 * 2. **Honesty.** Some of the well-known VTuber databases are JavaScript
 *    applications with no public data endpoint, and it is worth saying so
 *    rather than silently ignoring them.
 * 3. **Provenance.** The `source` field of a record says where it came from,
 *    and this is where those values are defined.
 */

export type SourceId =
  | "youtube"
  | "twitch"
  | "bilibili"
  | "niconico"
  | "vk"
  | "vdb"
  | "taiwan-tracker"
  | "vocadb"
  | "aislist"
  | "music-dataset"
  | "wikidata"
  | "wikipedia"
  | "virtual-youtuber-wiki"
  | "hololist"
  | "bacharu"
  | "vtubie"
  | "aivtuberdb"
  | "pvc-moe"
  | "vtuber-hk"
  | "holodex"
  | "musicdex"
  | "streamscharts"
  | "justoneapi"
  | "chzzk"
  | "kick"
  | "soop"
  | "ci.me";

export interface SourceInfo {
  id: SourceId;
  label: string;
  url: string;
  /** What the source provides. */
  provides: string;
  /**
   * How the pipeline reaches it.
   *
   * `api` — a public JSON API.
   * `raw` — a plain-text or CSV file.
   * `sparql` — a query endpoint.
   * `html` — the page has to be parsed.
   * `none` — no public data endpoint; the site is a JavaScript application.
   */
  access: "api" | "raw" | "sparql" | "html" | "none";
  /** True when the pipeline actually reads it. */
  used: boolean;
  /** What it is used for. */
  usedFor?: string;
}

/**
 * The sources.
 *
 * The `used: false` entries are the well-known databases that are worth
 * knowing about but that the pipeline cannot read: they are client-side
 * applications with no public JSON, or they block automated requests.
 */
export const SOURCES: SourceInfo[] = [
  {
    id: "youtube",
    label: "YouTube Data API v3",
    url: "https://developers.google.com/youtube/v3",
    provides: "Channels, uploads, live streams, statistics, descriptions",
    access: "api",
    used: true,
    usedFor: "The primary dataset: channel details, uploads, live and upcoming streams",
  },
  {
    id: "twitch",
    label: "Twitch Helix",
    url: "https://dev.twitch.tv/docs/api/reference",
    provides: "Channels, live streams, follower counts, followed channels",
    access: "api",
    used: true,
    usedFor: "Live streams and follower counts; account linking",
  },
  {
    id: "bilibili",
    label: "Bilibili",
    url: "https://api.bilibili.com",
    provides: "VTuber channels, uploads, live streams, follower counts",
    access: "api",
    used: true,
    usedFor: "The Chinese VTuber scene — channels, uploads and follower counts",
  },
  {
    id: "niconico",
    label: "Niconico",
    url: "https://api.search.nicovideo.jp/api/v2",
    provides: "Original songs, covers, channels",
    access: "api",
    used: true,
    usedFor: "Japanese original songs and covers",
  },
  {
    id: "vk",
    label: "VK",
    url: "https://api.vk.com/method",
    provides: "Channels, videos, follower counts",
    access: "api",
    used: true,
    usedFor: "The Russian VTuber scene",
  },
  {
    id: "vdb",
    label: "vdb — the Virtual YouTuber Name List Database",
    url: "https://vdb.vtbs.moe/json/list.json",
    provides:
      "~10,100 performers with their accounts on 35 platforms, their group and their language",
    access: "api",
    used: true,
    usedFor: "The channel roster, the platform identities and the region",
  },
  {
    id: "taiwan-tracker",
    label: "Taiwan VTuber Tracking Data",
    url: "https://taiwanvtuberdata.github.io/",
    provides:
      "YouTube and Twitch ids, aliases, nationality, debut and graduation dates, activity status",
    access: "api",
    used: true,
    usedFor: "The region, the lifecycle dates and the activity status",
  },
  {
    id: "vocadb",
    label: "VocaDB",
    url: "https://vocadb.net",
    provides:
      "Artists with their platform links, their songs and their album releases",
    access: "api",
    used: true,
    usedFor: "Cross-platform links and the music side of the catalogue",
  },
  {
    id: "aislist",
    label: "AiSList",
    url: "https://github.com/Override92/AiSList",
    provides: "A community list of channels that use AI-generated content",
    access: "raw",
    used: true,
    usedFor: "The `isAi` flag",
  },
  {
    id: "music-dataset",
    label: "VTuber Music Dataset",
    url: "https://github.com/meihei3/VTuber-music-dataset",
    provides: "The song and the original artist for each cover, and the collaborators",
    access: "raw",
    used: true,
    usedFor: "Authoritative song metadata and the collaboration lists",
  },
  {
    id: "wikidata",
    label: "Wikidata",
    url: "https://query.wikidata.org/sparql",
    provides:
      "The YouTube channel id, the agency, the gender, the country and the inception date",
    access: "sparql",
    used: true,
    usedFor: "Authoritative verification — a channel-id match is a fact, not an estimate",
  },
  {
    id: "wikipedia",
    label: "Wikipedia REST API",
    url: "https://en.wikipedia.org/api/rest_v1/",
    provides: "A one-line description, the lead paragraph and the infobox image",
    access: "api",
    used: true,
    usedFor: "A human-written description and a verified avatar",
  },
  {
    id: "virtual-youtuber-wiki",
    label: "Virtual YouTuber Wiki",
    url: "https://virtualyoutuber.fandom.com/api.php",
    provides: "Wiki identities, debut dates, agencies",
    access: "api",
    used: false,
    usedFor: "Available through the debut discovery; not wired into the roster yet",
  },
  {
    id: "hololist",
    label: "HoloList",
    url: "https://hololist.net",
    provides:
      "9,359 V-Tuber / V-Streamer / V-Singer / V-UP entries with the debut date, birthday, height, affiliation, languages, gender, model, status and the performer's own links",
    access: "html",
    used: true,
    usedFor:
      "New channels, the agency and languages it states, and the Twitch / X / Instagram / TikTok / Bilibili / Niconico accounts of records it already tracks",
  },
  {
    id: "bacharu",
    label: "bacharu",
    url: "https://bacharu.io",
    provides:
      "A Japanese VTuber directory: about 110,000 performers with their group, country, debut, status and YouTube account",
    access: "api",
    used: true,
    usedFor:
      "The YouTube channel id and group of every performer it lists, and the handle-only and linkless rows `--resolve-handles` and `--search-names` can still reach",
  },
  {
    id: "vtubie",
    label: "vTubie",
    url: "https://vtubie.com/allvtubers/",
    provides:
      "A directory of roughly 20,000 VTubers and VStreamers, ten per page",
    access: "html",
    used: true,
    usedFor:
      "New performers through `npm run data:discover` (and `--promote` for the ones that pass the virtual-and-singing gate) — the pages sit behind a Cloudflare challenge, so they are read with a browser (puppeteer-core, optional)",
  },
  {
    id: "aivtuberdb",
    label: "AI VTuber Database",
    url: "https://aivtuberdb.com",
    provides: "A list of AI-generated VTubers",
    access: "none",
    used: false,
    usedFor:
      "Worth reading for the AI flag, but it publishes no machine-readable file",
  },
  {
    id: "pvc-moe",
    label: "PVC.moe",
    url: "https://pvc.moe",
    provides: "VTuber profile data",
    access: "none",
    used: false,
    usedFor: "The data is only in the client bundle",
  },
  {
    id: "vtuber-hk",
    label: "VTuber.hk",
    url: "https://vtuber.hk",
    provides:
      "672 Hong Kong YouTube channels with their state (活動中 / 準備中 / 己引退), plus a channels.json dump carrying the description, country and the three counts",
    access: "html",
    used: true,
    usedFor:
      "Hong Kong channels, their graduation state, and the total view / video / subscriber counts InnerTube does not publish",
  },
  {
    id: "holodex",
    label: "Holodex",
    url: "https://holodex.net",
    provides:
      "A YouTube VTuber stream index: live and upcoming streams, channels and organisations, a clip index, and the VOD data behind them",
    access: "api",
    used: false,
    usedFor:
      "A comparison reference, not a source: the clip index, mentions, subber relations and Multiview are the depth this project does not build. Ingestion would need an API v2 key (`HOLODEX_API_KEY`); every endpoint answers 403 without one and no fixed quota is published",
  },
  {
    id: "musicdex",
    label: "Musicdex (Music Holodex)",
    url: "https://music.holodex.net",
    provides:
      "Songs and set lists tagged out of singing streams, with playlists by performer and organisation",
    access: "api",
    used: false,
    usedFor:
      "A comparison reference for song-level tagging, which this project classifies but does not tag; the song and original-artist metadata is read from the VTuber Music Dataset and VocaDB instead",
  },
  {
    id: "chzzk",
    label: "CHZZK — Naver's streaming platform",
    url: "https://chzzk.naver.com",
    provides:
      "Korean VTuber channels, descriptions, follower counts and live streams",
    access: "api",
    used: true,
    usedFor:
      "The Korean VTuber scene — the largest one after Japan and China",
  },
  {
    id: "kick",
    label: "KICK",
    url: "https://kick.com",
    provides:
      "Channel profiles, profile pictures, follower counts, the performer's published accounts and live streams",
    access: "api",
    used: true,
    usedFor:
      "The growing Western VTuber scene on KICK; category discovery needs an app access token, so known logins are refreshed",
  },
  {
    id: "soop",
    label: "SOOP live broadcast list",
    url: "https://live.sooplive.co.kr/api/main_broad_list_api.php",
    provides: "Public live broadcast titles, channel names and viewer counts",
    access: "api",
    used: true,
    usedFor:
      "Live channels in the public list; offline channel profiles are not available from a verified endpoint",
  },
  {
    id: "ci.me",
    label: "CI.ME Open API",
    url: "https://developers.ci.me/docs/api-channels",
    provides:
      "Channel names, handles, profile images, descriptions and follower counts; per-channel live status",
    access: "api",
    used: true,
    usedFor:
      "Profile refresh for CI.ME channel IDs (20 per request; app Client ID and Client Secret are required) and live status from the public, unauthenticated live-status endpoint",
  },
  {
    id: "justoneapi",
    label: "JustOneAPI",
    url: "https://github.com/justoneapi/justoneapi-python",
    provides:
      "A hosted API over YouTube, Bilibili, TikTok, Douyin, Weibo and more",
    access: "api",
    used: false,
    usedFor:
      "A token-based proxy for the platforms whose public endpoints are protected. It is a paid service, so the pipeline prefers the free sources — but its generated resources are a good catalogue of which endpoints exist",
  },
  {
    id: "streamscharts",
    label: "Streams Charts",
    url: "https://streamscharts.com/vtubers",
    provides: "Channel statistics and follower counts",
    access: "none",
    used: false,
    usedFor: "Blocks automated requests",
  },
];

/** The sources the pipeline reads. */
export const ACTIVE_SOURCES = SOURCES.filter((s) => s.used);

/** A short summary, for the CLI and the docs. */
export function describeSources(): string {
  const used = ACTIVE_SOURCES.length;
  const known = SOURCES.length;
  return `${used} of ${known} known sources are read by the pipeline`;
}
