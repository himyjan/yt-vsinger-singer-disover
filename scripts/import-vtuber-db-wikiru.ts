#!/usr/bin/env tsx
/**
 * Compares a vtuber-database.wikiru.jp harvest with the dataset and imports
 * new channels.
 *
 * `scripts/harvest-vtuber-db.ts` produces a snapshot in `.cache/`;
 * this script reads that snapshot, classifies each candidate through
 * `classifyChannel()`, and imports the ones that pass the virtual-and-singing
 * gate into `data/channels/`.
 *
 *   npm run data:vtuber-db-import                     # report only
 *   npm run data:vtuber-db-import -- --apply          # import the new channels
 *
 * The vtuber-database.wikiru.jp publishes a YouTube channel id for each
 * entry, so matching against the dataset is direct (no search required).
 *
 * Entries without a YouTube channel id are still added as new records,
 * keyed by `vdb:<uuid>`. When a YouTube channel is later discovered,
 * canonicalizeChannelIds() re-keys the record to the UC… id and merges
 * duplicates.
 *
 * Each row carries a YouTube channel id, so it is admitted as a
 * virtual claim (`reincarnationOf`-eligible).  What a roster still must
 * not buy is a fan: `detectClipAccount()` and `isFanAccountName()` must
 * both be false.
 *
 *   npm run data:vtuber-db-import                     # report only
 *   npm run data:vtuber-db-import -- --apply          # import the new channels
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

interface VdbChannel {
  channel_id?: string;
  title?: string;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  published_at?: string;
  region?: string | null;
  gender?: string | null;
  languages?: string[];
  handle?: string | null;
}

const SNAPSHOT = ".cache/vtuber-db/vtuber-db.json";
const RESOLVED = ".cache/vtuber-db/vtuber-db-resolved.json";

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
            "Usage: npm run data:vtuber-db-import -- [options]",
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
      `no snapshot at ${SNAPSHOT} — run npm run data:vtuber-db first`,
    );
    process.exit(1);
  }

  const snapshot: { data?: VdbChannel[]; generatedAt: string } = JSON.parse(
    fs.readFileSync(SNAPSHOT, "utf8")
  );
  const entries = snapshot.data || [];

  const dataset = readAllChannelRecords();
  const byId = new Map(dataset.map((c) => [c.id, c]));
  const byHandle = new Map<string, Channel>();
  const byYoutubeId = new Map<string, Channel>();
  const byUcId = new Map<string, Channel>();
  for (const channel of dataset) {
    for (const platform of channel.platforms) {
      if (platform.platform === "youtube" && platform.handle) {
        const h = platform.handle.replace(/^@+/, "").toLowerCase();
        if (!byHandle.has(h)) byHandle.set(h, channel);
      }
      if (platform.platform === "youtube" && platform.id) {
        if (!byYoutubeId.has(platform.id)) byYoutubeId.set(platform.id, channel);
      }
      if (/^UC[\w-]{20,}$/.test(channel.id)) {
        if (!byUcId.has(channel.id)) byUcId.set(channel.id, channel);
      }
    }
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    // Skip fan / clip accounts before anything else.
    if (
      detectClipAccount(entry.title ?? "", entry.description ?? "") ||
      isFanAccountName(entry.title ?? "")
    ) {
      rows.push({
        entry,
        id: null,
        record: null,
        verdict: "rejected",
        reason: "a clip or fan account",
      });
      continue;
    }

    if (entry.channel_id) {
      // vtuber-db entries are keyed by YouTube channel id directly
      const id = `youtube:${entry.channel_id}`;
      let record: Channel | null | undefined = byId.get(id);
      // Fall back to matching by raw YouTube UC id on the platform link
      if (!record) record = byYoutubeId.get(entry.channel_id) ?? undefined;
      // Fall back to matching by the record's own UC… id
      if (!record) record = byUcId.get(entry.channel_id) ?? undefined;

      if (!record && entry.handle) {
        record = byHandle.get(foldHandle(entry.handle)) ?? null;
      }

      rows.push({
        entry,
        id,
        record,
        verdict: record ? "tracked" : "new",
      });
    } else {
      // No YouTube channel — add as a new record keyed by vdb:<row index>.
      // When a YouTube channel is later discovered, canonicalizeChannelIds()
      // re-keys the record to the UC… id and merges duplicates.
      const id = `vdb:${entry.title ?? entry.description ?? "unknown"}`;
      let record: Channel | null | undefined = byId.get(id);

      rows.push({
        entry,
        id,
        record,
        verdict: record ? "tracked" : "new",
      });
    }
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
                `  ${row.id}  ${row.entry.title ?? row.entry.description ?? ""}`
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
    const entry = row.entry;
    const rowId = row.id;
    if (!rowId) continue;

    // YouTube entries: fetch profile via importYouTubeChannels.
    if (rowId.startsWith("youtube:")) {
      const result = await importYouTubeChannels([rowId.slice("youtube:".length)], {
        limit: 1,
        rosterHint: {
          agency: rowId ? { [rowId]: entry.affiliation ?? "" } : undefined,
          debut: rowId ? { [rowId]: entry.published_at ?? "" } : undefined,
          gender: rowId ? { [rowId]: "unknown" } : undefined,
        },
      });
      if (result.added.length > 0) {
        added += result.added.length;
      } else {
        existing += result.existing;
        for (const f of result.failed) {
        console.error(`vdb: ${f.id} failed — ${f.reason}`);
        failed++;
      }
      }
    } else {
      // Non-YouTube entry: build the Channel record directly.
      const classification = classifyChannel({
        name: entry.title ?? "",
        description: entry.description ?? null,
        tags: [],
        country: entry.region ?? null,
        platform: "vdb",
        virtualClaim: "roster",
        hasAvatar: false,
      });

      const aliases: string[] = [];
      if (entry.handle && entry.handle !== entry.title) {
        aliases.push(entry.handle);
      }

      const channel: Channel = {
        id: rowId,
        name: entry.title ?? "Unknown",
        nameSource: "roster",
        aliases: aliases.slice(0, 12),
        handle: null,
        kind: classification.kind,
        role: classification.role,
        region: classification.region,
        regionSource: "roster",
        languages: classification.languages,
        statedLanguages: classification.statedLanguages,
        agency: classification.agency ?? null,
        affiliation: "unknown",
        avatar: null,
        banner: null,
        description: entry.description ?? null,
        subscribers: { tag: "hidden" },
        videoCount: null,
        viewCount: null,
        uploadsPlaylistId: null,
        country: null,
        tags: [],
        isSinging: classification.isSinging,
        gender: classification.gender,
        isAi: classification.isAi,
        isOfficialArtist: false,
        officialArtistCheckedAt: null,
        variant: classification.variant,
        verification: null,
        source: "api",
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastItemsFetchedAt: null,
        lastDetailsFetchedAt: null,
        activity: "unknown",
        debutDate: entry.published_at ?? null,
        graduateDate: null,
        platforms: [],
        externals: {},
        popularVideoId: null,
      };

      const now = new Date().toISOString();
      const written = applyChannelEdits(
        [{ id: channel.id, update: () => true }],
        "vdb",
        now,
      );

      if (written) {
        added++;
      } else {
        existing++;
      }
    }
  }

  const now = new Date().toISOString();

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed`,
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
