#!/usr/bin/env tsx
/**
 * Import VTuber channels from 4chan /vt/ harvest into the dataset.
 *
 * Reads `.cache/vt4chan/vt4chan.json`, matches each entry against the dataset
 * by YouTube channel id, classifies through classifyChannel(), and imports
 * the ones that pass the virtual-and-singing gate into `data/channels/`.
 *
 *   npm run data:vt4chan-import                     # report only
 *   npm run data:vt4chan-import -- --apply          # import the new channels
 *
 * Entries without a YouTube link are still added as new records keyed by
 * `vt4chan:<thread_no>`. When a YouTube channel is later discovered,
 * canonicalizeChannelIds() re-keys the record to the UC… id and merges
 * duplicates.
 *
 * WARNING: 4chan is an anonymous imageboard. Results require manual review.
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

function extractHandle(url: string): string | null {
  const m = url.match(/^youtube\.com\/@([A-Za-z0-9_.-]+)$/);
  return m ? m[1] : null;
}

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

  console.log(`vt4chan: snapshot ${snapshot.generatedAt} · ${entries.length} entr(y/ies)`);

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
      if (!record) record = byYoutubeId.get(cId) ?? undefined;
      if (!record) record = byUcId.get(cId) ?? undefined;
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
        record = byHandle.get(h.toLowerCase());
        if (record) {
          id = `youtube:@${h}`;
          break;
        }
      }
    }

    if (!id && channelIds.length === 0 && handles.length === 0) {
      // No YouTube link — add as a new record keyed by thread number
      id = `vt4chan:${entry.no}`;
      record = byId.get(id);
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
    `vt4chan: ${entries.length} entr(y/ies) · ${dataset.length} record(s) tracked`,
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
            .map((row) => `  ${row.id}  ${row.entry.sub ?? row.entry.no}`)
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

  for (const row of newRows) {
    if (!row.id) continue;

    const entry = row.entry;

    // YouTube entries: fetch profile via importYouTubeChannels.
    if (row.id.startsWith("youtube:")) {
      const resolvedId = row.id.startsWith("youtube:UC")
        ? row.id.slice("youtube:".length)
        : null;

      if (resolvedId) {
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
        } else {
          existing += result.existing;
          for (const f of result.failed) {
        console.error(`vt4chan: ${f.id} failed — ${f.reason}`);
        failed++;
      }
        }

        if (entry.youtubeLinks.length > 0) {
          externalsEdits.push({
            id: resolvedId,
            platform: "youtube",
            handle: entry.youtubeLinks[0],
          });
        }
      } else if (row.id.startsWith("youtube:@")) {
        const h = row.id.slice("youtube:@".length);
        const resolved = await source.resolveHandle(h);
        if (!resolved) {
          console.error(
            `vt4chan: could not resolve @${h} to a YouTube channel id`,
          );
          failed++;
          continue;
        }
        const result = await importYouTubeChannels([resolved], {
          limit: 1,
          rosterHint: {
            agency: resolved ? { [resolved]: "" } : undefined,
            debut: resolved ? { [resolved]: "" } : undefined,
            gender: resolved ? { [resolved]: "unknown" } : undefined,
          },
        });
        if ((result.added as unknown[]).length > 0) {
          added += (result.added as unknown[]).length;
        } else {
          existing += result.existing;
          for (const f of result.failed) {
        console.error(`vt4chan: ${f.id} failed — ${f.reason}`);
        failed++;
      }
        }

        if (entry.youtubeLinks.length > 0) {
          externalsEdits.push({
            id: resolved,
            platform: "youtube",
            handle: entry.youtubeLinks[0],
          });
        }
      }
    } else {
      // Non-YouTube entry (vt4chan:<thread_no>): build the Channel record directly
      const classification = classifyChannel({
        name: entry.sub ?? `4chan /vt/ #${entry.no}`,
        description: entry.com ?? null,
        tags: [],
        country: null,
        platform: "vt4chan",
        virtualClaim: "roster",
        hasAvatar: false,
      });

      const aliases: string[] = [];
      if (entry.sub && entry.sub !== `4chan /vt/ #${entry.no}`) {
        aliases.push(entry.sub);
      }

      const channel: Channel = {
        id: row.id,
        name: entry.sub ?? `4chan /vt/ #${entry.no}`,
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
        description: entry.com ?? null,
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
        debutDate: null,
        graduateDate: null,
        platforms: [],
        externals: {},
        popularVideoId: null,
      };

      const now = new Date().toISOString();
      const written = applyChannelEdits(
        [{ id: channel.id, update: () => true }],
        "vt4chan",
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
    "vt4chan",
    now,
  );
  if (externalsWritten) {
    console.log(
      `${externalsWritten} record(s) had externals filled from vt4chan`,
    );
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
