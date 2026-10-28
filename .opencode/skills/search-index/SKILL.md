---
name: Search Index
description: How the inverted search index works — tokenisation, CJK bigrams, prefix matching, IDF ranking — and how to change or debug it
---

# The search index

Search is client-side and instant. The dataset ships an inverted index per
region; the browser answers a query with a few binary searches.

## The format

`data/search/<region>.json` — and, when a region outgrows
`SIZE_BUDGET.maxSearchPackBytes` (4 MB), `data/search/<region>.<n>.json` for
the rest. Every pack is a complete inverted index over its own slice; the
browser loads them together and `searchPacks()` merges the hits across packs
exactly as it does across regions. `manifest.json` gives each pack its `shard`
number.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-21T12:00:00.000Z",
  "region": "jp",
  "count": 1535,
  "tokens":  ["000", "05", "1.15", "…", "歌い", "…"],  // SORTED, unique
  "postings": [[12], [3, 7], [900], […]],              // parallel to tokens
  "idf":     [6.64, 7.33, 7.33, 4.1, 8.2, 6.1],       // parallel to tokens
  "entries": [{ "k": "i", "id": "…", "n": "…", … }]
}
```

`tokens`, `postings` and `idf` are **parallel arrays**. The token list must
stay sorted — the query engine binary-searches it. `scripts/validate.ts`
checks both properties and fails CI if they break.

## Tokenisation

`tokenize()` in `scripts/lib/search.ts` — shared by the builder and the
browser, so there is exactly one implementation.

- Latin and numeric runs become one token each (`hololive`).
- CJK runs become overlapping **bigrams**: `歌い手` → `歌い` + `い手`.
- Everything is NFKC-normalised and lower-cased first, so full-width and
  half-width forms collapse together.

**Why bigrams?** Japanese and Chinese are not space-delimited. Whitespace
tokenisation would index `歌い手` as one enormous token that no prefix search
could ever match. Bigrams make substring queries work without a dictionary
segmenter.

## The query

`searchPacks(packs, query, options)`:

1. tokenise the query the same way;
2. for each query token, binary-search the sorted array for its **prefix
   range** — this is what makes `holo` match `hololive`;
3. union the posting lists, weighting each entry by the highest IDF in the
   range;
4. filter by kind, region, category, gender and AI;
5. sort by score, then by recency.

`prefixRange()` is the core primitive:

```ts
prefixRange(tokens, "holo")  // → { start, end } over the sorted array
```

## Scoring

`idf = log(1 + N / df)`. Rare tokens score higher, so a query for `kizuna`
ranks that channel above a channel whose description happens to contain
`kizuna` once among forty other words.

Ties break on `ts` — the relevant timestamp — so recent content wins.

## Changing it

`scripts/lib/search.ts` is imported by **both** the builder and the browser,
through the `@shared/*` alias. Change it, then rebuild:

```bash
npm run data:index
npm run data:validate
```

### Adding a field to the search records

1. Add the field to `SearchEntryRecord` in `scripts/lib/search.ts` — use a
   **short key** (`d` for duration, `ac` for acoustic), because every byte is
   downloaded by the browser.
2. Populate it in `channelRecord()` / `itemRecord()` in
   `scripts/build-index.ts`.
3. Rebuild the index.

### Adding a filter

The search engine supports `kind`, `region`, `categories` and `status`. A new
filter needs:

1. a field on the entry (step above);
2. a check in `searchPacks()`;
3. an option on `SearchOptions`;
4. wiring in `src/lib/dataset.ts` → `search()`.

## Performance notes

**Do not put the search packs in Vue's `reactive()`.** They contain tens of
thousands of tokens and posting lists; a deep reactive proxy turns a lookup
into tens of thousands of proxy traps and the search took *seconds* instead of
milliseconds. The cache in `src/lib/dataset.ts` is a plain object for exactly
this reason.

## Debugging

```bash
npx tsx -e "
import { readFileSync } from 'node:fs';
import { searchPacks, queryTokens, prefixRange } from './scripts/lib/search';
const pack = JSON.parse(readFileSync('data/search/jp.json','utf8'));
console.log('tokens:', queryTokens('歌い手'));
const r = prefixRange(pack.tokens, '歌い');
console.log('range:', r, pack.tokens.slice(r.start, r.end));
console.log(searchPacks([pack], '歌い手', { limit: 5 }).map(h => h.entry.n));
"
```

In the browser, check that the pack was fetched at all:

```js
// DevTools console
performance.getEntriesByType('resource')
  .filter(r => r.name.includes('/data/search/'))
```

If a region 404s, it has no data — `data/search/manifest.json` lists the
regions that actually exist, and the app only requests those.

## Common problems

| Symptom | Cause |
| --- | --- |
| No results for a Japanese query | the CJK run was not tokenised as bigrams — check `queryTokens()` |
| Prefix search finds nothing | `tokens` is not sorted — `npm run data:index` |
| Results ignore a filter | the option is not forwarded from `src/lib/dataset.ts` |
| Search is slow | the packs ended up inside a `reactive()` object |
| A channel that is clearly in the dataset does not come up | the value is only in a **field that is not indexed** — a YouTube handle, a Bilibili mid, a description. Index the name, never the description. |
| Fewer results the narrower the query gets | the query matched a **context token** (a word nearly every record carries). `haystackFor()` once added the literal `channel`, so `channel` matched every record and `channel <name>` collapsed to the same 120 hits. A token that every record shares carries no information — do not add one. |
| `en.json` is written but only half the channels are findable | a region now has several packs (`en.json`, `en.1.json`, …). A reader that fetches only `<region>.json` sees only shard 0 — `loadSearchPack()` returns every shard, so use it. |
| A platform filter empties the list | the filter was applied *after* `search()` had already cut its results to a limit. Filter the whole result set: `src/App.vue` asks for 1,200 hits when a platform is selected. |
