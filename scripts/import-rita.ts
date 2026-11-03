#!/usr/bin/env tsx
/**
 * Compares a vt.rita.moe harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-rita.ts` produces a snapshot in `.cache/rita/rita.json`;
 * this script reads that snapshot, matches each row against the dataset by
 * YouTube channel id (or another platform id when there is no YouTube),
 * classifies through classifyChannel(), and imports the ones that are not
 * clip / fan accounts into `data/channels/`.
 *
 *   npm run data:rita-import                     # report only
 *   npm run data:rita-import -- --apply          # import the new channels
 *
 * vt.rita.moe publishes platform ids for each entry, so matching is direct
 * (no search required). Entries keyed by `twitch:<id>`, `kick:<id>` and so on
 * that also have a YouTube channel are merged with that record; platform-only
 * performers are created as `<platform>:<id>` records.
 *
 * The roster files every entry as a performer, which is the virtual-creator
 * claim; what it must not buy is a fan or clip account, so
 * `detectClipAccount()` and `isFanAccountName()` must both be false.
 *
 *   npm run data:rita-import                     # report only
 *   npm run data:rita-import -- --apply          # import the new channels
 */

import fs from "node:fs";
import path from "node:path";
import {
  detectAffiliation,
  detectClipAccount,
  isFanAccountName,
  classifyChannel,
  deriveVariant,
} from "../scripts/lib/classify";
import { applyChannelEdits } from "../scripts/lib/roster-fill";
import {
  readAllChannelRecords,
  writeChannelShards,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
} from "../scripts/lib/dataset";
import { acquireRunLock } from "../scripts/lib/io";
import {
  normalizeChannelId,
  isPlaceholderName,
  isPlaceholderAvatar,
} from "../scripts/lib/platforms";
import {
  canonicalAgency,
  normalizeCountry,
  REGION_LANGUAGE,
} from "../scripts/lib/regions";
import { splitName } from "../scripts/lib/names";
import type {
  Channel,
  Gender,
  PlatformId,
  RegionCode,
} from "../scripts/lib/types";
import { toCountRef } from "../scripts/lib/types";

const SNAPSHOT = ".cache/rita/rita.json";

/** Shape of a curated override from data/overrides.json, keyed by channel id. */
interface ChannelOverride {
  kind?: Channel["kind"];
  role?: Channel["role"];
  region?: Channel["region"];
  agency?: string | null;
  gender?: Gender;
  isSinging?: boolean;
}

const YT_CHANNEL = /youtube\.com\/channel\/(UC[\w-]{22})/i;

const LANG_TITLE_TO_CODE: Record<string, string> = {
  english: "en",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
  spanish: "es",
  portuguese: "pt",
  russian: "ru",
  thai: "th",
  vietnamese: "vi",
  indonesian: "id",
  malay: "ms",
  filipino: "fil",
  tagalog: "tl",
  hindi: "hi",
  arabic: "ar",
  french: "fr",
  german: "de",
  italian: "it",
  dutch: "nl",
};

interface RitaTag {
  id: number;
  group: string;
  title: string;
  color: string;
}

interface RitaLink {
  title: string;
  url: string;
}

interface RitaEntry {
  id: number;
  name: string;
  avatar: string | null;
  twitch: string | null;
  twitch_id: string | null;
  youtube: string | null;
  youtube_id: string | null;
  bilibili: string | null;
  chzzk: string | null;
  kick: string | null;
  kick_id: string | null;
  rplay: string | null;
  rplay_id: string | null;
  fansly: string | null;
  soopkr: string | null;
  links: RitaLink[];
  tags: RitaTag[];
}

interface Row {
  entry: RitaEntry;
  id: string | null;
  record: Channel | null | undefined;
  verdict: "tracked" | "new" | "rejected";
  reason?: string;
}

interface Options {
  apply: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:rita-import [--apply] [--limit <n>]",
            "",
            "  --apply    import the channels the gate admits",
            "  --limit <n>  import at most n channels",
          ].join("\n")
        );
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return options;
}

/** The canonical dataset id for one entry: YouTube first (rule #4), then any
 * platform id, then the roster id. */
function canonicalId(entry: RitaEntry): { id: string; primary: PlatformId } {
  if (entry.youtube_id)
    return { id: normalizeChannelId(entry.youtube_id), primary: "youtube" };
  const ytFromLinks = youtubeIdFromLinks(entry.links);
  if (ytFromLinks)
    return { id: normalizeChannelId(ytFromLinks), primary: "youtube" };
  if (entry.twitch_id) return { id: `twitch:${entry.twitch_id}`, primary: "twitch" };
  if (entry.kick_id) return { id: `kick:${entry.kick_id}`, primary: "kick" };
  if (entry.rplay_id) return { id: `rplay:${entry.rplay_id}`, primary: "rplay" };
  if (entry.bilibili)
    return { id: `bilibili:${entry.bilibili}`, primary: "bilibili" };
  if (entry.chzzk)
    return { id: `chzzk:${entry.chzzk}`, primary: "chzzk" };
  if (entry.soopkr) return { id: `soop:${entry.soopkr}`, primary: "soop" };
  return { id: `rita:${entry.id}`, primary: "rita" };
}

function youtubeIdFromLinks(links: RitaLink[] | undefined): string | null {
  for (const link of links ?? []) {
    const m = YT_CHANNEL.exec(link.url);
    if (m) return m[1];
  }
  return null;
}

function primaryHandle(entry: RitaEntry, primary: PlatformId): string | null {
  switch (primary) {
    case "youtube":
      return entry.youtube ?? null;
    case "twitch":
      return entry.twitch ?? null;
    case "kick":
      return entry.kick ?? null;
    case "rplay":
      return entry.rplay ?? null;
    case "bilibili":
      return entry.bilibili ?? null;
    case "chzzk":
      return entry.chzzk ?? null;
    case "soop":
      return entry.soopkr ?? null;
    default:
      return null;
  }
}

/** Every platform identity the entry publishes, as `PlatformLink`s. */
function buildPlatformLinks(
  entry: RitaEntry,
  avatar: string | null,
  now: string,
): Channel["platforms"] {
  const links: Channel["platforms"] = [];
  let avatarAssigned = false;
  const assignAvatar = () => {
    if (!avatarAssigned && avatar) {
      avatarAssigned = true;
      return avatar;
    }
    return null;
  };
  const add = (
    platform: PlatformId,
    id: string | null,
    handle: string | null,
    url: string | null,
  ) => {
    if (!id && !handle && !url) return;
    links.push({
      platform,
      id: id ?? handle ?? "",
      handle: handle ? handle.replace(/^@+/, "") : null,
      name: entry.name,
      url: url ?? "",
      subscribers: { tag: "hidden" },
      avatar: assignAvatar(),
      lastCheckedAt: now,
    });
  };

  const primaryYt = entry.youtube_id ? normalizeChannelId(entry.youtube_id) : null;
  if (primaryYt) {
    add(
      "youtube",
      entry.youtube_id,
      entry.youtube,
      `https://www.youtube.com/channel/${primaryYt}`,
    );
  }
  // Extra YouTube channels the entry links to (highlights, VODs, …).
  for (const link of entry.links ?? []) {
    const m = YT_CHANNEL.exec(link.url);
    if (m) {
      const uc = normalizeChannelId(m[1]);
      if (uc && uc !== primaryYt) {
        add("youtube", uc, null, `https://www.youtube.com/channel/${uc}`);
      }
    }
  }

  if (entry.twitch_id) {
    add(
      "twitch",
      entry.twitch_id,
      entry.twitch,
      `https://www.twitch.tv/${entry.twitch ?? ""}`,
    );
  } else if (entry.twitch) {
    add("twitch", null, entry.twitch, `https://www.twitch.tv/${entry.twitch}`);
  }
  if (entry.bilibili) {
    add(
      "bilibili",
      entry.bilibili,
      entry.bilibili,
      `https://space.bilibili.com/${entry.bilibili}`,
    );
  }
  if (entry.chzzk) {
    add("chzzk", entry.chzzk, entry.chzzk, `https://chzzk.naver.com/${entry.chzzk}`);
  }
  if (entry.kick_id) {
    add(
      "kick",
      entry.kick_id,
      entry.kick,
      `https://kick.com/${entry.kick ?? ""}`,
    );
  } else if (entry.kick) {
    add("kick", null, entry.kick, `https://kick.com/${entry.kick}`);
  }
  if (entry.rplay_id) {
    add(
      "rplay",
      entry.rplay_id,
      entry.rplay,
      `https://rplay.live/creatorhome/${entry.rplay_id}`,
    );
  }
  if (entry.fansly) {
    add("fansly", null, entry.fansly, `https://fansly.com/live/${entry.fansly}`);
  }
  if (entry.soopkr) {
    add(
      "soop",
      entry.soopkr,
      entry.soopkr,
      `https://www.sooplive.com/station/${entry.soopkr}`,
    );
  }
  return links;
}

/** Social handles and other addresses from the entry's link list. */
function buildExternals(entry: RitaEntry): Record<string, string> {
  const out: Record<string, string> = {};
  let webIndex = 1;
  for (const link of entry.links ?? []) {
    const url = link.url;
    if (!url) continue;
    const lower = url.toLowerCase();
    if (/youtube\.com|youtu\.be/.test(lower)) continue;

    const social = socialHandle(lower);
    if (social) {
      if (!out[social.platform]) out[social.platform] = social.handle;
    } else {
      const key = `web:${webIndex++}`;
      out[key] = url;
    }
  }
  return out;
}

function socialHandle(
  lower: string,
): { platform: string; handle: string } | null {
  const m = lower.match(
    /(?:twitter|x)\.com\/(?:i\/user\/(\d+)|([A-Za-z0-9_]{1,20}))/,
  );
  if (m) return { platform: "twitter", handle: m[1] ?? m[2] };
  const m2 = lower.match(/tiktok\.com\/@([A-Za-z0-9_.]{1,30})/);
  if (m2) return { platform: "tiktok", handle: m2[1] };
  const m3 = lower.match(/instagram\.com\/([A-Za-z0-9_.]{1,30})/);
  if (m3) return { platform: "instagram", handle: m3[1] };
  const m4 = lower.match(
    /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([A-Za-z0-9-]+)/,
  );
  if (m4) return { platform: "discord", handle: m4[1] };
  const m5 = lower.match(/fansly\.com\/(?:live\/)?([A-Za-z0-9_.]{1,30})/);
  if (m5) return { platform: "fansly", handle: m5[1] };
  return null;
}

/** Language titles the directory publishes, as ISO 639-1 codes. */
function langTitleToCode(title: string | null | undefined): string | null {
  if (!title) return null;
  return LANG_TITLE_TO_CODE[title.trim().toLowerCase()] ?? null;
}

function tagTitles(entry: RitaEntry, group: string): string[] {
  return entry.tags
    .filter((t) => t.group === group)
    .map((t) => t.title)
    .filter(Boolean);
}

function recordFromRitaEntry(
  entry: RitaEntry,
  now: string,
  override?: ChannelOverride,
): Channel | null {
  const name = (entry.name ?? "").trim();
  if (!name || isPlaceholderName(name)) return null;

  const { id, primary } = canonicalId(entry);

  const countryTag = tagTitles(entry, "country")[0] ?? null;
  const country = normalizeCountry(countryTag);

  const statedLangs: string[] = [];
  const langCode = langTitleToCode(tagTitles(entry, "lang")[0] ?? undefined);
  if (langCode) statedLangs.push(langCode);

  const genreTags = tagTitles(entry, "genre");
  const modelTags = tagTitles(entry, "model");
  const threadTags = tagTitles(entry, "thread");
  const otherTags = tagTitles(entry, "other");
  const classifierTags = [...genreTags, ...modelTags, ...threadTags, ...otherTags];

  const groupTag = tagTitles(entry, "group")[0] ?? null;

  const classification = classifyChannel({
    name,
    description: null,
    tags: classifierTags,
    country,
    platform: primary,
    virtualClaim: "roster",
    hasAvatar: !!(
      entry.avatar && !isPlaceholderAvatar(entry.avatar)
    ),
    override: override
      ? {
          kind: override.kind,
          role: override.role,
          region: override.region,
          agency: override.agency,
          isSinging: override.isSinging,
          curated: !!(
            override.kind ||
            override.role ||
            override.isSinging !== undefined
          ),
        }
      : undefined,
  });

  const agency = canonicalAgency(
    classification.agency ?? (groupTag ?? null),
  );
  const affiliation = detectAffiliation(name, null, agency);

  const gender: Gender =
    override?.gender ??
    (classification.gender !== "unknown" ? classification.gender : "unknown");

  const avatar = entry.avatar && !isPlaceholderAvatar(entry.avatar)
    ? entry.avatar
    : null;

  const handle = primaryHandle(entry, primary);
  const aliases = splitName(name).filter((part) => part !== name);

  const region: RegionCode = classification.region;
  const languages: string[] = statedLangs.length
    ? statedLangs
    : [REGION_LANGUAGE[region] ?? null]
        .filter((l): l is string => !!l);

  return {
    id,
    name,
    nameSource: "roster",
    aliases: aliases.slice(0, 12),
    handle,
    kind: classification.kind,
    role: classification.role,
    region,
    regionSource: classification.regionSource,
    languages,
    statedLanguages: statedLangs,
    agency,
    affiliation,
    avatar,
    banner: null,
    description: null,
    subscribers: toCountRef(null),
    videoCount: null,
    viewCount: null,
    uploadsPlaylistId: null,
    country,
    tags: [...new Set(classifierTags)],
    isSinging: classification.isSinging,
    gender,
    isAi: classification.isAi,
    isOfficialArtist: false,
    officialArtistCheckedAt: null,
    variant: deriveVariant(classification.role, gender, classification.isAi),
    verification: null,
    source: "api",
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: now,
    activity: "unknown",
    debutDate: null,
    graduateDate: null,
    reincarnationOf: null,
    platforms: buildPlatformLinks(entry, avatar, now),
    externals: buildExternals(entry),
    popularVideoId: null,
  };
}

function findRecord(
  entry: RitaEntry,
  byId: Map<string, Channel>,
  byPlatformId: Map<string, Channel>,
  byHandle: Map<string, Channel>,
): Channel | undefined {
  const { id } = canonicalId(entry);
  const record = byId.get(id);
  if (record) return record;

  const candidates: string[] = [];
  if (entry.youtube_id)
    candidates.push(`youtube:${normalizeChannelId(entry.youtube_id)}`);
  if (entry.twitch_id) candidates.push(`twitch:${entry.twitch_id}`);
  if (entry.kick_id) candidates.push(`kick:${entry.kick_id}`);
  if (entry.rplay_id) candidates.push(`rplay:${entry.rplay_id}`);
  if (entry.bilibili) candidates.push(`bilibili:${entry.bilibili}`);
  if (entry.chzzk) candidates.push(`chzzk:${entry.chzzk}`);
  if (entry.soopkr) candidates.push(`soop:${entry.soopkr}`);
  for (const link of entry.links ?? []) {
    const yt = youtubeIdFromLinks([link]);
    if (yt) candidates.push(`youtube:${normalizeChannelId(yt)}`);
  }
  for (const key of candidates) {
    const found = byPlatformId.get(key) ?? byId.get(key);
    if (found) return found;
  }

  const handles: string[] = [];
  if (entry.youtube)
    handles.push(entry.youtube.replace(/^@+/, "").toLowerCase());
  if (entry.twitch) handles.push(entry.twitch.toLowerCase());
  if (entry.kick) handles.push(entry.kick.toLowerCase());
  if (entry.rplay) handles.push(entry.rplay.toLowerCase());
  if (entry.bilibili) handles.push(entry.bilibili.toLowerCase());
  if (entry.chzzk) handles.push(entry.chzzk.toLowerCase());
  if (entry.soopkr) handles.push(entry.soopkr.toLowerCase());
  if (entry.fansly) handles.push(entry.fansly.toLowerCase());
  for (const handle of handles) {
    const found = byHandle.get(handle);
    if (found) return found;
  }

  return undefined;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:rita first`,
    );
    process.exit(1);
  }

  const overrides = readOverrides();

  const snapshot: {
    data?: RitaEntry[];
    generatedAt?: string;
  } = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const entries = snapshot.data || [];

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((c) => [c.id, c]));
  const byPlatformId = new Map<string, Channel>();
  const byHandle = new Map<string, Channel>();
  for (const channel of dataset) {
    for (const platform of channel.platforms) {
      if (platform.id) {
        const key = `${platform.platform}:${platform.id}`;
        if (!byPlatformId.has(key)) byPlatformId.set(key, channel);
      }
      if (platform.handle) {
        const h = platform.handle.replace(/^@+/, "").toLowerCase();
        if (!byHandle.has(h)) byHandle.set(h, channel);
      }
    }
    for (const [platform, handle] of Object.entries(
      channel.externals ?? {},
    )) {
      const h = handle.replace(/^@+/, "").toLowerCase();
      if (!byHandle.has(h)) byHandle.set(h, channel);
    }
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    const record = findRecord(entry, byId, byPlatformId, byHandle);
    let verdict: Row["verdict"] = record ? "tracked" : "new";
    let reason: string | undefined;
    if (!record) {
      const clip =
        detectClipAccount(entry.name, null) || isFanAccountName(entry.name);
      if (clip) {
        verdict = "rejected";
        reason = "clip or fan account";
      }
    }
    rows.push({ entry, id: canonicalId(entry).id, record, verdict, reason });
  }

  console.log(
    `snapshot ${snapshot.generatedAt ?? "?"} · ${entries.length} entr(y/ies) · ${dataset.length} record(s) tracked`,
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  }
  for (const verdict of ["tracked", "new", "rejected"] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count) console.log(`  ${verdict.padEnd(12)} ${count}`);
  }

  const fresh = rows.filter((row) => row.verdict === "new" && row.id);
  const deduped = new Map<string, Row>();
  for (const row of fresh) {
    if (!deduped.has(row.id!)) deduped.set(row.id!, row);
  }
  const newRows = [...deduped.values()];

  console.log(
    newRows.length +
      " channel(s) would be imported" +
      (newRows.length
        ? ":\n" +
          newRows
            .slice(0, 20)
            .map((row) => `  ${row.id}  ${row.entry.name}`)
            .join("\n")
        : ""),
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const now = new Date().toISOString();

  /** New records to create. */
  const records: Channel[] = [];
  for (const row of newRows) {
    const record = recordFromRitaEntry(row.entry, now, overrides[row.id!]);
    if (!record) {
      console.error(`rita: ${row.entry.name} has no usable name`);
      continue;
    }
    records.push(record);
  }

  /** Externals edits to fill on already-tracked records. */
  const externalsEdits: Array<{
    id: string;
    platform: string;
    handle: string;
  }> = [];
  for (const row of rows) {
    if (row.verdict !== "tracked" || !row.record) continue;
    const ext = buildExternals(row.entry);
    for (const [platform, handle] of Object.entries(ext)) {
      if (!row.record.externals?.[platform]) {
        externalsEdits.push({
          id: row.record.id,
          platform,
          handle,
        });
      }
    }
  }

  const release = acquireRunLock("import");
  try {
    const fresh = readAllChannelRecords();
    const byId = new Map(fresh.map((c) => [c.id, c]));
    for (const record of records) {
      if (!byId.has(record.id)) byId.set(record.id, record);
    }
    const all = [...byId.values()];
    writeChannelShards(all, now);
    rebuildChannelsManifest(all, now);
    refreshManifestChannelCounts(all, now);
  } finally {
    release();
  }

  const preMergeIds = new Set(dataset.map((c) => c.id));
  const added = records.filter((r) => !preMergeIds.has(r.id)).length;
  const existing = records.length - added;
  const failed = 0;

  const externalsWritten = applyChannelEdits(
    externalsEdits.map((e) => ({
      id: e.id,
      update: (channel: Channel) => {
        channel.externals ??= {};
        if (channel.externals[e.platform]) return false;
        channel.externals[e.platform] = e.handle;
        return true;
      },
    })),
    "rita",
    now,
  );
  if (externalsWritten) {
    console.log(`${externalsWritten} record(s) had externals filled from rita`);
  }

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed`,
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

function readOverrides(): Record<string, ChannelOverride> {
  try {
    const raw = JSON.parse(
      fs.readFileSync("data/overrides.json", "utf8"),
    ) as Record<string, unknown>;
    const out: Record<string, ChannelOverride> = {};
    for (const [key, value] of Object.entries(raw)) {
      const normalized = key.startsWith("youtube:")
        ? key.slice("youtube:".length)
        : key;
      out[normalized] = value as ChannelOverride;
    }
    return out;
  } catch {
    return {};
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
