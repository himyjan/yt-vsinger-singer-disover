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
} from "../scripts/lib/dataset";
import { acquireRunLock } from "../scripts/lib/io";
import { canonicalAgency } from "../scripts/lib/regions";
import { normalizeChannelId } from "../scripts/lib/platforms";
import { toCountRef } from "../scripts/lib/types";
import type { Channel, Item } from "../scripts/lib/types";

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

  console.log(
    `channels: ${channelsMatched} matched · ${channelsUpdated} updated`,
  );
  console.log(
    `songs: ${songsMatched} matched · ${itemsEnriched} item(s) enriched`,
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  // Write enriched item shards.
  const now = new Date().toISOString();
  writeItemShards(items, now);
  console.log(
    `${itemsEnriched} item(s) written to data/items/ — run npm run data:index next.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
