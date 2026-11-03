#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from VTuberDex.
 *
 * vtuberdex.pages.dev is a static HTML directory of VTubers. It has no JSON
 * API and **no paging** — every card is rendered on the single index page —
 * so this script fetches that one page and parses the card elements to
 * extract VTuber names, countries, and groups.
 *
 * Each entry is keyed by `vtuberdex:<name>` and carries no YouTube id — the
 * import step resolves names to YouTube channels through a name search.
 *
 *   npm run data:vtuberdex              # harvest VTuber candidates from VTuberDex
 *   npm run data:vtuberdex -- --limit 50  # sample for a parser check
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
            "Usage: npm run data:vtuberdex [options]",
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

  // Split the page into individual vtuber-card blocks, then pull each card's
  // attributes and name independently — attributes may appear in any order,
  // and some cards omit data-group or data-pais entirely.
  const cardBlocks = html.split(/<div class="vtuber-card[^>]*>/);
  for (const block of cardBlocks.slice(1)) {
    const countryMatch = block.match(/\bdata-pais="([^"]*)"/);
    const groupMatch = block.match(/\bdata-group="([^"]*)"/);
    // Match <h2>...</h2>, or handle malformed HTML like <h2>Name<h2>
    // (missing closing slash) by stopping at the next <h2 or </div>.
    const nameMatch = block.match(/<h2>([\s\S]*?)(?=<\/h2>|<h2\s|<\/div>|$)/);

    const country = countryMatch?.[1] || undefined;
    const group = groupMatch?.[1] || undefined;
    const name = nameMatch
      ? nameMatch[1]!
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";

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
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`vtuberdex: HTTP ${res.status} — stopping`);
      process.exit(1);
    }
    html = await res.text();
  } catch (error: unknown) {
    console.error(
      `vtuberdex: fetch failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const entries = parseVtuberdexHtml(html);
  if (entries.length === 0) {
    console.error("vtuberdex: no entries found on the page — stopping");
    process.exit(1);
  }

  console.log(`vtuberdex: ${entries.length} entr(y/ies) found on the page`);

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
