#!/usr/bin/env tsx
/**
 * Compares a v-sai.com/vtuber harvest with the dataset and imports new
 * channels.
 *
 * `scripts/harvest-v-sai.ts` produces a snapshot in `.cache/`;
 * this script reads that snapshot, classifies each candidate through
 * `classifyChannel()`, and imports the ones that pass the virtual-and-singing
 * gate into `data/channels/`.
 *
 *   npm run data:v-sai-import                     # report only
 *   npm run data:v-sai-import -- --apply          # import the new channels
 *
 * v-sai.com/vtuber publishes a YouTube channel id for each entry, so
 * matching against the dataset is direct (no search required).
 *
 * Each row carries a YouTube channel id, so it is admitted as a
 * virtual claim (`reincarnationOf`-eligible).  What a roster still must
 * not buy is a fan: `detectClipAccount()` and `isFanAccountName()` must
 * both be false.
 *
 *   npm run data:v-sai-import                     # report only
 *   npm run data:v-sai-import -- --apply          # import the new channels
 */

import fs from "node:fs";
import path from "node:path";
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
import { readAllChannelRecords } from "../scripts/lib/dataset";
import { InnerTubeSource } from "../scripts/lib/youtubei";
import type { Channel } from "../scripts/lib/types";

interface VSaiChannel {
  channel_id?: string;
  name?: string;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  views?: number;
  published_at?: string;
  region?: string | null;
  gender?: string | null;
  languages?: string[];
  handle?: string | null;
}

const SNAPSHOT = ".cache/v-sai/v-sai.json";
const RESOLVED = ".cache/v-sai/v-sai-resolved.json";

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
  reason?: string;
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
            "Usage: npm run data:v-sai-import -- [options]",
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
      `no snapshot at ${SNAPSHOT} — run npm run data:v-sai first`
    );
    process.exit(1);
  }

  const snapshot: { data?: VSaiChannel[]; generatedAt: string } = JSON.parse(
    fs.readFileSync(SNAPSHOT, "utf8")
  );
  const entries = snapshot.data || [];

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

  const rows: Row[] = [];
  for (const entry of entries) {
    if (!entry.channel_id) continue;

    const id = `youtube:${entry.channel_id}`;
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
            .map(
              (row) =>
                `  ${row.id}  ${row.entry.name}`
            )
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
        debut: row.id ? { [row.id!]: row.entry.published_at ?? "" } : undefined,
        gender: row.id ? { [row.id!]: "unknown" } : undefined,
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
