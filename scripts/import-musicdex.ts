#!/usr/bin/env tsx
/**
 * Imports Musicdex channel profiles and songs into the dataset.
 *
 * `scripts/harvest-musicdex.ts` produces a snapshot in
 * `.cache/musicdex/musicdex.json` containing:
 *   - channels: Musicdex channel profiles (YouTube channel id, name, org,
 *     avatar, subscriber count, video count, tags, activity, …)
 *   - songs: Musicdex songs (YouTube video id, channel id, song title,
 *     original artist, category, release date, …)
 *
 * This script:
 *   1. Matches channels to dataset records by YouTube channel id and updates
 *      them with Musicdex data (agency from org, avatar, subscriber count,
 *      video count, tags from top_topics, activity from inactive, twitter
 *      external).
 *   2. Matches songs to dataset items by YouTube video id and enriches them
 *      with song title, original artist, category, and release date.
 *
 * Precedence: Musicdex data fills empty fields only — it never overwrites a
 * confirmed value from a stronger source.
 *
 *   npm run data:musicdex-import                     # report only
 *   npm run data:musicdex-import -- --apply          # write enriched data
 */

import fs from "node:fs";
import path from "node:path";
import {
  readAllChannelRecords,
  writeChannelShards,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeItemShards,
  writeSongShards,
} from "../scripts/lib/dataset";
import { acquireRunLock, writeJsonIfChanged } from "../scripts/lib/io";
import { canonicalAgency } from "../scripts/lib/regions";
import { ALL_REGIONS } from "../scripts/lib/types";
import { normalizeChannelId } from "../scripts/lib/platforms";
import { toCountRef } from "../scripts/lib/types";
import type {
  Channel,
  Item,
  ItemCategory,
  RegionCode,
  SongRecord,
} from "../scripts/lib/types";
import { InnerTubeSource } from "../scripts/lib/youtubei";

const SNAPSHOT = ".cache/musicdex/musicdex.json";

interface MusicdexChannel {
  id: string;
  name: string;
  englishName?: string | null;
  org?: string | null;
  group?: string | null;
  photo?: string | null;
  twitter?: string | null;
  videoCount?: number | null;
  subscriberCount?: number | null;
  topTopics?: string[];
  inactive?: boolean;
  extraIds?: string[];
}

interface MusicdexSong {
  videoId: string;
  channelId: string;
  name: string;
  originalArtist?: string | null;
  isMv?: boolean;
  availableAt?: string | null;
}

interface Options {
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:musicdex-import -- [options]",
            "",
            "  --apply  write enriched channels and items to data/",
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

/** Map a Musicdex song to our ItemCategory. */
function musicdexCategory(song: MusicdexSong): Item["category"] | null {
  if (song.isMv) return "mv";
  const n = (song.name ?? "").toLowerCase();
  if (n.includes("cover") || n.includes("カバー")) return "cover";
  if (n.includes("original") || n.includes("オリジナル")) return "original";
  return null;
}

/** Load all item shards from data/items/<region>/<bucket>.json. */
function loadAllItems(): Item[] {
  const items: Item[] = [];
  const regions = [
    "cn", "en", "hk", "id", "jp", "kr", "live", "my", "sea", "tw", "unknown",
  ];
  for (const region of regions) {
    const dir = path.join("data", "items", region);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(dir, file), "utf8"),
        ) as { items?: Item[] };
        if (data?.items) items.push(...data.items);
      } catch {
        // skip unreadable shard
      }
    }
  }
  return items;
}

/** Read every song already committed under data/songs/ (region shards only). */
function loadExistingSongs(): SongRecord[] {
  const out: SongRecord[] = [];
  const songsDir = path.join("data", "songs");
  if (!fs.existsSync(songsDir)) return out;
  for (const entry of fs.readdirSync(songsDir)) {
    if (!entry.endsWith(".json")) continue;
    if (entry === "index.json" || entry === "manifest.json") continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(songsDir, entry), "utf8"),
      ) as { songs?: SongRecord[] };
      out.push(...(parsed.songs ?? []));
    } catch {
      // skip unreadable shard
    }
  }
  return out;
}

/** Convert a Musicdex song into a SongRecord using the channel record for metadata. */
function songToRecord(
  ms: MusicdexSong,
  channel: Channel | undefined,
): SongRecord | null {
  if (!channel) return null;
  const category: ItemCategory =
    (musicdexCategory(ms) as ItemCategory) ?? "other";
  return {
    id: ms.videoId,
    channelId: ms.channelId,
    channelName: channel.name,
    channelKind: channel.kind,
    region: channel.region,
    variant: channel.variant,
    gender: channel.gender,
    languages: channel.languages,
    isAi: channel.isAi,
    title: ms.name,
    songTitle: ms.name,
    originalArtist: ms.originalArtist ?? null,
    category,
    isCollab: false,
    collaborators: [
      { channelId: channel.id, name: channel.name, kind: channel.kind, region: channel.region },
    ],
    isAcoustic: false,
    publishedAt: ms.availableAt ?? null,
    duration: null,
    thumbnail: `https://i.ytimg.com/vi/${ms.videoId}/hqdefault.jpg`,
    viewCount: null,
    url: `https://www.youtube.com/watch?v=${ms.videoId}`,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:musicdex first`,
    );
    process.exit(1);
  }

  const snapshot: {
    channels?: MusicdexChannel[];
    songs?: MusicdexSong[];
    generatedAt?: string;
  } = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const mdexChannels = snapshot.channels || [];
  const mdexSongs = snapshot.songs || [];

  console.log(
    `snapshot ${snapshot.generatedAt ?? "?"} · ${mdexChannels.length} channel(s) · ${mdexSongs.length} song(s) from musicdex`,
  );

  if (mdexChannels.length === 0 && mdexSongs.length === 0) {
    console.log("snapshot has no data — nothing to import");
    return;
  }

  // Connect to InnerTube to fetch video durations for songs.
  // Musicdex does not publish song durations, so we look them up via YouTube.
  const innertube = new InnerTubeSource();
  const innertubeReady = await innertube.connect();
  if (!innertubeReady) {
    console.log(
      "musicdex-import: InnerTube unavailable — song durations will be null",
    );
  }

  // ------------------------------------------------------------------
  // 1. Channel import: match by YouTube channel id and update records.
  // ------------------------------------------------------------------
  const dataset = readAllChannelRecords();
  const byYoutubeId = new Map<string, Channel>();
  for (const channel of dataset) {
    for (const platform of channel.platforms) {
      if (platform.platform === "youtube" && platform.id) {
        const id = normalizeChannelId(platform.id);
        if (!byYoutubeId.has(id)) byYoutubeId.set(id, channel);
      }
    }
  }

  const channelEdits: Array<{ id: string; update: (c: Channel) => boolean }> = [];
  let channelsMatched = 0;

  for (const mc of mdexChannels) {
    const ytId = normalizeChannelId(mc.id);
    const record = byYoutubeId.get(ytId);
    if (!record) continue;

    channelsMatched++;

    channelEdits.push({
      id: record.id,
      update: (c: Channel): boolean => {
        let changed = false;

        // Agency from org.
        if (mc.org && !c.agency) {
          c.agency = canonicalAgency(mc.org);
          changed = true;
        }

        // Avatar from photo (only if not already set).
        if (mc.photo && !c.avatar) {
          c.avatar = mc.photo;
          changed = true;
        }

        // Subscriber count (only if not already public).
        if (
          mc.subscriberCount !== null &&
          mc.subscriberCount !== undefined &&
          c.subscribers.tag !== "has"
        ) {
          c.subscribers = toCountRef(mc.subscriberCount);
          changed = true;
        }

        // Video count (only if not already set).
        if (mc.videoCount !== null && mc.videoCount !== undefined && !c.videoCount) {
          c.videoCount = mc.videoCount;
          changed = true;
        }

        // Tags from top_topics (only new ones).
        if (mc.topTopics && mc.topTopics.length > 0) {
          const newTags = mc.topTopics.filter((t) => !c.tags.includes(t));
          if (newTags.length > 0) {
            c.tags = [...c.tags, ...newTags];
            changed = true;
          }
        }

        // Activity from inactive (only if not already graduated).
        if (mc.inactive === true && c.activity !== "graduated") {
          c.activity = "graduated";
          changed = true;
        }

        // Twitter external (only if not already set).
        if (mc.twitter && !c.externals.twitter) {
          c.externals ??= {};
          c.externals.twitter = mc.twitter;
          changed = true;
        }

        return changed;
      },
    });
  }

  let channelsUpdated = 0;
  if (channelEdits.length > 0) {
    const now = new Date().toISOString();
    const release = acquireRunLock("import");
    try {
      const fresh = readAllChannelRecords();
      const freshById = new Map(fresh.map((c) => [c.id, c]));
      let written = 0;
      for (const edit of channelEdits) {
        const channel = freshById.get(edit.id);
        if (channel && edit.update(channel)) written++;
      }
      if (written > 0) {
        writeChannelShards(fresh, now);
        rebuildChannelsManifest(fresh, now);
        refreshManifestChannelCounts(fresh, now);
      }
      channelsUpdated = written;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------
  // 2. Song import: match by YouTube video id and enrich items.
  // ------------------------------------------------------------------
  const items = loadAllItems();
  const byItemId = new Map(items.map((i) => [i.id, i]));

  let songsMatched = 0;
  let itemsEnriched = 0;

  for (const ms of mdexSongs) {
    const item = byItemId.get(ms.videoId);
    if (!item) continue;

    songsMatched++;
    let changed = false;

    // Song title — only when null or item is unclassified.
    if (ms.name && (!item.songTitle || item.category === "other")) {
      item.songTitle = ms.name;
      changed = true;
    }

    // Original artist — only when null.
    if (ms.originalArtist && !item.originalArtist) {
      item.originalArtist = ms.originalArtist;
      changed = true;
    }

    // Category — only when item is "other" or "live".
    const cat = musicdexCategory(ms);
    if (cat && (item.category === "other" || item.category === "live")) {
      item.category = cat;
      changed = true;
    }

    // Published at — only when null.
    if (ms.availableAt && !item.publishedAt) {
      item.publishedAt = ms.availableAt;
      changed = true;
    }

    if (changed) itemsEnriched++;
  }

  // ------------------------------------------------------------------
  // 3. Song import: write Musicdex songs to data/songs/.
  //    Dedup by video id — Musicdex songs win on collision, existing
  //    songs not re-harvested are kept.
  // ------------------------------------------------------------------
  const songsById = new Map<string, SongRecord>();
  let songsWritten = 0;

  for (const ms of mdexSongs) {
    const channel = byYoutubeId.get(normalizeChannelId(ms.channelId));
    const record = songToRecord(ms, channel);
    if (!record) continue;
    // Musicdex version wins on id collision.
    songsById.set(record.id, record);
    songsWritten++;
  }

  // Fetch video durations via InnerTube so the Songs tab shows length.
  // Musicdex does not publish durations, so we look them up per video.
  if (innertubeReady && innertube) {
    console.log(
      `musicdex-import: fetching durations for ${songsById.size} song(s)`,
    );
    for (const [id, song] of songsById) {
      if (song.duration !== null) continue;
      try {
        const info = await innertube.getBasicInfo(id);
        song.duration = info?.basic_info?.lengthSeconds ?? null;
      } catch {
        // Leave duration as null on failure.
      }
      // Pace requests to avoid rate limiting.
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  // Keep existing songs not re-harvested this run.
  const existingSongs = loadExistingSongs();
  let existingKept = 0;
  for (const song of existingSongs) {
    if (!songsById.has(song.id)) {
      songsById.set(song.id, song);
      existingKept++;
    }
  }

  const allSongs = [...songsById.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  console.log(
    `songs: ${songsWritten} new · ${existingKept} existing kept · ${allSongs.length} total`,
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  // Write enriched item shards.
  const now = new Date().toISOString();
  writeItemShards(items, now);

  // Write song shards to data/songs/.
  const songsDir = path.join("data", "songs");
  const keepSongFiles = new Set<string>();
  for (const region of ALL_REGIONS) {
    const list = allSongs.filter((s) => s.region === region);
    if (!list.length) continue;
    const shards = writeSongShards(songsDir, region, list, now);
    for (const shard of shards) keepSongFiles.add(shard);
  }
  // Remove stale region shard files.
  const songsDirExists = fs.existsSync(songsDir);
  if (songsDirExists) {
    for (const entry of fs.readdirSync(songsDir)) {
      if (!entry.endsWith(".json")) continue;
      if (entry === "index.json" || entry === "manifest.json") continue;
      if (!keepSongFiles.has(entry))
        fs.rmSync(path.join(songsDir, entry), { force: true });
    }
  }

  // Per-category slices.
  const songsCategoryDir = path.join(songsDir, "categories");
  const keepCategoryFiles = new Set<string>();
  const categoryCounts: Record<ItemCategory, number> = {
    cover: 0,
    mv: 0,
    original: 0,
    performance: 0,
    live: 0,
    premiere: 0,
    other: 0,
  };
  for (const category of ["cover", "mv", "original", "performance"] as const) {
    const list = allSongs.filter((s) => s.category === category);
    categoryCounts[category] = list.length;
    if (!list.length) continue;
    const shards = writeSongShards(songsCategoryDir, category, list, now);
    for (const shard of shards) keepCategoryFiles.add(shard);
  }

  const indexShards = writeSongShards(songsDir, "index", allSongs, now);
  for (const shard of indexShards) keepSongFiles.add(shard);

  // Manifest.
  const byRegionOut: Record<string, number> = {};
  for (const song of allSongs) {
    const region = song.region;
    byRegionOut[region] = (byRegionOut[region] ?? 0) + 1;
  }
  writeJsonIfChanged(
    path.join(songsDir, "manifest.json"),
    {
      schemaVersion: 1,
      generatedAt: now,
      total: allSongs.length,
      byCategory: categoryCounts,
      byRegion: byRegionOut,
    },
  );

  console.log(
    `${allSongs.length} song(s) written to data/songs/ — run npm run data:index next.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
