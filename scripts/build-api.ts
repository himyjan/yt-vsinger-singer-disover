#!/usr/bin/env tsx
/**
 * Writes the read-only dataset API index to `public/data/api/v1/index.json`.
 *
 * The dataset **is** the API: every record is a committed JSON file served
 * straight from the static host, with CORS open and a real cache policy. What
 * was missing was a discoverable, versioned entry point — a client had to know
 * the layout of `data/` before it could read anything.
 *
 * This index is that entry point. It carries the version, the counts, the
 * region table and the endpoint list with the shape of each response. It
 * **points at** the manifests rather than copying them: the shard names live in
 * `data/channels/manifest.json`, and a second copy here could go stale between
 * runs.
 *
 * Every endpoint listed is checked to exist before the file is written, so the
 * index can never advertise a route the deployment does not serve — which is
 * the reason to generate it instead of hand-writing it.
 *
 * Run `npm run api:build`. It is part of `npm run build`, after
 * `prepare:public` — which wipes `public/data/` and would take this file with
 * it.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PUBLIC_DATA_DIR,
  ensureDir,
  readJson,
  writeJson,
} from "./lib/io";

/** The contract version. A breaking change to a shape is a new version. */
const API_VERSION = 1;

/** Where the index is served from. */
const INDEX_PATH = path.join(PUBLIC_DATA_DIR, "api", "v1", "index.json");

interface DatasetManifest {
  schemaVersion?: number;
  generatedAt?: string;
  counts?: Record<string, number>;
  regions?: {
    code: string;
    label: string;
    badge?: string;
    channels: number;
    items: number;
  }[];
}

interface ChannelsManifest {
  regions?: {
    code: string;
    channels: number;
    virtual?: { channels?: number; buckets?: string[] };
    real?: { channels?: number; buckets?: string[] };
  }[];
}

interface ItemsManifest {
  regions?: {
    code: string;
    label?: string;
    badge?: string;
    buckets?: string[];
    items?: number;
  }[];
  counts?: Record<string, number>;
}

interface SearchManifest {
  regions?: { code: string; entries?: number; bytes?: number }[];
  total?: number;
}

interface SongsManifest {
  total?: number;
  byCategory?: Record<string, number>;
  byRegion?: Record<string, number>;
}

/** One documented endpoint. `example` is a real file that must exist. */
interface Endpoint {
  path: string;
  returns: string;
  shape: string;
  example: string;
}

function read<T>(relative: string, fallback: T): T {
  return readJson<T>(path.join(PUBLIC_DATA_DIR, relative), fallback);
}

/** The first region that ships shards of the given kind. */
function firstWithBuckets(
  manifest: ChannelsManifest,
  kind: "virtual" | "real",
): { region: string; bucket: string } | null {
  for (const region of manifest.regions ?? []) {
    const bucket = region[kind]?.buckets?.[0];
    if (bucket) return { region: region.code, bucket };
  }
  return null;
}

function main(): void {
  if (!fs.existsSync(PUBLIC_DATA_DIR)) {
    console.error(
      "[api:build] public/data/ does not exist — run `npm run prepare:public` first.",
    );
    process.exit(1);
  }

  const manifest = read<DatasetManifest>("manifest.json", {});
  const channels = read<ChannelsManifest>("channels/manifest.json", {});
  const items = read<ItemsManifest>("items/manifest.json", {});
  const search = read<SearchManifest>("search/manifest.json", {});
  const songs = read<SongsManifest>("songs/manifest.json", {});

  const virtual = firstWithBuckets(channels, "virtual");
  const real = firstWithBuckets(channels, "real");
  const itemShard = (items.regions ?? []).find(
    (region) => (region.buckets ?? []).length > 0,
  );
  const searchRegion = search.regions?.[0]?.code ?? "jp";

  const virtualExample = virtual
    ? `channels/virtual/${virtual.region}/${virtual.bucket}.json`
    : "channels/manifest.json";
  const realExample = real
    ? `channels/real/${real.region}/${real.bucket}.json`
    : "channels/manifest.json";
  const itemExample = itemShard
    ? `items/${itemShard.code}/${itemShard.buckets?.[0]}.json`
    : "items/manifest.json";

  const endpoints: Endpoint[] = [
    {
      path: "/data/manifest.json",
      returns: "The catalogue at a glance: counts, the region table and quota",
      shape:
        "{ schemaVersion, generatedAt, counts: { channels, channelsVirtual, channelsReal, channelsSinging, items, … }, regions: [{ code, label, badge, channels, items }] }",
      example: "manifest.json",
    },
    {
      path: "/data/channels/manifest.json",
      returns:
        "How many channels each region holds, and which shard files hold them",
      shape:
        "{ schemaVersion, generatedAt, total, regions: [{ code, channels, virtual: { channels, buckets: [] }, real: { channels, buckets: [] } }] }",
      example: "channels/manifest.json",
    },
    {
      path: "/data/channels/{kind}/{region}/{bucket}.json",
      returns:
        "One shard of channel records. `kind` is `virtual` or `real`, and the bucket names come from the channels manifest, so a client never has to probe for a file that does not exist",
      shape:
        "{ schemaVersion, generatedAt, channels: [Channel] }. The file holds one record per line and omits every field equal to its default — put the defaults back before reading: `expandChannel()` in src/lib/dataset.ts is the reference, and docs/DATA-SCHEMA.md lists the defaults",
      example: virtualExample,
    },
    {
      path: "/data/channels/real/{region}/{bucket}.json",
      returns: "The same, for the `real` (human performer) dataset",
      shape: "{ schemaVersion, generatedAt, channels: [Channel] }",
      example: realExample,
    },
    {
      path: "/data/items/manifest.json",
      returns: "The media shards, their regions and their counts",
      shape:
        "{ schemaVersion, generatedAt, regions: [{ code, label, badge, buckets: [], items }], counts: { live, upcoming, video, playlist, … } }",
      example: "items/manifest.json",
    },
    {
      path: "/data/items/{region}/{bucket}.json",
      returns: "One shard of media items — videos, playlists, covers, originals",
      shape: "{ schemaVersion, generatedAt, items: [Item] }",
      example: itemExample,
    },
    {
      path: "/data/items/live.json",
      returns: "What is live now",
      shape: "{ schemaVersion, generatedAt, items: [Item] }",
      example: "items/live.json",
    },
    {
      path: "/data/items/upcoming.json",
      returns: "Scheduled streams and premieres",
      shape: "{ schemaVersion, generatedAt, items: [Item] }",
      example: "items/upcoming.json",
    },
    {
      path: "/data/songs/manifest.json",
      returns: "Song totals, by category and by region",
      shape: "{ schemaVersion, generatedAt, total, byCategory: {}, byRegion: {} }",
      example: "songs/manifest.json",
    },
    {
      path: "/data/songs/index.json",
      returns: "Every song record in one file",
      shape:
        "{ schemaVersion, generatedAt, songs: [{ id, channelId, channelName, songTitle, originalArtist, category, isCollab, collaborators, isAcoustic, publishedAt, duration, viewCount, url }] }",
      example: "songs/index.json",
    },
    {
      path: "/data/songs/{region}.json",
      returns: "The songs of one region",
      shape: "{ schemaVersion, generatedAt, songs: [Song] }",
      example: "songs/jp.json",
    },
    {
      path: "/data/search/manifest.json",
      returns: "Which regions have a search pack, and how large each one is",
      shape:
        "{ schemaVersion, generatedAt, regions: [{ code, entries, bytes }], total }",
      example: "search/manifest.json",
    },
    {
      path: "/data/search/{region}.json",
      returns: "One region's inverted search index",
      shape:
        "{ schemaVersion, generatedAt, region, count, tokens: [string] (sorted), postings: [[number]] (parallel to tokens; each number is an index into `entries`), idf: [number] (parallel to tokens), entries: [{ k, id, n, g, r, th, ch }] }",
      example: `search/${searchRegion}.json`,
    },
  ];

  // Never advertise a route the deployment does not serve.
  const missing = endpoints.filter(
    (endpoint) => !fs.existsSync(path.join(PUBLIC_DATA_DIR, endpoint.example)),
  );
  if (missing.length > 0) {
    for (const endpoint of missing) {
      console.error(
        `[api:build] ${endpoint.path} names the example ${endpoint.example}, which does not exist`,
      );
    }
    process.exit(1);
  }

  const index = {
    apiVersion: API_VERSION,
    generatedAt: manifest.generatedAt ?? null,
    basePath: process.env.VITE_BASE_PATH || "/",
    /** Both deployments serve the dataset cross-origin. */
    cors: "access-control-allow-origin: *",
    cache: {
      dataset: "public, max-age=600, stale-while-revalidate=86400",
      guidance:
        "The dataset is rewritten every six hours. Do not poll faster than the cache lifetime, and send a conditional request rather than re-downloading.",
    },
    dataset: {
      schemaVersion: manifest.schemaVersion ?? null,
      counts: manifest.counts ?? {},
      regions: (manifest.regions ?? []).map((region) => ({
        code: region.code,
        label: region.label,
        badge: region.badge,
        channels: region.channels,
        items: region.items,
      })),
      search: { regions: search.regions?.length ?? 0, entries: search.total ?? 0 },
      songs: { total: songs.total ?? 0, byCategory: songs.byCategory ?? {} },
    },
    endpoints,
    /**
     * Not an endpoint: a recipe. The pack is a plain inverted index, so a
     * client can query it without a server — which is why the format is
     * published rather than hidden behind a search route.
     */
    search: {
      pack: "/data/search/{region}.json",
      algorithm: [
        "normalise and tokenise the query — Latin words whole, CJK as bigrams",
        "binary-search the sorted `tokens` array for each token's prefix range",
        "union the posting lists, weighting each by the `idf` of its best matching token",
        "resolve each posting index through `entries[index]`",
      ],
      reference:
        "scripts/lib/search.ts — the same tokenizer and ranking the site uses, MIT licensed",
    },
    /** The whole of `data/` is published, including the pipeline's inputs. */
    alsoPublished: [
      "/data/overrides.json — the curated per-channel corrections",
      "/data/seed-catalog.json — the curated channels",
      "/data/suggestions.json — the suggestion queue",
      "/data/upstream.json — the upstream snapshot metadata",
    ],
    docs: "https://github.com/himyjan/yt-vsinger-singer-disover/blob/main/docs/API.md",
    licence: {
      code: "MIT",
      data:
        "Compiled from public sources. See docs/SOURCES.md for each source and its licence — vdb's data is CC BY-NC-SA, the Taiwan tracker's is Unlicense. Attribution is required, and vdb-derived fields may not be used commercially.",
    },
  };

  ensureDir(path.dirname(INDEX_PATH));
  writeJson(INDEX_PATH, index);
  console.log(
    `[api:build] wrote ${path.relative(process.cwd(), INDEX_PATH)} — v${API_VERSION}, ${endpoints.length} endpoints, ${manifest.counts?.channels ?? 0} channels`,
  );
}

main();
