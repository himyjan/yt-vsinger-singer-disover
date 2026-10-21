/**
 * vdb — the Virtual YouTuber Name List Database.
 *
 * Source: https://vdb.vtbs.moe
 * Data:   https://vdb.vtbs.moe/json/list.json
 *
 * A community-maintained roster of **~10,000 VTubers**, and the most
 * complete cross-platform catalogue available for free. Each record looks
 * like this:
 *
 * ```jsonc
 * {
 *   "uuid": "8e9b02ae-78ba-5f8b-b825-0c0af068abb7",
 *   "type": "vtuber",          // vtuber | group | fan | misc
 *   "bot": false,              // true for AI / bot accounts
 *   "accounts": [
 *     { "id": "UCoO6PIMIwatyMWRp7l6CvKQ", "type": "official", "platform": "youtube" },
 *     { "id": "333325107",       "type": "official", "platform": "bilibili" },
 *     { "id": "90274745",        "type": "official", "platform": "niconico" }
 *   ],
 *   "name": { "cn": "A.I.D", "en": "A.I.D", "default": "en" },
 *   "group": "…", "group_name": "…"
 * }
 * ```
 *
 * ## Why it matters here
 *
 * - **10,134 performers**, mostly Chinese, where the other sources are thin.
 * - **`name.default` is the performer's own language**, which is an
 *   *authoritative* region signal — far better than inferring one from
 *   characters shared between Japanese and Chinese.
 * - **`bot` marks AI performers**, which is exactly the `isAi` flag the
 *   project needs.
 * - **`accounts[]` spans 35 platforms**, and `meta.linkSyntax` gives the URL
 *   template for each one — so the "all links" block can be filled in for
 *   performers who have no YouTube channel at all.
 */

import { detectLanguage } from "./regions";
import { classifyChannel } from "./classify";
import type { ArtistKind, PlatformId, RegionCode } from "./types";
import type { PlatformLink } from "./types";

const LIST_URL = "https://vdb.vtbs.moe/json/list.json";

interface VdbAccount {
  id: string;
  type: string;
  platform: string;
}

interface VdbRecord {
  uuid: string;
  type: string;
  bot: boolean;
  accounts: VdbAccount[];
  name: {
    default?: string;
    cn?: string;
    jp?: string;
    en?: string;
    extra?: string[];
    [key: string]: unknown;
  };
  group?: string;
  group_name?: string;
}

interface VdbFile {
  meta?: {
    linkSyntax?: Record<string, string>;
  };
  vtbs?: VdbRecord[];
}

/** Maps vdb's platform keys onto this project's platform ids. */
const PLATFORM_MAP: Record<string, PlatformId | "other"> = {
  youtube: "youtube",
  youtubeAt: "youtube",
  twitch: "twitch",
  bilibili: "bilibili",
  niconico: "niconico",
  vk: "vk",
  acfun: "bilibili",
};

/**
 * Maps the language a performer lists as their default onto a region.
 *
 * This is the authoritative region signal vdb provides — the performer's own
 * listing says which language they perform in.
 */
const REGION_BY_LANGUAGE: Record<string, RegionCode> = {
  cn: "cn",
  CN: "cn",
  Cn: "cn",
  "zh-cn": "cn",
  "cn+": "cn",
  cnen: "en",
  jp: "jp",
  JP: "jp",
  en: "en",
  EN: "en",
  ID: "id",
  "ID(印度尼西亚)": "id",
  kr: "kr",
  KR: "kr",
};

export interface VdbVTuber {
  /** vdb's own uuid. */
  uuid: string;
  /** The canonical channel id for this project. */
  id: string;
  /** Display name. */
  name: string;
  /** Alternative names. */
  aliases: string[];
  /** `virtual` | `real`. */
  kind: ArtistKind;
  /** The region, from the performer's own language listing. */
  region: RegionCode;
  /** How the region was determined. */
  regionSource: "declared" | "platform" | "script";
  /** Agency or group. */
  group: string | null;
  /** True for AI / bot accounts. */
  isAi: boolean;
  /** True for fan or clip channels. */
  isAggregator: boolean;
  /** Every platform identity. */
  platforms: PlatformLink[];
}

/** Locale keys that vdb sometimes records as the performer's name. */
const LOCALE_KEYS = new Set([
  "cn", "jp", "en", "id", "kr", "zh-cn", "zh-hant", "cn+", "cnen",
]);

export class VdbSource {
  private cache: VdbVTuber[] | null = null;
  private linkSyntax: Record<string, string> = {};

  /** Fetches and parses the roster. Cached for the process lifetime. */
  async fetch(): Promise<VdbVTuber[]> {
    if (this.cache) return this.cache;

    try {
      const res = await fetch(LIST_URL, {
        headers: {
          Accept: "application/json",
          "User-Agent": "VSingerSingerTracker/1.0",
        },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as VdbFile;
      this.linkSyntax = json.meta?.linkSyntax ?? {};

      const out: VdbVTuber[] = [];
      for (const record of json.vtbs ?? []) {
        const parsed = this.parse(record);
        if (parsed) out.push(parsed);
      }
      this.cache = out;
      return out;
    } catch {
      return [];
    }
  }

  private buildUrl(platform: string, id: string): string {
    const template = this.linkSyntax[platform];
    if (!template) return `https://${platform}/${id}`;
    return template.replace("{id}", encodeURIComponent(id));
  }

  private parse(record: VdbRecord): VdbVTuber | null {
    const names = record.name ?? {};
    const name =
      (typeof names.cn === "string" && names.cn) ||
      (typeof names.jp === "string" && names.jp) ||
      (typeof names.en === "string" && names.en) ||
      names.default ||
      "";
    if (!name || typeof name !== "string") return null;

    // Some vdb entries have the locale key as the name (`name.cn === "cn"`).
    // Those are malformed records, not performers.
    if (LOCALE_KEYS.has(name.trim().toLowerCase())) return null;

    const aliases = Array.isArray(names.extra)
      ? names.extra.filter((n): n is string => typeof n === "string")
      : [];

    /* --- platform identities ------------------------------------------- */
    const platforms: PlatformLink[] = [];
    for (const account of record.accounts ?? []) {
      if (!account?.id) continue;
      const mapped = PLATFORM_MAP[account.platform];
      if (mapped === undefined || mapped === "other") continue;

      const url = this.buildUrl(account.platform, account.id);
      platforms.push({
        platform: mapped,
        id: account.id,
        // A `youtube` account id is a channel id; a `youtubeAt` one is a
        // handle.
        handle: account.platform === "youtubeAt" ? account.id : null,
        name,
        url,
        subscribers: { tag: "hidden" },
        avatar: null,
        activity: "unknown",
        lastCheckedAt: new Date().toISOString(),
      });
    }

    /* --- the canonical id ---------------------------------------------- */
    const youtube = platforms.find((p) => p.platform === "youtube");
    const id = youtube
      ? youtube.id.startsWith("UC")
        ? youtube.id
        : `youtube:${youtube.id}`
      : platforms[0]
        ? `${platforms[0].platform}:${platforms[0].id}`
        : `vdb:${record.uuid}`;

    /* --- region ---------------------------------------------------------- */
    /**
     * Three sources, in order of authority:
     *
     * 1. `name.default` — the performer's own listing of their language.
     *    This is authoritative.
     * 2. The platform the performer is on — a channel that only exists on
     *    Bilibili is mainland Chinese, one that only exists on Niconico is
     *    Japanese. This matters because a Chinese name written entirely in
     *    characters shared with Japanese (「樱咲奈央」, 「川烈」) would
     *    otherwise be read as Japanese.
     * 3. Script detection on the name — the weakest signal.
     */
    const defaultLanguage =
      typeof names.default === "string" ? names.default : "";
    let region: RegionCode = "unknown";
    let regionSource: "declared" | "platform" | "script" = "declared";

    /**
     * The platform comes **first**.
     *
     * `name.default` says which of the performer's name variants to display,
     * which is a good proxy for their primary language — but a Chinese
     * performer who uses a Japanese stage name would be listed as `jp`, and
     * would then be filed in the wrong region.
     *
     * A performer who *only* exists on Bilibili is a mainland Chinese
     * VTuber, and one who only exists on Niconico is Japanese. That is a
     * statement about where they stream, which is what the region means.
     */
    const platformSet = new Set(platforms.map((p) => p.platform));
    if (platformSet.size === 1) {
      const only = [...platformSet][0];
      if (only === "bilibili") {
        region = "cn";
        regionSource = "platform";
      } else if (only === "niconico") {
        region = "jp";
        regionSource = "platform";
      }
    }

    if (region === "unknown") {
      region = REGION_BY_LANGUAGE[defaultLanguage] ?? "unknown";
    }

    if (region === "unknown") {
      const lang = detectLanguage(name);
      if (lang === "ja") region = "jp";
      else if (lang === "ko") region = "kr";
      else if (lang === "zh-Hans") region = "cn";
      else if (lang === "zh-Hant") region = "tw";
      else if (lang === "en") region = "en";
      regionSource = "script";
    }

    /* --- kind and role --------------------------------------------------- */
    const classification = classifyChannel({
      name,
      description: null,
      tags: [],
      country: null,
    });

    return {
      uuid: record.uuid,
      id,
      name,
      aliases,
      kind: "virtual",
      region,
      regionSource,
      group: record.group_name ?? record.group ?? null,
      isAi: record.bot === true,
      isAggregator: record.type === "fan" || record.type === "misc",
      platforms,
    };
  }
}
