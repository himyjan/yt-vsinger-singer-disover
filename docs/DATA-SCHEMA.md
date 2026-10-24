# Data schema

> Every field, every file, every enum. The TypeScript source of truth is
> `scripts/lib/types.ts` — this document explains what the fields *mean*.

## The file layout

```
data/
├── manifest.json               counts, region table, quota usage
├── overrides.json              manual corrections (input, not output)
├── seed-catalog.json           curated starting records (input, not output)
├── suggestions.json            channels suggested for import (input, not output)
├── identities.json             the de-duplication registry
├── channels/
│   ├── manifest.json           the shard map, per kind and region
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

Historical platform analytics are intentionally stored outside this
repository in `himyjan/yt-vsinger-singer-disover-analytics`. Its
`data/index.json` lists available dates and `data/daily/YYYY-MM-DD.json`
contains platform/channel metric snapshots and top-content view counts. The
separate archive keeps unbounded history from exceeding this repository's
dataset size budget.

A channel is stored **once**, in `virtual/` or `real/` — the dataset of its
kind. The two are separate because the scope switch has to be served without
downloading both: `virtual` is 14,000 records, `real` is a handful.

There used to be four copies: `regions/` held every record and `summaries/`
held a light projection for the list views, beside the two datasets. Every
writer had to remember all of them, and one that forgot let them drift — a
details run corrected a name in `regions/` and the next sync, which reads
back through `virtual/`, put the old name back. The copies are gone:

- the **list** is a projection of the records (`toSummary()` in
  `scripts/lib/summary.ts`), built in the browser from the shards it has
  already fetched for the drawer — nothing to store, nothing to diverge;
- the **scope switch** picks `virtual/` or `real/`, which is what the
  manifest's per-kind shard lists are for.

`writeChannelShards()` in `scripts/lib/dataset.ts` is the only place that
writes the records, and it writes each one to exactly one dataset.

Every channel dataset is sharded by **region and then by id bucket** (16
buckets). With a roster of more than 14,000 performers a single file would
overflow the per-file budget, and the browser would have to download the whole
catalogue to show one region. The manifests list the shards that exist, so
the browser never requests a file that is not there.

`channels/manifest.json` is that list, kept per kind — a region can have a
`real` shard that no `virtual` file matches:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-22T…",
  "total": 14517,
  "regions": [
    {
      "code": "jp",
      "channels": 617,
      "virtual": { "channels": 616, "buckets": ["00", "03", …] },
      "real": { "channels": 1, "buckets": ["0a"] }
    }
  ]
}
```

The bucket for a record is a hash of its id (`bucketFor()`), so the same
channel always lands in the same file and a run only rewrites the shards it
changed.

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
| `id` | string | The **immutable** id of the primary platform: a YouTube `UC…` channel id, or `<platform>:<id>` elsewhere |
| `handle` | string \| null | `@handle` without the `@` — a name, not an identity |
| `name` | string | Display name |
| `nameSource` | `"manual"` \| `"platform"` \| `"seed"` \| `"roster"` \| `"unknown"` | Where the name came from — see below |
| `aliases` | string[] | The other names the performer is known by |
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
| `isOfficialArtist` | boolean? | The 🎵 **Official Artist Channel** badge. *Optional*: filled by the details pass and the local subscription badge sync; absent means "not asked yet", not "no" |
| `variant` | see below | The combined label |
| `verification` | `Verification \| null` | What was actually looked up, and where — see below |
| `confidence` | `ClassificationConfidence` | *Optional.* The confidence estimate — see below |
| `source` | `"api"` \| `"seed"` \| `"manual"` | Provenance |
| `addedAt` | string | ISO timestamp of first sighting |
| `updatedAt` | string | ISO timestamp of last refresh |
| `lastItemsFetchedAt` | string \| null | When the channel's uploads were last fetched — drives the rotation |
| `lastDetailsFetchedAt` | string \| null | When the channel's profile was last resolved — drives the rotation |
| `activity` | `"active"` \| `"preparing"` \| `"graduated"` \| `"unknown"` | Streaming status — one per performer, not one per platform |
| `debutDate` | string \| null | ISO date of debut |
| `graduateDate` | string \| null | ISO date of graduation |
| `platforms` | `PlatformLink[]` | Every platform identity |
| `twitchId` | string \| null | |
| `twitchLogin` | string \| null | |
| `twitchFollowers` | `CountRef` | |
| `externals` | `Record<string, string>` | `x`, `instagram`, `tiktok`, `discord`, `spotify`, … |
| `popularVideoId` | string \| null | A representative upload |

### `activity` — one per performer, not one per platform

Whether a performer has retired is a fact about the **performer**, not about
one account. A performer who has graduated has graduated on every platform,
so the record carries one `activity` and the platform links carry none.

It is set from three places, and a graduation always wins:

| Source | Example |
| --- | --- |
| A **name or a description** | 「已停播」, 「已畢業」, 「卒業」, 「活動終了」, 「活動を終了」, 「停止活動」, 「retired」, «закрыт» |
| A **roster** | the Taiwan tracker publishes `active` / `preparing` / `graduated` |
| **Recency** | no upload for a year |

The markers are multilingual, because the performers are — see
`GRADUATED_MARKERS` in `scripts/lib/classify.ts`. The Chinese ones matter
most here: 「已停播」 and 「已畢業」 are what the Chinese scene writes, and
neither contains the Japanese 「卒業」.

Both fields are searched, and a phrase is matched with its inflections, not
just its bare form: 「活動終了」 alone missed 「活動を終了しました」, which is how
a Japanese channel usually announces it, and 「停止活動」/「停止活动」 is the
Chinese way of saying the same thing (「目前停止活動中」, 「无限期停止活动」).

A marker is only evidence when it is **not negated**. 「不會畢業」, 「不畢業」
and 「永不毕业」 contain 「畢業」 but say the opposite, just as 「卒業しません」
contains 「卒業」, 「은퇴하지 않습니다」 contains 「은퇴」, «не закрыт» contains
«закрыт», and "not graduated" contains "graduated". `detectActivity()` checks
each occurrence in its own clause, with the negators of the language that
marker belongs to; a positive occurrence elsewhere in the description still
wins. It is not a whole-description veto: 「我不會後悔畢業」 and "I did not know
she graduated" remain graduations.

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

### `id` — an identity, not a name

The `id` is the one thing about a channel that does not change, and everything
else in the dataset points at it: the shards and their buckets, the items,
the search index, the de-duplication registry.

For YouTube that is the `UC…` channel id — the one in
`youtube.com/channel/UC…`. A `@handle` is **unique but renameable**: the
performer picks a new one and every `@old` link is dead, so a record keyed by
a handle points at nothing. The handle is stored in `handle`, beside the id,
and is updated from the profile whenever the details are fetched.

The other platforms have the same rule: a Twitch login changes on rename, so
the numeric user id is the identity; the login is the handle.

A record that some source published as a handle — vdb lists YouTube accounts
as `youtubeAt` — is re-keyed the first time its profile is fetched, which is
what `npm run data:details -- --normalize-ids` does in bulk.

An id that was built from a **link** carries the tab it was copied from:
`UC…/featured`, `UC…/videos`. That is not an id — YouTube resolves it to
nothing, so the record can never be enriched — and the same channel usually
exists beside it under the clean id. `canonicalizeChannelIds()` in
`scripts/lib/dedupe.ts` strips the tab and merges the pair; the sync runs it
when it loads the dataset and again before it writes, because the rosters and
the platform adapters can re-add a tab-carrying copy mid-run.

### `nameSource` and `aliases` — whose name is it?

A performer renames, and every source records the name it saw. The Taiwan
roster says 「克蕾雅」; the YouTube channel itself says 「シスター・クレア」.
Both are right, at different times.

So the record keeps **two** things:

- **`name`** — the name to display.
- **`nameSource`** — where that name came from.

And the names it is *not* showing are kept in **`aliases`**.

The order of trust is:

| `nameSource` | Meaning |
| --- | --- |
| `manual` | A human wrote it in `data/overrides.json`. The final word. |
| `platform` | The platform's own current name. **The primary source.** |
| `seed` | A hand-verified seed, but as old as the seed file. |
| `roster` | Whatever a public roster said when it was written. |
| `unknown` | Not known. |

The order matters. The **platform** is the primary source, because it is the
only one that knows the name *now*: a roster's name is frozen at the moment
the roster was written, and a performer who renamed keeps the old name until
the platform corrects it. A hand-written override outranks everything,
because that is an explicit decision to disagree with the platform — which
is exactly what is needed when the platform's answer is a tombstone.

Two rules follow from it:

- **Only the record's own platform may rename it.** A Chinese Bilibili
  account must not rename a Japanese YouTube channel: the two names are
  different languages for the same performer.
- **A placeholder is not a name.** A deleted account still answers the
  profile endpoint, but with 「账号已注销」 instead of a name. That is
  rejected, and the record keeps the name it had.

#### A channel publishes more than one name

YouTube does not have *one* title for a channel: it has a **localization**
per language. The same channel answers

| `hl` | `title` |
| --- | --- |
| `en` | `Aoi / Vtuber` |
| `ja` | 「向葵 / あおい」 |
| `zh-TW` | 「向葵 / XiangKui」 |

so asking in the wrong language is how a Japanese channel ends up stored
under its English alias. The profile is therefore requested in the language
of the record's **region** (`jp` → `ja`, `cn` → `zh-CN`, `tw` → `zh-TW`,
`kr` → `ko`), and every other localization the record already had becomes an
**alias** — so `Aoi / Vtuber` still finds 「向葵 / あおい」.

When a region is corrected, the profile is fetched **again** in the new
language: the first answer was in the language of the old, wrong region.

Every rename is **recorded**: the old name goes into `aliases`, and the
aliases are indexed for search. A channel that renamed is still findable
under the name someone remembers.

A **Bilibili** record also indexes the name Bilibili gives its own account.
vdb files 「Tinsgoo-Project」 under Bilibili, where the account is called
「听世」; the display name is what the app shows, and the audience that found
the performer on Bilibili knows the other one. Only the record's **own**
platform may contribute that name — never another platform's, which is the
same rule the platform name follows everywhere else.

### `confidence` — the estimate

**Optional, and not populated by the current dataset.** The type allows it and
the shape is defined, but the sync does not write it — because a computed
number is a guess dressed up as a measurement, and the `verification` record
below says whether anyone actually checked.

The shape, when a producer does want to record an estimate:

| Axis | What it measures | `1` means |
| --- | --- | --- |
| `kind` | virtual or real | a source stated it |
| `region` | where the performer belongs | the roster or the performer stated it |
| `role` | what they do | a role marker matched |
| `gender` | self-described gender | the channel or agency stated it |
| `ai` | whether the performer is AI-generated | the AiSList listed it |
| `overall` | the weakest meaningful axis | curated by hand |

`overall` is `min(kind, region)`, because a record with the wrong region is in
the wrong place and a record with the wrong kind is in the wrong dataset. The
role, the gender and the AI flag are recorded but do **not** drag the record
down: a channel that never states its gender is still a perfectly good
record.

The values are coarse on purpose — `1` means a source stated it, `0` means
the source is silent, and the values in between mean it was inferred. A
number with three decimal places would look more precise than it is.

**What it is used for**, when it is present:

1. **Ordering the verification queue.** The records that are most uncertain
   are the ones worth looking up. The queue in `scripts/verify.ts` is
   actually ordered by *what is missing* — an unknown region, an unknown
   role, no description — which is a stricter and more useful signal than
   any score.
2. **Review in the UI.** The channel drawer names the uncertain axes, so a
   reader can see *which* field is shaky rather than just that something is.
3. **The merge.** When two records are merged, the stronger value wins per
   axis, so a curated field is never downgraded by an inferred one.

### `verification` — what was actually looked up

A computed confidence score is a guess. The verification record is not: it
says the record was **looked up**, by what, and what was found.

```jsonc
"verification": {
  "status": "verified",           // verified · conflicted · unverified
  "source": "wikidata",           // wikidata · wikipedia · web-search · manual
  "checked": ["affiliation", "gender", "region"],
  "at": "2026-10-22T09:14:00.000Z",
  "sources": ["https://www.wikidata.org/wiki/Q22128111"],
  "note": "Yua Mikami — affiliated with SKE48"
}
```

**The sources, in order of authority:**

1. **Wikidata**, queried by the YouTube channel id (`P2397`). A hit is a
   *fact*: the id in Wikidata either is the same performer or is not. The
   same query returns the agency (`P463`), the gender (`P21`), the country
   (`P27`) and the inception date (`P571`).
2. **Wikipedia**, through the [REST API](https://en.wikipedia.org/api/rest_v1/):
   `GET /page/summary/{title}` returns a clean summary, the one-line
   description, the infobox image and the Wikidata item id.
3. **A search-grounded model**, for the performers neither of the above
   covers.
4. **A human**, through `data/overrides.json`.

The Wikipedia text and image are only used when the article is actually
*about the performer*. An article about someone who later became a VTuber
often leads with their pre-fame career, and its infobox image is a photograph
of them — neither belongs on a VTuber record.

### Language code vs. region code

Two different standards, kept apart on purpose:

| | Standard | Japanese | Chinese (Simplified) | Korean |
| --- | --- | --- | --- | --- |
| `language` | ISO 639-1 | `ja` | `zh-Hans` | `ko` |
| `region` | ISO 3166-1 alpha-2 | `jp` | `cn` | `kr` |

`ja` is the language — it belongs in a `lang` attribute or a locale tag. `jp`
is the country — it belongs in a domain suffix or a country field. A Japanese
VTuber is `language: "ja"` and `region: "jp"`.

**The language follows the region, not the name.** A Taiwanese performer very
often has a Japanese-style stage name, and the kana in it says nothing about
the language they sing in. The region is the authoritative fact; the script of
a handle is a coincidence. Getting this wrong was not subtle: before the
region took precedence, **5,895 mainland Chinese channels were recorded as
Japanese** because their names used kana.

`languages` accepts **a single code or a list**. Performers usually stream in
more than one language, and the first entry is the primary one — but some
sources only ever name one, so both shapes are valid. Use
`toLanguageList()` (in `scripts/lib/regions.ts`) to read it either way:

```ts
const languages = toLanguageList(channel.languages);  // always a string[]
```

| Region | Languages |
| --- | --- |
| `jp` | `ja` |
| `cn` | `zh-Hans` |
| `tw` | `zh-Hant` |
| `hk` | **`yue`** — Cantonese, which is a separate language from written Mandarin |
| `kr` | `ko` |
| `en` | `en` |
| `id` / `my` | `id` / `ms` |

When a performer **states** their languages — 「主な配信言語: 広東語 / English」
— every language they name is kept, in the order they wrote them, and the
region no longer overrides it. That is a fact about themselves, and it
outranks anything inferred.

A mainland Chinese performer who is Cantonese-speaking (Guangzhou and the
Pearl River Delta) is detected from the markers 粵語 · 廣東話 · 廣州話 ·
`cantonese` in the description.

### `regionSource` — which source decided the region

The region is inferred from sources of very different quality, so the
provenance is stored with it.

| Source | Meaning | Reliability |
| --- | --- | --- |
| `override` | Curated by hand in `data/overrides.json` | certain |
| `roster` | The **Taiwan VTuber Tracking Data** nationality column | authoritative |
| `agency` | Their agency's branch | strong — the scene they perform in |
| `country` | The channel's published country | a stated fact |
| `name` | Kana in a Japanese name — they occur in Japanese and nowhere else | decisive for Japanese, still evidence |
| `platform` | The platform they are on — Bilibili → China, Niconico → Japan | a prior — a mirror breaks it |
| `declared` | The language vdb lists for display (`name.default`) | weak — a display choice, not an origin |
| `script` | The characters in the name | a guess |

The platform prior applies when the performer exists on **one** platform
only — a Bilibili account and nothing else. Their audience is mainland
Chinese, so that is their region. A performer who also has a YouTube or
Twitch account is presenting to a global audience, and their Bilibili account
does not decide where they are from.

**A mirror is not an origin.** A Japanese performer with a Bilibili channel
is Japanese, and the region records where the performer comes from, not
where each account is hosted. The order of authority:

1. **The agency branch.** vdb records the agency in `group_name`, and the
   branch is the strongest signal there is: a Hololive EN member is `en` and
   a VirtuaReal member is `cn`, whatever language their name is written in.
   「安堂いなり」 is Chinese — she is VirtuaReal Link — and
   「小鳥遊キアラ」 is English — she is Hololive EN.
2. **The channel's published country.** YouTube's about page states it —
   `"country":"日本"` — and it is the only region fact a mirror cannot
   corrupt. 「向葵 / あおい」 lists a Bilibili account and a Japanese
   description, and publishes Japan.
3. **A Japanese name.** Kana occur in Japanese and nowhere else, so a
   channel whose name contains them belongs to a Japanese performer —
   「巫てんり / Kannagi Tenri」, 「博衣こより」, 「獅白ぼたん」. Two kana, not
   one: a single の or め in an otherwise Chinese name is a stylisation
   (「猫の神様」, 「屁屁桃も」), not a Japanese name.
4. **The platform — but only as a prior.** A channel that exists *only* on
   Bilibili is probably mainland Chinese. A **link** to Bilibili is not a
   statement about origin, which is why the word "bilibili" is no longer a
   region marker: a Japanese channel that cross-posts lists
   `space.bilibili.com/…` in its description, and reading that as "this
   performer is Chinese" is how 49 Japanese channels ended up in `cn`.
5. **`name.default` is the weakest signal.** It is the language vdb
   *displays*, and vdb is a Chinese wiki: it lists 「巫てんり」 with
   `default: "cn"` because the Chinese rendition of the name
   (「巫天翼」) is the one it shows. A performer listed that way is not
   thereby Chinese.

When two records disagree, the region with the **more trusted source** wins,
and a tie goes to the fresher record:

| Order | Source | What it actually knows |
| --- | --- | --- |
| 1 | `override` | a human decided |
| 2 | `roster` | the Taiwan track list's nationality column |
| 3 | `agency` | the group's branch — Hololive EN, VirtuaReal |
| 4 | `country` | the channel's own published country |
| 5 | `name` | kana: Japanese, and nothing else |
| 6 | `platform` | where the account is hosted — a mirror breaks this |
| 7 | `declared` | the language vdb *displays* |
| 8 | `script` | a guess from shared characters |

An agency outranks a country because a branch is about the **scene**, not the
passport: a member of Hololive EN performs in English even if the channel's
about page says Japan. The country outranks kana because it is stated and
kana are evidence — which is why a Taiwanese performer with a Japanese stage
name stays `tw`.

`declared` sits that low because it is not a statement of origin: vdb is a
Chinese wiki, so 「巫てんり」 — a Japanese VTuber — is listed under the
Chinese rendition of her name. A record with no kana and no agency has
nothing better, but it never outranks a fact.

### `affiliation`

Most VTubers are independent; a large part belong to a commercial group. The
two are different facts and both are stored:

- `group` — an agency name is known. It is in `agency`.
- `independent` — the source says so positively: the Taiwan roster leaves the
  group column empty for a solo act, and a description that says 「个人势vup」,
  「個人勢」 or `independent` states it outright.
- `community` — 社團勢, a circle of fellow VTuber fans rather than a
  company: between the two.
- `unknown` — the sources do not say. This is **not** the same as
  `independent`, and the UI never treats it as such.

The three-way split comes from the Chinese VTuber scene's **camp** (勢)
vocabulary, where a performer's fan community is named after the kind of
performer they are: 個人勢 (individual), 企業勢 (corporate) and 社團勢
(community). The full glossary is in `scripts/lib/vtuber-glossary.ts`,
curated from the [Moegirl encyclopedia](https://zh.moegirl.org.cn/zh-tw/虚拟UP主用语与梗).

The affiliation and the activity status are re-evaluated whenever a channel's
description is fetched, because a description is where a performer states both.

### `agency` and 「〇〇所属」

An agency name is a fact, and the performer states it themselves far more
often than a roster records it. Every language has its own phrasing, and the
agency sits on the opposite side of the marker in each:

| Language | The line | What is read |
| --- | --- | --- |
| Japanese | 「にじさんじ所属」 · 「〇〇に所属」 | `agency: "nijisanji"` |
| Chinese | 「所属：彩虹社」 · 「隶属于〇〇」 · 「〇〇旗下」 | `agency: "nijisanji"` |
| Korean | 「니지산지 소속」 · 「소속：〇〇」 | `agency: "nijisanji"` |
| English | "affiliated with ○○" · "member of ○○" | `agency: "Nijisanji"` |

A stated agency sets `affiliation: "group"` in the same pass — the two fields
are one fact. The big agencies are canonicalised, so 「ホロライブ」, 「彩虹社」
and 「니지산지」 all become `hololive` / `nijisanji` and the grouping does not
split one agency across four spellings.

Two boundaries:

- **A否定 is not a name.** 「無所属」, 「无所属」 and 「非所属」 state the
  opposite, and they contain the marker, so they are checked first: the
  result is `affiliation: "independent"` and no agency.
- **The region is left alone.** 「ホロライブ所属」 names the group, not the
  branch — a Hololive EN member writes the same line — so an agency read out
  of a description never decides a region.

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
| `agency` | Their agency's branch | strong |
| `country` | The channel's published country | a stated fact |
| `name` | Kana in a Japanese name | evidence — decisive for Japanese, still evidence |
| `platform` | The platform they are on — Bilibili → China, Niconico → Japan | a prior — a mirror breaks it |
| `declared` | The language vdb lists for display (`name.default`) | weak — a display choice, not an origin |
| `script` | The characters in the name | a guess |
| `unknown` | | |

The order is the order of **what may override what**, and `REGION_TRUST` in
`scripts/lib/dedupe.ts` is the number behind it.

The platform rule matters more than it looks: a Chinese VTuber whose name is
written in characters shared with Japanese (「樱咲奈央」, 「川烈」) would
otherwise be filed in Japan. But a Bilibili *mirror* does not make a
Japanese performer Chinese — kana in the Japanese name and a YouTube channel
are the signals that keep them in `jp`. A performer who *only* exists on
Bilibili is mainland Chinese by default, and one who only exists on
Niconico is Japanese.

Two ways that prior is corrected, both understood by `data:links` and
`data:details --weak-region`:

- **Kana in the display name.** Two kana are a word, and they occur in
  Japanese and nowhere else. vdb's `jp` *field* does not count — it stores
  kana readings of Chinese names (「小卯」 → 「コウサギ」) — only the name the
  record displays.
- **The country of a discovered YouTube channel.** A performer whose Bilibili
  account is a mirror has a YouTube channel, and YouTube publishes its
  country. That is a stated fact, so it outranks the platform prior. It never
  overwrites an agency, a roster or an override.

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
| `id` | string | Platform-native video id or playlist id |
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

`playlist` items tagged `youtube-music` and `release` are albums or singles
read from an Official Artist Channel's YouTube Music Releases tab. They are
kept as playlists, not counted as individual song performances.

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
| `verification` | `Verification \| null` | What was looked up, and where — see above |

## `override.json`

Manual corrections, keyed by channel id. A file the humans edit.

```jsonc
{
  "UCxxxxxxxxxxxxxxxxxxxxxx": {
    "kind": "real",
    "role": "singer",
    "region": "jp",
    "agency": "nijisanji",
    "isSinging": true,
    "note": "Filipino VTuber — filed under SEA, not Japan"
  },
  "UCyyyyyyyyyyyyyyyyyyyyyy": { "hidden": true }
}
```

`hidden: true` removes the channel from the published dataset entirely.

`region` also sets `regionSource: "override"`, so the drawer shows that a
human decided it. `note` is not stored on the record — it is the reason,
kept for whoever reads the file next.

## `suggestions.json`

Channels suggested for import — an **input**, like `overrides.json`. A sync
never reads it; a suggestion becomes a record only when
`importYouTubeChannels()` resolves it and writes the shard.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-22T14:02:57.339Z",
  "suggestions": [
    {
      "platform": "youtube",
      "id": "UCqECaJ8Gagnn7YCbPEzWH6g",
      "name": "Taylor Swift",          // the suggester's label; the platform decides
      "url": "https://www.youtube.com/channel/UCqECaJ8Gagnn7YCbPEzWH6g",
      "kind": null,                     // optional hint, not a classification
      "note": null,
      "source": "subscription",         // "subscription" | "manual"
      "addedAt": "2026-10-22T14:02:57.320Z"
    }
  ]
}
```

A suggestion is unique per `platform:id`; `removeSuggestions()` rewrites the
file sorted by that key, so the diff stays stable. The local dev server writes
it (`POST /api/dataset/suggestions`,
`POST /api/dataset/suggestions/remove`); a static build keeps the same keys in
`localStorage` and can download the file.

The name is explicitly a **hint.** Importing fetches the profile and the
platform's name, region and classification win — a suggestion is a candidate,
never a record.

## Size budgets

Enforced by `scripts/lib/io.ts` (on write) and `scripts/validate.ts` (in CI).

| Budget | Value | Why |
| --- | --- | --- |
| `maxFileBytes` | 8 MB | No single file gets big enough to slow the app down |
| `maxDataBytes` | 180 MB | Comfortably inside GitHub Free's ~1 GB repository limit |
| `maxSearchIndexBytes` | 40 MB | |
| `maxLfsBytes` | 2 GB | GitHub's LFS per-file ceiling |

Retention rules keep the dataset inside those budgets: up to 30 routine items
per channel plus a preferential set of covers, MVs, originals and YouTube Music
releases; items older than 365 days are dropped except for live/upcoming items
and that preferential set.
