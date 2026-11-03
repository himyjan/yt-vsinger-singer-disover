#!/usr/bin/env tsx
/**
 * Compares a Chuysan harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-chuysan.ts` produces a snapshot in `.cache/chuysan/`;
 * this script reads that snapshot, matches each row against the dataset by
 * YouTube channel id, classifies through `classifyChannel()`, and imports
 * the ones that pass the virtual-and-singing gate into `data/channels/`.
 *
 *   npm run data:chuysan-import                     # report only
 *   npm run data:chuysan-import -- --apply          # import the new channels
 *
 * Chuysan publishes a YouTube channel id for each entry, so matching against
 * the dataset is direct (no search required).
 *
 * Chuysan is a VTuber directory — every entry is a virtual claim
 * (`reincarnationOf`-eligible).  What a roster still must not buy is a fan:
 * `detectClipAccount()` and `isFanAccountName()` must both be false.
 *
 *   npm run data:chuysan-import                     # report only
 *   npm run data:chuysan-import -- --apply          # import the new channels
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
import { inShard, parseShard } from "../scripts/lib/shard";
import type { Channel, Gender } from "../scripts/lib/types";

const SNAPSHOT = ".cache/chuysan/chuysan.json";

interface ChuYsanChannel {
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
}

interface Row {
  entry: ChuYsanChannel;
  id: string | null;
  record: Channel | null | undefined;
  verdict: "tracked" | "new" | "rejected";
  reason?: string;
  candidates: string[];
}

interface Options {
  apply: boolean;
  limit: number | null;
  shard: { index: number; count: number } | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, limit: null, shard: null };
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
      case "--shard":
        options.shard = parseShard(value);
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:chuysan-import -- [options]",
            "",
            "  --apply         import the channels the gate admits",
            "  --limit <n>     import at most n channels",
            "  --shard N/M     only process the Nth of M shards",
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
      `no snapshot at ${SNAPSHOT} — run npm run data:chuysan first`,
    );
    process.exit(1);
  }

  const snapshot: { data?: ChuYsanChannel[]; generatedAt: string } = JSON.parse(
    fs.readFileSync(SNAPSHOT, "utf8")
  );
  const entries: ChuYsanChannel[] = snapshot.data || [];

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((c) => [c.id, c]));
  const byUcId = new Map<string, Channel>();
  for (const channel of dataset) {
    if (/^UC[\w-]{20,}$/.test(channel.id)) {
      if (!byUcId.has(channel.id)) byUcId.set(channel.id, channel);
    }
    for (const platform of channel.platforms) {
      if (platform.platform === "youtube" && platform.id) {
        if (!byUcId.has(platform.id)) byUcId.set(platform.id, channel);
      }
    }
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    // Shard by the YouTube channel id so parallel volume jobs don't overlap.
    const shard = options.shard;
    if (shard && entry.channel_id && !inShard(entry.channel_id, shard.index, shard.count)) {
      continue;
    }

    // Skip fan / clip accounts before anything else.
    if (
      detectClipAccount(entry.name ?? "", entry.channel_id ?? "") ||
      isFanAccountName(entry.name ?? "")
    ) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "rejected",
        reason: "a clip or fan account",
        candidates: [],
      });
      continue;
    }

    // Chuysan publishes a YouTube channel id directly — match by UC id.
    let matchedId: string | null = null;
    let record: Channel | null | undefined = undefined;
    if (entry.channel_id) {
      matchedId = `youtube:${entry.channel_id}`;
      record =
        byId.get(matchedId) ?? byUcId.get(entry.channel_id) ?? undefined;
    }

    rows.push({
      entry,
      id: matchedId,
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
            .map((row) => `  ${row.id}  ${row.entry.name}`)
            .join("\n")
        : ""),
  );

  if (!options.apply) {
    console.log("Nothing was written. Re-run with --apply.");
    return;
  }

  const source = new InnerTubeSource({ delayMs: 100 });
  await source.connect();

  let added = 0;
  let existing = 0;
  let failed = 0;

  /** Externals edits to apply after import: id → { platform: handle }. */
  const externalsEdits: Array<{ id: string; platform: string; handle: string }> =
    [];

  /** Channel updates for already-tracked records: id → update fn. */
  const trackedUpdates: Array<{ id: string; update: (c: Channel) => boolean }> =
    [];

  /** Reincarnation edges: new record id → predecessor channel id. */
  const reincarnationEdges: Array<{ id: string; predecessorId: string }> = [];

  for (const row of newRows) {
    const entry = row.entry;
    const resolvedId = row.id!.slice("youtube:".length);
    const channelId = entry.channel_id ?? "";

    const rosterHint: RosterHint = {};
    if (channelId) rosterHint.agency = { [channelId]: "" };
    if (entry.published_at) rosterHint.debut = { [channelId]: entry.published_at };
    if (entry.gender) rosterHint.gender = { [channelId]: entry.gender as Gender };
    if (entry.languages) rosterHint.languages = { [channelId]: entry.languages };

    const result = await importYouTubeChannels([resolvedId], {
      limit: 1,
      rosterHint,
    });
    if ((result.added as unknown[]).length > 0) {
      added += (result.added as unknown[]).length;
    } else {
      existing += result.existing;
      for (const f of result.failed) {
        console.error(`chuysan: ${f.id} failed — ${f.reason}`);
        failed++;
      }
    }

    // Collect profile links as externals (never overwrite existing ones).
    if (entry.channel_id) {
      externalsEdits.push({
        id: resolvedId,
        platform: "youtube",
        handle: entry.channel_id,
      });
    }

    // Collect updates for already-tracked records (region, debutDate, gender).
    if (row.record) {
      trackedUpdates.push({
        id: row.record.id,
        update: (c: Channel) => {
          let changed = false;
          if (entry.published_at && !c.debutDate) {
            c.debutDate = entry.published_at;
            changed = true;
          }
          if (entry.region && !c.country) {
            c.country = entry.region;
            changed = true;
          }
          return changed;
        },
      });
    }
  }

  const now = new Date().toISOString();

  // Apply externals to imported/tracked records.
  const externalsWritten = applyChannelEdits(
    externalsEdits.map((e) => ({
      id: e.id,
      update: (channel: Channel) => {
        channel.externals ??= {};
        if (channel.externals[e.platform]) return false;
        channel.externals[e.platform] = e.handle;
        return true;
      },
    })),
    "chuysan",
    now,
  );
  if (externalsWritten) {
    console.log(`${externalsWritten} record(s) had externals filled from chuysan`);
  }

  // Apply updates to already-tracked records (region, debutDate).
  let trackedUpdated = 0;
  for (const u of trackedUpdates) {
    const channel = byId.get(u.id);
    if (channel && u.update(channel)) {
      trackedUpdated++;
    }
  }
  if (trackedUpdated > 0) {
    console.log(
      `${trackedUpdated} tracked record(s) updated from chuysan (region, debut)`,
    );
  }

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed`,
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

import { InnerTubeSource } from "../scripts/lib/youtubei";

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
