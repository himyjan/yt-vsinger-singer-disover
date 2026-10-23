---
name: Curate Data
description: Fix misclassified channels, add curated seeds, edit overrides, and improve the virtual/real, region, gender and AI classifiers
---

# Curate the dataset

Most contributions are corrections, not new code. A channel is misclassified;
you fix it.

## Decide which fix is right

| Situation | Fix |
| --- | --- |
| One specific channel is wrong | `data/overrides.json` |
| A whole class of channels is wrong (a marker misfires) | `scripts/lib/classify.ts` |
| A channel should definitely be tracked | `data/seed-catalog.json` |
| A channel should not be tracked at all | `data/overrides.json` → `"hidden": true` |

## The overrides file

`data/overrides.json` maps a channel id to a correction:

```jsonc
{
  "UCxxxxxxxxxxxxxxxxxxxxxx": {
    "kind": "real",
    "role": "singer",
    "region": "jp",
    "agency": "nijisanji",
    "isSinging": true
  },
  "UCyyyyyyyyyyyyyyyyyyyyyy": { "hidden": true }
}
```

| Key | Values |
| --- | --- |
| `kind` | `virtual` \| `real` |
| `role` | `vtuber` \| `vsinger` \| `singer` \| `musician` \| `producer` \| `composer` \| `unknown` |
| `region` | `jp` \| `cn` \| `tw` \| `hk` \| `kr` \| `en` \| `id` \| `my` \| `sea` \| `unknown` |
| `agency` | any string, or `null` |
| `isSinging` | boolean |
| `hidden` | `true` removes it from the published dataset |

Apply them:

```bash
npm run data:sync -- --no-search
npm run data:index
npm run data:validate
```

`--no-search` is important: it refreshes known channels for 1 unit each
instead of spending 100 on a discovery sweep.

## The classifier

`scripts/lib/classify.ts`. It is **deterministic** — no randomness, no network
calls — so the same input always produces the same record. Keep it that way.

### The marker tiers

```ts
const VIRTUAL_STRONG = [...];   // "vtuber", "hololive", "vsinger" …
const VIRTUAL_WEAK   = [...];   // "live2d", "uber", "oshis" …
const REAL_STRONG    = [...];   // "singer-songwriter", "ボカロp", "composer" …
const REAL_WEAK      = [...];   // "singer", "歌手", "musician" …
const AGGREGATOR_MARKERS = [...];
const SINGING_MARKERS    = [...];
const ACOUSTIC_MARKERS   = [...];  // 弾き語り / 彈唱 / acoustic
```

**Strong markers outweigh weak ones.** A channel that says "Vocaloid producer
and virtual singer" is a *producer*: the strong real marker wins over the
weak virtual one.

### The weighting

The channel name is weighted highest (3×) — it is what the performer chose to
be known by. The opening of the description (2×) is the identity line, where
channels write "VTuber / VSinger / Illustrator". The rest of the description
(1×) is noise.

This matters. An earlier version aggregated upload titles into a pseudo
description, which made nearly every channel match `#vsinger` and classified
everything as virtual with high confidence. **Do not feed upload titles into
the kind decision.**

Upload titles are useful for one thing only: **locale hints**. Pass a short
sample as `localeHints` so that a kanji-only name can be disambiguated
(「歌枠」 → Japan, 「翻唱」 → China).

### The fields it decides

| Field | Notes |
| --- | --- |
| `kind` | virtual vs. real |
| `role` | vtuber / vsinger / singer / musician / producer / composer |
| `region` | agency → published country → kana in the name → explicit markers → platform prior → script detection → locale hints |
| `gender` | explicit self-description first, honorifics only as a fallback |
| `isAi` | heuristics; the AiSList overrides it |
| `category` | cover / mv / original / live / premiere / performance |
| `isAcoustic` | a **flag**, not a category, so acoustic covers stay in the cover bucket |
| `variant` | the combined label: `female_vtuber`, `ai_vsinger`, … |
| `activity` | active / preparing / graduated / unknown — an unnegated graduation marker in the **name or the description** wins over anything a roster says |

### The region is never decided by a link

`detectStrongRegion()` looks for explicit statements — 「台灣」, 「香港」,
「한국」, 「にじさんじ」. It deliberately does **not** look for "bilibili":
a Japanese channel that cross-posts to Bilibili lists
`space.bilibili.com/…` in its description, and reading that as "this
performer is Chinese" is how Japanese channels ended up in `cn`. Only a
channel that exists **only** on Bilibili gets the platform prior, and the
country from YouTube's about page outranks it.

Kana count as evidence only when there are **two** of them: a single の or
め in an otherwise Chinese name is a stylisation (「猫の神様」), not a
Japanese name.

A region is re-read for every record on every sync, but only a more trusted
source replaces a less trusted one. To do the networked half — the country
and the name in the channel's own language:

```bash
npm run data:details -- --weak-region --limit 500
```

It selects the YouTube records whose `regionSource` is `declared`, `script`
or `unknown`, re-reads the region, and re-fetches the profile in the new
region's language (so 「向葵 / あおい」 replaces `Aoi / Vtuber`, which becomes
an alias).

### A graduation is a phrase, not a word

`GRADUATED_MARKERS` in `scripts/lib/classify.ts` is matched against the name
*and* the description, with the inflections the scene actually writes — not
only the dictionary form:

- Japanese: 「卒業」, 「活動終了」, 「活動を終了しました」, 「活動終えました」,
  「活動休止」, 「最終配信」, 「配信終了」;
- Chinese: 「已畢業」, 「已停播」, 「停止活動」/「停止活动」, 「活动终了」;
- English, Korean and Russian as well.

A channel that says it has retired is graduated even if a tracker still lists
it as `active`: `mergeActivity()` never downgrades a graduation.

But the marker must not be **negated**. 「不會畢業」, 「不畢業」 and 「永不毕业」
contain 「畢業」; 「卒業しません」 contains 「卒業」; 「은퇴하지 않습니다」
contains 「은퇴」; «не закрыт» contains «закрыт»; "not graduated" contains
"graduated". `detectActivity()` checks the occurrence in its own clause, with
that language's negators. It is per occurrence: 「不會畢業，但已畢業」 still
counts the second, positive clause. A negator far away in another clause does
not cancel a real marker, so 「我不會後悔畢業」 stays graduated.

### Aggregators are not performers

A channel that compiles other people's content (`… Subs`, `… Clips`,
`Hololive clipper`, `まとめ`) must not be classified as a performer. It gets
`role: "unknown"` and `isSinging: false`.

## The AI list

`scripts/lib/aislist.ts` fetches the community-maintained
[AiSList](https://github.com/Override92/AiSList):

- `aislist_blocklist.txt` — high confidence;
- `aislist_warnlist.txt` — medium confidence.

Both are plain text, one `@handle` or `UC…` id per line. A channel on either
list gets `isAi: true` and `confidence: 1`, which **overrides** the
heuristic. The heuristic in `classify.ts` is only the fallback.

## The curated seed list

`data/seed-catalog.json` is the highest-precedence source for curated channel
classification. Records keep `source: "seed"` as provenance; do not add a
`confidence` value.

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

Handles that cannot be resolved are skipped silently, so a typo never breaks
a run. The file is split into `VIRTUAL_JP`, `VIRTUAL_EN`, `VIRTUAL_ID`,
`VIRTUAL_CN` and `REAL_ARTISTS` — the real dataset is kept separate on
purpose.

## Song metadata

`scripts/lib/music-dataset.ts` fetches the
[VTuber Music Dataset](https://github.com/meihei3/VTuber-music-dataset), which
states the **song** and the **original artist** for each cover. That is
authoritative, so it overrides the heuristic extraction in
`extractSongInfo()`.

The heuristic is still needed for everything the dataset does not cover.

## Checking your work

```bash
npm run data:sync -- --no-search
npm run data:index
npm run data:validate
```

Then inspect the result:

```bash
npx tsx -e "
import { readFileSync } from 'node:fs';
const all = [...JSON.parse(readFileSync('data/channels/virtual.json','utf8')).channels,
             ...JSON.parse(readFileSync('data/channels/real.json','utf8')).channels];
const byRegion = {};
for (const c of all) (byRegion[c.region] ??= []).push(c);
for (const [r, list] of Object.entries(byRegion)) {
  console.log(r, list.length);
  console.log(list.slice(0, 8).map((c: any) => '   ' + c.name + ' [' + c.variant + ']').join('\n'));
}
"
```

## After a classifier change

A classifier fix changes many records at once. Always:

1. run the sync and the index;
2. run `npm run data:validate`;
3. **look at the diff** — `git diff --stat data/` tells you how many records
   moved;
4. commit the regenerated `data/` in the same commit, so the diff is
   reviewable.
