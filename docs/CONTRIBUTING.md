# Contributing

> How to add a channel, a region, a platform, or fix a misclassification.

## Setup

```bash
npm install
cp .env.example .env      # YOUTUBE_API_KEY is optional
```

Useful commands:

```bash
npm run dev               # Express dev server (SQLite-backed, legacy)
npm run dev:web           # Vite dev server (static dataset)
npm run build             # prepare the dataset and build for production
npm run lint              # vue-tsc type check

npm run data:sync         # refresh with InnerTube; API features are optional
npm run data:sync -- --shard 2/4   # one deterministic slice of the rotation
npm run data:index        # rebuild the inverted search index
npm run data:validate     # check the dataset (runs in CI)
npm run data:all          # all three in order
```

## Fixing a misclassification

This is the most common contribution, and it does not need any code.

### The automatic way

`data/overrides.json` maps a channel id to a correction:

```jsonc
{
  "UCxxxxxxxxxxxxxxxxxxxxxx": {
    "kind": "real",
    "role": "singer",
    "region": "jp",
    "agency": "nijisanji",
    "isSinging": true
  }
}
```

| Key | Values |
| --- | --- |
| `kind` | `virtual` \| `real` |
| `role` | `vtuber` \| `vsinger` \| `singer` \| `musician` \| `producer` \| `composer` \| `unknown` |
| `region` | `jp` \| `cn` \| `tw` \| `hk` \| `kr` \| `en` \| `id` \| `my` \| `sea` \| `unknown` |
| `agency` | any string, or `null` |
| `isSinging` | boolean |
| `reincarnationOf` | the previous persona's channel id — written on the **newer** record only; the drawer derives the reverse link |
| `hidden` | `true` removes the channel from the published dataset |

Then:

```bash
npm run data:reclassify -- --apply   # re-derive kind/role with the override applied
npm run data:index
npm run data:validate
```

`data:reclassify` needs no network and is the fastest way to see the effect:
`--explain <id or name>` prints the record's claim and what the classifier
makes of it.

### The permanent way

If the classifier itself is wrong — a marker that misfires, or a pattern that
is not covered — fix it in `scripts/lib/classify.ts` instead. The classifier
is deterministic, so a fix there applies to every future record.

Markers live in named lists at the top of the file:

```ts
const VIRTUAL_STRONG = [...];
const VIRTUAL_WEAK   = [...];
const REAL_STRONG    = [...];
const REAL_WEAK      = [...];
const AGGREGATOR_MARKERS = [...];
const SINGING_MARKERS    = [...];
const ACOUSTIC_MARKERS   = [...];
```

**Strong markers outweigh weak ones.** A channel describing itself as
"Vocaloid producer and virtual singer" is a *producer* — the strong real
marker wins over the weak virtual one.

## Adding a channel to the curated catalog

`data/seed-catalog.json` holds the hand-verified starting catalog. It is the
highest-precedence source during sync. Use a canonical YouTube `channelId`
when known; otherwise use a `handle`, which sync resolves to the immutable
channel id before writing a channel record.

```json
{
  "handle": "somehandle",
  "name": "Display Name",
  "kind": "virtual",
  "role": "vsinger",
  "region": "jp",
  "agency": "hololive",
  "isSinging": true
}
```

The catalog is validated when the sync pipeline loads it. A handle that
cannot be resolved does not become a channel record.

Curated seeds are an explicit admission path. Automatic discovery is stricter:
non-YouTube adapters only accept identities already present in vdb, the
dataset, or the seed catalog. YouTube can add a new virtual channel only when
at least two distinct videos each contain both virtual-creator identity and
singing evidence in their available titles, descriptions, or tags. Add a
verified channel to `data/seed-catalog.json` when it should not depend on
automated discovery.

## Adding a region

1. Add the code to `RegionCode` in `scripts/lib/types.ts`.
2. Add its metadata (label, badge, languages) to `REGION_META` in
   `scripts/lib/regions.ts`.
3. Add the ISO country → region mapping to `COUNTRY_REGION`.
4. Add locale tokens to `LOCALE_TOKENS` if the language needs disambiguating.
5. Add discovery keywords to `REGION_KEYWORDS` and to
   `config/sync.config.json`.

The region then appears automatically in the region filter, the manifest and
the dataset layout.

## Adding a platform

See `docs/PLATFORMS.md` for the full checklist. In short:

1. Write `scripts/lib/platforms/<name>.ts` implementing `PlatformAdapter`.
2. Register it in `scripts/lib/platform-registry.ts`.
3. Add the platform to `PlatformId` in `scripts/lib/types.ts`.
4. Add its label and colour to `PLATFORM_URLS` / `PLATFORM_META` in
   `scripts/lib/platforms.ts` and `src/lib/links.ts`.
5. Add discovery keywords to `config/platform-keywords.json`.

## Adding a roster

A roster is a directory that lists performers rather than a platform that hosts
them — vdb, bacharu, vtuber.hk, HoloList, vTubie's groups. The pattern is the
same every time, and it keeps the network out of the writing path:

1. **A parser** in `scripts/lib/<name>.ts`: the site's page or JSON → a plain
   entry (name, ids, links, region hints), with no network call in it.
2. **A harvester** `scripts/harvest-<name>.ts` that writes `.cache/<name>.json`
   and one file per row, so a pass resumes and a second pass is incremental
   (HoloList uses its sitemap's `<lastmod>`).
3. **A gated importer** `scripts/import-<name>.ts` that reports what would
   change and writes nothing without `--apply`, then calls
   `importYouTubeChannels()` with `rosterIds` and a `RosterHint`.
4. A row in `docs/SOURCES.md` with what the roster states and what it does
   not, and a line in `scripts/lib/sources.ts`.

A roster supplies the **claim** and the facts the platform does not publish —
the agency, the languages, the debut date, the retirement state — never the
name, and the fan tests (`detectClipAccount()`, `isFanAccountName()`) still
run.

## Adding a discovery source

`scripts/lib/debut-sources/types.ts` defines the interface:

```ts
export interface DebutSource {
  id: string;
  label: string;
  isConfigured(): boolean;
  unavailableReason(): string | null;
  fetch(since: string | null): Promise<Candidate[]>;
}
```

A source must degrade gracefully — return an empty array rather than throwing
when its API is unreachable.

Two sources exist: `fandom.ts` (the Virtual YouTuber Wiki's MediaWiki API) and
`vtubie.ts` (the vTubie directory, read through `puppeteer-core` because the
pages sit behind a Cloudflare challenge and there is no API). Run them with:

```bash
npm run data:discover                      # vTubie, 20 directory pages
npm run data:discover -- --source all      # every source
npm run data:discover -- --pages 200 --promote
npm run data:discover -- --dry-run         # report, write nothing
```

Candidates are merged into `data/identities.json`. `--promote` also resolves
those names to YouTube channels and adds the ones that pass the two-video
virtual-and-singing gate to `data/channels/`. The gate itself lives in
`scripts/lib/discovery-evidence.ts` and is shared with the sync — extend the
terms there, once, rather than in a second copy.

## Changing the search index

`scripts/lib/search.ts` holds the tokenizer and the query engine, and is
shared by the builder and the browser. If you change it, rebuild the index:

```bash
npm run data:index
```

### Tokenisation

- Latin and numeric runs become one token each.
- CJK runs become overlapping **bigrams** — `歌い手` → `歌い` + `い手`. This is
  what makes Japanese and Chinese searchable without a dictionary segmenter.
- Everything is NFKC-normalised and lower-cased first, so full-width and
  half-width forms collapse together.

### Scoring

Each matched query token contributes its IDF, so rare tokens rank higher.
Ties break on recency.

## Adding an item category

1. Add the value to `ItemCategory` in `scripts/lib/types.ts`.
2. Add its markers to the right list in `scripts/lib/classify.ts`.
3. Add a chip to `CATEGORIES` in `src/App.vue`.
4. Rebuild: `npm run data:sync -- --no-search && npm run data:index`.

## Data conventions

- **Deterministic output.** The classifier has no randomness and no network
  calls, so the same input always produces the same record. This keeps the
  git history of `data/` readable.
- **Stable ordering.** Records are sorted by id before writing.
- **ISO timestamps.** Always `YYYY-MM-DDTHH:mm:ss.sssZ`.
- **Preserve `addedAt`.** A refresh must not reset when a record was first
  seen — `mergeById()` in `scripts/lib/io.ts` handles this.
- **Preserve provenance.** `source: "seed"` and `source: "manual"` survive
  an API refresh.
- **A `data/` commit is not reviewable in the web UI.** GitHub truncates a
  diff over 300 files or 1 MB of raw diff, and a refresh touches more than
  that. Review the shape instead: `git diff --stat`, the counts
  `data:reclassify` prints, and `npm run data:validate`.
- **`data/` history is squashed monthly.** A commit older than a month may
  vanish in a rewrite, so do not base work on `git log -p data/` alone — the
  records carry `addedAt`, `source`, the aliases and `verification`, which is
  what a commit would have told you. The tree itself is never lost.

## The size budget

Three different ceilings apply, and only the first is enforced by the dataset
itself:

| What | Ceiling | Where |
| --- | --- | --- |
| one file | 8 MB | `SIZE_BUDGET.maxFileBytes`, on write |
| the tree | 180 MB | `SIZE_BUDGET.maxDataBytes`, in `data:validate` |
| the published site | 1 GB | `prepare:public` warns at 75 %, fails above |
| the stored history | 900 MB | `repo:size --max-mb 900` in the sync |

The history is bounded by policy, not by a constant: a monthly squash folds it
back to one snapshot, and a catalogue that no squash can keep under 700 MB is
split into **volumes** — `npm run data:volumes -- --dry-run` plans it,
`--count N` writes the trees under `.volumes/`, and `--verify .volumes` proves
no record was duplicated, omitted or filed under the wrong volume. See
[DEPLOY.md](DEPLOY.md#the-capacity-ladder).

If a change makes the dataset grow, add a retention rule or a new volume — do
not raise a budget.

## Pull requests

1. `npm run data:validate` must pass.
2. `npm run lint` must pass.
3. `npm run build` must pass.
4. If you changed the dataset, include the regenerated `data/` in the same
   commit so the diff is reviewable.
5. If you changed the classifier, say which records changed and why — the
   diff in `data/` is the evidence.

## Code style

- TypeScript, strict.
- Comments explain **why**, not **what**. If a heuristic looks arbitrary, say
  what it was tuned against.
- No new runtime dependencies in the pipeline — it must stay runnable in
  GitHub Actions with plain Node.
