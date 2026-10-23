# VSinger & Singer Tracker

A discovery and tracking platform for **virtual singers (VTuber / VSinger)** and
**real human singers / music producers**. It collects public performer profiles
and cross-platform identities from global rosters, then refreshes available
channel and media details from supported platform APIs.

- Collects VTuber singing streams, music videos, covers and original songs.
- Keeps the dataset **in the repository** as versioned JSON, so it is
  diffable, auditable and served directly from GitHub Pages.
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
```

`npm run data:all` does all three.

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
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | Historical platform metrics and dashboard |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | How to add a channel, a region, a platform |
| [AGENTS.md](AGENTS.md) | Guide for AI agents |

## How it works

```
scripts/sync.ts
  ├── roster and music sources
  ├── YouTube: InnerTube (primary) + Data API v3 (optional metadata/discovery)
  └── platform adapters: YouTube, Twitch, Bilibili, Niconico, VK,
                         CHZZK, KICK, SOOP and CI.ME
          ↓
       classify → data/*.json → committed → GitHub Pages
```

YouTube is the primary platform, and InnerTube (`youtubei.js`) is the primary
source for its channel profiles and uploads. The optional YouTube Data API v3
adds search and specialized live/video metadata. A newly discovered YouTube
channel is added to virtual data only after two distinct videos each show
both virtual-creator identity and singing evidence; non-YouTube discovery
only accepts identities already in vdb, the dataset, or the seed catalog.
The sync pipeline also
reads the global vdb roster (including links across many platforms), Taiwan
VTuber Tracking Data, VocaDB and curated music datasets. The Data API free tier
allows 10,000 quota units a day. The app supports YouTube, Twitch, Bilibili,
Niconico, VK, CHZZK, KICK, SOOP and CI.ME; public roster links are retained
even when a platform does not have a dedicated profile adapter.

### Supported platform features

| Platform | Dataset support | Secrets needed |
| --- | --- | --- |
| YouTube | Channel discovery, profiles, uploads, and live/video metadata | Optional `YOUTUBE_API_KEY`; InnerTube is the discovery fallback |
| Twitch | Keyword channel discovery and live streams; linked profiles and follower counts | `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are required for sync discovery |
| Bilibili | Ranking/live results filtered to vdb, existing or seeded identities; uploads and profiles | None |
| Niconico | Keyword-video authors filtered to vdb, existing or seeded identities; uploads; no live listing | None |
| VK | User discovery, channel profiles, uploads and follower counts | `VK_ACCESS_TOKEN` is required for discovery |
| CHZZK | Public keyword channel discovery, profiles and current live streams | None |
| KICK | Refresh known profiles and current live streams; no usable public keyword search | None |
| SOOP | Match current broadcasts from the first page of its public live list; no offline profile lookup | None |
| CI.ME | Refresh profiles for known channel IDs; no public search, uploads or live lookup | `CI_ME_CLIENT_ID` and `CI_ME_CLIENT_SECRET` |

Discovery coverage varies: KICK identities are sourced from the global roster
and existing records because its current web search endpoint is not a usable
public API. SOOP only exposes a public live list, so discovery is limited to
matching broadcasts on its first page. CI.ME can refresh known profiles only;
configure its credentials under **Settings → Secrets and variables → Actions**
to enable that refresh. See [docs/PLATFORMS.md](docs/PLATFORMS.md) for platform
endpoints, discovery limitations and account-linking details.

A quota budget refuses any YouTube Data API v3 call that would exceed the
daily allowance. InnerTube requests do not use Data API quota, and cached
responses avoid spending quota on unchanged Data API results.

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

The scheduled GitHub Actions workflow refreshes the roster and supported
platform data every six hours, rebuilds search, validates the dataset and
commits changes. The manual workflow also supports quota budgets, discovery
skip, dry-run and a custom keyword used by the enabled platform searches.
Scheduled searches use the per-platform terms in
[`config/platform-keywords.json`](config/platform-keywords.json). Twitch and VK
discovery need their respective Actions secrets. `--no-search` (or the manual
workflow's **Skip discovery searches** option) skips keyword discovery across
platforms while continuing profile and media refreshes for known channels.
Automatic discovery on non-YouTube platforms only admits identities already
present in vdb, the dataset, or the curated seed catalog. YouTube can also add
new virtual channels when at least two distinct videos mention both virtual
singer/VTuber identity and singing in their titles, descriptions, or tags.
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
| `regionSource` | which source decided the region — a roster, the platform, a script |

Uploads are classified as `cover`, `mv`, `original`, `live`, `premiere` or
`performance`, and carry an `isAcoustic` flag for 弾き語り / 彈唱 — singing
while playing an instrument.

## License

The dataset is committed to this repository. The code is MIT licensed.
