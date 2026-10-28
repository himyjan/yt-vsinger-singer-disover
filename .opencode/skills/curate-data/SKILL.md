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
| `agency` | any string, or `null` — `canonicalAgency()` folds every Hololive branch into `hololive` |
| `affiliation` | `independent` \| `community` \| `group` \| `unknown` |
| `tags` | string[] — merged into the record's tags (`["Fan Clip"]`) |
| `isSinging` | boolean |
| `hidden` | `true` — hide a fan channel or a duplicate from the published dataset without deleting it |

The file is **global**, and a split catalogue copies it rather than dividing
it: `npm run data:volumes` writes the whole `overrides.json` into every volume
it produces, because an override that hides a fan channel has to reach the
volume that would otherwise publish it. If you ever split by hand, copy it too.

Apply them:

```bash
npm run data:sync -- --no-search
npm run data:index
npm run data:validate
```

`--no-search` skips keyword searches, avoiding their 100-unit search cost.
Without a YouTube API key, the sync may still rebuild its roster; automatic
roster additions are limited to vdb, existing dataset identities, and curated
seeds. See the `sync-dataset` skill for the discovery admission rules.

A performer the Virtual YouTuber Wiki or the vTubie directory lists is a
*candidate*, not a record. `npm run data:discover` records the name in
`data/identities.json`; `--promote` adds the channel once two of its videos
show virtual-creator identity and singing evidence. That gate is the same one
the sync uses, so there is no second, looser path into `data/channels/`.

A **subscription group** is a curation too. A PocketTube backup is JSON of
group name → `UC…` ids, so a group called 「Vsinger」 (sung) or 「Vtuber」
(virtual) is the list owner's own statement about those channels. Write it to
`data/overrides.json` (`kind`, `isSinging`) before importing: the import path
and the sync both apply the file, so the next sync cannot infer the curation
away. One entry per id, with a `note` naming the group.

### A fan account is not a performer

A large share of the Chinese scene is **not** the artist: 搬运组, 字幕组,
切片/烤肉 channels, and accounts named after their subject —
「Petra的极地考察队」, 「Shu的香蕉种植园」. They are duplicates of the real
performer, filed under a second name.

`detectClipAccount()` in `classify.ts` finds them from the **name** and the
description, and `isFanAccountName()` handles the `X的Y` pattern (a tail that
is a place, a shop or a gag — 队, 室, 屋, 组). A performer's own
「初晴的小葵」 or their side account 「伊露夏的仓库」 is not a fan account;
the vocabularies in `classify.ts` record that difference.

Once such a channel is in the dataset, hide it:

```jsonc
"bilibili:190514": {
  "hidden": true,
  "note": "Fan account, not a performer: …"
}
```

`hidden: true` keeps it out of the dataset. Do not delete the record by hand —
the note is what makes the removal reviewable in the diff.

A curated `kind` **outranks** the fan-account test (`override.curated`): a
subscription group that files a clip channel under 「Vtuber」 is a person's
statement, and a name pattern is a guess.

## The classifier

`scripts/lib/classify.ts`. It is **deterministic** — no randomness, no network
calls — so the same input always produces the same record. Keep it that way.

### The marker tiers

```ts
const VIRTUAL_STRONG  = [...];  // "vtuber", "vtype", "virtual artist", "hololive" …
const VIRTUAL_WEAK    = [...];  // "live2d", "uber", "oshis" …
const REAL_STRONG     = [...];  // "singer-songwriter", "ボカロp", "composer" …
const REAL_WEAK       = [...];  // "singer", "歌手", "musician" …
const REAL_IDENTITY   = [...];  // "not a vtuber", "face reveal", "actual real person"
const VSINGER_ROLE    = [...];  // "vsinger", "virtual singer", "歌い手" — virtual only
const AGGREGATOR_MARKERS = [...];
const SINGING_MARKERS    = [...];
const ACOUSTIC_MARKERS   = [...];  // 弾き語り / 彈唱 / acoustic
```

**Strong markers outweigh weak ones — for the role.** A channel that says
"Vocaloid producer and virtual singer" is a *producer*.

**They do not decide `kind` on their own.** `singer`, `composer` and
`songwriter` are jobs a VTuber holds; 「resident Vtuber, Cosplayer, Guitarist,
Singer and Songwriter」 is not a human being. Only `REAL_IDENTITY` — a
statement about a body — overrules a virtual claim, and only the
`virtualClaim: "roster"` entry point is overrulable at all: a roster entry, a
curated `kind` and an override all outrank the word score.

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
| `kind` | virtual vs. real — a curated `kind`, then a roster's `virtualClaim`, then the text; see `docs/DATA-SCHEMA.md` → *How `kind` is decided* |
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

It selects the records whose `regionSource` is a **guess** — `declared`,
`script`, `unknown` and `platform` — re-derives the non-YouTube ones from
their own names without a request, and re-fetches the YouTube ones in the new
region's language (so 「向葵 / あおい」 replaces `Aoi / Vtuber`, which becomes
an alias).

A Bilibili-only record is the one that needs `npm run data:links`: it finds
the performer's YouTube/Twitch account from their own text, their X bio,
Wikidata or the optional `--web` search, and the YouTube channel's published
country then outranks the "only on Bilibili, so cn" prior. `country` (5) beats
`platform` (3) and loses to `agency` (6), `roster` (7) and `override` (8), so
running it never undoes curated work.

A link the pass found by **searching a name** is confirmed against the
record's display name only — never an alias. 「维多利亚」's alias `Victoria`
once matched the Canadian city's YouTube channel. Hand-written names in
`data/overrides.json` are safe from this entirely: `data:links` skips a record
with an overridden region.

Do **not** read vdb's `jp` name field as evidence: it holds kana readings of
Chinese names (「小卯」 → 「コウサギ」), and treating them as kana would re-file
thousands of Chinese performers as Japanese. Only the display name counts.

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

A classifier fix changes many records at once. The classifier reads only the
record, so the whole dataset can be re-derived without a single request:

```bash
npm run data:reclassify            # report: what would move, and why
npm run data:reclassify -- --apply # write it
npm run data:reclassify -- --explain "Some Name"   # one record, with its claim
npm run data:index
npm run data:validate
```

`reclassify` reads `data/overrides.json` and `source: "seed"` as the last
word, and the roster snapshots in `.cache/` as the claim — so a record the
roster named is judged the way its import judged it.

A catalogue-wide `--apply` rewrites every shard, which is about **20 MiB of
history in one commit** (a routine sync commit is ~0.3 MiB). Run one decisive
reclassify rather than five exploratory ones, and expect that commit to be one
of the biggest things in `git log` until the monthly squash folds it in.

Always:

1. run `data:reclassify` and read the report — the per-move counts, with
   `[roster|text,platform]`, say *why* each group moved;
2. run the index and `npm run data:validate`;
3. **look at the diff** — `git diff --stat data/` tells you how many records
   moved;
4. commit the regenerated `data/` in the same commit, so the diff is
   reviewable.
