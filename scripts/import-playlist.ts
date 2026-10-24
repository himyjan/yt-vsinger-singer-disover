#!/usr/bin/env tsx
/**
 * Imports classified YouTube videos and playlists from a DOCX link collection.
 *
 * New channels are deliberately not created here: an upload is imported only
 * when its immutable channel id or exact handle matches an existing record.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classifyChannel, classifyItem, extractCollaboratorNames } from "./lib/classify";
import { buildSearchIndex } from "./build-index";
import {
  CACHE_DIR,
  DATA_DIR,
  ROOT,
  acquireRunLock,
  readJson,
  writeJson,
} from "./lib/io";
import { readAllChannelRecords, readAllItems, writeDataset } from "./lib/dataset";
import { buildRegionMeta, mergeLanguages } from "./lib/regions";
import { InnerTubeSource } from "./lib/youtubei";
import { SCHEMA_VERSION } from "./lib/types";
import type {
  Channel,
  Item,
  ItemCategory,
  ItemType,
  Manifest,
  RegionCode,
} from "./lib/types";

interface PlaylistLink {
  type: "video" | "playlist";
  id: string;
  url: string;
  text: string;
}

interface OEmbedRecord extends PlaylistLink {
  title: string;
  authorName: string;
  authorUrl: string;
  thumbnail: string | null;
}

interface CliOptions {
  input: string;
  dryRun: boolean;
  verifyRegions: boolean;
  metadataCache: string;
  cacheInput: string | null;
}

interface UnmatchedLink {
  type: PlaylistLink["type"];
  id: string;
  title: string | null;
  authorName: string | null;
  authorUrl: string | null;
  url: string;
  reason: string;
}

function parseArgs(argv: string[]): CliOptions {
  let input = "";
  let dryRun = false;
  let verifyRegions = true;
  let metadataCache = path.join(CACHE_DIR, "playlist-oembed.json");
  let cacheInput: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-region-check") verifyRegions = false;
    else if (arg === "--metadata-cache") {
      cacheInput = argv[++index] ?? null;
      if (!cacheInput) throw new Error("--metadata-cache requires a file path.");
    } else if (!arg.startsWith("--") && !input) input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!input) {
    throw new Error(
      "Usage: npm run data:import-playlist -- <playlist.docx> [--dry-run] [--no-region-check] [--metadata-cache <file>]",
    );
  }
  return { input: path.resolve(input), dryRun, verifyRegions, metadataCache, cacheInput };
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function docxLinks(file: string): PlaylistLink[] {
  if (!fs.existsSync(file)) throw new Error(`DOCX file not found: ${file}`);
  const documentXml = execFileSync("unzip", ["-p", file, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const relationshipsXml = execFileSync(
    "unzip",
    ["-p", file, "word/_rels/document.xml.rels"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(
    /<Relationship\b([^>]*)\/?>/g,
  )) {
    const attributes = match[1];
    const id = attributes.match(/\bId="([^"]+)"/)?.[1];
    const target = attributes.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relationships.set(id, decodeXml(target));
  }

  const links: PlaylistLink[] = [];
  const seen = new Set<string>();
  const paragraphs = documentXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  for (const paragraph of paragraphs) {
    const text = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeXml(match[1]))
      .join(" ")
      .trim();
    const urls = new Set<string>();
    for (const match of paragraph.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      urls.add(match[0].replace(/[.,;:!?)}\]]+$/, ""));
    }
    for (const match of paragraph.matchAll(/\br:id="([^"]+)"/g)) {
      const target = relationships.get(match[1]);
      if (target) urls.add(target);
    }

    for (const rawUrl of urls) {
      const link = youtubeLink(rawUrl, text);
      if (!link) continue;
      const key = `${link.type}:${link.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
  }
  return links;
}

function youtubeLink(rawUrl: string, text: string): PlaylistLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "youtube.com" && host !== "music.youtube.com" && host !== "youtu.be") {
    return null;
  }

  const playlistId = url.searchParams.get("list");
  if (playlistId) {
    return {
      type: "playlist",
      id: playlistId,
      url: `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
      text,
    };
  }

  const videoId =
    host === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") ??
        url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?]+)/)?.[1];
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
  return {
    type: "video",
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    text,
  };
}

function loadOEmbedCache(file: string): Map<string, OEmbedRecord> {
  if (!fs.existsSync(file)) return new Map();
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`Invalid oEmbed cache: ${file}`);
  const records = new Map<string, OEmbedRecord>();
  for (const value of parsed) {
    if (!value || typeof value !== "object") continue;
    const row = value as Partial<OEmbedRecord>;
    if (
      (row.type !== "video" && row.type !== "playlist") ||
      typeof row.id !== "string" ||
      typeof row.url !== "string" ||
      typeof row.title !== "string"
    ) {
      continue;
    }
    records.set(`${row.type}:${row.id}`, {
      type: row.type,
      id: row.id,
      url: row.url,
      text: typeof row.text === "string" ? row.text : "",
      title: row.title,
      authorName: typeof row.authorName === "string" ? row.authorName : "",
      authorUrl: typeof row.authorUrl === "string" ? row.authorUrl : "",
      thumbnail: typeof row.thumbnail === "string" ? row.thumbnail : null,
    });
  }
  return records;
}

async function fetchOEmbed(link: PlaylistLink): Promise<OEmbedRecord | null> {
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", link.url);
  endpoint.searchParams.set("format", "json");
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      console.error(`oEmbed ${response.status} for ${link.type} ${link.id}`);
      return null;
    }
    const body = (await response.json()) as {
      title?: unknown;
      author_name?: unknown;
      author_url?: unknown;
      thumbnail_url?: unknown;
    };
    if (typeof body.title !== "string") {
      console.error(`oEmbed returned no title for ${link.type} ${link.id}`);
      return null;
    }
    return {
      ...link,
      title: body.title,
      authorName: typeof body.author_name === "string" ? body.author_name : "",
      authorUrl: typeof body.author_url === "string" ? body.author_url : "",
      thumbnail: typeof body.thumbnail_url === "string" ? body.thumbnail_url : null,
    };
  } catch (error) {
    console.error(
      `oEmbed failed for ${link.type} ${link.id}: ${(error as Error).message}`,
    );
    return null;
  }
}

async function collectMetadata(
  links: PlaylistLink[],
  cache: Map<string, OEmbedRecord>,
  cacheFile: string,
): Promise<void> {
  const missing = links.filter((link) => !cache.has(`${link.type}:${link.id}`));
  let next = 0;
  let nextStart = Date.now();
  const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (next < missing.length) {
      const link = missing[next++];
      const wait = Math.max(0, nextStart - Date.now());
      nextStart = Math.max(nextStart, Date.now()) + 200;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const result = await fetchOEmbed(link);
      if (result) cache.set(`${link.type}:${link.id}`, result);
      if (cache.size % 50 === 0) {
        writeJson(cacheFile, [...cache.values()]);
      }
    }
  });
  await Promise.all(workers);
  writeJson(cacheFile, [...cache.values()]);
}

function channelIdentityMaps(channels: Channel[]): {
  byId: Map<string, Channel>;
  byHandle: Map<string, Channel>;
} {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const candidates = new Map<string, Set<string>>();
  for (const channel of channels) {
    const handle = channel.handle?.replace(/^@/, "").toLowerCase();
    if (!handle) continue;
    const ids = candidates.get(handle) ?? new Set<string>();
    ids.add(channel.id);
    candidates.set(handle, ids);
  }
  const byHandle = new Map<string, Channel>();
  for (const [handle, ids] of candidates) {
    if (ids.size === 1) {
      const id = [...ids][0];
      const channel = byId.get(id);
      if (channel) byHandle.set(handle, channel);
    }
  }
  return { byId, byHandle };
}

function ownerFor(
  authorUrl: string,
  maps: ReturnType<typeof channelIdentityMaps>,
): Channel | null {
  if (!authorUrl) return null;
  try {
    const url = new URL(authorUrl, "https://www.youtube.com");
    const channelId = url.pathname.match(/^\/channel\/(UC[\w-]{22})/)?.[1];
    if (channelId) return maps.byId.get(channelId) ?? null;
    const handle = url.pathname.match(/^\/@([^/?]+)/)?.[1];
    return handle ? maps.byHandle.get(decodeURIComponent(handle).toLowerCase()) ?? null : null;
  } catch {
    return null;
  }
}

function itemFromMetadata(
  metadata: OEmbedRecord,
  owner: Channel,
  existingIds: Set<string>,
  now: string,
): Item | null {
  if (existingIds.has(metadata.id)) return null;
  const type: ItemType = metadata.type === "playlist" ? "playlist" : "video";
  const classification = classifyItem({
    title: metadata.title,
    description: metadata.text || null,
    tags: [],
    channelKind: owner.kind,
    status: "unknown",
    isShort: false,
    durationSeconds: null,
    channelRegion: owner.region,
  });
  if (type === "video" && classification.category === "other") return null;

  const collaborators = [
    {
      channelId: owner.id,
      name: owner.name,
      kind: owner.kind,
      region: owner.region,
    },
    ...extractCollaboratorNames(metadata.title)
      .filter((name) => name.toLocaleLowerCase() !== owner.name.toLocaleLowerCase())
      .map((name) => ({
        channelId: null,
        name,
        kind: "unknown" as const,
        region: "unknown" as const,
      })),
  ];
  const category: ItemCategory = type === "playlist" ? "other" : classification.category;

  return {
    id: metadata.id,
    platform: "youtube",
    url: metadata.url,
    type,
    channelId: owner.id,
    channelName: owner.name,
    channelKind: owner.kind,
    region: owner.region,
    gender: owner.gender,
    languages: owner.languages,
    isAi: owner.isAi,
    variant: owner.variant,
    title: metadata.title,
    description: metadata.text || null,
    thumbnail: metadata.thumbnail,
    publishedAt: null,
    scheduledStart: null,
    actualStart: null,
    actualEnd: null,
    duration: null,
    status: "unknown",
    category,
    songTitle: classification.songTitle,
    originalArtist: classification.originalArtist,
    isCollab: classification.isCollab || collaborators.length > 1,
    collaborators,
    isAcoustic: classification.isAcoustic,
    tags: [],
    viewCount: null,
    likeCount: null,
    concurrentViewers: null,
    source: "api",
    addedAt: now,
    updatedAt: now,
    lastItemsFetchedAt: null,
    lastDetailsFetchedAt: null,
  };
}

async function verifyRegions(channels: Channel[]): Promise<number> {
  const candidates = channels.filter(
    (channel) =>
      channel.id.startsWith("UC") &&
      channel.region !== "unknown" &&
      channel.regionSource !== "override" &&
      channel.regionSource !== "roster" &&
      channel.regionSource !== "country",
  );
  if (!candidates.length) return 0;
  const source = new InnerTubeSource({
    delayMs: 500,
    onLog: (message) => console.log(message),
  });
  if (!(await source.connect())) {
    console.error("Region verification unavailable; existing regions are unchanged.");
    return 0;
  }

  const overrides = readJson<Record<string, { region?: RegionCode }>>(
    path.join(DATA_DIR, "overrides.json"),
    {},
  );
  let verified = 0;
  for (const channel of candidates) {
    const profile = await source.profile(channel.id, { lang: "en", about: true });
    if (!profile?.country) continue;
    const result = classifyChannel({
      name: channel.name,
      description: channel.description,
      tags: [],
      country: profile.country,
      platform: "youtube",
      override: { region: overrides[channel.id]?.region },
    });
    channel.country = profile.country;
    channel.region = result.region;
    channel.regionSource = result.regionSource;
    channel.languages = mergeLanguages(channel.statedLanguages, result.languages);
    verified++;
  }
  return verified;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const links = docxLinks(options.input);
  const cache = loadOEmbedCache(options.cacheInput ?? options.metadataCache);
  const oldCacheSize = cache.size;
  await collectMetadata(links, cache, options.metadataCache);
  console.log(
    `DOCX links: ${links.length}; cached metadata: ${oldCacheSize}; metadata available: ${cache.size}`,
  );

  const releaseLock = options.dryRun
    ? () => {}
    : acquireRunLock("import-playlist");
  try {
  const channels = readAllChannelRecords();
  const items = readAllItems();
  const maps = channelIdentityMaps(channels);
  const itemIds = new Set(items.map((item) => item.id));
  const now = new Date().toISOString();
  const added: Item[] = [];
  let unknownOwners = 0;
  const unmatched: UnmatchedLink[] = [];
  const playlistByOwner = new Map<string, string>();
  const matchedOwnerIds = new Set<string>();

  for (const link of links) {
    const metadata = cache.get(`${link.type}:${link.id}`);
    if (!metadata) {
      unmatched.push({
        type: link.type,
        id: link.id,
        title: null,
        authorName: null,
        authorUrl: null,
        url: link.url,
        reason: "YouTube did not return oEmbed metadata",
      });
      continue;
    }
    const owner = ownerFor(metadata.authorUrl, maps);
    if (!owner) {
      unknownOwners++;
      unmatched.push({
        type: link.type,
        id: link.id,
        title: metadata.title,
        authorName: metadata.authorName,
        authorUrl: metadata.authorUrl,
        url: metadata.url,
        reason: "Uploader does not match an existing channel id or exact handle",
      });
      continue;
    }
    matchedOwnerIds.add(owner.id);
    if (metadata.type === "playlist" && !playlistByOwner.has(owner.id)) {
      playlistByOwner.set(owner.id, metadata.url);
    }
    const item = itemFromMetadata(metadata, owner, itemIds, now);
    if (item) {
      added.push(item);
      itemIds.add(item.id);
    } else if (metadata.type === "video" && !itemIds.has(metadata.id)) {
      unmatched.push({
        type: link.type,
        id: link.id,
        title: metadata.title,
        authorName: metadata.authorName,
        authorUrl: metadata.authorUrl,
        url: metadata.url,
        reason: "Video title does not clearly identify a supported song category",
      });
    }
  }

  const playlistOwners = new Map(channels.map((channel) => [channel.id, channel]));
  for (const [channelId, url] of playlistByOwner) {
    const channel = playlistOwners.get(channelId);
    if (channel && !channel.externals?.youtube_playlist) {
      channel.externals = { ...channel.externals, youtube_playlist: url };
    }
  }

  const verifiedRegions = options.verifyRegions
    ? await verifyRegions(channels.filter((channel) => matchedOwnerIds.has(channel.id)))
    : 0;
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  const mergedItems = [...items, ...added];
  for (const item of mergedItems) {
    const owner = channelsById.get(item.channelId);
    if (!owner) continue;
    item.channelName = owner.name;
    item.channelKind = owner.kind;
    item.region = owner.region;
    item.gender = owner.gender;
    item.languages = owner.languages;
    item.isAi = owner.isAi;
    item.variant = owner.variant;
    item.collaborators[0] = {
      channelId: owner.id,
      name: owner.name,
      kind: owner.kind,
      region: owner.region,
    };
  }
  const manifest = readJson<Manifest>(path.join(DATA_DIR, "manifest.json"), {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "",
    counts: {
      channels: 0,
      channelsVirtual: 0,
      channelsReal: 0,
      channelsSinging: 0,
      items: 0,
      itemsLive: 0,
      itemsUpcoming: 0,
      itemsVideo: 0,
      itemsPlaylist: 0,
      itemsCover: 0,
      itemsMv: 0,
      itemsOriginal: 0,
    },
    regions: [],
    quota: { used: 0, limit: 10_000, remaining: 10_000 },
    notes: "",
  });
  manifest.generatedAt = now;
  manifest.counts = {
    ...manifest.counts,
    channels: channels.length,
    channelsVirtual: channels.filter((channel) => channel.kind === "virtual").length,
    channelsReal: channels.filter((channel) => channel.kind === "real").length,
    channelsSinging: channels.filter((channel) => channel.isSinging).length,
    items: mergedItems.length,
    itemsLive: mergedItems.filter((item) => item.status === "live").length,
    itemsUpcoming: mergedItems.filter((item) => item.status === "upcoming").length,
    itemsVideo: mergedItems.filter((item) => item.type === "video" || item.type === "short").length,
    itemsPlaylist: mergedItems.filter((item) => item.type === "playlist").length,
    itemsCover: mergedItems.filter((item) => item.category === "cover").length,
    itemsMv: mergedItems.filter((item) => item.category === "mv").length,
    itemsOriginal: mergedItems.filter((item) => item.category === "original").length,
  };
  const regionCounts = new Map<RegionCode, { channels: number; items: number }>();
  for (const channel of channels) {
    const count = regionCounts.get(channel.region) ?? { channels: 0, items: 0 };
    count.channels++;
    regionCounts.set(channel.region, count);
  }
  for (const item of mergedItems) {
    const count = regionCounts.get(item.region) ?? { channels: 0, items: 0 };
    count.items++;
    regionCounts.set(item.region, count);
  }
  manifest.regions = buildRegionMeta(regionCounts);

  console.log(
    `Matched items: ${added.length}; playlists: ${added.filter((item) => item.type === "playlist").length}; ` +
      `videos by category: ${JSON.stringify(Object.fromEntries([...new Set(added.map((item) => item.category))].map((category) => [category, added.filter((item) => item.category === category).length])))}; ` +
      `unmatched owners: ${unknownOwners}; regions checked: ${verifiedRegions}`,
  );
  writeJson(path.join(CACHE_DIR, "playlist-import-unmatched.json"), unmatched);
  console.log(
    `Review report: ${path.relative(ROOT, path.join(CACHE_DIR, "playlist-import-unmatched.json"))} (${unmatched.length} entries)`,
  );
  if (options.dryRun) {
    console.log("Dry run; dataset files were not changed.");
    return;
  }
  writeDataset(channels, mergedItems, manifest, now);
  buildSearchIndex();
  console.log(`Imported ${added.length} items and rebuilt the search index.`);
  } finally {
    releaseLock();
  }
}

main().catch((error: unknown) => {
  console.error(`Playlist import failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
