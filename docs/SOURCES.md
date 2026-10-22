# Data sources

> Every source the project knows about, what it provides, and whether the
> pipeline actually reads it.

The registry lives in `scripts/lib/sources.ts` — this document is the prose
version of it. When a source is added, both are updated.

## The principle

The dataset is only as good as the sources behind it, and the sources are of
very different quality:

- Some are **authoritative** — a curated roster that publishes its own
  ground truth (the Taiwan VTuber track list's nationality column, Wikidata's
  YouTube channel id).
- Some are **descriptive** — an API that returns what a platform says about
  a channel.
- Some are **unusable** — a client-side JavaScript application with no
  machine-readable data, or one that blocks automated requests.

The project records where each fact came from. `Channel.source` says which
roster the record was built from; `Channel.regionSource` says which source
decided the region; `Channel.verification` says what was actually looked up.

## What the pipeline reads

### 1. YouTube Data API v3 — the primary source

`https://developers.google.com/youtube/v3`

Channels, uploads, live and upcoming streams, statistics, descriptions. The
free tier allows 10,000 units a day; the quota guard in
`scripts/lib/youtube.ts` refuses any call that would exceed it. See
`docs/YOUTUBE-API.md`.

### 2. vdb — the Virtual YouTuber Name List Database

`https://vdb.vtbs.moe/json/list.json`

~10,100 performers, each with their accounts on up to 35 platforms, their
group and the names they use in each language — `cn`, `jp`, `en` and
`extra`. It is the backbone of the roster: it is where most of the platform
identities come from.

Every locale name is kept as an alias, and the name the record *shows*
follows the region — a Japanese performer is listed as 「巫てんり」, not as
the Chinese rendition 「巫天翼」.

`name.default` is **not** a declaration of origin. It is the language the
catalogue displays, and vdb is a Chinese wiki: 「巫てんり / Kannagi Tenri」,
a Japanese VTuber with a Bilibili mirror, is listed with `default: "cn"`.
Taking that at face value put **163 performers in the wrong region** — 135
Japanese ones under China, and the Hololive EN members under China too.

The region is now settled in this order:

1. **`group_name`** — the agency branch. Hololive EN → `en`, VirtuaReal →
   `cn`, NIJISANJI → `jp`. 「安堂いなり」 is Chinese despite the Japanese
   name; she is VirtuaReal Link.
2. **The platform**, for a performer with a Bilibili account and no YouTube
   account.
3. **A Japanese name and a YouTube channel** — kana are decisive.
4. **`name.default`**, and finally the script of the name.

That order is *inside* vdb. Across the sources, a merge keeps the more
trusted answer — an override, then the Taiwan tracker's nationality, then a
published country, then an agency, then kana, then the platform, then vdb's
display language. The full ranking is in `docs/DATA-SCHEMA.md`.

The JSON has no avatar and no description — those come from the platform
APIs and from Wikipedia.

One account list can hold the same channel twice — `youtubeAt` with the
handle and `youtube` with the channel id — and the `youtube` value is
sometimes another handle, `KiichanYT` where a `UC…` id belongs. The better
identity wins (channel id over handle over anything else), so a performer is
not given two links to one channel and a `youtube.com/channel/KiichanYT`
that does not exist.

### 3. Taiwan VTuber Tracking Data

`https://taiwanvtuberdata.github.io/`

The authoritative region source. Its track list publishes YouTube and Twitch
ids, alias names, the nationality, the debut date, the graduation date and
the activity status for ~4,400 performers. The nationality column is the
single most valuable field in the whole project: it is a stated fact, where
every other region signal is an inference.

### 4. VocaDB

`https://vocadb.net`

The music database. Its artist records carry the platform links (YouTube
channel, Niconico user, X handle, official site) and its song catalogue is
the deepest public record of who sang what.

### 5. AiSList

`https://github.com/Override92/AiSList`

The community-maintained list of channels that use AI-generated content, split
into a high-confidence blocklist and a medium-confidence warnlist. It is the
authoritative source for the `isAi` flag — far better than a keyword
heuristic.

### 6. VTuber Music Dataset

`https://github.com/meihei3/VTuber-music-dataset`

States the **song** and the **original artist** for each cover, plus the
collaborating performers. That metadata cannot be reliably extracted from a
title, so the curated version overrides the heuristic extraction.

### 7. Wikidata

`https://query.wikidata.org/sparql`

Queried by the YouTube channel id (`P2397`). A hit is a **fact**: the id in
Wikidata either is the same performer or is not. The same query returns the
agency (`P463`), the gender (`P21`), the country (`P27`) and the inception
date (`P571`).

### 8. Wikipedia

`https://en.wikipedia.org/api/rest_v1/`

`GET /page/summary/{title}` returns a clean summary, a one-line description,
the lead paragraph, the infobox image and the Wikidata item id. It is the
source of the human-written descriptions and the verified avatars.

The text and the image are only used when the article is actually *about the
performer* — an article about someone who later became a VTuber often leads
with their pre-fame career, and its infobox image is a photograph of them.

### 9–13. The platform APIs

Bilibili, Niconico, Twitch and VK — see `docs/PLATFORMS.md`.

### The quota-free sources

The Data API's 10,000 units a day is a hard ceiling: the catalogue is
fourteen thousand channels, and at one unit per channel plus one per fifty
videos, a full refresh would take days of the allowance.

Each platform has an unofficial route that costs **nothing** — the same trade
InnerTube offers on YouTube:

| Platform | Official | Quota-free equivalent | Gives |
| --- | --- | --- | --- |
| YouTube | Data API v3 | **InnerTube** (`youtubei.js`) | description, avatar, subscribers, uploads, live |
| Twitch | Helix (client id **and** secret) | **GQL** (`gql.twitch.tv`) | description, avatar, followers, live |
| Bilibili | — | **WBI-signed public API** | description, avatar, followers, uploads, live |
| CHZZK | — | **the public API** | description, image, followers, live |
| KICK | — | **the public API** | description, image, followers, live |

**InnerTube** (`scripts/lib/youtubei.ts`) — the channel's *description* is the
richest field in the project: it is where a performer states their own
language, their agency and their links. It also gives the avatar, the
subscriber count and the upload list.

Two things about it are easy to miss, and both were wrong for a long time:

- **A channel publishes a title and a description per language.** The
  default answer is the English localization, which for a Japanese channel
  is an alias — `Aoi / Vtuber` for 「向葵 / あおい」. `profile(id, { lang })`
  asks in the language of the record's region, and the other localizations
  become aliases.
- **The about page is the only place the channel states its country.**
  `profile(id, { about: true })` reads it (`"country":"日本"`) and normalizes
  the localized label to an ISO code, because the country is the one region
  fact a mirror cannot corrupt.

**Twitch GQL** (`scripts/lib/twitch-gql.ts`) — the same GraphQL endpoint the
Twitch website itself uses. It needs only the **public web client id** that
every Twitch page ships with, so there is no secret to manage and no quota.

**Bilibili WBI** (`scripts/lib/platforms/bilibili.ts`) — Bilibili's equivalent
of InnerTube. Two pieces:
- the **visitor id** (`buvid3`), fetched once from `x/frontend/finger/spi` and
  sent as a cookie, which is what stops the risk-control system answering
  with HTTP 412;
- the **WBI signature**, computed from the two rotating key URLs — and the
  key file names must be taken *without their extensions*, or every signed
  request is rejected with `-412 request was banned`.

### Filling in the missing data

Most of the catalogue starts as a **name and a channel id** — the rosters give
identities, not pictures. The descriptions, avatars and follower counts come
from the platform APIs, one channel at a time, and that work is **cumulative**:
each run fills in a slice, and the filled-in data is committed.

The details pass sorts the channels so the ones missing the most visible
fields go first:

| Field | Where it comes from |
| --- | --- |
| the **description** | InnerTube (YouTube), GQL (Twitch), the Bilibili `card` endpoint, the CHZZK and KICK profile endpoints |
| the **avatar** | the same three sources |
| the **follower count** | InnerTube, GQL, `x/relation/stat` (Bilibili) |
| the **country** | YouTube's about page — the record's own statement of where it belongs |
| the **links** | the channel's own published links |

The free sources cost no quota, so the pass can afford to be generous — it is
limited by politeness rather than by the budget, and the adaptive limiter
keeps it that way. A channel that has been resolved once is not resolved
again until every channel has had a turn.

**The dataset is therefore a work in progress**: run the sync a few times and
the coverage climbs. The progress is visible in the summary:

```
channels 14500 · with an avatar 3356 · with a description 347
```

### Rate limiting

The free sources have no published quota, but they do push back. All three go
through `scripts/lib/rate-limit.ts`, which keeps a minimum gap between
requests, **doubles** it when a source answers with a rate-limit response,
and relaxes it again once the source has been quiet. Bilibili also needs the
visitor id, without which every request is treated as an attack.

**With no YouTube API key at all the pipeline still produces a complete
dataset** — the uploads come from InnerTube and the profiles from InnerTube
and Twitch GQL.

## What the pipeline cannot read

These are the well-known VTuber databases worth knowing about, and why they
are not in the pipeline.

| Source | Why not |
| --- | --- |
| [Virtual YouTuber Wiki](https://virtualyoutuber.fandom.com/) | The MediaWiki API works, and it is used by the debut discovery — but the roster is not wired in yet |
| [Hololist](https://hololist.net) | Agency-limited: Hololive only, so it adds little over vdb and the Taiwan tracker |
| [bacharu](https://bacharu.io) | A client-side Astro application with no public data endpoint |
| [Vtubie](https://vtubie.com) | Blocks automated requests |
| [AI VTuber DB](https://aivtuberdb.com) | Worth reading for the AI flag, but it publishes no machine-readable file |
| [PVC.moe](https://pvc.moe) | The data is only in the client bundle |
| [VTuber.hk](https://vtuber.hk) | Server-rendered, but with no documented data format |
| [Streams Charts](https://streamscharts.com/vtubers) | Blocks automated requests |
| [JustOneAPI](https://github.com/justoneapi/justoneapi-python) | A token-based proxy for the protected platforms — a paid service, so the free sources are preferred. Its generated resources are a useful catalogue of which endpoints exist |

If any of them publishes a JSON or CSV file, adding it is one adapter and
one line in the registry.

## Reference implementations consulted

These are read for **how** a platform's API is called, not for their data.

| Project | What it settled |
| --- | --- |
| [biliscope](https://github.com/gaogaotiantian/biliscope) | The WBI signature, the mixin key (file names **without** the `.jpg`), the fact that `web_location` is not required (PR #287), and the `w_webid` that `space/wbi/acc/info` wants |
| [youtubei.js](https://github.com/LuanRT/YouTube.js) | InnerTube: the profile, the upload grid, the live streams, and `navigation/resolve_url` for turning a `@handle` into a channel id |
| `gql.twitch.tv` | The GQL endpoint and the public web client id |

## Adding a source

1. Write the adapter — usually `scripts/lib/platforms/<name>.ts` for a
   platform, or `scripts/lib/sources/<name>.ts` for a roster.
2. Register it in `scripts/lib/sources.ts` with what it provides and whether
   it is read.
3. Wire it into `scripts/lib/roster.ts` (for a roster) or
   `scripts/sync.ts` (for a platform).
4. Add it to this document.

## The identity problem

Every source identifies a performer differently:

| Source | Identifier |
| --- | --- |
| YouTube | `UC…` channel id, or an `@handle` |
| vdb | A UUID, plus a list of platform accounts |
| Taiwan tracker | A YouTube channel id and a Twitch id |
| VocaDB | A numeric artist id, plus its web links |
| Wikidata | A `Q…` item, plus the `P2397` YouTube id |

`scripts/lib/identity.ts` keeps a registry of **identity keys** — a YouTube
channel id, a handle, a platform-native id — and merges records that share
one. Without it, a performer with accounts on three platforms appears three
times. The registry is committed, so the merges are stable and reviewable.
