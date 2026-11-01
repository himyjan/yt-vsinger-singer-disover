/**
 * Merges the volume shards back into `data/`.
 *
 * **Volumes are disjoint by record, not by file.** Every volume writes the
 * same shard paths — `channels/virtual/jp/00.json`, `items/en/03.json` — and
 * each file holds only that volume's slice of them. So copying shard files
 * between volumes merges nothing: the last volume copied wins and the
 * catalogue shrinks to one volume's worth. That is exactly what happened the
 * first time this ran in the live workflow: 72,698 channels in, 3,590 out.
 *
 * The records are therefore read back and combined, then written through the
 * same shard writers the sync uses — which keeps the one-record-per-line
 * format, the per-file budget, the shard map and the manifests in step with
 * each other.
 */

import fs from "node:fs";
import path from "node:path";

import {
  readAllChannelRecords,
  readAllItems,
  writeChannelShards,
  writeItemShards,
  rebuildChannelsManifest,
} from "./lib/dataset";
import { buildRegionMeta } from "./lib/regions";
import { readJson, writeJson } from "./lib/io";
import type { Channel, Item, Manifest, ManifestCounts, RegionCode } from "./lib/types";

/** `--count 20` and `--count=20` both work; the workflow passes the first. */
function parseCount(argv: string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--count=")) {
      const n = Number(arg.slice("--count=".length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    if (arg === "--count") {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return 10;
}

/**
 * `--items-only` merges the item files and nothing else.
 *
 * The live pass writes **only** items, and its volumes were split from the
 * checkout the job started with. Writing the channel shards back from those
 * volumes therefore rewrites every channel record to the snapshot the job
 * read — which is how a `data: fill channel details` commit that landed while
 * the live run was working got reverted. In this mode the channel shards and
 * the shared files are left exactly as the branch has them, and only the item
 * counts in the manifest move.
 */
function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

/** The counts every writer records, in one place (`scripts/sync.ts` does the same). */
function computeCounts(channels: Channel[], items: Item[]): ManifestCounts {
  return {
    channels: channels.length,
    channelsVirtual: channels.filter((c) => c.kind === "virtual").length,
    channelsReal: channels.filter((c) => c.kind === "real").length,
    channelsSinging: channels.filter((c) => c.isSinging).length,
    items: items.length,
    itemsLive: items.filter((i) => i.status === "live").length,
    itemsUpcoming: items.filter((i) => i.status === "upcoming").length,
    itemsVideo: items.filter((i) => i.type === "video").length,
    itemsPlaylist: items.filter((i) => i.type === "playlist").length,
    itemsCover: items.filter((i) => i.category === "cover").length,
    itemsMv: items.filter((i) => i.category === "mv").length,
    itemsOriginal: items.filter((i) => i.category === "original").length,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const count = parseCount(argv);
  const itemsOnly = hasFlag(argv, "--items-only");
  const channelsOnly = hasFlag(argv, "--channels-only");
  if (itemsOnly && channelsOnly) {
    console.error("--items-only and --channels-only are mutually exclusive");
    process.exit(1);
  }
  const mergeChannels = !itemsOnly;
  const mergeItems = !channelsOnly;
  const root = process.cwd();
  const volRoot = path.join(root, ".volumes");
  const dataRoot = path.join(root, "data");
  const now = new Date().toISOString();

  const volDirs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const dir = path.join(volRoot, `vol-${i}`, "data");
    if (fs.existsSync(dir)) volDirs.push(dir);
  }
  if (!volDirs.length) {
    console.error(`No volumes found under ${volRoot}`);
    process.exit(1);
  }
  const scope = itemsOnly ? " (items only)" : channelsOnly ? " (channels only)" : "";
  console.log(`merging ${volDirs.length} volume(s) into data/${scope}`);

  /**
   * Shared files are identical in every volume, so vol-0 is the source — but
   * only on a full merge. A scoped merge takes them from the branch instead:
   * a concurrent commit may have changed an override while this run worked,
   * and copying the checkout's copy back would revert it.
   */
  if (mergeChannels && mergeItems) {
    for (const file of ["overrides.json", "seed-catalog.json", "suggestions.json", "upstream.json"]) {
      const src = path.join(volDirs[0]!, file);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.copyFileSync(src, path.join(dataRoot, file));
    }
  }

  /* --- records: concatenate, then let the id decide --- */
  const channels = new Map<string, Channel>();
  const items = new Map<string, Item>();
  for (const dir of volDirs) {
    if (mergeChannels) {
      for (const channel of readAllChannelRecords(dir)) channels.set(channel.id, channel);
    }
    if (mergeItems) {
      for (const item of readAllItems(dir)) items.set(item.id, item);
    }
  }
  const channelList = [...channels.values()];
  const itemList = [...items.values()];

  /**
   * A volume can hold the same record twice only if two volumes overlap, which
   * `volumeOf()` makes impossible — but a duplicate id would be a silent
   * data loss if it ever happened, so the maps above are keyed by id and the
   * counts below say what was kept.
   */
  if (mergeChannels) {
    const rawChannels = volDirs.reduce((sum, dir) => sum + readAllChannelRecords(dir).length, 0);
    if (rawChannels !== channelList.length) {
      console.log(`  deduplicated ${rawChannels - channelList.length} channel(s) across volumes`);
    }
  }

  /* Every writer takes the root, or it would write into the repository. */
  if (mergeChannels) {
    writeChannelShards(channelList, now, dataRoot);
    rebuildChannelsManifest(channelList, now, dataRoot);
  }
  if (mergeItems) {
    writeItemShards(itemList, now, dataRoot);
  }

  /* --- the root manifest: counts and the region table --- */
  const manifest = readJson<Manifest | null>(path.join(dataRoot, "manifest.json"), null);
  if (manifest) {
    /**
     * A scoped merge leaves the side it did not touch exactly as the branch
     * has it: the channel counts describe the branch's channels when only
     * items were merged, and the item counts describe the branch's items when
     * only channels were merged.
     */
    const regionCounts = new Map<RegionCode, { channels: number; items: number }>();
    if (!mergeChannels) {
      for (const region of manifest.regions ?? []) {
        regionCounts.set(region.code, { channels: region.channels, items: 0 });
      }
    } else {
      for (const channel of channelList) {
        const entry = regionCounts.get(channel.region) ?? { channels: 0, items: 0 };
        entry.channels += 1;
        regionCounts.set(channel.region, entry);
      }
    }
    if (!mergeItems) {
      for (const region of manifest.regions ?? []) {
        const entry = regionCounts.get(region.code) ?? { channels: 0, items: 0 };
        entry.items = region.items;
        regionCounts.set(region.code, entry);
      }
    } else {
      for (const item of itemList) {
        const region = (item.region ?? "unknown") as RegionCode;
        const entry = regionCounts.get(region) ?? { channels: 0, items: 0 };
        entry.items += 1;
        regionCounts.set(region, entry);
      }
    }

    const next = computeCounts(mergeChannels ? channelList : [], mergeItems ? itemList : []);
    manifest.counts = {
      ...manifest.counts,
      ...(mergeChannels
        ? {
            channels: next.channels,
            channelsVirtual: next.channelsVirtual,
            channelsReal: next.channelsReal,
            channelsSinging: next.channelsSinging,
          }
        : {}),
      ...(mergeItems
        ? {
            items: next.items,
            itemsLive: next.itemsLive,
            itemsUpcoming: next.itemsUpcoming,
            itemsVideo: next.itemsVideo,
            itemsPlaylist: next.itemsPlaylist,
            itemsCover: next.itemsCover,
            itemsMv: next.itemsMv,
            itemsOriginal: next.itemsOriginal,
          }
        : {}),
    };
    manifest.regions = buildRegionMeta(regionCounts);
    manifest.generatedAt = now;
    writeJson(path.join(dataRoot, "manifest.json"), manifest);
  }

  console.log(
    `merged ${channelList.length} channel(s) and ${itemList.length} item(s)` +
      ` · ${manifest?.counts.itemsLive ?? 0} live · ${manifest?.counts.itemsUpcoming ?? 0} upcoming`,
  );
  console.log("done — run `npm run data:index` to rebuild the search index");
}

main();
