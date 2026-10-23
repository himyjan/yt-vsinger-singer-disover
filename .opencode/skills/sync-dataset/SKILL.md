---
name: Sync Dataset
description: Run, debug and extend the YouTube/Twitch/Bilibili/Niconico/VK data sync pipeline — quota budgeting, the sync script, the dataset layout, and the GitHub Actions workflow
---

# Sync the dataset

The pipeline refreshes `data/` from the platform APIs and commits the result.

## Before you start

```bash
npm install
export YOUTUBE_API_KEY=...   # required
```

The pipeline must run with **plain Node** — no native modules. `better-sqlite3`
is an `optionalDependency` used only by the one-off legacy migration.

## The commands

```bash
npm run data:sync                     # normal run
npm run data:sync -- --dry-run        # fetch + classify, write nothing
npm run data:sync -- --budget 500     # cap this run at 500 quota units
npm run data:sync -- --no-search      # refresh known channels only (1 unit each)
npm run data:sync -- --keyword "…"    # run one discovery query
npm run data:sync -- --force          # reset the quota counter and refetch
npm run data:index                    # rebuild the inverted search index
npm run data:validate                 # structure + size budgets (CI gate)
```

Always finish with `npm run data:index && npm run data:validate`.

## How the run works

`scripts/sync.ts` executes in this order:

1. **Load** the current dataset from `data/`.
2. **Resolve seeds** — `data/seed-catalog.json` holds curated records; handles
   are resolved with `channels.list?forHandle=` (1 unit each).
3. **Discover** — `search.list` (100 units each), bounded by
   `maxSearchesPerRun`.
4. **Refresh channels** — `channels.list` (1 unit per 50).
5. **Enrich** — Twitch, AiSList, and the other platform adapters.
6. **Fetch items** — `playlistItems.list` + `videos.list` per channel.
7. **Fetch live** — `liveBroadcasts.list` (1 unit per 50 channels).
8. **Backfill durations** — `videos.list` for records that have no duration.
9. **Enrich songs** — the VTuber Music Dataset overrides the heuristic song
   extraction.
10. **Retain** — apply the age and per-channel caps.
11. **Merge and write** — `scripts/lib/dataset.ts` writes every shard.

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

- The free tier is **10,000 units/day**. `QuotaBudget` refuses any call that
  would exceed it, and the counter persists to `.cache/quota.json` (reset
  daily).
- **Never** call the API directly with `fetch`. Always go through
  `YouTubeClient` so the budget and the cache are respected.
- A `search.list` costs as much as fifty channel lookups. Prefer refreshing
  known channels over searching.

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
| `Refusing search.list` | the budget is exhausted; raise `--budget` or wait for the daily reset |
| `quotaExceeded` | the daily allowance is spent; lower `maxSearchesPerRun` |
| `accessNotConfigured` | the YouTube Data API v3 is not enabled for the project |
| Channels written but no items | the uploads playlist could not be derived — the channel id may not start with `UC` |
| `twitch: skipped` | `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` are not set |
| `aislist: unavailable` | the raw GitHub URL was unreachable; the heuristic AI detection is used instead |

## In GitHub Actions

`.github/workflows/sync-data.yml` runs every 6 hours. It restores
`.cache` between runs so the quota budget is cumulative across the day, then
commits `data/` with `git-auto-commit-action`. A run that finds nothing new
produces no commit.

The required secret is `YOUTUBE_API_KEY`. Optional: `TWITCH_CLIENT_ID`,
`TWITCH_CLIENT_SECRET`, `VK_ACCESS_TOKEN`.
