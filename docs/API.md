# The read-only JSON API

> A versioned, documented contract over the committed dataset. No key, no
> account, no backend.

The dataset in `data/` **is** the API. Every record is a JSON file published
straight from the static host, so a client can read the whole catalogue without
asking anyone's permission and without a server in between. This document is
the contract: what exists, what shape it is, how it is cached, and what it
promises.

## Base URLs

| Deployment | Base | Notes |
| --- | --- | --- |
| Vercel | `https://yt-song-disover.vercel.app` | Real cache headers: a hashed asset for a year, the dataset for ten minutes |
| GitHub Pages | `https://himyjan.github.io/yt-vsinger-singer-disover` | Served from the project sub-path; a flat `max-age=600` on everything |

Both serve the dataset with `access-control-allow-origin: *`, so a browser on
any origin can fetch it. Both answer `404` for a shard that does not exist
rather than falling back to the app's HTML.

## The index

`GET /data/api/v1/index.json`

Start here. It is generated at build time from the dataset's own manifests and
carries the API version, the counts, the region table, the cache policy, the
licence and the endpoint list with the shape of each response:

```bash
curl -s https://yt-song-disover.vercel.app/data/api/v1/index.json | jq .endpoints
```

```js
const base = "https://yt-song-disover.vercel.app";
const index = await (await fetch(`${base}/data/api/v1/index.json`)).json();
console.log(index.apiVersion, index.dataset.counts.channels);
for (const endpoint of index.endpoints) console.log(endpoint.path, "—", endpoint.returns);
```

A documented endpoint is checked to exist at build time, so the index cannot
advertise a route that is not deployed.

## Endpoints

| Path | Returns |
| --- | --- |
| `/data/api/v1/index.json` | This contract, generated: version, counts, endpoints |
| `/data/manifest.json` | Counts, the region table (channels and items per region), quota |
| `/data/channels/manifest.json` | Channels per region, and the shard files holding them |
| `/data/channels/{kind}/{region}/{bucket}.json` | One shard of channel records |
| `/data/items/manifest.json` | The media shards and their counts |
| `/data/items/{region}/{bucket}.json` | One shard of media items |
| `/data/items/live.json` | What is live now |
| `/data/items/upcoming.json` | Scheduled streams and premieres |
| `/data/songs/manifest.json` | Song totals, by category and by region |
| `/data/songs/index.json` | Every song record |
| `/data/songs/{region}.json` | The songs of one region |
| `/data/search/manifest.json` | Which regions have a search pack, and its size |
| `/data/search/{region}.json` | One region's inverted search index |

`kind` is `virtual` or `real`. The bucket names come from the channel/items
manifest — **do not probe** for them, or the browser console fills with 404s.

### Channel records are compact

A channel shard holds **one record per line**, with every field equal to its
default omitted, so a one-record change stays a one-line diff in the
repository. Put the defaults back before reading anything: they are listed in
[`DATA-SCHEMA.md`](DATA-SCHEMA.md), and `expandChannel()` in
`src/lib/dataset.ts` is the reference implementation. `isSinging`, `aliases`
and `externals` in particular are usually absent rather than `false`/`[]`/`{}`.

```js
const DEFAULTS = {
  aliases: [], tags: [], statedLanguages: [], platforms: [], externals: {},
  banner: null, description: null, country: null, agency: null, handle: null,
  debutDate: null, graduateDate: null, uploadsPlaylistId: null,
  popularVideoId: null, verification: null, officialArtistCheckedAt: null,
  isOfficialArtist: false, isAi: false, isSinging: false,
  videoCount: null, viewCount: null,
};

const expand = (raw) => ({ ...DEFAULTS, ...raw });

const manifest = await (await fetch(`${base}/data/channels/manifest.json`)).json();
const japan = manifest.regions.find((r) => r.code === "jp");
const channels = [];
for (const bucket of japan.virtual.buckets) {
  const shard = await (await fetch(`${base}/data/channels/virtual/jp/${bucket}.json`)).json();
  channels.push(...shard.channels.map(expand));
}
console.log(channels.length, "Japanese channels");
```

### Searching without a server

The search packs are plain inverted indexes, so a client can run the same query
the site runs — no endpoint needed:

1. normalise and tokenise the query — Latin words whole, CJK as bigrams;
2. binary-search the sorted `tokens` array for each token's prefix range;
3. union the posting lists, weighting each by the `idf` of its best matching
   token;
4. resolve each posting index through `entries[index]`.

`scripts/lib/search.ts` is the reference implementation (MIT), and
[`ARCHITECTURE.md`](ARCHITECTURE.md#the-search-engine) explains the format. A
pack is 2.3 MB for Japan, so cache it.

## Caching and etiquette

| | |
| --- | --- |
| Cache-Control (dataset) | `public, max-age=600, stale-while-revalidate=86400` |
| Cache-Control (hashed assets) | `public, max-age=31536000, immutable` (Vercel) |
| `Access-Control-Allow-Origin` | `*` |
| Refresh cadence | `live.json`, `upcoming.json` and the item shards every ten minutes; the channel and song files, and the search index, every six hours |

The live and upcoming lists change on a ten-minute cadence and the rest of the
tree once every six hours, so polling faster than the cache lifetime only
spends other people's bandwidth. Send a conditional request (`If-None-Match`) —
a repeat visit costs one `304` rather than the payload.

**There is no rate limit, because there is no server to rate-limit you.** The
whole surface is static files on a CDN. That is also the reason the API is
read-only: nothing here can write to the dataset, and the endpoints that can
(`POST /api/dataset/*`) exist only on the local dev server.

## What this API is not

- **No query parameters.** Filtering happens in the client, over the files.
- **No authentication, and no writes.** A suggestion queue exists
  (`/data/suggestions.json`), but it is a file the maintainers commit, not an
  endpoint you can POST to.
- **No per-request search route.** The index packs are published instead; see
  above.
- **No SLA.** It is a static deployment of a research dataset.

## Licence and attribution

The code is MIT. The dataset is compiled from public sources — see
[`SOURCES.md`](SOURCES.md) for each one and its terms. Two matter in
particular: **vdb's data is CC BY-NC-SA** (attribution, non-commercial) and the
**Taiwan VTuber Tracking Data is Unlicense**. Attribute the upstream sources,
and do not use vdb-derived fields commercially.

## Regenerating the index

`npm run api:build` writes it from the dataset's own manifests, and
`npm run build` runs it after `prepare:public`. `prepare:public` wipes
`public/data/` and therefore takes the generated index with it, so the order
matters — the API index is a build artefact, never committed.
