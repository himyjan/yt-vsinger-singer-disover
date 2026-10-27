# VSinger & Singer Tracker

A discovery and tracking platform for **virtual singers (VTuber / VSinger)** and
**real human singers / music producers**. It collects public performer profiles
and cross-platform identities from global rosters, then refreshes available
channel and media details from supported platform APIs.

- Collects VTuber singing streams, music videos, covers and original songs.
- Keeps the dataset **in the repository** as versioned JSON, so it is
  diffable, auditable and served directly from a static host — GitHub Pages,
  and a separate deployment on Vercel with real cache headers.
- Searches it instantly with an inverted index built at pipeline time.
- Separates the **virtual** and **real** datasets, and splits everything by
  **region**. The app can filter channels and media by region and platform.
- Lets you link supported platform accounts to see the VTubers and singers you
  already follow.

---

## Quick start

```bash
npm install
cp .env.example .env        # optional platform API credentials
npm run dev:web             # the web app on :5173
```

The web app reads the committed dataset in `data/`. To refresh it:

```bash
npm run data:sync           # InnerTube + optional Data API + platform adapters
npm run data:index          # rebuild the search index
npm run data:validate       # check structure and size budgets
npm run data:links          # find the missing cross-platform accounts
npm run data:discover       # new performers from vTubie (--source all: + the wiki)
```

`npm run data:all` does the first three.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | The brief, with status markers |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit together |
| [docs/DATA-SCHEMA.md](docs/DATA-SCHEMA.md) | Every field, every file, every enum |
| [docs/YOUTUBE-API.md](docs/YOUTUBE-API.md) | Quota maths and endpoint costs |
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | Platform identities, adapters and account-linking coverage |
| [docs/SOURCES.md](docs/SOURCES.md) | Every data source, and which are read |
| [docs/DEPLOY.md](docs/DEPLOY.md) | GitHub Actions, Pages, secrets, LFS |
| [docs/API.md](docs/API.md) | The read-only JSON API: endpoints, shapes, caching |
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | Historical platform metrics and dashboard |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | How to add a channel, a region, a platform |
| [AGENTS.md](AGENTS.md) | Guide for AI agents |

## How it works

```
scripts/sync.ts
  ├── roster and music sources
  ├── YouTube: InnerTube (primary) + Data API v3 (optional extras)
  └── platform adapters: YouTube, Twitch, Bilibili, Niconico, VK,
                         CHZZK, KICK, SOOP and CI.ME
          ↓
       classify → data/*.json → committed → GitHub Pages / Vercel

scripts/resolve-links.ts   the missing accounts: the performer's own text,
                           their X bio, Wikidata, optional web search

scripts/discover.ts        new performers: the Virtual YouTuber Wiki, and the
                           vTubie directory through a real browser
                           → data/identities.json; --promote adds the ones
                             that pass the two-video gate
```

YouTube is the primary platform, and InnerTube (`youtubei.js`) is the primary
source for its channel search, video search, channel profiles, uploads and
live tab. It needs no API key and spends no Data API quota. The optional
YouTube Data API v3 adds richer video statistics and exact live scheduling
when configured. A newly discovered YouTube channel is added to virtual data
only after two distinct videos each show both virtual-creator identity and
singing evidence; non-YouTube discovery only accepts identities already in
vdb, the dataset, or the seed catalog.
The sync pipeline also
reads the global vdb roster (including links across many platforms), Taiwan
VTuber Tracking Data, VocaDB and curated music datasets. The Data API free tier
allows 10,000 quota units a day. The app supports YouTube, Twitch, Bilibili,
Niconico, VK, CHZZK, KICK, SOOP and CI.ME; public roster links are retained
even when a platform does not have a dedicated profile adapter.

### Supported platform features

| Platform | Dataset support | Secrets needed |
| --- | --- | --- |
| YouTube | Channel and video discovery, profiles, uploads, and live/upcoming streams | None required; optional `YOUTUBE_API_KEY` adds video statistics and exact broadcast times |
| Twitch | Keyword channel discovery and live streams; linked profiles and follower counts | `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are required for sync discovery |
| Bilibili | Ranking/live results filtered to vdb, existing or seeded identities; uploads and profiles | None |
| Niconico | Keyword-video authors filtered to vdb, existing or seeded identities; uploads; no live listing | None |
| VK | User discovery, channel profiles, uploads and follower counts | `VK_ACCESS_TOKEN` is required for discovery |
| CHZZK | Public keyword channel discovery, profiles and current live streams | None |
| KICK | Refresh known profiles and current live streams; no usable public keyword search | None |
| SOOP | Match current broadcasts from the first page of its public live list; no offline profile lookup | None |
| CI.ME | Refresh profiles for known channel IDs; no public search, uploads or live lookup | `CI_ME_CLIENT_ID` and `CI_ME_CLIENT_SECRET` |

To import YouTube playlist links from a DOCX, run
`npm run data:import-playlist -- "path/to/playlist.docx"`. The importer only
associates uploads with existing channels by immutable YouTube id or exact
handle, checks published YouTube country where available, and leaves
unmatched or ambiguously classified links in `.cache/playlist-import-unmatched.json`.

Discovery coverage varies: KICK identities are sourced from the global roster
and existing records because its current web search endpoint is not a usable
public API. SOOP only exposes a public live list, so discovery is limited to
matching broadcasts on its first page. CI.ME can refresh known profiles only;
configure its credentials under **Settings → Secrets and variables → Actions**
to enable that refresh. See [docs/PLATFORMS.md](docs/PLATFORMS.md) for platform
endpoints, discovery limitations and account-linking details.

A large part of the catalogue comes from vdb under a **Bilibili account
alone** — no YouTube channel, no Twitch login — and a record whose only
account is on Bilibili is filed under `cn`. `npm run data:links` finds the
accounts the performer publishes about themselves (their Bilibili signature,
their YouTube about page, their X bio through FxTwitter) and, failing that,
asks Wikidata by name or — with `--web` — a search-grounded model. A
name-search result is only accepted when the profile it resolves to points
back at the record. The discovered YouTube channel's published country then
corrects the region, because a country is the fact a mirror cannot corrupt.

A quota budget refuses any YouTube Data API v3 call that would exceed the
daily allowance. InnerTube requests do not use Data API quota, and cached
responses avoid spending quota on unchanged Data API results. Because the
catalogue is far larger than one run can refresh, each run owns a
deterministic shard of the refresh and live rotation, and the scheduled
workflow rotates that shard every run.

GitHub Actions refreshes the dataset every six hours, validates it, and
commits the result.

The Analytics view charts daily platform snapshots and ranks available metrics.
History is stored in the separate
[`yt-vsinger-singer-disover-analytics`](https://github.com/himyjan/yt-vsinger-singer-disover-analytics)
repository so it does not consume the main dataset size budget. Enable the
`ANALYTICS_REPO_TOKEN` Actions secret as described in
[docs/DEPLOY.md](docs/DEPLOY.md).

## The data layout

```
data/
├── manifest.json        counts, region table, quota usage
├── channels/            virtual/<region>/<bucket>.json · real/<region>/<bucket>.json
├── items/               <region>/<bucket>.json · live.json · upcoming.json
├── songs/               the music-centric projection
└── search/              the inverted index, per region
```

The same files are the **read-only API**: `data/api/v1/index.json` is a
generated, versioned index of every endpoint and the shape of its response,
and both deployments serve the tree cross-origin with a ten-minute cache. See
[docs/API.md](docs/API.md).

The scheduled GitHub Actions workflow refreshes the roster and supported
platform data every six hours, rebuilds search, validates the dataset and
commits changes. A second workflow (`live.yml`) runs the live-only pass every
ten minutes: it refreshes `data/items/live.json` and `upcoming.json` from the
InnerTube Live tab, spends no Data API quota, and commits only when a stream
actually started or ended. The manual workflow also supports quota budgets, discovery
skip, dry-run, shard count, a channel cap and a custom keyword used by the
enabled platform searches. Scheduled searches use the per-platform terms in
[`config/platform-keywords.json`](config/platform-keywords.json). Twitch and VK
discovery need their respective Actions secrets. `--no-search` (or the manual
workflow's **Skip discovery searches** option) skips keyword discovery across
platforms while continuing profile and media refreshes for known channels.
Automatic discovery on non-YouTube platforms only admits identities already
present in vdb, the dataset, or the curated seed catalog. YouTube can also add
new virtual channels when at least two distinct videos mention both virtual
singer/VTuber identity and singing in their titles, descriptions, or tags.
The refresh and live rotation is split into deterministic shards, so a
catalogue of thousands of channels is covered across successive runs rather
than starved by the per-run cap.
Sync and verification workflows serialize dataset writes and rebase generated
changes onto the latest branch before committing.
See [docs/DEPLOY.md](docs/DEPLOY.md) and [docs/PLATFORMS.md](docs/PLATFORMS.md).

Everything is sharded so no single file grows large — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#2-sharding-is-a-product-decision-not-an-implementation-detail).

## Classification

Each channel is classified along several axes, deterministically. The **region
is authoritative** and the language follows it — a Taiwanese performer often
has a Japanese-style stage name, and the kana in it says nothing about the
language they sing in.

| Axis | Values |
| --- | --- |
| `kind` | `virtual` · `real` |
| `role` | `vtuber` · `vsinger` · `singer` · `musician` · `producer` · `composer` |
| `region` | `jp` · `cn` · `tw` · `hk` · `kr` · `en` · `id` · `my` · `sea` |
| `gender` | `female` · `male` · `unknown` |
| `isAi` | AI-generated performers (AI VTuber, AI singer) |
| `variant` | the combined label — `female_vtuber`, `ai_vsinger`, … |
| `affiliation` | independent · community · business group (the 勢 vocabulary) |
| `regionSource` | which source decided the region — a roster, the platform's published country, kana, a script |

Uploads are classified as `cover`, `mv`, `original`, `live`, `premiere` or
`performance`, and carry an `isAcoustic` flag for 弾き語り / 彈唱 — singing
while playing an instrument.

## License

The dataset is committed to this repository. The code is MIT licensed.
