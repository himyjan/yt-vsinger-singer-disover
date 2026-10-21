# AGENTS.md

> Guide for AI agents working in this repository.

## What this project is

A tracker and discovery platform for **virtual singers (VTuber / VSinger)** and
**real human singers / music producers**, across **YouTube, Twitch, Bilibili,
Niconico and VK**.

Three things it does:

1. **Collects** VTuber singing videos, music videos, covers, originals and live
   streams.
2. **Stores** the result as JSON committed to this repository (`data/`), so it
   is versioned, diffable and served straight from GitHub Pages.
3. **Searches** it instantly with an inverted index built at pipeline time.

## Before you change anything

```bash
npm install
npm run data:validate   # the dataset must be valid
npm run lint            # vue-tsc must pass
npm run build           # the app must build
```

All three also run in CI (`ci.yml`), so a green local run means a green PR.

## The two halves of the repository

They share `scripts/lib/types.ts` and `scripts/lib/search.ts` through the
`@shared/*` alias. There is exactly **one** definition of the data model and
**one** tokenizer.

### The pipeline (`scripts/`)

Node + TypeScript, no native dependencies. It runs unchanged in GitHub Actions.

```
scripts/
├── sync.ts            fetch → classify → merge → write
├── build-index.ts     build the inverted search index
├── validate.ts        CI gate
├── import-legacy-db.ts  one-off SQLite migration
├── prepare-public.ts  copy data/ into public/ for the build
└── lib/               types, youtube, twitch, platforms, classify, regions,
                       identity, search, aislist, music-dataset, seeds,
                       dataset, io
```

### The web app (`src/`)

Vue 3 + Tailwind v4 + Vite. Static — it reads the committed JSON and never
talks to a backend.

```
src/
├── App.vue            the shell: header, filters, views, drawer, mobile nav
├── lib/store.ts       reactive state: scope, filters, accounts, theme
├── lib/dataset.ts     loads and filters the dataset
├── lib/auth.ts        account linking for four platforms
├── lib/links.ts       the "all links" block
├── lib/env.ts         build-time environment
└── components/        LiveCard.vue, ChannelDrawer.vue
```

## The rules that matter

### 1. The scope switch is applied in the data layer

`Virtual` / `Real` / `Both` is enforced in `filterItems()` and
`filterChannels()` in `src/lib/dataset.ts` — **not** in individual views. Any
new view must funnel its results through those functions. Do not add a
per-view `kind` check.

### 2. The classifier is deterministic

`scripts/lib/classify.ts` has no randomness and no network calls. The same
input always produces the same record. This is what keeps the git history of
`data/` readable — do not introduce `Math.random()`, timestamps or
network-derived values into a record's classification.

### 3. Never write a file over the size budget

`scripts/lib/io.ts` throws when a file exceeds 8 MB, and `data/` is capped at
180 MB. GitHub Free allows ~1 GB for the whole repository. If a change makes
the dataset grow, add a retention rule rather than raising the budget.

### 4. Every record keeps its provenance

`mergeById()` preserves `addedAt`, and preserves `source: "seed"` and
`source: "manual"` across API refreshes. Do not overwrite provenance.

### 5. Never let a failing source break the run

Every network call in the pipeline is wrapped. A source that is unreachable
must return an empty result and log why. A broken Bilibili endpoint must
never take the YouTube sync down.

### 6. Quota is a hard constraint

The YouTube free tier is 10,000 units/day and `search.list` costs 100. The
`QuotaBudget` refuses calls that would exceed the limit. Never bypass it with
a direct `fetch` to the API.

### 7. `better-sqlite3` is an optional dependency

It is only used by the one-off legacy migration. The CI path must stay free
of native modules.

## Common tasks

| Task | Where |
| --- | --- |
| Fix a misclassified channel | `data/overrides.json`, then `npm run data:sync -- --no-search` |
| Fix the classifier itself | `scripts/lib/classify.ts` |
| Add a curated channel | `scripts/lib/seeds.ts` |
| Add a region | `scripts/lib/types.ts`, `scripts/lib/regions.ts` |
| Add a platform | `scripts/lib/platforms/<name>.ts` + `platform-registry.ts` |
| Add a discovery source | `scripts/lib/debut-sources/<name>.ts` |
| Change the search behaviour | `scripts/lib/search.ts`, then `npm run data:index` |
| Add a UI filter | `src/lib/dataset.ts` (`filterItems`) + `src/App.vue` |

## Running things

```bash
npm run data:sync -- --dry-run       # fetch and classify, write nothing
npm run data:sync -- --budget 500    # cap the spend
npm run data:sync -- --no-search     # refresh known channels only
npm run data:sync -- --keyword "…"   # run one discovery query
npm run data:index                   # rebuild the search index
npm run data:validate                # structure + budgets
npm run data:import-legacy           # migrate the old SQLite database
```

## Skills

Task-specific instructions live in `.opencode/skills/`:

| Skill | Use it when |
| --- | --- |
| `sync-dataset` | Running, debugging or extending the sync pipeline |
| `curate-data` | Fixing classifications, adding seeds, editing overrides |
| `search-index` | Changing tokenisation, ranking or the index format |
| `add-platform` | Adding a platform adapter |
| `web-ui` | Building or changing views, filters or the theme |

Load one with the `skill` tool, e.g. `skill({ id: "sync-dataset" })`.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/REQUIREMENTS.md` | The original brief, with status markers |
| `docs/ARCHITECTURE.md` | How the pieces fit together |
| `docs/DATA-SCHEMA.md` | Every field, every file, every enum |
| `docs/YOUTUBE-API.md` | Quota maths and endpoint costs |
| `docs/PLATFORMS.md` | The five platform adapters |
| `docs/DEPLOY.md` | GitHub Actions, Pages, secrets, LFS |
| `docs/CONTRIBUTING.md` | How to add a channel, a region, a platform |

## External data sources

| Source | URL | Used for |
| --- | --- | --- |
| YouTube Data API v3 | `developers.google.com/youtube/v3` | The primary dataset |
| AiSList | `github.com/Override92/AiSList` | Which channels are AI-generated |
| VTuber Music Dataset | `github.com/meihei3/VTuber-music-dataset` | Curated song and original-artist metadata |
| Virtual YouTuber Wiki | `virtualyoutuber.fandom.com/api.php` | Debut dates, graduation dates, wiki identities |
| Bilibili | `api.bilibili.com` | Chinese VTuber channels |
| Niconico | `api.search.nicovideo.jp/api/v2` | Japanese original songs and covers |
| VK | `api.vk.com/method` | Russian VTuber channels |

Reference sites worth looking at:
[holodex.net](https://holodex.net) ·
[music.holodex.net](https://music.holodex.net) ·
[taiwanvtuberdata.github.io](https://taiwanvtuberdata.github.io/) ·
[vdb.vtbs.moe](https://vdb.vtbs.moe)
