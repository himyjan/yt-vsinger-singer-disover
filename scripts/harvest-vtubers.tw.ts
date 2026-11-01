#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VTubers.tw.
 *
 * vtubers.tw publishes channel data as static JSON:
 *   https://static.starknows.tw/channels.json        — full channel list
 *   https://static.starknows.tw/channel-addition.json — new channel additions
 *
 * No authentication required.
 *
 *   npm run data:vtubers.tw              # harvest VTuber candidates from VTubers.tw
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:vtubers.tw-import`.
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const CHANNELS_URL = "https://static.starknows.tw/channels.json";
const ADDITION_URL = "https://static.starknows.tw/channel-addition.json";
const CACHE_DIR = ".cache/vtubers.tw";
const OUT_PATH = path.join(CACHE_DIR, "vtubers.tw.json");

interface ChannelEntry {
  id: string;
  title: string;
  subscribers: string;
  status: number;
}

interface AdditionEntry {
  id: string;
  customUrl: string;
  country: string;
  image: string;
  videoCount: string;
  endorse: string;
  created_at: number;
}

interface ChannelsResponse {
  lastUpdated: string;
  channels: ChannelEntry[];
}

interface AdditionResponse {
  lastUpdated: string;
  addition: AdditionEntry[];
}

interface Options {
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtubers.tw [--limit <n>]",
            "",
            "  --limit <n>  max channels to harvest",
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Fetch the main channel list
  const channels = await fetchJson<ChannelsResponse>(CHANNELS_URL);
  if (!channels?.channels) {
    console.error("vtubers.tw channels feed unavailable — leaving previous cache untouched");
    process.exit(0);
  }

  // Fetch new channel additions
  const addition = await fetchJson<AdditionResponse>(ADDITION_URL);
  const additions = addition?.addition ?? [];

  // Merge: additions can override/update main entries by id
  const byId = new Map<string, ChannelEntry | AdditionEntry>();
  for (const ch of channels.channels) byId.set(ch.id, ch);
  for (const add of additions) {
    if (byId.has(add.id)) {
      // Merge addition data over main entry
      const existing = byId.get(add.id)! as ChannelEntry;
      byId.set(add.id, { ...existing, customUrl: add.customUrl, country: add.country });
    } else {
      byId.set(add.id, add as unknown as ChannelEntry);
    }
  }

  let all = Array.from(byId.values());
  if (options.limit) all = all.slice(0, options.limit);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtubers.tw",
    count: all.length,
    data: all,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `vtubers.tw: ${all.length} channel(s) harvested (${channels.channels.length} main + ${additions.length} additions) → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
