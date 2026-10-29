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
│         │                              │ YouTube InnerTube (primary)│
│         │                              │ YouTube Data API v3 (opt.)│
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
                    │  static host              │
                    │  Vue SPA + /data/*.json   │
                    │  GitHub Pages · Vercel    │
                    └───────────────────────────┘
```

## Three ideas hold the design together

### 1. The dataset lives in the repository

`data/` is committed. That makes the data:

- **versioned** — every change is a commit you can diff and revert;
- **auditable** — the classifier is deterministic, so the same input always
  produces the same output;
- **free to serve** — a static host publishes it with the app, same origin, no
  CORS setup; GitHub Pages serves both, and the Vercel deployment adds the
  cache headers a static host has no way to set;
- **reviewable** — a pull request that changes `data/` shows exactly which
  channels were added or reclassified.

The cost is a size ceiling, which is why the dataset is **sharded** and
**budgeted** (see below).

The ceiling applies to the **tree**, not to its history. A snapshot of `data/`
packs to about 28 MiB and a routine commit adds about 0.3 MiB, so the history
is squashed to one snapshot every month and the shards stay the only part of
the repository that grows. When a squash stops being enough the catalogue is
split into **volumes** — one repository per slice, `volumeOf(id)` deciding
which, planned and verified by `npm run data:volumes` — and the app reads them
the way it already reads regions. The ladder and
both procedures are in [DEPLOY.md](DEPLOY.md#the-capacity-ladder).

### 2. Sharding is a product decision, not an implementation detail

GitHub recommends keeping a repository under 1 GB (10 GB of `.git` is the
documented maximum), and a single JSON blob that large is unusable in a
browser anyway. So the dataset is split:

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
| `data/search/<region>.json` | inverted index for one region — shard 0 | 1–5 MB |
| `data/search/<region>.<n>.json` | further packs of a region too big for one file | 1–5 MB |

The browser loads only the slice it needs: the channel manifest on startup,
the shards of the regions and kinds it is showing when the user picks one, the
live/upcoming files for those views, and the search packs for the query. A
region may be several packs — `en` is three — but they are one index: a query
looks up each and merges the hits, exactly as it merges regions. The
list is a projection of those records — there is no separate summary file to
download.

### 3. The scope switch is enforced in the data layer

`Virtual` / `Real` / `Both` is not a per-view concern. Every view funnels its
results through `filterItems()` / `filterChannels()` in
`src/lib/dataset.ts`, which apply the scope, the region, the categories, the
gender filter, the AI filter and the acoustic filter in one place. A new view
cannot accidentally leak the wrong kind of performer, because it has to go
through the same funnel.

The platform filter goes through the same funnel, and it matches by **site**,
not by raw key: `platformFilterKey()` in `src/lib/links.ts` folds the numbered
`web:<n>` address slots (and the `web`/`other` spellings, and the
`x`/`twitter`, `weibo`/`weiboByName`, `youtube_video`/`youtube_playlist`
aliases) into one option, and `matchesPlatform()` is the matching half. The
dropdown is built from the same grouped keys, which is why it lists one
「Website」 rather than `web:1` … `web:56` — the raw keys are storage slots in
`externals`, not platforms.

## Layers

### The pipeline (`scripts/`)

```
scripts/
├── sync.ts                  orchestrator: fetch → classify → merge → write
├── fill-details.ts          fills the missing avatars, names and regions
├── resolve-links.ts         finds the missing cross-platform accounts
├── discover.ts              finds performers nobody has recorded yet
├── verify.ts                verifies classifications with search grounding
├── build-index.ts           builds the inverted search index (`--root` for a volume)
├── split-volumes.ts         plans, writes and verifies the split into volumes
├── validate.ts              CI gate: structure, consistency, size budgets
├── prepare-public.ts        copies data/ into public/ for the build
├── harvest-bacharu.ts       bacharu's roster → .cache/ (resumable, JSON API)
├── harvest-vtuberhk.ts      vtuber.hk: /channels/ + /data/*.json → .cache/
├── harvest-hololist.ts      hololist.net: sitemaps + one page per entry → .cache/
├── import-bacharu.ts        gates a bacharu snapshot into data/
├── import-vtuberhk.ts       gates a VtuberHK snapshot into data/
├── import-hololist.ts       gates a HoloList snapshot into data/ (+ --links)
└── lib/
    ├── types.ts             the canonical data model (shared with the app)
    ├── youtube.ts           YouTube Data API v3 client + quota budget
    ├── youtubei.ts          InnerTube: channel/video search, profile, uploads,
    │                        Live tab, OAC badge, Music releases
    ├── innertube-subs.ts    signed-in FEchannels subscription feed
    ├── youtube-channel.ts   one-channel snapshot for the subscription cards
    ├── twitch.ts            Twitch Helix client
    ├── platforms/           Bilibili, Niconico, VK, CHZZK, KICK, SOOP and
    │                        CI.ME adapters
    ├── platform-registry.ts assembles every adapter
    ├── platforms.ts         the PlatformAdapter interface
    ├── classify.ts          virtual/real, role, region, gender, AI, category
    ├── regions.ts           region metadata, agency → region, script and
    │                        latin-language detection (es/pt/fr/de/…)
    ├── link-discovery.ts    the identities a performer publishes, resolved
    ├── web-links.ts         optional search-grounded link finder (`--web`)
    ├── shard.ts             the deterministic shard, shared by every pass
    ├── volume.ts            the deterministic volume: rendezvous hashing
    ├── identity.ts          de-duplication registry
    ├── discovery-evidence.ts  virtual-creator and singing evidence rules
    ├── debut-sources/       the wiki and the vTubie directory, as adapters
    ├── promote-candidates.ts  candidate → confirmed channel → record
    ├── search.ts            tokenizer + inverted index + query engine
    ├── aislist.ts           AI-channel list
    ├── vdb.ts               the Virtual YouTuber Name List Database
    ├── hololist.ts          the HoloList directory: entry and sitemap parsers
    ├── taiwan-vtuber-data.ts  the Taiwan VTuber track list
    ├── chinese-scripts.ts   simplified vs. traditional character sets
    ├── dedupe.ts            identity-based de-duplication
    ├── roster.ts            builds the channel roster from those sources
    ├── music-dataset.ts     curated cover-song metadata
    ├── seed-catalog.ts      validates and loads data/seed-catalog.json
    ├── suggestions.ts       data/suggestions.json — the import queue
    ├── import-channels.ts   suggestions → InnerTube → classified records
    ├── dataset.ts           the on-disk layout and the writers
    └── io.ts                file helpers and size budgets
```

### The sync run

`scripts/sync.ts` is one pass of:

```
load data/ → refresh upstream rosters → discovery searches
   → qualify new channels → refresh profiles/uploads/live
   → classify → merge by id → retention → write shards → manifest
```

InnerTube is the default YouTube source for every network step in that list:
channel search, video search, profiles, uploads, releases and the Live tab. The
Data API is optional and only adds richer video statistics, exact broadcast
times and a fallback for a failed InnerTube lookup, so a run with no API key is
still complete.

**A run is a shard.** Fourteen thousand channels cannot be refreshed in one
run, and a fixed `slice(0, N)` would refresh the same head of the list forever.
Instead the refresh, live and discovered-candidate sets are filtered by
`FNV-1a(channel id) % shardCount === shardIndex - 1`. The hash is over the
immutable platform id, so the assignment is stable across machines and runs;
the scheduled workflow rotates the index with `GITHUB_RUN_NUMBER`, and within a
shard the channels that have gone longest without a refresh are taken first.
The union of successive runs therefore covers the catalogue without a cursor
file, and every run still commits its own slice.

`scripts/lib/shard.ts` holds that hash, so the sync, the details fill and the
link resolver put a channel in the same shard.

### The discovery run

`scripts/discover.ts` answers the other question: who exists that the
catalogue has never seen. A **debut source** (`scripts/lib/debut-sources/`)
publishes candidates in its own shape — the Virtual YouTuber Wiki's
`{{Character}}` infobox, the vTubie directory's cards — and the runner merges
every one through `IdentityRegistry.upsert()` into `data/identities.json`.

The registry is the de-duplication database: a performer is keyed by every
strong identity a source knows (YouTube channel id, handle, X handle, wiki
page), records that share one are merged rather than duplicated, and the
alternative names are kept so one performer stays reachable under every name
they are known by. A run that finds nothing new leaves the file untouched.

A directory entry is a **name**, never a channel id, so discovery alone cannot
write `data/channels/`. `--promote` closes that gap: the name is resolved
through InnerTube channel search, the hit is confirmed against the channel's
own title, and the channel enters the catalogue only when two of its videos
show virtual-creator identity **and** singing evidence
(`scripts/lib/discovery-evidence.ts`, the same terms the sync applies to a
discovered channel). The survivors go through `importYouTubeChannels()`, which
builds the record, applies `data/overrides.json`, merges it into the shards
and rebuilds the search index.

The vTubie source drives a real browser (`puppeteer-core`, optional) because
their pages sit behind a Cloudflare challenge and there is no API. A challenge
that does not clear is reported and yields no candidates; it never fails the
run.

### The link resolver

`scripts/resolve-links.ts` is the pass for the records whose platform list is
incomplete — 9,000+ of them, filed under Bilibili alone. It reads what the
performer publishes about themselves (description, X bio through FxTwitter),
then Wikidata by name, then YouTube's own channel search by the display name
(InnerTube, no quota) — a name candidate is confirmed by the profile's name,
either direction of containment, and rejected if it is a clip or fan account —
then, with `--web`, a search-grounded model. It writes the accounts it can
**prove** belong to the record. A discovered YouTube channel's published
country may correct the region; nothing else about the record is rewritten.

The account also decides the **id**: the record is re-keyed to the YouTube
`UC…` channel (`canonicalizeChannelIds()`), its items are re-pointed, and a
duplicate with an existing YouTube record is merged, so a pass that finds the
channel leaves the record on the id that channel owns. It skips an account
another record already owns. `--platform <id>` and `--region <code>` narrow the
queue — `--platform bilibili --region jp` is the Japanese mirror backlog.

### The web app (`src/`)

```
src/
├── App.vue                  the application shell
├── lib/
│   ├── store.ts             reactive state: scope, filters, accounts, theme
│   ├── origins.ts           where the dataset lives: one origin or N volumes
│   ├── dataset.ts           loads and filters the committed dataset
│   ├── auth.ts              account linking for seven platforms
│   ├── takeout.ts           reads a Takeout/export subscriptions.csv
│   ├── subs-export.ts       the in-page script that writes that CSV
│   ├── youtube-detail.ts    browser client for the one-channel bridge
│   ├── links.ts             builds the "all links" block
│   └── env.ts               build-time environment
└── components/
    ├── LiveCard.vue         thumbnail + info block + all links
    ├── ChannelCard.vue      channel badge, name, followers
    ├── ChannelDrawer.vue    channel detail, links, uploads and releases
    ├── OfficialArtistBadge.vue  YouTube's inline SVG, right of the name
    └── SubscriptionDetail.vue  untracked subscription fetched on open
```

`scripts/lib/types.ts` and `scripts/lib/search.ts` are imported by **both**
the pipeline and the app, through the `@shared/*` alias. There is exactly one
definition of the data model and one tokenizer.

### What the first paint waits for

The shell is deliberately small and the dataset deliberately late.

- **The app's own CSS and bundle are the only render-blocking resources** —
  51 KB of CSS and 333 KB of JavaScript (9 KB and 113 KB gzip). The theme
  class is applied by an inline script in the head, which must stay blocking:
  it decides the colour scheme before the first pixel.
- **The webfonts are not on the critical path.** They are linked from
  `index.html` rather than `@import`ed in the bundle, and the Google sheet is
  larger than the JavaScript — 383 KB uncompressed, 344 `@font-face` rules
  across 118 subsets, ~104 KB gzip. So it is loaded as a print-media sheet
  that swaps itself in when it lands, with a `<noscript>` fallback for a
  browser without JavaScript. Because the URL already carries
  `display=swap`, text painted in the fallback face either way; blocking on
  the sheet only bought a later first paint. A second blocking stylesheet in
  the head is what would put that 104 KB back on the critical path.
- **The dataset loads after the first paint.** `loadDataset()` waits for two
  `requestAnimationFrame` callbacks (with a timeout fallback) and then fetches
  the channel manifest, the channel shards, `live.json` and `upcoming.json` in
  parallel, followed by the item shards the Songs view needs. The Live tab
  reads three small files; the roster it downloads beside them is the largest
  transfer in the app, so a view-scoped boot is the remaining byte cut.

A cold visit transfers roughly 2.4 MB compressed — the vast majority of it
channel JSON, sharded by region — and a repeat visit inside ten minutes costs
one conditional request, because the dataset is served with a ten-minute
`max-age` and `stale-while-revalidate`, and the hashed bundle as `immutable`.
Those headers are per host, not per app: see
[docs/DEPLOY.md](DEPLOY.md#serving-from-vercel).

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
| `kind` (virtual / real) | a curated `kind`, then a roster's `virtualClaim` (vdb, vTubie's groups, bacharu, VtuberHK, HoloList, each platform's VTuber directory), then a weighted score over strong and weak markers with the channel name weighted highest and the opening of the description next. `singer` / `composer` / `songwriter` are jobs and do not decide it; `REAL_IDENTITY` holds the words that state a human body |
| `role` | the strongest matching role marker, unless the channel looks like an aggregator |
| `region` | agency → published country → kana in the name → explicit region markers → platform prior → script detection → locale hints. A link to another platform is not a signal, and the winning source is stored in `regionSource` |
| `gender` | explicit self-description first; honorifics only as a fallback |
| `isAi` | the AiSList blocklist and warnlist, plus keyword heuristics as a fallback |
| `category` | cover / mv / original / live / premiere / performance, from the title, description and tags |
| `isAcoustic` | 弾き語り / 彈唱 / acoustic — a flag, not a category, so acoustic covers stay in the cover bucket |
| `variant` | the combined label: `female_vtuber`, `ai_vsinger`, … |

Everything is overridable from `data/overrides.json`, and the curated catalog
in `data/seed-catalog.json` has the highest precedence of all.

The classifier reads **only the record** — no clock, no network — so the whole
catalogue can be re-derived in seconds with `npm run data:reclassify`, which is
how a corrected vocabulary becomes a correct dataset without re-fetching
sixty thousand profiles. It reads `.cache/bacharu-vtubers.json` and
`.cache/vtubie-groups.json` for the roster claim, and honours overrides and
seeds as the last word. `--languages` goes one field further: it re-derives
the `region` and `languages` of a record whose region is only a guess
(`script` or `unknown`), which is how the Spanish descriptions that used to
be read as English stop being `en`.

## De-duplication

The same performer appears under many identifiers. `scripts/lib/identity.ts`
keeps a registry of identity keys:

- **strong** — YouTube channel id, handle, X handle, wiki page title;
- **weak** — normalised display name, matched with a bounded edit distance
  and only within the same region.

Records that share a key are merged, never duplicated. The registry also
enriches channels the YouTube API knows nothing about — the wiki supplies
debut dates and graduation dates, which the API does not expose.

## Reincarnation (轉生)

A talent can graduate and return under a new name, model and, often, another
agency. De-duplication deliberately does **not** merge those two records: they
are two channels with two audiences, two histories and two sets of items, and
the merge would erase one of them.

The relation is a curated edge, `reincarnationOf`, stored **once** on the newer
record — `data/overrides.json` is the input, and the sync applies it the same
way it applies a curated `kind`. The drawer derives the other direction by
scanning the summaries for records that point at the one open, so
`轉生帳號 · Reincarnation account` and `前世 · Previous persona` are two views of
one field and cannot disagree. `openChannelById()` in `App.vue` resolves the
other persona from the full catalogue when the current region filter has not
loaded it.

The edge chains: `B.reincarnationOf = A`, `C.reincarnationOf = B` walks
A → B → C one hop at a time, and any number of records may name the same
predecessor. It is never inferred — a shared voice or a fan wiki's guess is not
evidence, and a wrong edge would publish one performer's page under another's
history.

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

A **group** in a PocketTube backup is a curation, not an inference: the
list's owner filed a channel under 「Vsinger」 or 「Vtuber」, which is a
statement the description may not repeat. So the group is written to
`data/overrides.json` first (`kind`, `isSinging`), and the import applies the
same overrides the sync applies — otherwise the next sync would re-classify
the channel from its description and drop the reason it was imported.

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
| `sync-data.yml` | every 6 hours + manual | fetch → qualify discovery candidates → classify → index → validate → rebase → commit `data/`; rotates through the catalogue by shard |
| `verify-data.yml` | daily + manual | verify uncertain records → re-apply corrections → index → validate → rebase → commit `data/` |
| `deploy-pages.yml` | push to `main` | validate → build → publish to Pages |
| `ci.yml` | push + pull request | validate → type-check → build |

The sync and verification workflows share one repository-wide dataset-writer
concurrency group. Before committing, each fetches and rebases its generated
data changes onto the latest branch head so intervening commits do not cause a
non-fast-forward push failure.

The quota spent by a sync is cached between workflow runs, so several runs a
day can never exceed the 10,000-unit daily allowance.
