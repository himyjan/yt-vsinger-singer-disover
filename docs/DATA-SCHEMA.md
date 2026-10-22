# Data schema

> Every field, every file, every enum. The TypeScript source of truth is
> `scripts/lib/types.ts` — this document explains what the fields *mean*.

## The file layout

```
data/
├── manifest.json               counts, region table, quota usage
├── overrides.json              manual corrections (input, not output)
├── identities.json             the de-duplication registry
├── channels/
│   ├── manifest.json           the region list, with the shard names
│   ├── summaries/<region>/<bucket>.json   ChannelSummary[] — list views
│   ├── regions/<region>/<bucket>.json      Channel[] — full records
│   ├── virtual/<region>/<bucket>.json      Channel[] — virtual dataset
│   └── real/<region>/<bucket>.json         Channel[] — real dataset
├── items/
│   ├── manifest.json           shard map and counts
│   ├── <region>/<bucket>.json  Item[] — sharded by region, then id bucket
│   ├── live.json               Item[] — live right now
│   └── upcoming.json           Item[] — scheduled streams and premieres
├── songs/
│   ├── manifest.json           totals by category and region
│   ├── index.json              SongRecord[] — the music-centric projection
│   ├── <region>.json           SongRecord[] — one region
│   └── categories/<c>.json     SongRecord[] — cover / mv / original / performance
└── search/
    ├── manifest.json           which regions have a pack
    └── <region>.json           SearchPack — the inverted index
```

Every channel dataset is sharded by **region and then by id bucket** (16
buckets). With a roster of more than 14,000 performers a single file would
overflow the per-file budget, and the browser would have to download the whole
catalogue to show one region. The manifests list the shards that exist, so
the browser never requests a file that is not there.

Every file has the same envelope:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-21T12:00:00.000Z",
  "channels": [ /* … */ ]      // or "items" / "songs" / "entries"
}
```

## `Channel`

The record for one performer.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | YouTube channel id (`UC…`), or `<platform>:<id>` for a performer who only exists elsewhere |
| `name` | string | Display name |
| `handle` | string \| null | `@handle` without the `@` |
| `kind` | `"virtual"` \| `"real"` | Virtual performer vs. real human artist |
| `role` | see below | What they do |
| `region` | see below | Where they belong |
| `language` | string \| null | BCP-47 tag detected from the description |
| `agency` | string \| null | `hololive`, `nijisanji`, `kmvs`, … |
| `avatar` | string \| null | Channel avatar |
| `banner` | string \| null | Channel banner |
| `description` | string \| null | Truncated to 1000 characters |
| `subscribers` | `CountRef` | See below |
| `videoCount` | number \| null | |
| `viewCount` | number \| null | |
| `uploadsPlaylistId` | string \| null | The `UU…` uploads playlist |
| `country` | string \| null | ISO-3166 alpha-2, from `brandingSettings` |
| `tags` | string[] | Declared keywords |
| `isSinging` | boolean | Publishes singing content |
| `gender` | `"female"` \| `"male"` \| `"unknown"` | Self-described |
| `isAi` | boolean | AI-generated performer (AI VTuber, AI singer) |
| `variant` | see below | The combined label |
| `confidence` | number | 0–1; `1` for curated records |
| `source` | `"api"` \| `"seed"` \| `"manual"` | Provenance |
| `addedAt` | string | ISO timestamp of first sighting |
| `updatedAt` | string | ISO timestamp of last refresh |
| `lastItemsFetchedAt` | string \| null | When the channel's uploads were last fetched — drives the rotation |
| `lastDetailsFetchedAt` | string \| null | When the channel's profile was last resolved — drives the rotation |
| `activity` | `"active"` \| `"preparing"` \| `"graduated"` \| `"unknown"` | Streaming status |
| `debutDate` | string \| null | ISO date of debut |
| `graduateDate` | string \| null | ISO date of graduation |
| `platforms` | `PlatformLink[]` | Every platform identity |
| `twitchId` | string \| null | |
| `twitchLogin` | string \| null | |
| `twitchFollowers` | `CountRef` | |
| `externals` | `Record<string, string>` | `x`, `instagram`, `tiktok`, `discord`, `spotify`, … |
| `popularVideoId` | string \| null | A representative upload |

### `CountRef`

A subscriber count is not a plain number, because YouTube *omits* the field
when a channel hides it — and hiding is common among VTubers. Modelling it as
`number | null` would make "hidden", "unknown" and "zero" indistinguishable.

```ts
type CountRef =
  | { tag: "has"; count: number }
  | { tag: "hidden" }
  | { tag: "no" };
```

This mirrors the pattern used by the reference `TaiwanVTuberTrackingDataJson`
API, which gets it right.

### `affiliation`

Most VTubers are independent; a large part belong to a commercial group. The
two are different facts and both are stored:

- `group` — an agency name is known. It is in `agency`.
- `independent` — the source says so positively: the Taiwan roster leaves the
  group column empty for a solo act, and a description that says 「个人势vup」,
  「個人勢」 or `independent` states it outright.
- `unknown` — the sources do not say. This is **not** the same as
  `independent`, and the UI never treats it as such.

The affiliation and the activity status are re-evaluated whenever a channel's
description is fetched, because a description is where a performer states both.

### Enums

**`role`** — what the performer does:

`vtuber` · `vsinger` · `singer` · `musician` · `producer` · `composer` ·
`unknown`

**`region`** — where they belong:

`jp` · `cn` · `tw` · `hk` · `kr` · `en` · `id` · `my` · `sea` · `unknown`

**`regionSource`** — which source decided the region. The region is inferred
from sources of very different quality, so the provenance is stored with it
and shown in the channel drawer.

| Source | Meaning | Reliability |
| --- | --- | --- |
| `override` | Curated by hand in `data/overrides.json` | certain |
| `roster` | The **Taiwan VTuber Tracking Data** nationality column | authoritative |
| `declared` | The performer listed their own language (vdb `name.default`) | authoritative |
| `platform` | The platform they are on — Bilibili → China, Niconico → Japan | strong |
| `country` | The channel's published country | strong |
| `agency` | Their agency's branch | strong |
| `script` | The characters in the name | a guess |
| `unknown` | | |

The platform rule matters more than it looks: a Chinese VTuber whose name is
written in characters shared with Japanese (「樱咲奈央」, 「川烈」) would
otherwise be filed in Japan. A performer who *only* exists on Bilibili is
mainland Chinese by definition, and one who only exists on Niconico is
Japanese.

The current split, with the provenance:

```
platform   9310   cn
declared    753   cn 212 · en 70 · jp 471
roster     4425   tw 3685 · hk 402 · my 197 · unknown 141
script        1   en 1
```

**`variant`** — the combined label, derived from `role` + `gender` + `isAi`:

`female_vtuber` · `male_vtuber` · `ai_vtuber` · `female_vsinger` ·
`male_vsinger` · `ai_vsinger` · `female_singer` · `male_singer` ·
`ai_singer` · `female_producer` · `ai_producer` · `vtuber` · `vsinger` ·
`singer` · `producer` · `composer` · `musician` · `unknown`

AI takes precedence over gender, because an AI performer has no meaningful
gender — "AI VTuber" is the more useful distinction.

## `Item`

One upload.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Video id or playlist id |
| `type` | `"video"` \| `"short"` \| `"live"` \| `"playlist"` | |
| `channelId` | string | |
| `channelName` | string | Denormalised for offline display |
| `channelKind` | `"virtual"` \| `"real"` | Denormalised |
| `region` | `RegionCode` | Denormalised |
| `gender` | `Gender` | Denormalised |
| `isAi` | boolean | Denormalised |
| `variant` | `Variant` | Denormalised |
| `title` | string | |
| `description` | string \| null | Truncated to 600 characters |
| `thumbnail` | string \| null | |
| `publishedAt` | string \| null | ISO timestamp |
| `scheduledStart` | string \| null | For upcoming streams and premieres |
| `actualStart` | string \| null | |
| `actualEnd` | string \| null | |
| `duration` | number \| null | Seconds |
| `status` | `"live"` \| `"upcoming"` \| `"past"` \| `"unknown"` | |
| `category` | see below | Singing-specific classification |
| `songTitle` | string \| null | The performed song |
| `originalArtist` | string \| null | Who performed it originally |
| `isCollab` | boolean | |
| `isAcoustic` | boolean | Singing while playing an instrument |
| `tags` | string[] | |
| `viewCount` | number \| null | |
| `likeCount` | number \| null | |
| `concurrentViewers` | number \| null | While live |
| `source` | `RecordSource` | |
| `addedAt` / `updatedAt` | string | ISO timestamps |

### `category`

| Value | Meaning | Detected from |
| --- | --- | --- |
| `cover` | A cover of someone else's song | `cover`, `歌ってみた`, `カバー`, `翻唱` |
| `mv` | A music video | `music video`, `mv`, `pv`, `mv版` |
| `original` | An original song | `original song`, `オリジナル曲`, `自作詞` |
| `live` | A live performance | `歌枠`, `ライブ`, `live`, `コンサート`, `カラオケ` |
| `premiere` | A scheduled premiere or upcoming stream | `status === "upcoming"` |
| `performance` | An instrumental or arranged performance | `performance`, `生演奏`, `unplugged` |
| `other` | A singing-channel upload we could not classify further | — |

`isAcoustic` is deliberately a **flag** and not a category: 弾き語り / 彈唱
uploads are usually covers as well, and filtering for "singing while playing
an instrument" must not remove them from the cover bucket.

## `SongRecord`

The music-centric projection — one record per performance, stored separately
in `data/songs/`. It is what "find every cover of this song" is answered
from.

| Field | Type |
| --- | --- |
| `id` | string |
| `channelId`, `channelName` | string |
| `channelKind` | `ArtistKind` |
| `region` | `RegionCode` |
| `variant`, `gender` | `Variant`, `Gender` |
| `isAi` | boolean |
| `title` | string |
| `songTitle` | string \| null |
| `originalArtist` | string \| null |
| `category` | `ItemCategory` |
| `isCollab`, `isAcoustic` | boolean |
| `publishedAt` | string \| null |
| `duration` | number \| null |
| `thumbnail` | string \| null |
| `viewCount` | number \| null |
| `url` | string |

## `SearchPack`

The inverted index for one region.

| Field | Type | Notes |
| --- | --- | --- |
| `region` | string | |
| `count` | number | Number of entries |
| `tokens` | string[] | **Sorted**, unique. Parallel to `postings` and `idf` |
| `postings` | number[][] | Ascending entry indices per token |
| `idf` | number[] | `log(1 + N / df)` per token |
| `entries` | `SearchEntryRecord[]` | Display-ready records |

`SearchEntryRecord` is deliberately compact — every byte is downloaded by the
browser:

| Key | Field |
| --- | --- |
| `k` | `"c"` (channel) or `"i"` (item) |
| `id` | channel / video / playlist id |
| `n` | display title |
| `g` | artist kind |
| `r` | region |
| `c` | category (items only) |
| `ts` | epoch ms of the relevant timestamp |
| `ch` | owning channel id |
| `cn` | channel name |
| `th` | thumbnail |
| `s` | song title |
| `o` | original artist |
| `sb` | subscriber count |
| `st` | live status |
| `d` | duration in seconds |
| `ac` | `1` when acoustic |
| `gd` | gender |
| `ai` | `1` when AI-generated |
| `vr` | variant |

## `IdentityRecord`

The de-duplication registry, in `data/identities.json`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Canonical id |
| `names` | string[] | Every name the performer is known by |
| `handles` | string[] | |
| `externals` | `Record<string, string[]>` | Platform handles |
| `wikiPages` | string[] | |
| `region` | `RegionCode` \| null | |
| `affiliation` | string \| null | |
| `debutDate` / `graduateDate` | string \| null | |
| `sources` | string[] | Which sources contributed |
| `firstSeen` / `updatedAt` | string | |
| `confidence` | number | 0–1 |

## `override.json`

Manual corrections, keyed by channel id. A file the humans edit.

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

`hidden: true` removes the channel from the published dataset entirely.

## Size budgets

Enforced by `scripts/lib/io.ts` (on write) and `scripts/validate.ts` (in CI).

| Budget | Value | Why |
| --- | --- | --- |
| `maxFileBytes` | 8 MB | No single file gets big enough to slow the app down |
| `maxDataBytes` | 180 MB | Comfortably inside GitHub Free's ~1 GB repository limit |
| `maxSearchIndexBytes` | 40 MB | |
| `maxLfsBytes` | 2 GB | GitHub's LFS per-file ceiling |

Retention rules keep the dataset inside those budgets: at most 30 items per
channel, items older than 365 days dropped, live and upcoming items always
kept, and signature uploads (covers, MVs, originals) kept preferentially.
