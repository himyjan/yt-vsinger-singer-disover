---
name: Sync Dataset
description: Run, debug and extend the YouTube/Twitch/Bilibili/Niconico/VK data sync pipeline — quota budgeting, the sync script, the dataset layout, and the GitHub Actions workflow
---

# Sync the dataset

The pipeline refreshes `data/` from the platform APIs and commits the result.

## Before you start

```bash
npm install
export YOUTUBE_API_KEY=...   # optional; enables richer Data API video metadata
```

The pipeline must run with **plain Node** — no native modules. `better-sqlite3`
is an `optionalDependency` used only by the one-off legacy migration.

## The commands

```bash
npm run data:sync                     # normal run
npm run data:sync -- --dry-run        # fetch + classify, write nothing
npm run data:sync -- --budget 500     # cap Data API spend at 500 quota units
npm run data:sync -- --no-search      # skip keyword searches; refresh known channels
npm run data:sync -- --shard 2/4      # refresh only the second of four shards
npm run data:sync -- --limit-channels 50 --limit-live 100
npm run data:sync -- --keyword "…"    # run one discovery query
npm run data:sync -- --force          # reset the quota counter and refetch
npm run data:index                    # rebuild the inverted search index
npm run data:validate                 # structure + size budgets (CI gate)
```

Always finish with `npm run data:index && npm run data:validate`.
Without a Data API key, sync may still rebuild the roster and discover new
channels and videos through InnerTube; `--no-search` is not a promise that no
new roster records can be added.

## How the run works

`scripts/sync.ts` executes in this order:

1. **Load** the current dataset from `data/`.
2. **Resolve seeds** — `data/seed-catalog.json` holds curated records; handles
   are resolved with InnerTube, with `channels.list?forHandle=` as fallback
   (1 unit each).
3. **Discover candidates** — InnerTube channel and video search by default;
   `search.list` (100 units each) when the Data API is configured and within
   budget. `searchVideos(q, n, { liveOnly: true })` mirrors `eventType=live`.
4. **Qualify new YouTube channels** — require at least two distinct videos
   that each contain virtual-creator identity and singing evidence in
   available titles, descriptions, or tags. Existing vdb/dataset/seed
   identities are retained without this check. Non-YouTube search results
   must match vdb, the dataset, or the seed catalog.
5. **Refresh channels** — InnerTube profiles; `channels.list` is optional and
   only used as a fallback (1 unit per 50).
6. **Enrich** — Twitch, AiSList, and the other platform adapters.
7. **Fetch items** — InnerTube uploads; `playlistItems.list` + `videos.list`
   as fallback.
8. **Fetch live** — the InnerTube channel Live tab. A successful empty check
   retires the stale live item to `past`; a failed check (`null`) changes
   nothing. The Data API optionally enriches discovered broadcasts with exact
   times and viewer counts.
9. **Backfill durations** — `videos.list` for records that have no duration.
10. **Enrich songs** — the VTuber Music Dataset overrides the heuristic song
   extraction.
11. **Retain** — apply the age and per-channel caps.
12. **Merge and write** — `scripts/lib/dataset.ts` writes every shard.

### Sharding

Steps 3, 5 and 8 operate on sets far larger than one run can finish. Each set
is filtered by `inShard()`: `FNV-1a(immutable channel id) % shardCount ===
shardIndex`, with a 1-based `--shard N/M` (`M=1` disables sharding). Within a
shard, channels with the oldest `lastItemsFetchedAt` go first. The scheduled
workflow rotates the shard index by `GITHUB_RUN_NUMBER`, so successive runs
cover the catalogue without a cursor file. Never replace this with a fixed
`slice()` — the head of the list would be refreshed forever.

Two passes near the end are worth knowing about because they change records
without any request:

- **Activity** — `detectActivity()` re-reads every name and description for a
  graduation marker (「卒業」, 「活動を終了しました」, 「停止活動」), and a
  graduation always wins over a roster's `active`.
- **Region** — `classifyChannel()` re-reads every record's stored name,
  description, tags and country, and a more trusted source replaces a less
  trusted one; an override, a roster and an agency are never overwritten.
  This is how 49 Japanese channels that listed their Bilibili link in their
  description stopped being `cn` without a single request.

The networked half is `npm run data:details -- --weak-region`, which fetches
the published country and the profile in the record's own language.

## Quota rules — do not bypass these

| Request | Units |
| --- | ---: |
| `search.list` | **100** |
| everything else | 1 |

InnerTube requests spend **no** Data API quota: channel and video search,
profiles, uploads, releases and the Live tab. The Data API is optional, and
`liveBroadcasts.list` is not used because it requires OAuth while the
scheduled pipeline only has an API key.

- The free tier is **10,000 units/day**. `QuotaBudget` refuses any call that
  would exceed it, and the counter persists to `.cache/quota.json` (reset
  daily).
- **Never** call the Data API directly with `fetch`. Always go through
  `YouTubeClient` so the budget and the cache are respected.
- A `search.list` costs as much as fifty channel lookups. Prefer InnerTube
  search and refreshing known channels over a Data API search.
- Every InnerTube call carries a timeout; a hung request must return an empty
  result rather than stall the run.

## The dataset layout

`scripts/lib/dataset.ts` owns the on-disk layout. It writes:

```
data/manifest.json
data/channels/manifest.json
data/channels/virtual/<region>/<bucket>.json   (16 buckets per region)
data/channels/real/<region>/<bucket>.json
data/items/<region>/<bucket>.json     (16 buckets per region)
data/items/{live,upcoming}.json
data/songs/{index,manifest}.json
data/songs/<region>.json
data/songs/categories/<category>.json
data/search/<region>.json
```

Stale shards are pruned automatically. **Never write a file larger than 8 MB**
(`SIZE_BUDGET.maxFileBytes` throws) and never let `data/` exceed 180 MB.

## Extending the pipeline

| I want to… | Do this |
| --- | --- |
| Add a discovery keyword | `config/sync.config.json` → `searches[]` |
| Change how much is fetched | `config/sync.config.json` → the `max*` knobs |
| Add a platform | See the `add-platform` skill |
| Add a debut source | `scripts/lib/debut-sources/<name>.ts` |
| Add a data source that enriches records | A module with a `fetch*()` that returns `null` on failure |

Every network call must be wrapped so that a failure yields an empty result
and a log line — never an exception that aborts the run.

## Debugging

```bash
npm run data:sync -- --dry-run 2>&1 | tail -40
```

The log prints, per step: what was fetched, what was skipped, and why.

| Symptom | Cause |
| --- | --- |
| `Refusing search.list` | the budget is exhausted; InnerTube search takes over, or raise `--budget` / wait for the daily reset |
| `quotaExceeded` | the daily allowance is spent; lower `maxSearchesPerRun` |
| `accessNotConfigured` | the YouTube Data API v3 is not enabled for the project |
| Channels written but no items | the uploads playlist could not be derived — the channel id may not start with `UC` |
| `twitch: skipped` | `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` are not set |
| `aislist: unavailable` | the raw GitHub URL was unreachable; the heuristic AI detection is used instead |

## In GitHub Actions

`.github/workflows/sync-data.yml` runs every 6 hours. It rotates a
deterministic shard of the refresh and live rotation by
`GITHUB_RUN_NUMBER`, restores `.cache` between runs so the quota budget is
cumulative across the day, then commits `data/` with
`git-auto-commit-action`. A run that finds nothing new produces no commit. The
sync and verification workflows use the same repository-wide concurrency group
and rebase generated data onto the latest branch before committing, preventing
overlapping dataset writes and non-fast-forward pushes.

`YOUTUBE_API_KEY` is optional; it enables richer video statistics, exact
broadcast times and a fallback for failed InnerTube lookups. Optional platform
credentials: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `VK_ACCESS_TOKEN`.
