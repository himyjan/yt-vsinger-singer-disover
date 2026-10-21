#!/usr/bin/env tsx
/**
 * Imports the legacy SQLite database into the new JSON dataset.
 *
 * The original project stored everything in `yt_singers_channel.db`
 * (a `channels` + `items` + `blacklist` schema). This script converts that
 * into the sharded JSON dataset, running the same classifier the API sync
 * uses so the imported rows are consistent with freshly-fetched ones.
 *
 * Because the legacy schema has no channel descriptions or tags, the channel
 * classifier is fed the channel's *upload titles* as a stand-in description.
 * Titles such as "【#歌枠】1曲いかがですか？" are strong singing signals, so
 * this yields a much better classification than the channel name alone.
 *
 *   npm run import:legacy
 *
 * This script is a one-off migration tool. It is NOT part of the CI pipeline
 * because `better-sqlite3` is a native module — the GitHub Actions data
 * workflow only ever uses plain Node + the YouTube API.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ROOT, readJson } from "./lib/io";
import { layout, writeDataset } from "./lib/dataset";
import { classifyChannel, classifyItem, detectActivity } from "./lib/classify";
import { buildRegionMeta } from "./lib/regions";
import { toCountRef } from "./lib/types";
import { SCHEMA_VERSION } from "./lib/types";
import type {
  Channel,
  Item,
  Manifest,
  ManifestCounts,
  RegionCode,
} from "./lib/types";

const DB_PATH = path.join(ROOT, "yt_singers_channel.db");

interface LegacyChannel {
  id: string;
  name: string;
  handle: string | null;
  thumbnail: string | null;
  last_synced: number | null;
  is_collected: number;
  discovered_at: number | null;
}

interface LegacyItem {
  id: string;
  channel_id: string | null;
  title: string;
  type: string | null;
  thumbnail: string | null;
  published_at: string | null;
  is_collected: number;
  discovered_at: number | null;
  tags: string | null;
  video_count: string | null;
}

function toIso(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    // Legacy timestamps were stored in milliseconds.
    return new Date(value).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function main(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[import] database not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const legacyChannels = db
    .prepare("SELECT * FROM channels")
    .all() as LegacyChannel[];
  const legacyItems = db.prepare("SELECT * FROM items").all() as LegacyItem[];
  const blacklist = db
    .prepare("SELECT id FROM blacklist")
    .all() as { id: string }[];
  db.close();

  const blocked = new Set(blacklist.map((b) => b.id));
  console.log(
    `[import] ${legacyChannels.length} channels, ${legacyItems.length} items, ${blocked.size} blacklisted`,
  );

  /* --- group item titles per channel ---------------------------------- */
  const titlesByChannel = new Map<string, string[]>();
  for (const item of legacyItems) {
    if (!item.channel_id) continue;
    const list = titlesByChannel.get(item.channel_id) ?? [];
    list.push(item.title);
    titlesByChannel.set(item.channel_id, list);
  }

  const now = new Date().toISOString();
  const channelById = new Map<string, Channel>();

  for (const legacy of legacyChannels) {
    if (blocked.has(legacy.id)) continue;

    const titles = titlesByChannel.get(legacy.id) ?? [];

    /**
     * The legacy schema has no channel description, so there is no reliable
     * identity signal — only the channel name.
     *
     * An earlier version fed the channel's upload titles in as a stand-in
     * description. That was actively harmful: aggregating dozens of titles
     * made nearly every channel match "#vsinger", so every channel was
     * classified virtual with high confidence.
     *
     * Instead the classifier only sees the name, and the record is written
     * with a low confidence so the UI can flag it for review. The YouTube
     * sync fills in the real description — and therefore the real
     * classification — on the next run.
     */
    const classification = classifyChannel({
      name: legacy.name,
      description: null,
      tags: [],
      country: null,
    });

    // A cheap extra signal: a channel whose *every* title is a compilation
    // is an aggregator, not a performer.
    const aggregatorish =
      titles.length >= 5 &&
      titles.every((t) => /compilation|まとめ|精选|合集|megamix/i.test(t));

    const activity = detectActivity(legacy.name, null, null);

    channelById.set(legacy.id, {
      id: legacy.id,
      name: legacy.name,
      handle: legacy.handle,
      kind: classification.kind,
      role: aggregatorish ? "unknown" : classification.role,
      region: classification.region,
      language: classification.language,
      agency: classification.agency,
      avatar: legacy.thumbnail,
      banner: null,
      description: null,
      subscribers: toCountRef(null),
      videoCount: null,
      viewCount: null,
      uploadsPlaylistId: legacy.id.startsWith("UC") ? `UU${legacy.id.slice(2)}` : null,
      country: null,
      tags: [],
      isSinging: classification.isSinging,
      gender: classification.gender,
      isAi: classification.isAi,
      variant: classification.variant,
      confidence: aggregatorish ? 0.3 : Math.min(classification.confidence, 0.55),
      source: "legacy-db",
      addedAt: toIso(legacy.discovered_at) ?? now,
      updatedAt: now,

      activity,
      debutDate: null,
      graduateDate: null,

      platforms: [
        {
          platform: "youtube",
          id: legacy.id,
          handle: legacy.handle,
          name: legacy.name,
          url: `https://www.youtube.com/channel/${legacy.id}`,
          subscribers: toCountRef(null),
          avatar: legacy.thumbnail,
          activity,
          lastCheckedAt: now,
        },
      ],
      twitchId: null,
      twitchLogin: null,
      twitchFollowers: { tag: "hidden" },
      externals: {},

      popularVideoId: null,
    });
  }

  /* --- items ----------------------------------------------------------- */
  const items: Item[] = [];
  for (const legacy of legacyItems) {
    const channel = legacy.channel_id
      ? channelById.get(legacy.channel_id)
      : undefined;
    if (legacy.channel_id && blocked.has(legacy.channel_id)) continue;

    const tags = legacy.tags ? legacy.tags.split(",").filter(Boolean) : [];
    const publishedAt = toIso(legacy.published_at);

    const classification = classifyItem({
      title: legacy.title,
      description: null,
      tags,
      channelKind: channel?.kind ?? "virtual",
      status: publishedAt ? "past" : "unknown",
      isShort: false,
      durationSeconds: null,
      channelRegion: channel?.region ?? "unknown",
    });

    items.push({
      id: legacy.id,
      type: legacy.type === "playlist" ? "playlist" : "video",
      channelId: legacy.channel_id ?? "",
      channelName: channel?.name ?? "Unknown",
      channelKind: channel?.kind ?? "virtual",
      region: channel?.region ?? "unknown",
      gender: channel?.gender ?? "unknown",
      isAi: channel?.isAi ?? false,
      variant: channel?.variant ?? "unknown",
      title: legacy.title,
      description: null,
      thumbnail: legacy.thumbnail,
      publishedAt,
      scheduledStart: null,
      actualStart: null,
      actualEnd: null,
      duration: null,
      status: publishedAt ? "past" : "unknown",
      category: classification.category,
      songTitle: classification.songTitle,
      originalArtist: classification.originalArtist,
      isCollab: classification.isCollab,
      isAcoustic: classification.isAcoustic,
      tags,
      viewCount: null,
      likeCount: null,
      concurrentViewers: null,
      source: "legacy-db",
      addedAt: toIso(legacy.discovered_at) ?? now,
      updatedAt: now,
    });
  }

  /* --- write ----------------------------------------------------------- */
  const channels = [...channelById.values()];

  const regionCounts = new Map<RegionCode, { channels: number; items: number }>();
  for (const c of channels) {
    const e = regionCounts.get(c.region) ?? { channels: 0, items: 0 };
    e.channels++;
    regionCounts.set(c.region, e);
  }
  for (const i of items) {
    const e = regionCounts.get(i.region) ?? { channels: 0, items: 0 };
    e.items++;
    regionCounts.set(i.region, e);
  }

  const counts: ManifestCounts = {
    channels: channels.length,
    channelsVirtual: channels.filter((c) => c.kind === "virtual").length,
    channelsReal: channels.filter((c) => c.kind === "real").length,
    channelsSinging: channels.filter((c) => c.isSinging).length,
    items: items.length,
    itemsLive: items.filter((i) => i.status === "live").length,
    itemsUpcoming: items.filter((i) => i.status === "upcoming").length,
    itemsVideo: items.filter((i) => i.type === "video").length,
    itemsPlaylist: items.filter((i) => i.type === "playlist").length,
    itemsCover: items.filter((i) => i.category === "cover").length,
    itemsMv: items.filter((i) => i.category === "mv").length,
    itemsOriginal: items.filter((i) => i.category === "original").length,
  };

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    counts,
    regions: buildRegionMeta(regionCounts),
    quota: { used: 0, limit: 0, remaining: 0 },
    notes:
      "Imported from the legacy yt_singers_channel.db. Run `npm run sync` to " +
      "refresh from the YouTube Data API.",
  };

  const result = writeDataset(channels, items, manifest, now);
  console.log(
    `[import] wrote ${channels.length} channels / ${items.length} items across ${result.files} files`,
  );
}

main();
