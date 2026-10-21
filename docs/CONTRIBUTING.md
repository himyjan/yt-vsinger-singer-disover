# Contributing

> How to add a channel, a region, a platform, or fix a misclassification.

## Setup

```bash
npm install
cp .env.example .env      # add YOUTUBE_API_KEY
```

Useful commands:

```bash
npm run dev               # Express dev server (SQLite-backed, legacy)
npm run dev:web           # Vite dev server (static dataset)
npm run build             # prepare the dataset and build for production
npm run lint              # vue-tsc type check

npm run data:sync         # refresh the dataset from the platform APIs
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
| `hidden` | `true` removes the channel from the published dataset |

Then:

```bash
npm run data:sync -- --no-search   # re-apply the overrides
npm run data:index
npm run data:validate
```

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

## Adding a channel to the curated seed list

`scripts/lib/seeds.ts` holds the hand-verified starting catalogue. It is the
highest-precedence source, so a seeded record always has `confidence: 1`.

```ts
{
  handle: "somehandle",              // or channelId: "UC…"
  name: "Display Name",
  kind: "virtual",
  role: "vsinger",
  region: "jp",
  agency: "hololive",
  isSinging: true,
}
```

Handles that cannot be resolved are skipped silently, so a typo never breaks
a run.

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
