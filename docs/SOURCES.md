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

**10,138 identity records** — 9,903 performers, 221 groups, 13 fan accounts —
each performer with their accounts on up to 35 platforms, their group and the
names they use in each language — `cn`, `jp`, `en` and `extra`. It is the backbone of the roster: it is where most of the platform
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

1. **`group_name`** — the group's scene. Hololive EN → `en`, VirtuaReal →
   `cn`, NIJISANJI → `jp`. 「安堂いなり」 is Chinese despite the Japanese
   name; she is VirtuaReal Link. The stored `agency` is one `hololive` since
   2026-09-07, but the group that placed a performer still decides the region.
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

### VtuberHK — the Hong Kong directory

`https://vtuber.hk` · read by `scripts/harvest-vtuberhk.ts`

A Hong Kong–centred tracker — 俗稱的DD網 — that lists every channel it covers
on one page, with the `UC…` id, the name, the subscriber count, the video
count and the total view count, grouped by the performer's state:

| Section | Count | This project's field |
| --- | ---: | --- |
| 活動中 (active) | 452 | `activity: "active"` |
| 準備中 (preparing) | 39 | `activity: "preparing"` |
| 己引退 (retired) | 162 | `activity: "graduated"` |
| 觀察中 (watching) | 2 | `activity: "active"` |
| 相關組織 (organizations) | 17 | reported, **not** imported: an agency is not a performer |

The **roster and its state** are the one thing the site does not publish as
JSON: 活動中 / 準備中 / 己引退 are `<section>` lists in `GET /channels/` (812 KB
of server-rendered HTML). Everything else is a static JSON file, and the
harvest reads it instead of scraping:

| Request | Size | What it gives |
| --- | ---: | --- |
| `GET /data/channels.json` | 1.3 MB | a YouTube `channels.list` dump keyed by channel id: title, description, `customUrl`, published country, and `statistics.viewCount` / `videoCount` / `subscriberCount` |
| `GET /data/live-hkv.json` | 50 KB | 146 live and upcoming streams: `cid`, video id, title, `u` (start, Unix seconds), `vc` (viewers), `pf` |
| `GET /data/archive-hkv.json` | 92 KB | 278 recently ended streams and uploads, keyed by index, with `d` (runtime) |
| `GET /data/featured.json?p=N` | 14 KB a page | 50 精華 clips a page, 29 pages: the **clip channel** (`ct`) and the video |
| `GET /data/list-hkv-watching.json` | 55 B | the site's own watch list, two channel ids |
| `GET /twitch` | 112 KB | 235 Twitch logins, no counts |

It is the cheapest region source the project has — **the id is published, so
no name search is involved** — and the only one that states graduation for the
Hong Kong scene. `channels.json` is also the only free source of a channel's
**total view count** — a field InnerTube does not publish, and the one this
project fills from here.

The clip list (`/data/featured.json`, 29 pages of 50) is documented and not
read: a clip channel is a fan re-upload (`detectClipAccount()`), and the
dataset drops those rather than tracking them.

What the roster decides, and what it does not:

- **The claim.** Every entry it carries is a virtual performer
  (`rosterIds`), the same claim vTubie's groups and bacharu make.
- **The region.** The site is the Hong Kong scene, so its entries are `hk` —
  but only where `classifyChannel()` returned `unknown`. A Japanese performer
  who streams with a Hong Kong group keeps the `jp` her country and kana
  gave her; the roster fills a gap, it does not overwrite a fact
  (`RosterHint` in `scripts/lib/import-channels.ts`).
- **The state.** 己引退 is `activity: "graduated"`, and the roster is the only
  source that states it for these channels.
- **Not the name.** The platform's own title is still the name, as in every
  import (`AGENTS.md` rule 2).

The harvest is `npm run data:vtuberhk`; the gated import is
`npm run data:vtuberhk-import` (report) and `-- --apply` (write). Of its 672
rows, 253 were channels the catalogue did not have and 401 it already tracked;
250 were written — two ids no longer resolve to a channel at all
(`UCPcMERb50-gZ5-rGnUjX4OA`, `UCPbZzX8Uq3iCsPtclDcIlfQ`) and one row was a
clip account, which the import rejects. `-- --stats` then filled **876 empty
counts across 360 records** from `channels.json`, mostly the `viewCount` and
`videoCount` the platform adapter never writes.

### HoloList — the VTuber directory

`https://hololist.net` · read by `scripts/harvest-hololist.ts`

A general VTuber directory — not an agency site — of **9,359 entries**, each a
WordPress post at `https://hololist.net/<slug>/` and each filed under one or
more of four types:

| Type | Entries | What it is |
| --- | ---: | --- |
| V-Tuber | 9,127 | the mainstream virtual performer |
| V-Streamer | 3,751 | a streamer-first virtual performer |
| V-Singer | 905 | a virtual **singer** — the part of the roster this project is named after |
| V-UP | 143 | 虚拟UP主, the Chinese word for the same thing |

The types overlap, so the four sum past the roster. Entries are global: every
Hololive and Holostars branch, NIJISANJI and NIJISANJI EN, VShojo, Phase
Connect, KAMITSUBAKI, VirtuaReal and several thousand independent performers.

**How it is read.** The site's own front end would use the WordPress REST API,
but `/wp-json/wp/v2/posts` answers `403` through Cloudflare, `robots.txt`
disallows `/*?*`, and the archive pages (`/debut/`, `/newest/`) are
client-rendered shells. What is left is the path the site itself advertises:

| Request | What it gives |
| --- | --- |
| `GET /wp-sitemap.xml` | the index: five post sitemaps |
| `GET /wp-sitemap-posts-post-{1..5}.xml` | 2,000 + 2,000 + 2,000 + 2,000 + 1,359 = **9,359 entry URLs**, each with a `<lastmod>` |
| `GET /<slug>/` | one server-rendered entry, about 56 KB |

That is one request per entry and ~525 MB for the first census — lighter than
bacharu's 2.9 GB — and `<lastmod>` makes every later run incremental: the
harvester keeps the last modification it saw per URL and refetches only what
moved. `npm run data:hololist` writes one file per entry under
`.cache/hololist/pages/` (so an interrupted pass resumes) and merges them into
`.cache/hololist.json`.

**What an entry publishes.** The page is a stack of `<section id="…">` blocks,
which is a better shape than most rosters:

| Section | Example | This project's field |
| --- | --- | --- |
| `h1` | `Akugaki Koa` | `name` (the platform's title still wins) |
| `#nickname` | `Koa-tan`, `AKGK` | `aliases` — *planned* |
| `#type` | `V-Tuber`, `V-Streamer` | the roster's virtual claim (`rosterIds`) |
| `#tags`, `#content` | `Demon`, `Singing` | `tags`, `isSinging` — *planned* |
| `#debut` | `May 3, 2024` | `debutDate` (`RosterHint.debut`) |
| `#birthday` | `October 28` | **no field yet** |
| `#height` | `135 cm` | **no field yet** |
| `#affiliation` | `ChromaSHIFT` | `agency` (`RosterHint.agency`, canonicalised) |
| `#language` | `English`, `Japanese`, `Spanish` | `languages`, and the language the profile is asked in (`RosterHint.languages`) |
| `#gender` | `Female` | `gender` — a fallback behind the classifier (`RosterHint.gender`) |
| `#model` | `L2D`, `3D` | **no field yet** |
| `#status` | `Active`, `Retired` | `activity` (`RosterHint.activity`) |
| `#description`, `#lore` | prose | the profile's description wins; the lore has **no field** |
| `#links` | YouTube `@handle`, Twitch, X, Instagram, TikTok, Bilibili, Niconico | `platforms[]` and `externals` |
| `#fanbase`, `#oshi-mark`, `#hashtag`, `#likes`, `#dislikes`, `#character-sheet` | `Koanikis`, `↝ ⛓️`, `#AKGKart` | **no field yet** |
| the count `<a title="63,600">63.6K</a>` | the exact subscriber count | `subscribers` |

The links are the reason the roster is worth reading. The YouTube account is
an `@handle` — never a `UC…` id — so the importer resolves it through
InnerTube once and caches the answer, but the **Twitch, X, Instagram, TikTok,
Bilibili and Niconico** accounts beside it are exactly what a record built
from a roster is usually missing. `npm run data:hololist-import -- --links`
reports them and `--links --apply` writes them into `externals`, which is the
same field a description harvest fills and the same field `data:links` reads
as a source. Nothing already on the record is overwritten.

What the roster decides, and what it does not (`AGENTS.md` rule 15):

- **The claim.** Every entry is a virtual performer (`rosterIds`), so `kind`
  is settled even when the bio never says "VTuber".
- **The agency, the languages, the debut, the gender and the state.** All five
  are fallbacks or facts the profile does not publish: the agency only where
  the title and description name none, the languages as the language to
  *ask* the profile in, the gender only where the classifier answered
  `unknown`, and `Retired` as `activity: "graduated"`.
- **Not the name, the region or the role.** The platform still owns the name.
  The site publishes no country, so the region is whatever YouTube's about
  page, the agency or the language gives; a Spanish-speaking VTuber stays
  `unknown` with `languages: ["es", "en", "ja"]` rather than being guessed
  into a country. A `V-Singer` is a claim about content, and content is what
  `classifyChannel()` reads from the channel.
- **Not a fan account.** `detectClipAccount()` and `isFanAccountName()` still
  run: a clip channel files itself as a VTuber while duplicating the
  performer it clips, and a directory that accepts submissions lists them.

**What the roster does not give.** It publishes a `@handle`, never a `UC…`
id — so an entry costs one InnerTube resolution, cached in
`.cache/hololist-resolved.json` — and it publishes no country, so a
Spanish-speaking performer stays `unknown` rather than being guessed into
`es`'s nearest region (there is none). Some entries are Twitch-only: the
importer reports them as `no-youtube` and writes nothing, because its import
path is YouTube's. The site also lists **fans** — a directory that accepts
submissions always does — which is why the clip and fan tests run before
anything else.

#### What HoloList has that this project does not

Read from the site on 2026-10-28, one entry at a time, against the dataset.

| HoloList | What it publishes | This project today | Plan |
| --- | --- | --- | --- |
| **2.5× the roster of any single source** | 9,359 entries across every agency | 72,361 channels, most from vdb and bacharu | import the ids the gate admits (`data:hololist-import --apply`) |
| **the performer's other accounts** | Twitch, X, Instagram, TikTok, Bilibili, Niconico beside the YouTube channel | `externals` is filled from a description harvest, and most records have none | **done** — `--links` |
| **the debut date** | `May 3, 2024` | `debutDate` exists; InnerTube never states it | **done** — `RosterHint.debut` |
| **birthdays** | `October 28`, per entry | **no field** | `birthday` (`MM-DD`) on `Channel`, then a `/birthday/` view — the site's own birthday page is its most-used one |
| **anniversaries** | debut month + day, computed | `debutDate` is stored | a `/anniversary/` view over `debutDate`, once the dates are filled |
| **height, weight, zodiac, MBTI** | `135 cm`, `Scorpio` | **no field** | **not planned** — profile trivia, and a schema field with no view is a field that forks the record |
| **model type** | `L2D`, `3D` | **no field** | `modelType` on `Channel`, shown in the drawer — cheap, and a real filter for VTuber users |
| **fanbase name, oshi mark, hashtags** | `Koanikis`, `↝ ⛓️`, `#AKGKart` | **no field** | `fanbaseName` and the hashtags as `tags`; the oshi mark is decoration |
| **likes / dislikes / lore** | prose lists | **no field** | **not planned** — it is the character's biography, not the performer's, and the dataset is a tracker rather than a wiki |
| **ratings, favourites, watchlist, spotlight** | a signed-in account feature | the Subs view and the account menu | nothing to build — a different product |
| **live / debuts / retirements calendars** | `/live/`, `/debut/`, `/retirement/` | live items exist per card; retirements are `activity` | the **timetable** and **recent** views already planned from VtuberHK cover `/live/`; `/retirement/` is a filter over `activity` |
| **exact counts in the markup** | `title="63,600"` | `subscribers` from InnerTube; `viewCount` / `videoCount` are usually empty | the subscriber count is passed for new imports; a `data:details --stats` pass is still the missing half |

#### The build plan

1. **Harvest and import** — `data:hololist` (resumable, incremental) and
   `data:hololist-import` with the performer gate. `--apply` writes the new
   channels with `rosterIds`, the agency, the languages, the debut, the gender
   and the state.
2. **The links** — `--links --apply` fills `externals` for tracked records
   from the `#links` section, which is the field that makes the drawer and the
   cross-platform block complete.
3. **The two fields the roster states and the schema lacks** — `birthday`
   (`MM-DD`) and `modelType` (`L2D` / `3D`). Both are additive, both are
   cheap, and both have a view.
4. **The dates reach the UI** — a birthday view and an anniversary view over
   the data already on disk, which is the same work the VtuberHK comparison
   asks for under *the timetable and the recent feed*.

The first two are implemented; the third and fourth are the honest gaps the
comparison leaves.

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

`https://holodex.net` · `https://music.holodex.net`

**Discovery references, not sources** — no page of either is ingested.
Holodex indexes YouTube VTuber streams (live, upcoming, channels,
organisations, a **clip index** with the clipper relations behind it) and its
**Multiview** plays several streams at once; Musicdex is the music layer —
songs and set lists tagged out of singing streams, with playlists by performer
and organisation.

What ingestion would take: the API v2 (live/upcoming, videos, channels,
search, comment search) is the only machine-readable path, it needs a
`HOLODEX_API_KEY` repository secret, and the docs publish no fixed quota —
the terms reserve the right to throttle “excessive” use, so an adapter would
have to sit behind `scripts/lib/rate-limit.ts` like every other source that
pushes back. Every endpoint answers `403` without a key, so the inventory
cannot even be counted before the work starts.

What is already covered without them: the song and original-artist metadata
comes from the linked VTuber Music Dataset and VocaDB, and the live/upcoming
list from InnerTube, so neither site is the only route to anything this
project needs. Read them for the two things it does not build — a clip index,
and song-level tagging of a stream — not for their data. Their frontends are
open (Holodex MIT, Musicdex Apache-2.0); their backend crawler and dataset are
not.

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
| Bilibili | — | **WBI-signed public API** | description, avatar, followers, uploads, live (via `online/list?rid=160` VTuber partition) |
| CHZZK | — | **the public API** | channel search, profile, followers, live |
| KICK | — | **the public API** | profile and live data for known channels; no usable public keyword search |
| SOOP | — | **the public live-list API** | first-page live titles, channel names, viewer counts |
| [CI.ME Open API](https://developers.ci.me/docs/api-channels) | **Open API** (`Client-Id` / `Client-Secret`) | **the public live-status endpoint** | channel profile and follower count (batched, 20 ids per request); per-channel live status via `GET /api/openapi/v1/{channelId}/live-status`, which needs no credentials |
| X / Twitter | — (no free read API) | [**FxTwitter**](https://github.com/FixTweet/FxTwitter) (`api.fxtwitter.com/<handle>`) | the bio, the website field and the location — where a Bilibili-only performer usually writes their YouTube link |
| Niconico | — | **the public API** | search, uploads, live programs via Content Search API v2 |

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

**Multi-platform live streaming.** The sync checks live/upcoming status for
YouTube channels via the InnerTube Live tab, and for channels linked to
CHZZK, KICK, SOOP and Bilibili via each platform's adapter. Non-singing VTubers
are included — a VTuber who also streams on Twitch or goes live on CHZZK is
caught regardless of `isSinging`. The live check covers all YouTube-keyed
records in the catalogue (`maxLiveChannelsPerRun` default 50,000), not just
the current shard, because live status is time-sensitive.

- **Bilibili** live streams come from `online/list?rid=160` (VTuber partition),
  fetched once per run via `search()` and filtered against known VTuber channel ids.
- **Niconico** live programs come from the Content Search API v2 with
  `filters[liveStatus]=onair`, fetched once per run and matched against
  Niconico-linked channels.
- **CI.ME** live streams come from the **public** per-channel
  `GET /api/openapi/v1/{channelId}/live-status`, so no client credentials are
  needed; the answer names the stream's title and start time, and the item id
  is `ci.me:<channelId>:<openedAt>` so each stream of a channel is its own
  item. The platform-wide live list (`GET /api/openapi/open/v1/lives`, the
  `cime-sdk` `client.live.getLives()` path) needs the credentials and could
  not be attributed to a channel, so it is not used.

Ended streams are retired to `past` on every run so the Live page stays current.

### The singing-event calendar — finding new singers by event

VTuber singing events (歌枠リレー) are announced and indexed by the community,
and a participant's stream is titled with the event's name. That makes an
event name a **seed query** for YouTube discovery: searching for it finds
every participant, and the event itself is evidence that the channel sings.

Two sources feed the query list:

| Source | What it is | How it is read |
| --- | --- | --- |
| **歌枠リレーカレンダー** | @shimesaba_krm's Google Sheet, the community's canonical calendar of singing relays, one cell per event per day | `npm run data:singing-events` — the CSV export of the current month's sheet, plus the previous months from the year sheet's named tabs via `gviz/tq?tqx=out:csv&sheet=…` |
| **X** | event announcements (`"歌枠リレー" "タイムテーブル"`) and recruitment posts (`#歌枠リレー募集`) | `scripts/harvest-x-singing-tags.py` through twscrape, keeping the hashtags that name a singing event |

Both write a `.cache/` snapshot — `singing-events.json` and
`x-singing-tags.json` — and `scripts/sync.ts` reads them through
`scripts/lib/singing-events.ts`. The calendar's names come first (an event
there has a date, a timetable and a participant list), and the X hashtags fill
in the events the calendar has not filed yet.

Each event becomes a **video** search (`SearchSpec.eventTag`), not a channel
search, because the participants title their streams with the event name. A
result is admitted when the event name appears **inside** the video's title or
description — a YouTube search returns unrelated hits too — and the event is
then treated as **both halves** of the virtual-and-singing gate: the name
`…歌枠リレー` is the singing evidence, and the VTuber calendar it came from is
the virtual half. A channel found that way is classified `virtual` with
`isSinging: true`.

The number of event searches per run is `maxSingingEventSearchesPerRun`
(default 24) in `config/sync.config.json`; `--no-search` skips them along with
every other search.

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
| **YouTube channel search** (InnerTube) | the record's display name, through `searchChannels()` — no Data API quota | the channel's name must be the record's, and it must not be a clip/fan account |
| **web search** (`--web`, `GEMINI_API_KEY`) | a search-grounded model | the profile must point back at the record |

The last three answer a **name** match, so what they return is a *candidate*,
not a link. A candidate is accepted only when the resolved profile points back
at the record — the Bilibili space id in the YouTube description, the same X
handle — or when its title is the record's distinctive **display name**. A
one- or two-character name never confirms anything on its own.

Only the display name counts, never an alias. An alias is a romanisation or a
translation the pipeline added — vdb lists 「维多利亚」 as `Victoria` — and a
common romanisation belongs to something else as often as to the performer: the
Canadian city of Victoria has a YouTube channel, and a name match on the alias
adopted it. A link found in the performer's **own text** is taken at face
value, because there the performer said it themselves.

Containment is tested in both directions, because the two sides decorate a name
differently: 「雫るる_Official」 keeps its suffix (`normalizeName()` strips
`official` only where it is a word — never after kana), and the channel is
just 「雫るる」. The record's name is the distinctive side and has to appear in
the candidate's; a one- or two-character name confirms nothing. A **search**
candidate that turns out to be a clip, fan or re-upload account is rejected
outright (`detectClipAccount()`, `isFanAccountName()`): 切片/烤肉 channels are
named after the person they clip, so they are what a name search returns first.

`--region <code>` and `--platform <id>` narrow the queue. The Japanese
Bilibili backlog is the case the search exists for — 310 records whose shape is
「a Japanese VTuber whose only roster account is a Bilibili mirror」 — and
`npm run data:links -- --platform bilibili --region jp` walks it.

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

**vTubie** publishes a directory of roughly 20,000 performers at
`vtubie.com/allvtubers/?pg=N`, ten to a page, and has no API — their FAQ
answers "in development", and every path (including `/wp-json/`) sits behind
a Cloudflare managed challenge. A plain `fetch` gets `403 Just a moment...`,
so the adapter drives a real browser through `puppeteer-core` (optional, and
it ships no Chrome) and reads the cards. A challenge that does not clear is a
normal outcome on a datacenter IP: the source says so and returns nothing
rather than failing the run.

The listing gives a name and a profile slug, never a channel id, so
`npm run data:discover` records the performers it finds in `data/identities.json`
and `--promote` then resolves each name through InnerTube channel search. A hit
is confirmed against the channel's own title, and the channel enters
`data/channels/` only when two of its videos show virtual-creator identity and
singing evidence — the same rule the sync applies to a discovered channel.

**vTubie's group pages are the exception that does publish an id.** The
directory's `groups/` index (1,028 groups over 103 pages) links each circle and
agency, `/g/<slug>/` lists its members, and a member's own page carries the
YouTube RSS feed carrying `channel_id` — the key the dataset is built on. So
`npm run data:vtubie-groups` walks the three levels and writes a snapshot to
`.cache/vtubie-groups.json`, and `npm run data:vtubie-import` compares it with
the dataset and, with `--apply`, imports the new channels. Nothing is guessed
from a name: the id comes from the profile itself. A profile page is also
rate-limited well below the directory's own pace — 1.2 requests a second
sustains, 2.5 gets a 429 and then a 403 — so the profile pass runs at that
rate and resumes from its state file.

The harvest runs through a real browser for the same Cloudflare reason, then
reads every following page with a same-origin `fetch` **inside** that page so
the clearance cookie (HttpOnly, so invisible to the page's scripts) rides
along. A 404 is an answer — a deleted group or profile — and is recorded; a
403 is the challenge coming back, and stops the pass instead of grinding
through the rest of the directory.

**bacharu** is the largest roster the pipeline reads: about 110,000 performers
at `bacharu.io`, each filed under a country, a group, a debut and a status. It
is an Astro front end over a Fastify JSON API, so unlike vTubie it needs no
browser: `GET /api/vtubers?limit=100&page=N` answers a hundred **whole**
records (about 2.6 MB and three seconds a page), `GET /api/vtubers/<_id>`
answers one, and `?search=<name>` filters — which makes it the cheapest
`name → YouTube channel` resolver the pipeline has, and the reason the
`data:links` gap can be closed without a search-grounding key.

`fields=card` is the only projection and it **drops `social`**, so a card page
has no channel id; every other value of `fields` returns the whole record.
`/api/groups` lists the groups without their members, and
`/api/vtubers/filters` lists the values the filters accept. Of the 109,828
rows, 27,099 carry a `/channel/UC…` URL, 35,099 a `@handle` only and 47,630 no
YouTube link at all (Twitch-first performers, Bilibili, IRIAM).

Two things make the harvest unlike the others:

- **The roster is sorted by `last_active_at`, and the site keeps updating it.**
  A paginated crawl therefore sees rows move between pages while it runs: one
  pass of 1,099 requests returned 13,500 rows twice and skipped as many, where
  a second pass of 1,181 requests at a different page size returned all
  109,828 exactly once. The harvester writes one file per page, so a second
  pass can be unioned in with `--merge-dir`, and the snapshot is de-duplicated
  by `_id`. `sortBy` accepts `last_active_at` and nothing else, so there is no
  stable order to ask for.
- **`robots.txt` disallows `/api/` for every agent**, and lists GPTBot and
  ClaudeBot by name. The roster is therefore read as a **one-off census**, not
  polled: two pages at a time, about one request a second, and a 429 doubles
  the gap and cools down for two minutes.

`npm run data:bacharu` writes `.cache/bacharu-vtubers.json` — one flat extract
per performer, about 900 bytes, with the YouTube id, the handle, the groups,
the country, the debut and the avatar. `npm run data:bacharu-import` is the
gate: it reports what is new, what is already tracked, what is a fan account,
what has no key, and imports only the rows whose `UC…` id it can verify
through the platform — the platform's name wins, and a roster name that shares
no word with the channel's title is reported rather than imported.

**A stale id is not an import.** The first full import of the rows the
catalogue did not have attempted 715 channel ids and wrote **one**. Most of
the failures are channels YouTube no longer has — the profile answers `null`
and the channel page says 「This channel does not exist」 or 「This account has
been terminated」 — and the rest were a placeholder name or an id that now
belongs to another record.
The roster is a historical census — it keeps the rows of channels that have
since been deleted — so a run that reports hundreds of failures is reporting
dead source rows, not a broken pipeline.

A channel that no longer exists is not written, and its id is remembered in
`.cache/bacharu-dead.json` for **seven days**, so the next run does not spend
the same fifteen minutes asking YouTube about the same dead accounts.
`--retry-dead` ignores that list; a failure older than the window is tried
again on its own. The list is a cache, not a dataset fact, which is why it
does not live in `data/`.

**The roster's membership is the claim.** bacharu files every entry as a
virtual performer, and that is the only evidence some channels have: their
whole YouTube bio is 「I'm just a guy trying to have fun, png made by
@owo_uou」. The importer therefore passes `rosterIds` to
`importYouTubeChannels()`, which hands `virtualClaim: "roster"` to
`classifyChannel()` — it settles `kind`, leaves `role` to the profile, and an
explicit statement of a human body (「not a VTuber」) still overrules it.
Without the claim, the 854 channels whose bio never says "vtuber" were filed
as human singers.

### Reading a roster without a link

A row with no `UC…` id and only an `@handle` is one InnerTube resolution away
from an import: `npm run data:bacharu-import -- --resolve-handles 6000`
resolves the handle to the real channel id and imports it like any other
candidate. A handle that resolves to a channel the dataset already tracks is
skipped, not duplicated, and a channel the roster itself names under another
row is imported once.

`--limit` caps **what a run imports**, not what it reports, so a batch that
resolves handles always has something to write.

A row with **no YouTube link at all** — 47,630 of bacharu's 109,828 — is a
different case: the roster knows the performer and not where they stream, so
the channel has to be found before it can be imported. `--search-names <n>`
searches YouTube by the row's name, fetches the candidates' profiles and
accepts one only when the channel's own title confirms the roster's display
name in either direction, the name is distinctive (`isDistinctiveName()`), the
account is not a clip or fan channel, and **exactly one** candidate matches.
Two channels that both carry the name are an ambiguity, not a link — the same
rule a name search follows for a record that already exists.

### The groups, and the agency

A bacharu row carries its groups with a `current` / `former` status, and that
is a statement about affiliation the channel's own text often never makes:
1,332 of the tracked rows are in a current group, and 1,044 of those have no
`agency` at all. `--agencies` fills exactly those, and only where the row's
current groups agree on one agency.

The name is **canonicalised** before it is written, because the roster spells
an agency several ways: `NIJISANJI`, `Nijisanji` and `NIJISANJI (main branch)`
are one agency, and every `hololive` branch is `hololive` (`canonicalAgency()`,
`AGENTS.md`). A former group is not a current affiliation, and an agency the
channel's title or description names still wins — the roster fills an empty
field, it never takes one back. A group that matches no known agency is kept
as the roster writes it, because that is all the source states.

### The links and hints of tracked rows

Bacharu knows more than just the YouTube channel: each row carries the performer's social accounts (Twitch, X, Instagram, TikTok, Bilibili, Niconico, KICK, CHZZK, SOOP, VK), plus a country, a debut date and a gender. Two passes attach what the roster knows to records the dataset already tracks:

**Social links** — `npm run data:bacharu-import -- --links` reports the handles bacharu publishes that the dataset does not yet have; `--links --apply` writes them into `externals`. The record **is** the YouTube channel, so a `youtube.com/channel/…` link is skipped, and a link already on the record (read from the performer's own text) is never overwritten. `clips` links are skipped too — a clips channel publishes the performer, it is not the performer. Every other address lands in `externals` as its platform key (`twitch`, `twitter`, `instagram`, `tiktok`, …), or as `web:<n>` for a personal site or shop.

**Region, debut and gender** — `npm run data:bacharu-import -- --hints` reports empty fields bacharu can fill; `--hints --apply` writes them:

- `region` is written **only** where `classifyChannel()` could not place the channel at all (`unknown`) — bacharu's country outranks nothing stronger, and an already-known region is never changed.
- `debutDate` is parsed from bacharu's free-text `debut` (`2022/07/03`, `June 18, 2022`, `YouTube: 2024/06/01`) — anything that is not a clean date (`TBA`, `2022`, `N/N/N as Indie VTuber`) is left blank.
- `gender` is written only where the channel's own text did not answer (`unknown`) — bacharu's `Female`/`Male` maps to `female`/`male`, anything else stays with the classifier's answer. A written gender re-derives `variant` (`female_vtuber`, `male_vtuber`).

Both passes run under the run lock, re-read the dataset inside it, and write nothing when nothing changed.

#### What bacharu has that this project does not

Read from the site on 2026-10-28, one entry at a time, against the dataset.

| bacharu | What it publishes | This project today | Plan |
| --- | --- | --- | --- |
| **109,828 performers** | the largest single roster | 72,691 channels across all sources | import the ids the gate admits (`data:bacharu-import --apply`) |
| **every platform link** | Twitch, X, Instagram, TikTok, Bilibili, Niconico, KICK, CHZZK, SOOP, VK plus `web:` | `externals` for tracked records from `--links` | done — `--links --apply` |
| **country / region** | `countries` + `nationality`, filed per performer | `region`, filled only where unknown | done — `--hints --apply` |
| **debut date** | free text (`2022/07/03`, `June 18, 2022`, `YouTube: 2024/06/01`) | `debutDate` | done — `--hints --apply` parses it |
| **gender** | `Female` / `Male` / free text | `gender`, filled only where unknown | done — `--hints --apply` maps `Female`→`female` |
| **status** | `active` / `preparing` / `graduated` / `hidden` | `activity` | done — `--hints --apply` maps it |
| **groups with current/former** | affiliation history per performer | `agency` + `affiliation` | done — `--agencies` fills empty agency |
| **avatar on its own CDN** | `avatar`, `banner` as fallbacks | `avatar` from `data:details` | done — used until the profile pass overwrites |
| **Twitter activity** | follower count, last tweet, locked/suspended state | **no field** | not planned — snapshot trivia, not tracker state |
| **birthday** | `October 28`, per entry | **no field** | `birthday` (`MM-DD`) on `Channel`, then a `/birthday/` view |
| **anniversary** | debut month + day, computed | `debutDate` is stored | an `/anniversary/` view over `debutDate` |
| **model type** | `L2D`, `3D` | **no field** | not planned — profile trivia |
| **fanbase name, hashtags** | prose lists per entry | **no field** | not planned — biography, not tracker data |
| **follower counts** | Twitch, X subscriber counts per entry | `subscribers` / counts per platform link | done — the Twitch-keying import reads the follower count |
| **Twitch schedule** | scheduled stream times per performer | **no field** | not planned — roster trivia |
| **YouTube followers history** | historical subscriber counts | **no field** | not planned — historical trivia |
| **Recent Activity (X)** | recent posts per performer | **no field** | not planned — social media trivia |
| **debut page** | lists everyone who debuted on a day | **no field** | not planned — roster trivia, not a tracker field |

#### The build plan

1. **Harvest and import** — `data:bacharu` (one-off census, ~1,099 pages) and `data:bacharu-import` with the performer gate. `--apply` writes new YouTube-keyed channels with `rosterIds`, agency, activity, languages, debut and gender.
2. **Dead-YouTube keying** — the Twitch-keying pass: rows whose `UC…` id YouTube no longer has (or never had) but who carry a Twitch login become records keyed by `twitch:<login>`, with the GQL profile supplying name, avatar and follower count.
3. **Links and hints** -- `--links --apply` fills `externals` on tracked records; `--hints --apply` fills empty `region`, `debutDate` and `gender`.
4. **The two missing UI fields** — `birthday` and `modelType` on `Channel`, then views over them.

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
| [Virtual YouTuber Wiki](https://virtualyoutuber.fandom.com/) | The MediaWiki API works, and it is wired in as a **debut discovery source** (`scripts/lib/debut-sources/fandom.ts`) — debut dates, graduation dates, YouTube handles, X handles and affiliations from `{{Character}}` infoboxes. The roster itself is not yet wired for direct channel import |
| [AI VTuber DB](https://aivtuberdb.com) | Worth reading for the AI flag, but it publishes no machine-readable file |
| [PVC.moe](https://pvc.moe) | The data is only in the client bundle |
| [Streams Charts](https://streamscharts.com/vtubers) | Blocks automated requests |
| [JustOneAPI](https://github.com/justoneapi/justoneapi-python) | A token-based proxy for the protected platforms — a paid service, so the free sources are preferred. Its generated resources are a useful catalogue of which endpoints exist |
| [facebook-gql-scraper](https://github.com/XD-MHLOO/facebook-gql-scraper) | Facebook's internal GraphQL, driven by `scripts/harvest-facebook-groups.py`. It needs a **logged-in cookie session**: without one, a group URL answers `302 → /login/?next=…`, the `fb_dtsg` token never appears, and search and group reads both fail. Worth using with a session, because group posts are where Taiwanese VTubers are announced |
| r/VirtualYoutubers | `.json` and `/api/` both answer a block page (403); `new/.rss` works and is read by `.cache/harvest-reddit.ts`, and YouTube `oembed` turns a post's video into its channel |
| X communities | A logged-out page renders the community header and a few posts with no `tweetText` nodes and no links, and there is no community timeline endpoint. A **user** timeline is readable — see the twscrape row below — but `UserUnavailable` is ambiguous: it means no session **or** a protected account, and the two cannot be told apart from the answer alone |
| [twscrape](https://github.com/vladkens/twscrape) | The working way to read X: `scripts/harvest-x-twscrape.py` wraps it with a cookie-based account, so login → `userId` (`UserByScreenName`) → `UserTweets` happens in the library, with per-endpoint rate-limit rotation across accounts. `TWS_HTTP_BACKEND=curl` is required for `user_by_id` (Cloudflare rejects httpx) and `TWS_TELEMETRY=0` turns its telemetry off. Verified: a timeline, a search, and expanding `t.co` links into `links[].expandedUrl` all work with one cookie account |
| [OpenCLI](https://github.com/jackwener/opencli) | 173 site CLIs, `twitter` and `reddit` among them, but every action needs a browser and a cookie session — and `twitter tweets` takes a `username` while X's `UserTweets` takes a `userId`, so it carries the same friction as calling the endpoint by hand |

If any of them publishes a JSON or CSV file, adding it is one adapter and
one line in the registry.

## Reference implementations consulted

These are read for **how** a platform's API is called, not for their data.

| Project | What it settled |
| --- | --- |
| [biliscope](https://github.com/gaogaotiantian/biliscope) | The WBI signature, the mixin key (file names **without** the `.jpg`), the fact that `web_location` is not required (PR #287), and the `w_webid` that `space/wbi/acc/info` wants |
| [youtubei.js](https://github.com/LuanRT/YouTube.js) | InnerTube: the profile, the upload grid, the live streams, and `navigation/resolve_url` for turning a `@handle` into a channel id |
| `gql.twitch.tv` | The GQL endpoint and the public web client id |

## How this compares to the other trackers

A snapshot taken on **2026-10-27**, so a later reader can tell what moved.
Method: `curl --compressed` from one US VM plus each site's own published
files. Payload and TTFB are network facts; Core Web Vitals need a browser and
are not measured here.

| | this project | HoloList | Holodex | Musicdex | Taiwan tracker | vdb | VtuberHK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| blocking JS + CSS | **125 KB** (116,014 B JS + 9,373 B CSS) | 282 KB (48,642 B JS + 233,943 B CSS), plus a 206 KB ad script | 276 KB | 385 KB | 165 KB | 32 KB of static HTML | 229 KB (131,307 B JS + 97,686 B CSS) + Google Fonts |
| hashed asset cache | `immutable`, one year (Vercel) | no `Cache-Control`; ETag only | hashed | hashed | ten minutes, flat | ten minutes, flat | no `Cache-Control`, ETag only |
| data access | committed JSON, no key | sitemap + one server-rendered page per entry, no key; the REST API is behind Cloudflare | API v2, `X-APIKEY` | same key | static JSON | static `list.json` | server-rendered HTML, no key |
| inventory | **72,691 channels**, 1,803 items | 9,359 entries (905 V-Singer, 3,751 V-Streamer, 9,127 V-Tuber, 143 V-UP) | not published; `403` without a key | not published | 288 groups; performer list not published | 10,138 records | 672 channels (235 Twitch logins) |
| platforms tracked | 9 with adapters | YouTube plus Twitch / X / Instagram / TikTok / Bilibili / Niconico links | YouTube (Twitch in Multiview only) | YouTube | YouTube, Twitch | Bilibili stats; ids for any | YouTube; Twitch as a directory |
| regions | 10, aliases per locale | none — languages instead | language filters | — | TW, HK, MY | `cn`-centric | HK |
| refresh | every 6 h | undocumented; `<lastmod>` allows incremental reads | undocumented | undocumented | ~30 min (its own timestamps) | ~5 min stats / <15 s live (its own claim) | undocumented; the state is edited, not measured |
| licence | MIT | not stated | MIT frontend | Apache-2.0 | Unlicense | VDBL (CC BY-NC-SA data, GPL code) | not stated |

**This project's edge:** cross-platform identity rebuilt from each platform,
the region-evidence chain with recorded provenance, ten regions where the
others are Chinese- or Taiwan-centred, and the whole subscription path
(account linking, Takeout/PocketTube/export import, suggestions) which has no
equivalent in any of them.

**Where they are ahead:** Multiview and the clip index (Holodex), song-level
tagging and a player (Musicdex), a public API (Holodex, vdb, the Taiwan
tracker), Bilibili live history at minute resolution (`vtbs.moe`), the
sort-and-scan channel list (VtuberHK sorts 672 channels by subscriber, video
and view count from the page itself), the birthday and anniversary calendars
and the dates behind them (HoloList — 9,359 entries with a debut and a
birthday apiece), and — the one architectural win that matters — incremental
fetching. A cold visit here transfers the catalogue
rather than a page of it (~2.4 MB compressed / 16 MB raw over ~220 requests),
which is the remaining performance debt against sites that ask an API for
twenty rows at a time.

### What VtuberHK has that this project does not

Read from the site on 2026-10-28. Its whole feature set is five pages, and
four of them are things this project has the data for but no view of:

| VtuberHK | What it shows | This project today | Plan |
| --- | --- | --- | --- |
| 節目 (`/`) | the live and upcoming schedule | live and upcoming **items** exist, but only per card | a **timetable** view — group the upcoming items by start time (`live-hkv.json` shows the shape: one row per stream with its start) |
| 影片 (`/archive/`) | the most recently ended streams and uploads, in YouTube's delivery order | the same items exist, with `publishedAt` | a **recent** feed, ordered by `publishedAt`, across the whole scope |
| 精華 (`/highlight/`) | a curated clip list | clips are *rejected* as duplicates (`detectClipAccount()`) | **not planned** — a clip is a fan re-upload, and the dataset hides those (`data/overrides.json`). A "clips mentioning this performer" index is Holodex's ground, not this one's |
| sorting (`頻道` by subscriber / videos / views) | three sort keys over 672 channels | `subscribers` and `videoCount` are stored, `viewCount` is not filled | `data:vtuberhk-import -- --stats` fills the three counts for HK records from `channels.json` (876 fields over 360 records); a general `data:details --stats` pass is still to be written, then the sort |
| 觀察中 (watch list) | a local list of channels to watch | the Subs view is stronger — it is account-linked and synced | nothing to build |
| `/twitch` (235 logins) | a Twitch directory for the same scene | Twitch is a platform adapter, and a record may hold both accounts | feed the logins to `data:links` as **candidates**: a login that matches a tracked performer is a cross-platform link, and the confirmation rules are the same ones a name search follows |

The two worth building are the timetable and the recent feed — both are views
over data already on disk — and the sort needs one field the details pass never
fills, which the HK roster now supplies for its own scene.

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
