#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VTuberpedia (vtpedia.com).
 *
 * vtpedia.com publishes VTuber channel data as static JSON:
 *   https://vtpedia.com/data/vtubers.json
 *
 * No authentication required.
 *
 *   npm run data:vtpedia              # harvest all
 *   npm run data:vtpedia -- --limit 50   # sample for parser check
 *
 * The harvest writes to .cache/vtpedia/vtpedia.json.
 * Importing is a separate step: npm run data:vtpedia-import
 */

import { fetchJson } from "../scripts/lib/io";
import fs from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://vtpedia.com/data/vtubers.json";
const CACHE_DIR = ".cache/vtpedia";
const OUT_PATH = path.join(CACHE_DIR, "vtpedia.json");

interface VtpediaVTuber {
  id: string;
  activity: string;
  name: string;
  imgUrl?: string;
  YouTube?: {
    subscriber: { tag: string; count: number };
    id: string;
  } | null;
  Twitch?: {
    follower: { tag: string; count: number };
    id: string;
  } | null;
  popularVideo?: {
    type: string;
    id: string;
  };
  nationality?: string;
  debutDate?: string;
}

interface VtpediaApiResponse {
  VTubers: VtpediaVTuber[];
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
            "Usage: npm run data:vtpedia -- [options]",
            "",
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`vtpedia: fetching ${SOURCE_URL}`);
  let data: VtpediaApiResponse;
  try {
    const res = await fetchJson<VtpediaApiResponse>(SOURCE_URL);
    if (!res?.VTubers) {
      console.error(
        "vtpedia: feed unavailable — leaving previous cache untouched",
      );
      process.exit(0);
    }
    data = res;
  } catch {
    console.error(
      "vtpedia: fetch failed — leaving previous cache untouched",
    );
    process.exit(0);
  }

  let vtubers = data.VTubers;
  if (options.limit) vtubers = vtubers.slice(0, options.limit);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtpedia.com",
    count: vtubers.length,
    data: vtubers,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `vtpedia: ${vtubers.length} entr(y/ies) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
