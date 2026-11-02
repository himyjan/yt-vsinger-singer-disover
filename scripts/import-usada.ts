#!/usr/bin/env tsx
/**
 * Compares a USADA harvest with the dataset and imports new channels.
 *
 * `scripts/harvest-usada.ts` produces a snapshot in `.cache/usada/usada.json`;
 * this script reads that snapshot, matches each row against the dataset by
 * YouTube channel id OR YouTube handle, classifies through classifyChannel(),
 * and imports the ones that pass the virtual-and-singing gate into
 * `data/channels/`.
 *
 * USADA publishes a YouTube channel id for each entry, so matching against
 * the dataset is direct (no search required).
 *
 * USADA is a VTuber directory — every entry is a virtual claim
 * (`reincarnationOf`-eligible).  What a roster still must not buy is a fan:
 * `detectClipAccount()` and `isFanAccountName()` must both be false.
 *
 *   npm run data:usada-import                     # report only
 *   npm run data:usada-import -- --apply          # import the new channels
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
import type { Affiliation, Channel } from "../scripts/lib/types";

const SNAPSHOT_DIR = ".cache/usada";
const RESOLVED = ".cache/usada/usada-resolved.json";

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

interface UsadaEntry {
  id: string;
  name: string;
  gender: string | null;
  affiliation: string | null;
  group: string | null;
  activity: string | null;
  debutDate: string | null;
  country: string | null;
  youtubeUrl: string | null;
  youtubeId: string | null;
  youtubeHandle: string | null;
  twitterUrl: string | null;
  twitchUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  reincarnationOf: string[] | null;
  roleTags: string[] | null;
  statusData: string | null;
  links: { platform: string; handle: string; url: string }[] | null;
}

interface Row {
  entry: UsadaEntry;
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
            "Usage: npm run data:usada-import -- [options]",
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

/** Maps USADA activity status to our Activity type. */
function mapActivity(status: string | null): "active" | "preparing" | "graduated" | "unknown" | null {
  if (!status) return null;
  const s = status.toLowerCase().trim();
  if (s === "active" || s === "活動中") return "active";
  if (s === "preparing" || s === "準備中") return "preparing";
  if (s === "graduated" || s === "畢業" || s === "引退" || s === "畢業 / 引退" || s === "己引退") return "graduated";
  if (s === "hiatus" || s === "休止" || s === "休止中") return "active"; // hiatus is still active, just on break
  if (s === "unknown") return null;
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const snapshotFiles = fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.startsWith("usada-") && f.endsWith(".json"))
    .sort((a, b) => {
      // `usada-all.json` first so shard files can overwrite its entries.
      if (a === "usada-all.json") return -1;
      if (b === "usada-all.json") return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (snapshotFiles.length === 0) {
    console.error(
      `no snapshot at ${SNAPSHOT_DIR}/usada-*.json — run npm run data:usada-listings first`,
    );
    process.exit(1);
  }

  const snapshotById = new Map<string, UsadaEntry>();

  for (const file of snapshotFiles) {
    const filePath = path.join(SNAPSHOT_DIR, file);
    try {
      const snapshot: { data?: UsadaEntry[]; generatedAt?: string } = JSON.parse(
        fs.readFileSync(filePath, "utf8")
      );
      for (const entry of snapshot.data || []) {
        snapshotById.set(entry.id, entry);
      }
    } catch (err) {
      console.error(`Failed to read ${filePath}: ${(err as Error).message}`);
    }
  }

  const entries = [...snapshotById.values()];

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
    }
    if (/^UC[\w-]{20,}$/.test(channel.id)) {
      if (!byUcId.has(channel.id)) byUcId.set(channel.id, channel);
    }
  }

  const rows: Row[] = [];
  const shard = options.shard ? parseShard(options.shard) : null;
  for (const entry of entries) {
    // Skip fan / clip accounts before anything else.
    if (
      detectClipAccount(entry.name ?? "", entry.twitterUrl ?? "") ||
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

    // Try to match by YouTube UC id first, then by YouTube handle.
    let matchedId: string | null = null;
    let record: Channel | null | undefined = undefined;

    if (entry.youtubeId) {
      // Shard by YouTube UC id.
      if (shard && !inShard(entry.youtubeId, shard.index, shard.count)) continue;
      matchedId = `youtube:${entry.youtubeId}`;
      record =
        byId.get(matchedId) ??
        byYoutubeId.get(entry.youtubeId) ??
        byUcId.get(entry.youtubeId) ??
        undefined;
    }

    if (!record && entry.youtubeHandle) {
      // Shard by YouTube handle.
      if (shard && !inShard(entry.youtubeHandle, shard.index, shard.count)) continue;
      const h = entry.youtubeHandle.replace(/^@+/, "").toLowerCase();
      matchedId = `youtube:${h}`;
      record = byHandle.get(h);
    }

    // Also try matching by Twitch handle.
    if (!record && entry.twitchUrl) {
      const twitchMatch = entry.twitchUrl.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
      if (twitchMatch) {
        // Shard by Twitch login.
        if (shard && !inShard(twitchMatch[1], shard.index, shard.count)) continue;
        const h = twitchMatch[1].toLowerCase();
        const fromHandle = byHandle.get(h);
        if (fromHandle) {
          matchedId = `youtube:${fromHandle.id}`;
          record = fromHandle;
        }
      }
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
    `snapshot · ${entries.length} entr(y/ies) · ${dataset.length} record(s) tracked`,
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

  // Build a map from usadanews slug → dataset channel id for reincarnation resolution.
  const slugToChannelId = new Map<string, string>();
  for (const row of rows) {
    if (row.record && row.entry.id) {
      slugToChannelId.set(row.entry.id, row.record.id);
    }
  }

  for (const row of newRows) {
    const entry = row.entry;
    const rowId = row.id!;

    // YouTube entries: fetch profile via importYouTubeChannels.
    if (rowId.startsWith("youtube:")) {
      const resolvedId = rowId.slice("youtube:".length);
      const result = await importYouTubeChannels([resolvedId], {
        limit: 1,
        rosterHint: {
          agency: { [resolvedId]: entry.affiliation ?? "" },
          debut: { [resolvedId]: entry.debutDate ?? "" },
          gender: { [resolvedId]: "unknown" },
        },
      });
      if ((result.added as unknown[]).length > 0) {
        added += (result.added as unknown[]).length;
      } else {
        existing += result.existing;
        for (const f of result.failed) {
          console.error(`usada: ${f.id} failed — ${f.reason}`);
          failed++;
        }
      }

      // Collect profile links as externals (never overwrite existing ones).
      // Covers every platform the generic extractor found — YouTube, Twitch,
      // X, Instagram, TikTok, Bilibili, Niconico, VK, plus any unknown host
      // landed in a `web:<n>` slot — not just the five USADA historically
      // captured.
      if (entry.links) {
        for (const link of entry.links) {
          externalsEdits.push({
            id: resolvedId,
            platform: link.platform,
            handle: link.handle,
          });
        }
      }

      // Collect reincarnation edge: if this entry lists other usadanews
      // profiles as 前世/轉生, resolve them to dataset channel ids.
      if (entry.reincarnationOf) {
        for (const slug of entry.reincarnationOf) {
          const predId = slugToChannelId.get(slug);
          if (predId) {
            reincarnationEdges.push({ id: resolvedId, predecessorId: predId });
          }
        }
      }

      // Collect updates for already-tracked records (activity, debutDate, country, affiliation).
      if (row.record) {
        trackedUpdates.push({
          id: row.record.id,
          update: (c: Channel) => {
            let changed = false;
            const activity = mapActivity(entry.activity);
            if (activity && c.activity !== activity) {
              c.activity = activity;
              changed = true;
            }
            if (entry.debutDate && !c.debutDate) {
              c.debutDate = entry.debutDate;
              changed = true;
            }
            if (entry.activity && c.activity === "unknown") {
              const a = mapActivity(entry.activity);
              if (a) { c.activity = a; changed = true; }
            }
            if (entry.country && !c.country) {
              c.country = entry.country;
              changed = true;
            }
            if (entry.affiliation && !c.agency) {
              c.agency = entry.affiliation;
              changed = true;
            }
            return changed;
          },
        });
      }
    } else {
      // Non-YouTube entry: build the Channel record directly.
      // Role tags from USADA (e.g. 歌回, VSinger) help classify singing content.
      const roleTagList = entry.roleTags ?? [];
      const isSingingTag = roleTagList.some((t) =>
        /歌回|歌唱|歌ってみた|VSinger|Vsinger|vsinger|音楽|music|cover|original|カバー|弾き語り|KARAOKE|Karaoke|singing/i.test(t)
      );
      const classification = classifyChannel({
        name: entry.name,
        description: null,
        tags: roleTagList,
        country: entry.country ?? null,
        platform: "usada",
        virtualClaim: "roster",
        hasAvatar: false,
      });

      // Override isSinging if role tags clearly indicate singing content.
      const isSinging = classification.isSinging || isSingingTag;

      const aliases: string[] = [];

      const channel: Channel = {
        id: rowId,
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
        affiliation: entry.affiliation
          ? entry.affiliation.toLowerCase().includes("independent")
            ? "independent"
            : entry.affiliation.toLowerCase().includes("group")
              ? "group"
              : entry.affiliation.toLowerCase().includes("community")
                ? "community"
                : "unknown"
          : "unknown",
        avatar: null,
        banner: null,
        description: null,
        subscribers: { tag: "hidden" },
        videoCount: null,
        viewCount: null,
        uploadsPlaylistId: null,
        country: entry.country ?? null,
        tags: [],
        isSinging: isSinging,
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
        activity: mapActivity(entry.activity) ?? "unknown",
        debutDate: entry.debutDate ?? null,
        graduateDate: null,
        platforms: [],
        externals: {},
        popularVideoId: null,
      };

      const now2 = new Date().toISOString();
      const written = applyChannelEdits(
        [{ id: channel.id, update: () => true }],
        "usada",
        now2,
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
    "usada",
    now,
  );
  if (externalsWritten) {
    console.log(
      `${externalsWritten} record(s) had externals filled from usada`,
    );
  }

  // Apply updates to already-tracked records (activity, debutDate, country, affiliation).
  let trackedUpdated = 0;
  for (const u of trackedUpdates) {
    const channel = byId.get(u.id);
    if (channel && u.update(channel)) {
      trackedUpdated++;
    }
  }
  if (trackedUpdated > 0) {
    console.log(
      `${trackedUpdated} tracked record(s) updated from usada (activity, debut, country, agency)`,
    );
  }

  // Apply reincarnation edges: write reincarnationOf on new records.
  if (reincarnationEdges.length > 0) {
    const reincarnationEdits = reincarnationEdges.map((e) => ({
      id: e.id,
      update: (c: Channel) => {
        if (c.reincarnationOf) return false; // already set, don't overwrite
        c.reincarnationOf = e.predecessorId;
        return true;
      },
    }));
    const reincWritten = applyChannelEdits(reincarnationEdits, "usada", now);
    if (reincWritten > 0) {
      console.log(
        `${reincWritten} record(s) got reincarnationOf (轉生/前世) from usada`,
      );
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
