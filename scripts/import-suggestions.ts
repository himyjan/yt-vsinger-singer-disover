#!/usr/bin/env tsx
/**
 * Imports the YouTube suggestions sitting in `data/suggestions.json`.
 *
 * The suggestion list is a candidate queue, not a record store: a channel
 * stays on it until someone imports it, and only YouTube `UC…` ids can be
 * imported here — Twitch/Niconico/etc suggestions have no import path yet
 * and are reported but left in place.
 *
 *   npm run data:import-suggestions          # report only, writes nothing
 *   npm run data:import-suggestions --apply  # import and clear resolved ids
 *
 * Mirrors the dev-server `/api/dataset/sync` endpoint so a static build
 * can clear the queue locally instead of in the browser.
 */

import fs from "node:fs";
import { readAllChannelRecords } from "./lib/dataset";
import { importYouTubeChannels } from "./lib/import-channels";
import {
  listSuggestions,
  removeSuggestions,
  SUGGESTIONS_PATH,
} from "./lib/suggestions";
import { acquireRunLock } from "./lib/io";

interface Args {
  apply: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const options: Args = { apply: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(argv[i + 1] ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:import-suggestions [options]",
            "",
            "  --apply   import YouTube suggestions into data/ and clear resolved ids",
            "  --limit   max ids to look at this run (default: all)",
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
  const file = fs.readFileSync(SUGGESTIONS_PATH, "utf8");
  const current = JSON.parse(file) as {
    schemaVersion: number;
    generatedAt: string;
    suggestions: Array<{ platform: string; id: string; name: string }>;
  };
  const suggestions = current.suggestions ?? [];

  const youtubeIds = suggestions
    .filter((s) => s.platform === "youtube" && /^UC[\w-]{20,}$/.test(s.id))
    .map((s) => s.id);
  const nonYoutube = suggestions.filter((s) => s.platform !== "youtube");
  const invalidYoutube = suggestions.filter(
    (s) => s.platform === "youtube" && !/^UC[\w-]{20,}$/.test(s.id),
  );

  console.log(
    `suggestions.json: ${suggestions.length} total · ` +
      `${youtubeIds.length} YouTube · ${nonYoutube.length} other · ` +
      `${invalidYoutube.length} malformed YouTube`,
  );

  if (nonYoutube.length) {
    console.log(
      `\nnon-YouTube suggestions (cannot be imported — no CLI path):` +
        `\n  ${nonYoutube.slice(0, 20).map((s) => `${s.platform}:${s.id}`).join(" · ")}` +
        (nonYoutube.length > 20 ? ` · … ${nonYoutube.length - 20} more` : ""),
    );
  }

  if (invalidYoutube.length) {
    console.log(
      `\nmalformed YouTube ids (not a UC… channel id):` +
        `\n  ${invalidYoutube.slice(0, 20).map((s) => s.id).join(" · ")}`,
    );
  }

  if (!youtubeIds.length) {
    console.log("\nNothing to import.");
    return;
  }

  const ids = options.limit === null ? youtubeIds : youtubeIds.slice(0, options.limit);
  console.log(`\nimporting ${ids.length} YouTube id(s)…`);

  let added = 0;
  let existing = 0;
  let failed = 0;
  let remaining = 0;
  const failedIds = new Set<string>();
  const existingIds = new Set(readAllChannelRecords().map((c) => c.id));

  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const result = await importYouTubeChannels(batch, {
      limit: batch.length,
      onLog: (message) => console.log(`  ${message}`),
    });
    added += result.added.length;
    existing += result.existing;
    failed += result.failed.length;
    remaining += result.remaining;
    for (const f of result.failed) failedIds.add(f.id);
  }

  const resolvedIds = ids.filter((id) => !failedIds.has(id));
  console.log(
    `\n${added} added · ${existing} already tracked · ${failed} failed · ` +
      `${ids.length - resolvedIds.length} still pending`,
  );

  if (!options.apply) {
    console.log("\nNothing was written. Re-run with --apply.");
    return;
  }

  if (resolvedIds.length > 0) {
    const release = acquireRunLock("import-suggestions");
    try {
      // Re-read inside the lock in case a sync wrote between passes.
      removeSuggestions(
        resolvedIds.map((id) => `youtube:${id}`),
      );
      console.log(
        `${resolvedIds.length} resolved suggestion(s) removed from suggestions.json`,
      );
    } finally {
      release();
    }
  }

  if (remaining > 0) {
    console.log(
      `${remaining} suggestion(s) still pending — run again to retry failures.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
