#!/usr/bin/env tsx
/**
 * Compares a vtuber-index harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-vtuber-index.ts` produces a snapshot in
 * `.cache/vtuber-index/vtuber-index.json`; this script reads that snapshot,
 * matches each row against the dataset by YouTube channel id, classifies
 * through classifyChannel(), and imports the ones that pass the
 * virtual-and-singing gate into `data/channels/`.
 *
 *   npm run data:vtuber-index-import                     # report only
 *   npm run data:vtuber-index-import -- --apply          # import the new channels
 *
 * vtuber-index.com publishes a YouTube channel id for each entry, so matching
 * against the dataset is direct (no search required).
 *
 * Entries without a YouTube channel id are still added as new records,
 * keyed by `vtuber-index:<id>`. When a YouTube channel is later discovered
 * for the same performer, `canonicalizeChannelIds()` re-keys the record to
 * the `UC…` id and merges duplicates.
 *
 * vtuber-index.com is a VTuber directory — every entry is a virtual claim
 * (`reincarnationOf`-eligible).  What a roster still must not buy is a fan:
 * `detectClipAccount()` and `isFanAccountName()` must both be false.
 *
 *   npm run data:vtuber-index-import                     # report only
 *   npm run data:vtuber-index-import -- --apply          # import the new channels
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
import { inShard, parseShard } from "../scripts/lib/shard";
import type { Channel } from "../scripts/lib/types";

const SNAPSHOT = ".cache/vtuber-index/vtuber-index.json";
const RESOLVED = ".cache/vtuber-index/vtuber-index-resolved.json";

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

interface VtuberIndexEntry {
  id: string;
  channel_id: string;
  name: string;
  group: string;
  subscriber: number;
  view_count: number;
  video_count: number;
  video_live_count: number;
  spc_data_count: number;
  country: string;
  member_fee: string;
  image_url: string;
  first_video_date: string;
  last_video_date: string | null;
  retirement_date: string | null;
}

interface Row {
  entry: VtuberIndexEntry;
  id: string | null;
  record: Channel | null | undefined;
  verdict: "tracked" | "new" | "rejected";
  reason?: string;
  candidates: string[];
}

interface Options {
  apply: boolean;
  limit: number | null;
  shard: string | null;
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
        options.shard = value ?? null;
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:vtuber-index-import -- [options]",
            "",
            "  --apply         import the channels the gate admits",
            "  --limit <n>     import at most n channels",
            "  --shard N/M     only import entries whose id lands in shard N (1-based) of M",
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
      `no snapshot at ${SNAPSHOT} — run npm run data:vtuber-index first`,
    );
    process.exit(1);
  }

  const snapshot: { data?: VtuberIndexEntry[]; generatedAt: string } = JSON.parse(
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
  const shard = options.shard ? parseShard(options.shard) : null;
  for (const entry of entries) {
    // Skip fan / clip accounts before anything else.
    if (
      detectClipAccount(entry.name ?? "", entry.group ?? "") ||
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

    if (entry.channel_id) {
      // vtuber-index entries are keyed by YouTube channel id directly
      const id = `youtube:${entry.channel_id}`;
      // Shard by the YouTube channel id so parallel jobs don't overlap.
      if (shard && !inShard(entry.channel_id, shard.index, shard.count)) continue;
      let record: Channel | null | undefined = byId.get(id);
      // Fall back to matching by raw YouTube UC id on the platform link
      if (!record) record = byYoutubeId.get(entry.channel_id) ?? undefined;
      // Fall back to matching by the record's own UC… id
      if (!record) record = byUcId.get(entry.channel_id) ?? undefined;

      rows.push({
        entry,
        id,
        record,
        verdict: record ? "tracked" : "new",
        candidates: [],
      });
    } else {
      // No YouTube channel — add as a new record keyed by the vtuber-index id.
      // When a YouTube channel is later discovered, canonicalizeChannelIds()
      // re-keys the record to the UC… id and merges duplicates.
      const id = `vtuber-index:${entry.id}`;
      // Shard by the vtuber-index id for entries without a YouTube channel.
      if (shard && !inShard(entry.id, shard.index, shard.count)) continue;
      let record: Channel | null | undefined = byId.get(id);

      rows.push({
        entry,
        id,
        record,
        verdict: record ? "tracked" : "new",
        candidates: [],
      });
    }
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
  let youtubeAdded = 0;

  /** Externals edits to apply after import: id → { platform: handle }. */
  const externalsEdits: Array<{ id: string; platform: string; handle: string }> =
    [];

  for (const row of newRows) {
    if (!row.id) continue;

    // YouTube entries: fetch profile via importYouTubeChannels.
    if (row.id.startsWith("youtube:")) {
      const resolvedId = row.id.slice("youtube:".length);
      const result = await importYouTubeChannels([resolvedId], {
        limit: 1,
        rosterHint: {
          agency: resolvedId ? { [resolvedId]: "" } : undefined,
          debut: resolvedId ? { [resolvedId]: "" } : undefined,
          gender: resolvedId ? { [resolvedId]: "unknown" } : undefined,
        },
      });
      if ((result.added as unknown[]).length > 0) {
        added += (result.added as unknown[]).length;
        youtubeAdded += (result.added as unknown[]).length;
      } else {
        existing += result.existing;
        for (const f of result.failed) {
        console.error(`vtuber-index: ${f.id} failed — ${f.reason}`);
        failed++;
      }
      }

      // Collect platform links as externals (never overwrite existing ones).
      const entry = row.entry;
      if (entry.channel_id) {
        externalsEdits.push({
          id: resolvedId,
          platform: "youtube",
          handle: entry.channel_id,
        });
      }
    } else {
      // Non-YouTube entry (e.g. vtuber-index:<id>): build the Channel record
      // directly without calling importYouTubeChannels().
      const entry = row.entry;
      const classification = classifyChannel({
        name: entry.name,
        description: entry.group ?? null,
        tags: [],
        country: entry.country ?? null,
        platform: "vtuber-index",
        virtualClaim: "roster",
        hasAvatar: false,
      });

      const aliases: string[] = [];
      if (entry.group && entry.group !== entry.name) {
        aliases.push(entry.group);
      }

      const channel: Channel = {
        id: row.id,
        name: entry.name,
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
        affiliation: entry.group
          ? entry.group.toLowerCase().includes("independent")
            ? "independent"
            : "group"
          : "unknown",
        avatar: null,
        banner: null,
        description: entry.group ?? null,
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
        activity: entry.retirement_date ? "graduated" : "unknown",
        debutDate: entry.first_video_date ?? null,
        graduateDate: entry.retirement_date ?? null,
        platforms: [],
        externals: {},
        popularVideoId: null,
      };

      const now = new Date().toISOString();
      const written = applyChannelEdits(
        [
          {
            id: channel.id,
            update: () => true, // always write new records
          },
        ],
        "vtuber-index",
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
    "vtuber-index",
    now,
  );
  if (externalsWritten) {
    console.log(
      `${externalsWritten} record(s) had externals filled from vtuber-index`,
    );
  }

  console.log(
    `\n${added} channel(s) written · ${existing} already tracked · ${failed} failed · ${youtubeAdded} via YouTube`,
  );
  if (added > 0) console.log("Run npm run data:index next.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
