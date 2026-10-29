#!/usr/bin/env tsx
/**
 * Harvests the Virtual YouTuber Wiki (Fandom) roster into a reviewable snapshot.
 *
 * The wiki exposes a public MediaWiki API — no key, no browser — and every
 * performer page carries a `{{Character}}` infobox with name, debut date,
 * graduation date, affiliation, YouTube channel and X/Twitter handle.
 *
 *   npm run data:fandom                      # every entry not yet on disk
 *   npm run data:fandom -- --limit 50        # a sample, for a parser check
 *
 * The harvest lists all pages in the main namespace and fetches each page's
 * wikitext, parsing the infobox. Nothing here writes `data/` — adding the
 * channels is `npm run data:fandom-import`.
 */

import fs from "node:fs";
import path from "node:path";
import { harvestFandom } from "./lib/fandom";

const CACHE_DIR = ".cache/fandom";
const OUT_PATH = path.join(CACHE_DIR, "fandom.json");

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
            "Usage: npm run data:fandom -- [options]",
            "",
            "  --limit <n>  stop after n pages in this pass",
          ].join("\n"),
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

  const vtubers = await harvestFandom(options.limit ?? 10_000);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "virtualyoutuber.fandom.com",
    count: vtubers.length,
    vtubers,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`${vtubers.length} vtuber(s) harvested → ${OUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
