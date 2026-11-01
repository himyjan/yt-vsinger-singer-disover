#!/usr/bin/env tsx
/**
 * Compares a VtuberDB HTML harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-vdb-html.ts` produces a snapshot in
 * `.cache/vdb-html/vdb-html.json`; this script reads that snapshot,
 * matches each row against the dataset by YouTube channel id, classifies
 * through classifyChannel(), and imports the ones that pass the
 * virtual-and-singing gate into `data/channels/`.
 *
 *   npm run data:vdb-html-import                     # report only
 *   npm run data:vdb-html-import -- --apply          # import the new channels
 *
 * VtuberDB publishes a YouTube channel url for each entry, so matching
 * against the dataset is direct once the url is resolved to a UC… id.
 *
 * VtuberDB is a performer directory — every entry is a virtual claim
 * (`reincarnationOf`-eligible).  What a roster still must not buy is a fan:
 * `detectClipAccount()` and `isFanAccountName()` must both be false.
 *
 *   npm run data:vdb-html-import                     # report only
 *   npm run data:vdb-html-import -- --apply          # import the new channels
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
import type { Channel, Gender } from "../scripts/lib/types";

const SNAPSHOT = ".cache/vdb-html/vdb-html.json";
const RESOLVED = ".cache/vdb-html/vdb-html-resolved.json";

interface ResolvedCache {
  [url: string]: { id: string | null; at: string };
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

interface VdbHtmlEntry {
  name: string;
  slug: string;
  gender: string | null;
  affiliation: string | null;
  group: string | null;
  activity: string | null;
  debutDate: string | null;
  youtubeUrl: string | null;
}

interface Row {
  entry: VdbHtmlEntry;
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
            "Usage: npm run data:vdb-html-import -- [options]",
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

/** Extracts a YouTube channel id from a youtube.com url. */
function extractChannelId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    url.match(/youtube\.com\/channel\/(UC[\w-]{22})/) ||
    url.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/);
  if (!m) return null;
  return m[1].startsWith("UC") ? m[1] : null;
}

/** Extracts a YouTube handle from @handle format. */
function extractHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(
      `no snapshot at ${SNAPSHOT} — run npm run data:vdb-html first`,
    );
    process.exit(1);
  }

  const snapshot: { data?: VdbHtmlEntry[]; generatedAt: string } = JSON.parse(
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
    const channelId = extractChannelId(entry.youtubeUrl);
    let id = channelId ? `youtube:${channelId}` : null;
    let record: Channel | null | undefined = id ? byId.get(id) : undefined;

    if (!id && entry.youtubeUrl) {
      const h = extractHandle(entry.youtubeUrl);
      if (h) {
        record = byHandle.get(h.toLowerCase()) ?? undefined;
        if (record) id = `youtube:@${h}`;
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
                `  ${row.id}  ${row.entry.name}`
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

    const entry = row.entry;
    const ytHandle = entry.youtubeUrl ? extractHandle(entry.youtubeUrl) : null;

    let resolvedId: string | null = null;
    if (row.id.startsWith("youtube:UC")) {
      resolvedId = row.id.slice("youtube:".length);
    } else if (row.id.startsWith("youtube:@")) {
      const h = row.id.slice("youtube:@".length);
      resolvedId = await source.resolveHandle(h);
      if (!resolvedId) {
        console.error(
          `vdb-html: could not resolve @${h} to a YouTube channel id`,
        );
        failed++;
        continue;
      }
    }

    // Run classifyChannel gate
    const signals = {
      name: entry.name,
      description: entry.group ?? null,
      tags: entry.group ? [entry.group] : [],
      channelKind: "virtual",
      status: "past",
      isShort: false,
      durationSeconds: null,
      channelRegion: entry.activity ?? "unknown",
      country: entry.group ?? null,
    };
    const classification = classifyChannel(signals);

    // Check clip/fan account tests
    const nameToCheck = entry.name;
    if (
      detectClipAccount(nameToCheck, entry.group ?? null) ||
      isFanAccountName(nameToCheck)
    ) {
      rejectedByFan++;
      continue;
    }

    // Check virtual + singing gate
    if (!classification.isSinging || classification.kind !== "virtual") {
      rejectedByGate++;
      continue;
    }

    const channelIdStr = resolvedId as string;

    const rosterHint: RosterHint = {};
    if (channelIdStr) {
      rosterHint.agency = { [channelIdStr]: entry.affiliation ?? "" } as Record<string, string>;
      rosterHint.debut = { [channelIdStr]: (entry.debutDate ?? "") } as Record<string, string>;
      rosterHint.gender = { [channelIdStr]: (entry.gender ?? "unknown") as Gender } as Record<string, Gender>;
    }

    const result = await importYouTubeChannels([resolvedId!], {
      limit: 1,
      rosterHint,
    });
    if ((result.added as unknown[]).length > 0) {
      added += (result.added as unknown[]).length;
    } else {
      existing += result.existing;
      for (const f of result.failed) {
        console.error(`vdb-html: ${f.id} failed — ${f.reason}`);
        failed++;
      }
    }

    // Collect profile links as externals (never overwrite existing ones).
    if (entry.youtubeUrl) {
      const h = extractHandle(entry.youtubeUrl);
      if (h) {
        externalsEdits.push({
          id: resolvedId!,
          platform: "youtube",
          handle: `@${h}`,
        });
      }
      const c = extractChannelId(entry.youtubeUrl);
      if (c) {
        externalsEdits.push({
          id: resolvedId!,
          platform: "youtube",
          handle: c,
        });
      }
    }
  }

  const now = new Date().toISOString();

  // Apply externals to imported/tracked records.

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
    "vdb-html",
    now,
  );
  if (externalsWritten) {
    console.log(
      `${externalsWritten} record(s) had externals filled from vdb-html`,
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
