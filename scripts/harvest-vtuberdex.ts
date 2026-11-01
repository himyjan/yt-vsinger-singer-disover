#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VTuberDex.
 *
 * vtuberdex.pages.dev is a static HTML directory of VTubers. It has no JSON
 * API, so this script parses the HTML directory page to extract VTuber names,
 * countries, and groups from the card elements.
 *
 * Each entry is keyed by `vtuberdex:<name>` and carries no YouTube id — the
 * import step resolves names to YouTube channels through a name search.
 *
 *   npm run data:vtuberdex              # harvest VTuber candidates from VTuberDex
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:vtuberdex-import`.
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://vtuberdex.pages.dev";
const CACHE_DIR = ".cache/vtuberdex";
const OUT_PATH = path.join(CACHE_DIR, "vtuberdex.json");

interface VtuberdexEntry {
  name: string;
  country?: string;
  group?: string;
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
            "Usage: npm run data:vtuberdex [--limit <n>]",
            "",
            "  --limit <n>  max entries to harvest",
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

/** Parses VTuberDex HTML cards to extract name, country, and group. */
function parseVtuberdexHtml(html: string): VtuberdexEntry[] {
  const entries: VtuberdexEntry[] = [];
  const seen = new Set<string>();

  // Match vtuber-card divs: <div class="vtuber-card cardN" data-pais="..." data-group="...">
  const cardRegex = /<div class="vtuber-card[^"]*"[^>]*data-pais="([^"]*)"[^>]*data-group="([^"]*)"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const country = match[1] || undefined;
    const group = match[2] || undefined;
    const name = match[3].trim();

    if (!name || seen.has(name)) continue;
    seen.add(name);

    entries.push({ name, country, group });
  }

  return entries;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`vtuberdex: fetching ${SOURCE_URL}`);
  let html: string;
  try {
    const res = await fetch(SOURCE_URL, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(
        `vtuberdex: HTTP ${res.status} — leaving previous cache untouched`,
      );
      process.exit(0);
    }
    html = await res.text();
  } catch {
    console.error(
      "vtuberdex: fetch failed — leaving previous cache untouched",
    );
    process.exit(0);
  }

  const entries = parseVtuberdexHtml(html);
  if (!entries.length) {
    console.error(
      "vtuberdex: no entries found in HTML — leaving previous cache untouched",
    );
    process.exit(0);
  }

  let limited = entries;
  if (options.limit) limited = entries.slice(0, options.limit);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vtuberdex.pages.dev",
    count: limited.length,
    data: limited,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `vtuberdex: ${limited.length} entr(y/ies) harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
