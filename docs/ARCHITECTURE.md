# Architecture

> How the pieces fit together. Read `docs/DATA-SCHEMA.md` for the field-level
> reference and `docs/DEPLOY.md` for the deployment story.

## The shape of the project

```
┌───────────────────────────── GitHub ─────────────────────────────┐
│                                                                    │
│  ┌──────────────┐   schedule    ┌───────────────┐   commit       │
│  │ sync-data.yml│──────────────▶│ scripts/sync  │──────────────▶ │ data/*.json
│  └──────────────┘               └───────────────┘                │
│         │                              │                          │
│         │                              │ YouTube Data API v3       │
│         │                              │ YouTube InnerTube          │
│         │                              │ Twitch Helix              │
│         │                              │ Bilibili / Niconico / VK  │
│         │                              │ CHZZK / KICK / SOOP       │
│         │                              │ CI.ME profile links       │
│         │                              │ AiSList                   │
│         │                              │ VTuber Music Dataset      │
│         │                              ▼                          │
│         │                    ┌───────────────┐                   │
│         │                    │  scripts/lib  │                   │
│         │                    │ classify      │                   │
│         │                    │ identity      │                   │
│         │                    │ search        │                   │
│         │                    │ youtube       │                   │
│         │                    └───────────────┘                   │
│         │                                                        │
│         ▼                                                        ▼
│  ┌──────────────┐                                    ┌────────────────┐
│  │  ci.yml      │                                    │ deploy-pages   │
│  │  validate    │                                    │ vite build     │
│  └──────────────┘                                    └────────────────┘
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │  GitHub Pages (static)    │
                    │  Vue SPA + /data/*.json   │
                    └───────────────────────────┘
```

## Three ideas hold the design together

### 1. The dataset lives in the repository

`data/` is committed. That makes the data:

- **versioned** — every change is a commit you can diff and revert;
- **auditable** — the classifier is deterministic, so the same input always
  produces the same output;
- **free to serve** — GitHub Pages publishes it with the app, same origin, no
  CORS setup;
- **reviewable** — a pull request that changes `data/` shows exactly which
  channels were added or reclassified.

The cost is a size ceiling, which is why the dataset is **sharded** and
**budgeted** (see below).

### 2. Sharding is a product decision, not an implementation detail

GitHub Free allows roughly 1 GB of repository content, and a single JSON
blob that large is unusable in a browser anyway. So the dataset is split:

| File | Contents | Approx. size |
| --- | --- | --- |
| `data/manifest.json` | counts, region table, quota usage | ~4 KB |
| `data/channels/manifest.json` | the shard map, per kind and region | ~4 KB |
| `data/channels/virtual/<r>/<b>.json` | full records, virtual performers | ~150 KB each |
| `data/channels/real/<r>/<b>.json` | full records, real artists | small |
| `data/items/<region>/<bucket>.json` | items, sharded by region + id bucket | ~50 KB each |
| `data/items/live.json` | currently live | small |
| `data/items/upcoming.json` | scheduled streams and premieres | small |
| `data/songs/<region>.json` | the music-centric projection | ~200 KB |
| `data/songs/categories/<c>.json` | one file per song category | ~100 KB |
| `data/search/<region>.json` | inverted index for one region | ~200 KB |

The browser loads only the slice it needs: the channel manifest on startup,
the shards of the regions and kinds it is showing when the user picks one, the
live/upcoming files for those views, and the search packs for the query. The
list is a projection of those records — there is no separate summary file to
download.

### 3. The scope switch is enforced in the data layer

`Virtual` / `Real` / `Both` is not a per-view concern. Every view funnels its
results through `filterItems()` / `filterChannels()` in
`src/lib/dataset.ts`, which apply the scope, the region, the categories, the
gender filter, the AI filter and the acoustic filter in one place. A new view
cannot accidentally leak the wrong kind of performer, because it has to go
through the same funnel.

## Layers

### The pipeline (`scripts/`)

```
scripts/
├── sync.ts                  orchestrator: fetch → classify → merge → write
├── build-index.ts           builds the inverted search index
├── validate.ts              CI gate: structure, consistency, size budgets
├── prepare-public.ts        copies data/ into public/ for the build
└── lib/
    ├── types.ts             the canonical data model (shared with the app)
    ├── youtube.ts           YouTube Data API v3 client + quota budget
    ├── youtubei.ts          InnerTube: profile, uploads, live, OAC header
    ├── innertube-subs.ts    signed-in FEchannels subscription feed
    ├── youtube-channel.ts   one-channel snapshot for the subscription cards
    ├── twitch.ts            Twitch Helix client
    ├── platforms/           Bilibili, Niconico, VK, CHZZK, KICK and SOOP
    │                        adapters
    ├── platform-registry.ts assembles every adapter
    ├── platforms.ts         the PlatformAdapter interface
    ├── classify.ts          virtual/real, role, region, gender, AI, category
    ├── regions.ts           region metadata, agency → region, script detection
    ├── identity.ts          de-duplication registry
    ├── search.ts            tokenizer + inverted index + query engine
    ├── aislist.ts           AI-channel list
    ├── vdb.ts               the Virtual YouTuber Name List Database
    ├── taiwan-vtuber-data.ts  the Taiwan VTuber track list
    ├── chinese-scripts.ts   simplified vs. traditional character sets
    ├── dedupe.ts            identity-based de-duplication
    ├── roster.ts            builds the channel roster from those sources
    ├── dedupe.ts            identity-based de-duplication
    ├── music-dataset.ts     curated cover-song metadata
    ├── seeds.ts             curated starting catalogue
    ├── suggestions.ts       data/suggestions.json — the import queue
    ├── import-channels.ts   suggestions → InnerTube → classified records
    ├── dataset.ts           the on-disk layout and the writers
    └── io.ts                file helpers and size budgets
```

### The web app (`src/`)

```
src/
├── App.vue                  the application shell
├── lib/
│   ├── store.ts             reactive state: scope, filters, accounts, theme
│   ├── dataset.ts           loads and filters the committed dataset
│   ├── auth.ts              account linking for four platforms
│   ├── takeout.ts           reads a Takeout/export subscriptions.csv
│   ├── subs-export.ts       the in-page script that writes that CSV
│   ├── youtube-detail.ts    browser client for the one-channel bridge
│   ├── links.ts             builds the "all links" block
│   └── env.ts               build-time environment
└── components/
    ├── LiveCard.vue         thumbnail + info block + all links
    ├── ChannelCard.vue      channel badge, name, followers
    ├── ChannelDrawer.vue    channel detail, links and recent uploads
    ├── OfficialArtistBadge.vue  YouTube's inline SVG, right of the name
    └── SubscriptionDetail.vue  untracked subscription fetched on open
```

`scripts/lib/types.ts` and `scripts/lib/search.ts` are imported by **both**
the pipeline and the app, through the `@shared/*` alias. There is exactly one
definition of the data model and one tokenizer.

## The search engine

A linear scan over tens of thousands of entries is too slow to run on every
keystroke. Instead the dataset ships an inverted index per region:

```jsonc
{
  "region": "jp",
  "count": 1535,
  "tokens": ["000", "05", "1.15", "…", "歌い", "…"],   // sorted
  "postings": [[12], [3, 7], [900], […]],             // parallel to tokens
  "idf": [6.64, 7.33, 7.33, 4.1, 8.2, 6.1],          // parallel to tokens
  "entries": [{ "k": "i", "id": "…", "n": "…", … }]
}
```

A query is then:

1. tokenise it (Latin words whole, CJK as bigrams);
2. binary-search the sorted token array for every token's prefix range;
3. union the posting lists, weighting each by the IDF of its best matching
   token;
4. filter by scope, region, category, gender and AI;
5. sort by score, then by recency.

Prefix matching falls out of the sorted array for free: typing `holo` finds
`hololive`. CJK bigrams make `歌い手` findable without a dictionary
segmenter, because `歌い手` is indexed as `歌い` + `い手`.

## Classification

`scripts/lib/classify.ts` decides, deterministically:

| Field | How |
| --- | --- |
| `kind` (virtual / real) | weighted score over strong and weak markers, with the channel name weighted highest and the opening of the description next |
| `role` | the strongest matching role marker, unless the channel looks like an aggregator |
| `region` | agency → published country → kana in the name → explicit region markers → platform prior → script detection → locale hints. A link to another platform is not a signal, and the winning source is stored in `regionSource` |
| `gender` | explicit self-description first; honorifics only as a fallback |
| `isAi` | the AiSList blocklist and warnlist, plus keyword heuristics as a fallback |
| `category` | cover / mv / original / live / premiere / performance, from the title, description and tags |
| `isAcoustic` | 弾き語り / 彈唱 / acoustic — a flag, not a category, so acoustic covers stay in the cover bucket |
| `variant` | the combined label: `female_vtuber`, `ai_vsinger`, … |

Everything is overridable from `data/overrides.json`, and the curated seed
list in `scripts/lib/seeds.ts` has the highest precedence of all.

## De-duplication

The same performer appears under many identifiers. `scripts/lib/identity.ts`
keeps a registry of identity keys:

- **strong** — YouTube channel id, handle, X handle, wiki page title;
- **weak** — normalised display name, matched with a bounded edit distance
  and only within the same region.

Records that share a key are merged, never duplicated. The registry also
enriches channels the YouTube API knows nothing about — the wiki supplies
debut dates and graduation dates, which the API does not expose.

## Growing the catalogue from a subscription list

Discovery finds performers by searching; it cannot reproduce a person's
subscriptions, because the list is private. The app therefore has a second,
deliberate path in:

```
subscriptions (API, Takeout CSV, or the in-page export script)
        │
        ▼
data/suggestions.json        ← an input file; cheap, reviewable, not records
        │  POST /api/dataset/sync  (consent: true)
        ▼
import-channels.ts
   InnerTube profile → region → profile in that language
   classifyChannel() → the same evidence a sync uses
   mergeById() → writeChannelShards() → manifest → search index
```

Three points hold it together:

- **The list is not the dataset.** A suggestion is a candidate with a name
  the suggester saw; importing fetches the platform's profile and the
  platform wins. That is the same rule as a roster name.
- **Writing needs a server.** GitHub Pages is static. The endpoints live on
  the local dev server (`server.ts`); a static build keeps the same keys in
  `localStorage` and downloads `suggestions.json` for the user to commit.
- **Writing needs permission.** `consent: true` is checked before the first
  network call, and the UI asks the user to confirm they own the account or
  have permission. Importing someone's subscriptions publishes third-party
  data.

**Refresh reads the signed-in feed, not the Data API.** The YouTube link asks
for the full `youtube` scope because InnerTube refuses `youtube.readonly` with
`insufficientPermissions`. `youtube.com` sends no CORS headers, so the browser
cannot call it; `server.ts` exposes `POST /api/youtube/subscriptions`, backed by
`scripts/lib/innertube-subs.ts`, which uses the bearer token, the **TVHTML5**
client and `browseId: "FEchannels"`. The TV feed answers with channel
`tileRenderer`s (id, title, handle, avatar), not `channelRenderer`s. A live
account returned **4,804 subscriptions in 5 pages** (~2.4 s). The token is
forwarded only to `youtube.com`, is never stored or logged by the server, and a
static build falls back to the Data API. The **Reconnect** action in the account
menu replaces an expired token without creating a second account.

**The subscription cards also read the channel page, for one reason: the 🎵
badge.** The TV `FEchannels` feed returns id, title, handle and avatar, but no
`AUDIO_BADGE`; the badge exists only in the channel page header. `server.ts`
therefore exposes a second, unauthenticated endpoint,
`POST /api/youtube/channel`, backed by `scripts/lib/youtube-channel.ts`. It
returns one `YouTubeChannelSnapshot`:

- with `detail: false` (the background sync) it performs one
  `getChannel(id)` and reads the header — the badge, title, avatar, handle and
  subscriber count;
- with `detail: true` (a card the user opened) it additionally calls
  `getLiveStreams()` and `getReleases()`, and returns the current live stream,
  the next upcoming stream, and up to twelve releases plus the total count.

The two paths are deliberately separate. Checking 4,800 subscriptions must not
open 4,800 Live and Releases tabs. The server limits itself to two channel
requests in flight, the browser uses two workers with a 120 ms gap, and a 429
stops the run. Results are cached in the browser by immutable channel id:
`vst.youtubeBadges` for 30 days, `vst.youtubeDetails` for the last 200 opened
channels. They are not part of the subscription list, so a Refresh cannot erase
them. A tracked subscription reads live/upcoming/songs from the dataset; only
an untracked card fetches the detail snapshot on open. The same route is
local-only and is not available on GitHub Pages.

The YouTube Data API stops a `mine=true` subscription list at **1,000**
items. Takeout has no such limit but is queued for hours, so the app offers
**Export from YouTube** as the no-link path: a script run on
`youtube.com/feed/channels` that uses the page's own session — `SAPISIDHASH`
from the `SAPISID` cookie — to walk the `FEchannels` continuation through
`/youtubei/v1/browse` and download a three-column CSV, the exact format the
importer accepts. The page renders only the first 1,000 cards, but the
continuation keeps going: a live 4,804-subscription account exported all 4,804
in 49 pages. Nothing leaves the browser, the cookie is never logged, and if the
signed request is refused the script falls back to the rendered page and says
so. A **PocketTube backup** (JSON) and a Takeout CSV still import through the
same `parseSubscriptionsFile()`, but neither is required for a large account.

## GitHub Actions

| Workflow | Trigger | Does |
| --- | --- | --- |
| `sync-data.yml` | every 6 hours + manual | fetch → classify → index → validate → commit `data/` |
| `deploy-pages.yml` | push to `main` | validate → build → publish to Pages |
| `ci.yml` | push + pull request | validate → type-check → build |

The quota spent by a sync is cached between workflow runs, so several runs a
day can never exceed the 10,000-unit daily allowance.
