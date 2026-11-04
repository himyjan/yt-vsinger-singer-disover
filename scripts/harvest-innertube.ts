#!/usr/bin/env tsx
/**
 * Harvest music (uploads + YouTube Music releases) from YouTube channels
 * using InnerTube's channel catalog — no Data API quota.
 *
 * Reads every YouTube channel from data/channels/, splits them into 20
 * volume shards, and each shard job calls InnerTube's channelCatalog()
 * for its channels. The catalog returns the channel's uploads and, for
 * Official Artist Channels, its YouTube Music releases — exactly the
 * music data the song tab displays.
 *
 * Nothing here writes data/ — adding the items is a separate step
 * through `npm run data:innertube-music-import`.
 *
 *   npm run data:innertube-music              # harvest all channels
 *   npm run data:innertube-music -- --shard 1/20   # one shard only
 *   npm run data:innertube-music -- --limit 50     # sample for parser check
 */

import fs from "node:fs";
import path from "node:path";
import { InnerTubeSource } from "../scripts/lib/youtubei";
import { readAllChannelRecords } from "../scripts/lib/dataset";
import { inShard, parseShard } from "../scripts/lib/shard";
import type { Channel } from "../scripts/lib/types";

const CACHE_DIR = ".cache/innertube-music";

interface MusicEntry {
  channelId: string;
  channelName: string;
  channelKind: Channel["kind"];
  channelRegion: string | null;
  channelGender: string;
  channelVariant: string;
  channelLanguages: string | string[];
  channelIsAi: boolean;
  officialArtist: boolean;
  uploads: Array<{ id: string; title: string; thumbnail: string | null }>;
  releases: Array<{ id: string; title: string; thumbnail: string | null }>;
}

interface Options {
  limit: number | null;
  shard: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null, shard: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--shard":
        options.shard = value ?? null;
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:innertube-music [--shard N/M] [--limit <n>]",
            "",
            "  (no flags)   harvest music for all YouTube channels",
            "  --shard N/M  only this shard (1-based), e.g. --shard 1/20",
            "  --limit <n>  stop after n channels in this pass",
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

function snapshotPath(shard: string | null): string {
  return path.join(
    CACHE_DIR,
    `innertube-music-${shard?.replace("/", "-") ?? "all"}.json`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const OUT_PATH = snapshotPath(options.shard);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const channels = readAllChannelRecords();

  // Only YouTube channels (UC… ids) have InnerTube channel catalogs.
  const ytChannels = channels.filter((c) => c.id.startsWith("UC"));

  let targets = ytChannels;
  if (options.shard) {
    const shard = parseShard(options.shard);
    targets = ytChannels.filter((c) => inShard(c.id, shard.index, shard.count));
    console.log(
      `innertube-music: shard ${options.shard} — ${targets.length} of ${ytChannels.length} YouTube channels`,
    );
  } else {
    console.log(
      `innertube-music: ${targets.length} YouTube channel(s) to fetch music for`,
    );
  }

  if (options.limit) {
    targets = targets.slice(0, options.limit);
  }

  if (targets.length === 0) {
    console.error(
      "innertube-music: no channels to fetch — leaving previous cache untouched",
    );
    process.exit(0);
  }

  const source = new InnerTubeSource({ delayMs: 100 });
  await source.connect();

  const entries: MusicEntry[] = [];
  let processed = 0;

  for (const channel of targets) {
    processed++;
    console.log(
      `  [${processed}/${targets.length}] ${channel.name} (${channel.id})`,
    );
    try {
      const catalog = await source.channelCatalog(
        channel.id,
        30, // uploadLimit
        12, // releaseLimit
      );
      entries.push({
        channelId: channel.id,
        channelName: channel.name,
        channelKind: channel.kind,
        channelRegion: channel.region,
        channelGender: channel.gender,
        channelVariant: channel.variant,
        channelLanguages: channel.languages,
        channelIsAi: channel.isAi,
        officialArtist: catalog.officialArtist,
        uploads: catalog.uploads.map((u) => ({
          id: u.id,
          title: u.title,
          thumbnail: u.thumbnail,
        })),
        releases: catalog.releases.map((r) => ({
          id: r.id,
          title: r.title,
          thumbnail: r.thumbnail,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    failed ${channel.name}: ${msg}`);
      entries.push({
        channelId: channel.id,
        channelName: channel.name,
        channelKind: channel.kind,
        channelRegion: channel.region,
        channelGender: channel.gender,
        channelVariant: channel.variant,
        channelLanguages: channel.languages,
        channelIsAi: channel.isAi,
        officialArtist: false,
        uploads: [],
        releases: [],
      });
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "youtube-innertube",
    count: entries.length,
    data: entries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  const withMusic = entries.filter(
    (e) => e.uploads.length > 0 || e.releases.length > 0,
  ).length;
  console.log(
    `innertube-music: ${entries.length} channel(s) (${withMusic} with music) → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
