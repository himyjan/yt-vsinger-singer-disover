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

### 1. YouTube — the primary platform

`https://developers.google.com/youtube/v3`

YouTube is the primary platform. InnerTube (`youtubei.js`) is the primary
source for channel search, video search, handle resolution, channel profiles,
uploads, releases and the Live tab, and needs no API key or quota. The
optional YouTube Data API v3 adds richer video statistics and exact broadcast
timing, and is a fallback when InnerTube cannot retrieve a channel profile or
uploads. Its free tier allows 10,000 units a day; the quota guard in
`scripts/lib/youtube.ts` refuses any call that would exceed it. See
`docs/YOUTUBE-API.md` for the InnerTube/Data API split and quota details.

YouTube search discovers candidates; it does not by itself establish that a
channel belongs in the virtual catalogue. New YouTube records must have at
least two distinct videos that each contain both virtual-creator identity and
singing evidence in the available title, description, or tag metadata. A
channel already identified by vdb, the committed dataset, or a curated seed
does not need this admission check.

InnerTube also reads the channel's About-page country and dedicated Links
section. A published YouTube country outranks a platform-region prior; links
in the section are normalized into channel external links, including Bilibili,
YouTube videos and playlists.

### 2. vdb — the Virtual YouTuber Name List Database

`https://vdb.vtbs.moe/json/list.json`

~10,100 performers, each with their accounts on up to 35 platforms, their
group and the names they use in each language — `cn`, `jp`, `en` and
`extra`. It is the backbone of the roster: it is where most of the platform
identities come from. All valid account platform keys are retained, not just
the platforms with an API adapter in this project. The app's platform filter
therefore includes these additional roster identities too.

For keyword discovery, vdb is also an identity allowlist: non-YouTube platform
searches may refresh only identities already in vdb, the dataset, or the seed
catalog. When vdb is unavailable, new automatic discoveries fail closed;
existing and explicitly curated records continue to refresh.

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

This source enriches Taiwan, Hong Kong and Malaysia records; it is not the
only source of regional coverage. vdb and the other classification sources
provide global roster coverage.

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

`data:links` also searches Wikidata **by name** (`wbsearchentities` in
Japanese, Chinese and English) for a record that has no YouTube or Twitch
link. A name is not an identifier — two performers can share one — so the
item's labels have to agree with the record's own names, and the account it
points at still has to confirm the identity (see
[Finding the missing cross-platform links](#finding-the-missing-cross-platform-links)).
A name match is a suggestion, never a merge.

### 8. Wikipedia

`https://en.wikipedia.org/api/rest_v1/`

`GET /page/summary/{title}` returns a clean summary, a one-line description,
the lead paragraph, the infobox image and the Wikidata item id. It is the
source of the human-written descriptions and the verified avatars.

The text and the image are only used when the article is actually *about the
performer* — an article about someone who later became a VTuber often leads
with their pre-fame career, and its infobox image is a photograph of them.

### Holodex and Music Holodex

The Holodex sites are useful discovery references, but their website pages are
not ingested by this pipeline. Holodex API ingestion would require an API
adapter and a `HOLODEX_API_KEY` repository secret. Music metadata is currently
read from the linked VTuber Music Dataset and VocaDB rather than scraped from
`music.holodex.net`.

### 9–13. The platform APIs

The sync adapters support Bilibili, Niconico, Twitch, VK, CHZZK, KICK, SOOP
and CI.ME with different discovery and media coverage. For the endpoint-level
details and limitations, see `docs/PLATFORMS.md`.

### The quota-free sources

The Data API's 10,000 units a day is a hard ceiling: the catalogue is
fourteen thousand channels, and at one unit per channel plus one per fifty
videos, a full refresh would take days of the allowance.

Several platforms expose public or quota-free routes, but their availability,
credentials and coverage differ. A public endpoint is not necessarily a
stable or complete search API:

| Platform | Official | Quota-free equivalent | Gives |
| --- | --- | --- | --- |
| YouTube | Data API v3 | **InnerTube** (`youtubei.js`) | channel and video search, description, avatar, subscribers, uploads, releases, live/upcoming |
| Twitch | Helix (client id **and** secret) | **GQL** (`gql.twitch.tv`) for browser account features | description, avatar, followers, live; sync keyword discovery uses Helix |
| Bilibili | — | **WBI-signed public API** | description, avatar, followers, uploads, live |
| CHZZK | — | **the public API** | channel search, profile, followers, live |
| KICK | — | **the public API** | profile and live data for known channels; no usable public keyword search |
| SOOP | — | **the public live-list API** | first-page live titles, channel names, viewer counts |
| [CI.ME Open API](https://developers.ci.me/docs/api-channels) | **Open API** (`Client-Id` / `Client-Secret`) | same API | channel profile and follower count for known channel IDs; no documented search/media API |
| X / Twitter | — (no free read API) | [**FxTwitter**](https://github.com/FixTweet/FxTwitter) (`api.fxtwitter.com/<handle>`) | the bio, the website field and the location — where a Bilibili-only performer usually writes their YouTube link |

**InnerTube** (`scripts/lib/youtubei.ts`) — the channel's *description* is the
richest field in the project: it is where a performer states their own
language, their agency and their links. It also gives the avatar, the
subscriber count, the upload list, the YouTube Music releases, and the Live
tab. Public search is the quota-free counterpart of `search.list`: both channel
and video queries return candidates, and a video result carries the owning
channel id, a title, a description snippet, a thumbnail and a view count.
`searchVideos(q, n, { liveOnly: true })` mirrors `eventType=live`.

**The app's subscription Refresh is the other InnerTube use.** It does not go
through the pipeline: `scripts/lib/innertube-subs.ts` reads the signed-in
account's `FEchannels` feed with the TVHTML5 client and the OAuth bearer token
(full `youtube` scope, because `youtube.readonly` is refused with
`insufficientPermissions`). The browser cannot call it directly — no CORS — so
the local server proxies it. See `docs/ARCHITECTURE.md`.

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
- **The 🎵 badge is an Official Artist Channel.** The Data API does not
  expose it; the channel page renders it as `AUDIO_BADGE` /
  `BADGE_STYLE_TYPE_VERIFIED_ARTIST`. `profile()` already has the header, so
  `officialArtist` costs no request. The details pass stores it as
  `isOfficialArtist`.
- **The subscription list needs a separate one-channel read.** The TV
  `FEchannels` feed has no badge, so `server.ts` exposes
  `POST /api/youtube/channel` over `scripts/lib/youtube-channel.ts`. It reads
  one header for the background badge sync (cached 30 days by `UC…` id), and
  optionally `getLiveStreams()` + `getReleases()` when an untracked card is
  opened. Tracked cards use the committed dataset instead. The route is
  unauthenticated, local-only, and limited to two requests in flight.

### The subscription export

A person's subscription list is not in any public source, so the app grows the
catalogue from the one list the user already owns:

| Route | Limit | Cost | Works when |
| --- | --- | --- | --- |
| **InnerTube `FEchannels`** (`server.ts` bridge, **Refresh**) | none | no quota | the dev server runs and the account is linked (full `youtube` scope) |
| Data API `subscriptions.list(mine=true)` | **1,000 items** | quota | signed in (the API itself reads with `youtube.readonly`; the app asks full for InnerTube) |
| Google Takeout `subscriptions/subscriptions.csv` | none | hours of queue | the export is not empty |
| **`youtube.com/feed/channels` script** (`src/lib/subs-export.ts`) | none | seconds | signed in to the browser |

The file routes (Takeout and the script) end as the same
`Channel Id, Channel Url, Channel Title` CSV, read by `parseTakeoutCsv()`; the
InnerTube route stores the same channel ids directly. It is described above
and in `docs/ARCHITECTURE.md`. The script signs the session's `SAPISID` cookie
(`SAPISIDHASH`) and walks the `FEchannels` continuation through
`/youtubei/v1/browse`, falling back to the rendered page if the signed request
is refused; it downloads the file locally — the list never leaves the browser.
This is also the route that works for legacy accounts whose Takeout zip is
empty.

The CSV is a **subscription**, not a record: it is stored under the synthetic
account `youtube:takeout`, marked as untracked or tracked against the
dataset, and only an explicit import writes channel records.

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
| the **description** | InnerTube (YouTube), Helix (Twitch), the Bilibili `card` endpoint, CHZZK and KICK profile endpoints |
| the **avatar** | the same profile sources |
| the **follower count** | InnerTube, Helix (Twitch), `x/relation/stat` (Bilibili), CHZZK and KICK profile endpoints |
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

### Finding the missing cross-platform links

vdb files **9,000+ performers under Bilibili alone** — no YouTube channel, no
Twitch login. For some that is the truth; for many it is the roster's gap, and
the gap is what makes their region wrong: a record whose only account is on
Bilibili is filed under `cn`, even when the performer is Japanese and the
Bilibili account is a mirror.

`npm run data:links` closes the gap. It reads the identities a performer
publishes about themselves, strongest first:

| Source | What it is | How the link is trusted |
| --- | --- | --- |
| the record's description | the Bilibili signature, a YouTube about page | it is the performer's own words |
| the record's `externals` | handles harvested from a description | the same |
| the performer's **X profile** (FxTwitter) | the bio, the website field, the location | the same |
| **Wikidata**, by name in `ja` / `zh` / `en` | `P2397` YouTube, `P4047` Twitch | the profile must point back at the record |
| **web search** (`--web`, `GEMINI_API_KEY`) | a search-grounded model | the profile must point back at the record |

The last two answer a **name** match, so what they return is a *candidate*,
not a link. A candidate is accepted only when the resolved profile points back
at the record — the Bilibili space id in the YouTube description, the same X
handle — or when its title is one of the record's distinctive names. A
one- or two-character name never confirms anything on its own.

The new link lands in `platforms[]`, and the handles its profile publishes are
harvested into `externals`. It never renames the record: the performer's own
platform is still the authority for the name. The one field a discovered
YouTube channel may decide is the **region** — YouTube publishes the channel's
country, and that is the fact a mirror cannot corrupt. A country outranks the
"only on Bilibili, so Chinese" prior, and never overrides an agency, a roster's
nationality or a hand-written override.

An account another record already owns is **skipped**, not duplicated: the
right fix for that pair is a merge.

Every record the pass looks at is stamped with `lastDetailsFetchedAt`,
whether or not a link was found, and the queue is ordered oldest-first. That
is what makes the backlog **advance**: a record that yields nothing is not a
record to retry tomorrow, or the same hundred difficult records would be
re-read every run and the rest never reached.

Not every source is readable from every machine. Bilibili's card endpoint is
public, but its WBI-signed upload listing returns 412 to an unauthenticated
client, so upload descriptions are not harvested locally. X has no free read
API at all, which is why the bio is read through FxTwitter.

### Rate limiting

The free sources have no published quota, but they do push back. All three go
through `scripts/lib/rate-limit.ts`, which keeps a minimum gap between
requests, **doubles** it when a source answers with a rate-limit response,
and relaxes it again once the source has been quiet. Bilibili also needs the
visitor id, without which every request is treated as an attack.

**With no YouTube API key at all the pipeline still produces a complete
dataset** — discovery, uploads, releases and live status come from InnerTube,
and the profiles from InnerTube and Twitch GQL.

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
