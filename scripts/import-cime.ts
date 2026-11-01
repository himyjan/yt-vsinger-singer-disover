#!/usr/bin/env tsx
/**
 * Compares a CI.ME harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-cime.ts` produces a snapshot in `.cache/`; this is the
 * gate between that snapshot and `data/`. It prints what would change and
 * writes nothing without `--apply`.
 *
 *   npm run data:cime-import                     # report only
 *   npm run data:cime-import -- --apply          # import the new channels
 *
 * The CI.ME API publishes channel ids directly, so matching is exact:
 *   `ci.me:<channel_id>` → channel id.
 */

import fs from "node:fs";
import { readAllChannelRecords } from "../scripts/lib/dataset";
import {
  detectClipAccount,
  isFanAccountName,
} from "../scripts/lib/classify";
import { applyChannelEdits } from "../scripts/lib/roster-fill";
import {
  importYouTubeChannels,
  type RosterHint,
} from "../scripts/lib/import-channels";
import { canonicalAgency } from "../scripts/lib/regions";
import { InnerTubeSource } from "../scripts/lib/youtubei";
import type { Channel, PlatformId } from "../scripts/lib/types";

const SNAPSHOT = ".cache/cime/cime.json";
const RESOLVED = ".cache/cime/cime-resolved.json";

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
            "Usage: npm run data:cime-import -- [options]",
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

interface Row {
  entry: any;
  id: string | null;
  record: Channel | null | undefined;
  verdict: "tracked" | "new" | "rejected";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:cime first`
    );
    process.exit(1);
  }

  const snapshot: { items: any[]; generatedAt: string } = JSON.parse(
    fs.readFileSync(SNAPSHOT, "utf8")
  );
  const entries = snapshot.items;

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((c) => [c.id, c]));
  const byHandle = new Map<string, Channel>();
  for (const channel of dataset) {
    for (const platform of channel.platforms) {
      if (platform.platform === "youtube" && platform.handle) {
        const h = platform.handle.replace(/^@+/, "").toLowerCase();
        if (!byHandle.has(h)) byHandle.set(h, channel);
      }
    }
  }

  const rows: Array<{ entry: any; id: string | null; record: Channel | null | undefined; verdict: "tracked" | "new" | "rejected" }> = [];

  for (const entry of entries) {
    if (!entry.channel_id) continue;

    const id = `ci.me:${entry.channel_id}`;
    let record: Channel | null | undefined = byId.get(id);

    if (!record && entry.handle) {
      record = byHandle.get(foldHandle(entry.handle)) ?? null;
    }

    rows.push({
      entry,
      id,
      record,
      verdict: record ? "tracked" : "new",
    });
  }

  console.log(
    `snapshot ${snapshot.generatedAt} · ${entries.length} entr(y/ies) · ${dataset.length} record(s) tracked`
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  }
  for (const verdict of ["tracked", "new", "rejected"] as const) {
    const count = counts.get(verdict) ?? 0;
    if (count) console.log(`  ${verdict.padEnd(12)} ${count}`);
  }

  const fresh = rows.filter((row) => row.verdict === "new" && row.id);
  const deduped = new Map<string, Row>();
  for (const row of fresh) {
    if (!deduped.has(row.id!)) deduped.set(row.id!, row);
  }
  const newRows = [...deduped.values()];

  console.log(
    newRows.length +
      " channel(s) would be imported" +
      (newRows.length
        ? ":\n" +
          newRows
            .slice(0, 20)
            .map((row) => `  ${row.id}  ${row.entry.name}`)
            .join("\n")
        : ""),
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const source = await new InnerTubeSource({ delayMs: 100 }).connect();
  const client = (source as any).client;

  let added = 0;
  let existing = 0;
  let failed = 0;

  for (const row of newRows) {
    const result = await importYouTubeChannels([row.id!], {
      limit: 1,
      rosterHint: {
        agency: row.id ? { [row.id!]: row.entry.affiliation ?? "" } : undefined,
        debut: row.entry.debutDate ?? null,
        gender: row.id ? { [row.id!]: row.entry.gender ?? "unknown" } : undefined,
      },
    });
    if (result.added.length > 0) {
      added += result.added.length;
    } else {
      existing += result.existing;
      failed += result.failed.length;
    }
  }

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed`
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

function foldHandle(handle: string): string {
  return handle
    .trim()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(?:www\.)?(?:youtube\.com\/)?/i, "")
    .replace(/^(?:channel|user|c)\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
