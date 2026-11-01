#!/usr/bin/env tsx
/**
 * Compares a Twitch harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-twitch.ts` produces a snapshot in `.cache/twitch/twitch.json`;
 * this script reads that snapshot, classifies each candidate through
 * `classifyChannel()`, and imports the ones that pass the virtual-and-singing
 * gate into `data/channels/`.
 *
 *   npm run data:twitch-import                     # report only
 *   npm run data:twitch-import -- --apply          # import the new channels
 *
 * Twitch publishes a broadcaster id for each entry, so matching against the
 * dataset is direct (no search required).
 */

import fs from "node:fs";
import path from "node:path";
import { readAllChannelRecords } from "../scripts/lib/dataset";
import {
  detectClipAccount,
  isFanAccountName,
  classifyChannel,
} from "../scripts/lib/classify";
import { applyChannelEdits } from "../scripts/lib/roster-fill";
import {
  importYouTubeChannels,
  type RosterHint,
} from "../scripts/lib/import-channels";
import { InnerTubeSource } from "../scripts/lib/youtubei";
import type { Channel } from "../scripts/lib/types";

const SNAPSHOT = ".cache/twitch/twitch.json";
const RESOLVED = ".cache/twitch/twitch-resolved.json";

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

interface Row {
  entry: any;
  id: string | null;
  record: Channel | null | undefined;
  verdict: "tracked" | "new" | "rejected";
  candidates: string[];
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
            "Usage: npm run data:twitch-import [--apply] [--limit <n>]",
            "",
            "  --apply    import the channels the gate admits",
            "  --limit <n>  import at most n channels",
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

function foldHandle(handle: string): string {
  return handle
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:twitch first`,
    );
    process.exit(1);
  }

  const snapshot: { data?: any[]; generatedAt: string } = JSON.parse(
    fs.readFileSync(SNAPSHOT, "utf8")
  );
  const entries = snapshot.data || [];

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((c) => [c.id, c]));
  const byHandle = new Map<string, Channel>();
  for (const channel of dataset) {
    for (const platform of channel.platforms) {
      if (platform.platform === "twitch" && platform.handle) {
        const h = platform.handle.replace(/^@+/, "").toLowerCase();
        if (!byHandle.has(h)) byHandle.set(h, channel);
      }
    }
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    const id = `twitch:${entry.id}`;
    let record: Channel | null | undefined = byId.get(id);

    if (!record && entry.broadcaster_login) {
      record = byHandle.get(foldHandle(entry.broadcaster_login)) ?? undefined;
    }

    rows.push({
      entry,
      id,
      record,
      verdict: record ? "tracked" : "new",
      candidates: [],
    });
  }

  console.log(
    `snapshot ${snapshot.generatedAt} · ${entries.length} entr(y/ies) · ${dataset.length} record(s) tracked`,
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
            .map(
              (row) =>
                `  ${row.id}  ${row.entry.broadcaster_name ?? row.entry.broadcaster_login ?? row.entry.id}`
            )
            .join("\n")
        : ""),
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const source = await new InnerTubeSource({ delayMs: 100 }).connect();

  let added = 0;
  let existing = 0;
  let failed = 0;

  for (const row of newRows) {
    const result = await importYouTubeChannels([row.id!], {
      limit: 1,
      rosterHint: {
        agency: row.id ? { [row.id!]: row.entry.broadcaster_name ?? "" } : undefined,
        debut: row.id ? { [row.id!]: "" } : undefined,
        gender: row.id ? { [row.id!]: "unknown" } : undefined,
      },
    });
    if ((result.added as unknown[]).length > 0) {
      added += (result.added as unknown[]).length;
    } else {
      existing += result.existing;
      for (const f of result.failed) {
        console.error(`twitch: ${f.id} failed — ${f.reason}`);
        failed++;
      }
    }
  }

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed`,
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
