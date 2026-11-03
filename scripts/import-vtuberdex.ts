#!/usr/bin/env tsx
/**
 * Compares a VTuberDex harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-vtuberdex.ts` produces a snapshot in `.cache/vtuberdex/vtuberdex.json`;
 * this script reads that snapshot, resolves each name to a YouTube channel
 * through InnerTube channel search, confirms the hit against the record's
 * own display name, gates on the two-video rule (virtual + singing evidence),
 * and imports the survivors into `data/channels/`.
 *
 *   npm run data:vtuberdex-import                     # report only
 *   npm run data:vtuberdex-import -- --apply          # import the new channels
 *
 * VTuberDex publishes VTuber names but not always YouTube channel ids. When
 * a profile page is available, the direct channel id is used; otherwise each
 * name is resolved through YouTube channel search and confirmed before
 * import. Each admitted channel is a virtual claim (`reincarnationOf`-eligible).
 * What a roster still must not buy is a fan: the discover-evidence gate
 * excludes clip and fan accounts.
 *
 *   npm run data:vtuberdex-import                     # report only
 *   npm run data:vtuberdex-import -- --apply          # import the new channels
 */

import fs from "node:fs";
import path from "node:path";
import { promoteCandidates } from "../scripts/lib/promote-candidates";
import type { PromotionCandidate } from "../scripts/lib/promote-candidates";

const SNAPSHOT = ".cache/vtuberdex/vtuberdex.json";
const RESOLVED = ".cache/vtuberdex/vtuberdex-resolved.json";

interface ResolvedCache {
  [handle: string]: { id: string | null; at: string };
}

function readResolved(): ResolvedCache {
  try {
    return JSON.parse(fs.readFileSync(RESOLVED, "utf8")) as ResolvedCache;
  } catch {
    return {};
  }
}

function writeResolved(cache: ResolvedCache): void {
  fs.writeFileSync(RESOLVED, JSON.stringify(cache, null, 0));
}

interface VtuberdexEntry {
  name: string;
  country?: string;
  group?: string;
  youtubeId?: string;
}

interface Options {
  apply: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtuberdex-import -- [options]",
            "",
            "  --apply         import the channels the gate admits",
            "  --limit <n>     import at most n channels",
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
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:vtuberdex first`,
    );
    process.exit(1);
  }

  const snapshot: { data?: VtuberdexEntry[]; generatedAt: string } = JSON.parse(
    fs.readFileSync(SNAPSHOT, "utf8")
  );
  const entries = snapshot.data || [];

  console.log(
    `snapshot ${snapshot.generatedAt} · ${entries.length} entr(y/ies)`,
  );

  if (!options.apply) {
    console.log(
      `Nothing was written. Re-run with --apply to resolve ${entries.length} name(s) through YouTube search.`
    );
    return;
  }

  const candidates: PromotionCandidate[] = entries.map((entry) => ({
    name: entry.name,
    source: "vtuberdex",
    channelId: entry.youtubeId ?? null,
  }));

  const outcome = await promoteCandidates(candidates, {
    limit: options.limit ?? 25,
    onLog: (message) => console.log(`  ${message}`),
  });

  console.log(
    `\n${outcome.added.length} channel(s) written · ${outcome.existing} already tracked · ${outcome.rejected.length} rejected · ${outcome.failed.length} failed`,
  );
  for (const rejected of outcome.rejected.slice(0, 10)) {
    console.log(`  rejected ${rejected.name}: ${rejected.reason}`);
  }
  for (const failed of outcome.failed.slice(0, 10)) {
    console.log(`  failed ${failed.name}: ${failed.reason}`);
  }
  if (outcome.added.length > 0) console.log("Run npm run data:index next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
