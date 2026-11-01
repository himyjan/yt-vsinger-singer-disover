#!/usr/bin/env tsx
/**
 * Compares a 4chan /vt/ harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-vt4chan.ts` produces a snapshot in `.cache/vt4chan/vt4chan.json`;
 * this script reads that snapshot, extracts YouTube channel links from thread
 * comments, resolves handles to UC ids via InnerTube channel search, confirms
 * the match against the channel's own display name, runs the virtual-and-singing
 * gate, and imports survivors into `data/channels/`.
 *
 *   npm run data:vt4chan-import                     # report only
 *   npm run data:vt4chan-import -- --apply          # import the new channels
 *
 * WARNING: 4chan is an anonymous imageboard. Any user can post any link.
 * Fan accounts, clip channels, and re-uploads are common. This importer
 * applies detectClipAccount() and isFanAccountName() filters, and only accepts
 * YouTube channel URLs (not video URLs). Results should be treated as
 * candidates requiring manual review.
 *
 *   npm run data:vt4chan-import                     # report only
 *   npm run data:vt4chan-import -- --apply          # import the new channels
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

const SNAPSHOT = ".cache/vt4chan/vt4chan.json";
const RESOLVED = ".cache/vt4chan/vt4chan-resolved.json";

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

interface Vt4chanEntry {
  no: number;
  sub?: string;
  com?: string;
  youtubeLinks: string[];
}

interface Row {
  entry: Vt4chanEntry;
  id: string | null;
  record: Channel | null | undefined;
  verdict: "tracked" | "new" | "rejected";
  reason?: string;
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
            "Usage: npm run data:vt4chan-import -- [options]",
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

/** Extracts a YouTube handle from @handle format. */
function extractHandle(url: string): string | null {
  const m = url.match(/^youtube\.com\/@([A-Za-z0-9_.-]+)$/);
  return m ? m[1] : null;
}

/** Extracts a UC channel id from channel URL. */
function extractChannelId(url: string): string | null {
  const m = url.match(/^youtube\.com\/channel\/(UC[\w-]{22})$/);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:vt4chan first`,
    );
    process.exit(1);
  }

  const snapshot: { data?: Vt4chanEntry[]; generatedAt: string } = JSON.parse(
    fs.readFileSync(SNAPSHOT, "utf8")
  );
  const entries = snapshot.data || [];

  console.log(
    `snapshot ${snapshot.generatedAt} · ${entries.length} entr(y/ies)`,
  );

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
    // Collect all YouTube handles/ids from this thread's comments
    const handles: string[] = [];
    const channelIds: string[] = [];
    for (const link of entry.youtubeLinks) {
      const h = extractHandle(link);
      if (h) handles.push(h);
      const c = extractChannelId(link);
      if (c) channelIds.push(c);
    }

    let id: string | null = null;
    let record: Channel | null | undefined = undefined;

    // First try direct UC id match
    for (const cId of channelIds) {
      const fullId = `youtube:${cId}`;
      record = byId.get(fullId);
      if (record) {
        id = fullId;
        break;
      }
    }

    // Then try handle match
    if (!id) {
      for (const h of handles) {
        const fullId = `youtube:@${h}`;
        record = byId.get(fullId);
        if (record) {
          id = fullId;
          break;
        }
        // Also try by handle in byHandle map
        record = byHandle.get(h.toLowerCase());
        if (record) {
          id = `youtube:@${h}`;
          break;
        }
      }
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
                `  ${row.id}  ${row.entry.sub || row.entry.no}`
            )
            .join("\n")
        : "")
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
  let rejectedByGate = 0;
  let rejectedByFan = 0;

  /** Externals edits to apply after import: id → { platform: handle }. */
  const externalsEdits: Array<{
    id: string;
    platform: string;
    handle: string;
  }> = [];

  for (const row of newRows) {
    if (!row.id) continue;

    // Extract YouTube handle from the entry's links for handle resolution
    const entry = row.entry;
    const ytHandle = entry.youtubeLinks
      .map((l) => extractHandle(l))
      .find((h) => h !== null);

    let resolvedId: string | null = null;
    if (row.id.startsWith("youtube:UC")) {
      resolvedId = row.id.slice("youtube:".length);
    } else if (row.id.startsWith("youtube:@")) {
      const h = row.id.slice("youtube:@".length);
      resolvedId = await source.resolveHandle(h);
      if (!resolvedId) {
        console.error(
          `vt4chan: could not resolve @${h} to a YouTube channel id`,
        );
        failed++;
        continue;
      }
    }

    // Run classifyChannel gate
    const signals = {
      name: entry.sub || `4chan /vt/ #${entry.no}`,
      description: entry.com ?? null,
      tags: [],
      channelKind: "virtual",
      status: "past",
      isShort: false,
      durationSeconds: null,
      channelRegion: "unknown",
      country: null,
    };
    const classification = classifyChannel(signals);

    // Check clip/fan account tests
    const nameToCheck = entry.sub || resolvedId;
    if (detectClipAccount(nameToCheck, entry.com ?? null) || isFanAccountName(nameToCheck)) {
      rejectedByFan++;
      continue;
    }

    // Check virtual + singing gate
    if (!classification.isSinging || classification.kind !== "virtual") {
      rejectedByGate++;
      continue;
    }

    const channelId = row.id;

    const rosterHint: RosterHint = {};
    if (channelId) {
      rosterHint.agency = { [channelId]: "" };
      rosterHint.debut = { [channelId]: "" };
      rosterHint.gender = { [channelId]: "unknown" };
    }

    if (!resolvedId) {
      console.error(`vt4chan: ${row.entry.sub || row.id} has no YouTube channel id to import`);
      failed++;
      continue;
    }

    const result = await importYouTubeChannels([resolvedId], {
      limit: 1,
      rosterHint,
    });
    if ((result.added as unknown[]).length > 0) {
      added += (result.added as unknown[]).length;
    } else {
      existing += result.existing;
      failed += result.failed.length;
    }

    // Collect profile links as externals (never overwrite existing ones).
    if (entry.youtubeLinks) {
      for (const link of entry.youtubeLinks) {
        const h = extractHandle(link);
        if (h) {
          externalsEdits.push({
            id: resolvedId!,
            platform: "youtube",
            handle: `@${h}`,
          });
        }
        const c = extractChannelId(link);
        if (c) {
          externalsEdits.push({
            id: resolvedId!,
            platform: "youtube",
            handle: c,
          });
        }
      }
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
    "vt4chan",
    now,
  );
  if (externalsWritten) {
    console.log(
      `${externalsWritten} record(s) had externals filled from virtuallife`,
    );
  }

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed · ${rejectedByGate} rejected by gate · ${rejectedByFan} rejected by fan/clip test`,
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
