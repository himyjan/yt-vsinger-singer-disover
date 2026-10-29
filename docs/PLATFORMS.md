# Platform adapters and identities

> The platforms with profile/media adapters, plus the wider set of
> cross-platform identities retained from public rosters.

## The adapter interface

Every platform implements `scripts/lib/platforms.ts`:

```ts
export interface PlatformAdapter {
  id: PlatformId;
  label: string;
  color: string;

  isConfigured(): boolean;
  unavailableReason(): string | null;

  resolve(query: string): Promise<PlatformChannel | null>;
  uploads(channel: PlatformChannel, limit: number): Promise<PlatformUpload[]>;
  live(channel: PlatformChannel): Promise<PlatformUpload[]>;
  search?(query: string, limit: number): Promise<PlatformChannel[]>;
}
```

`scripts/lib/platform-registry.ts` assembles the concrete adapters. The
currently implemented adapters cover YouTube, Twitch, Bilibili, Niconico, VK,
CHZZK, KICK, SOOP and CI.ME. Public roster links from vdb are retained for
additional platforms even when this project does not yet have a profile or
media adapter for them.

The important rule: **an adapter that fails must never break the run**. Every
network call is wrapped so that a changed API, a rate limit or an outage
degrades to "no results", not a crashed sync.

## Channel identity across platforms

A `Channel` record carries a list of `PlatformLink`s:

```ts
interface PlatformLink {
  platform: PlatformId;
  id: string;          // platform-native id
  handle: string | null;
  name: string | null;
  url: string;
  subscribers: CountRef;
  avatar: string | null;
  lastCheckedAt: string;
}
```

So one performer can be present on YouTube *and* Twitch *and* Bilibili, and
the web app renders every one of them in the "all links" block.

There is deliberately **no** per-platform `activity`: whether a performer has
graduated is a fact about the performer, not about one account, so it lives
on the record.

### Linking performers across platforms

`src/lib/auth.ts` matches a user's subscriptions against the local dataset
in two steps:

1. **Exact** — the platform channel id equals a dataset channel id.
2. **By name** — the normalised display name matches. `normalizeForMatch()`
   strips emoji, punctuation and case, so 「Sameko Saba」 and
   `sameko saba` are the same performer.

The second step is what lets a YouTube subscription of a VTuber who also
streams on Twitch be recognised.

### Discovering the links a record is missing

A vdb record often lists only a Bilibili account, so the YouTube or Twitch
identity exists but the dataset does not know it. `npm run data:links` looks
for it in the performer's own text (the Bilibili signature, the About page),
their **X bio** read through FxTwitter, Wikidata by name, YouTube's own
channel search by the record's display name (InnerTube, no Data API quota),
and — with `--web` — a search-grounded model.

A name-search result is a candidate until the resolved profile proves it:
the Bilibili space id or X handle has to appear in the profile, or its title
has to be one of the record's distinctive names — containment either way, so
「雫るる」 confirms 「雫るる_Official」 — and it must not be a clip or fan
account, which is named after its subject and therefore matched first. Only
then is the `PlatformLink` written.

Once the link is written the record is re-keyed to the YouTube channel's
`UC…` id (`canonicalizeChannelIds()`), its items re-pointed, and a duplicate
with an existing YouTube record merged. `--platform <id>` and `--region
<code>` narrow the queue; the Japanese Bilibili backlog is
`--platform bilibili --region jp`.

The discovered account also supplies the one fact a mirror cannot: YouTube
publishes the channel's **country**, and a country outranks the "Bilibili
only, so Chinese" prior. That is what moves a Japanese performer out of `cn`
without letting a mirror rename them.

---

## YouTube

**Adapter:** `scripts/lib/platform-registry.ts` → `YouTubeAdapter`
**Client:** `scripts/lib/youtube.ts`
**Credentials:** `YOUTUBE_API_KEY` (optional)

YouTube is the primary platform. The pipeline uses InnerTube (`youtubei.js`)
for handle resolution, channel and video search, channel profiles, uploads,
releases and the Live tab without an API key. When configured, the Data API
supplements that path with detailed video statistics and exact broadcast
start/end times; it is also a fallback for a profile or uploads lookup that
InnerTube cannot complete. See `docs/YOUTUBE-API.md` for quota details.

- `search()` — InnerTube channel or video search; the Data API is used only
  when configured and within quota.
- `resolve()` — InnerTube handle resolution; Data API fallback (1 unit).
- `uploads()` — InnerTube channel uploads; Data API fallback using the `UU`
  trick plus `playlistItems.list` and `videos.list` (2 units per 50 videos).
- `live()` — InnerTube channel Live tab (live and upcoming only); a successful
  empty check retires a stale live item, a failed check changes nothing.
  `liveBroadcasts.list` is not used: it requires OAuth, and the scheduled
  pipeline only has an API key.

## Twitch

**Client:** `scripts/lib/twitch.ts`
**Credentials:** `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` (optional)

Twitch Helix API, behind an app access token obtained with the client
credentials grant.

| Endpoint | Cost |
| --- | --- |
| `GET /helix/users?login=…` | free |
| `GET /helix/channels?broadcaster_id=…` | free |
| `GET /helix/streams?user_id=…` | free |
| `GET /helix/search/channels?query=…` | free |
| `GET /helix/channels/followers?broadcaster_id=…` | free |

Twitch follower counts are always public, so they map straight to
`{ tag: "has", count }`.

With credentials, the sync discovers channels by its configured keywords and
checks their live streams. Without credentials, Twitch discovery and live
checks are skipped and the pipeline logs how to enable them.

### Account linking

Twitch account linking uses **OAuth 2.0 with PKCE** — a public client, so no
client secret is needed in the browser and the flow works entirely
client-side.

```
authorize → code_challenge (S256)
token     → code_verifier
```

The scope is `user:read:follows`, and the followed channels come from
`GET /helix/channels/followed?user_id=…`.

## Bilibili

**Adapter:** `scripts/lib/platforms/bilibili.ts`
**Credentials:** none — the public web API works

| Endpoint | Purpose |
| --- | --- |
| `GET /x/web-interface/card?mid=…` | Profile, avatar, follower count, video count |
| `GET /x/space/wbi/arc/search?mid=…` | Recent uploads (WBI signed) |
| `GET /x/space/wbi/acc/info?mid=…` | The modern profile endpoint (WBI signed) |
| `GET /x/relation/stat?vmid=…` | The follower count |
| `GET /x/web-interface/search/type?search_type=bili_user` | User search |
| `GET /x/relation/followings?vmid=…` | The user's follow list (needs a cookie) |
| `GET /x/web-interface/nav` | The signed-in user's id (needs a cookie) |
| `GET /x/frontend/finger/spi` | The visitor id (`buvid3`) |

### The 412 wall

Bilibili answers a burst of requests with **HTTP 412**, and a rejected
request with `-352 风控校验失败` in the body. Neither is an error in the
usual sense — it is the risk-control system saying "this looks automated".

What the reference implementations do, and what this adapter does too:

- **Send a visitor id.** `buvid3` from `x/frontend/finger/spi`, as a cookie,
  exactly as the browser sends it.
- **Rotate it on rejection.** A `buvid3` that was just refused is unlikely
  to be accepted on the next attempt, so a fresh one is fetched.
- **Back off quickly.** The breaker trips after a few rejections and the
  adapter stops calling Bilibili for the rest of the run, rather than
  grinding through thousands of doomed requests.

The `x/web-interface/card` endpoint is the workhorse: it is **not** behind
the wall, and it carries the name, the avatar, the signature, the follower
count and the video count in one request. `space/*` is behind it.

### Avatars are HTTPS and no-referrer

The profile `face` is usually `http://i0.hdslb.com/…`. The app is served over
HTTPS, so the adapter rewrites it to `https://` (`absoluteUrl()`), and the
committed dataset stores only the HTTPS form. Bilibili's CDN also answers
**403** when the request carries a foreign `Referer` (the deployed site's
own origin), so every rendered `<img>` sets `referrerpolicy="no-referrer"`.
`src/lib/image.ts` applies the HTTPS rewrite once more at render time, which
covers cached or older JSON.

> **Note on the WBI signature.** In 2023 Bilibili added a WBI signature
> requirement to `space/arc/search` and `space/wbi/acc/info`. The signature
> is `md5(sortedQuery + wts + mixinKey)`, where the mixin key comes from
> the two key file names in `/x/web-interface/nav` — **without** their
> `.jpg` extensions. Taking the extension with them produces a key that
> looks right and is rejected by every request.
>
> The `web_location` parameter is not required. The reference implementation
> ([biliscope](https://github.com/gaogaotiantian/biliscope), PR #287) dropped
> it, and the signed request works without it.
>
> `space/wbi/acc/info` additionally wants a `w_webid` — the `access_id` from
> the space page's `__RENDER_DATA__` — and answers `-352` without it.

### Account linking

Bilibili has **no public OAuth that exposes your follow list**. The
practical route is the `SESSDATA` cookie:

1. sign in at bilibili.com,
2. open the developer tools → Application → Cookies,
3. copy the `SESSDATA` value.

The app stores it in `localStorage` like any other token and only ever sends
it to Bilibili's own API.

## Niconico

**Adapter:** `scripts/lib/platforms/niconico.ts`
**Credentials:** none

Niconico's public search API v2:

```
GET https://api.search.nicovideo.jp/api/v2/video?query=…&targets=tagsExact
GET https://api.search.nicovideo.jp/api/v2/channel?query=…
```

Returns `contentId`, `title`, `tags`, `viewCounter`, `startTime` and
`contentType`. The sync stores videos returned directly by discovery and
derives candidate channels from their authors. Niconico Live has no comparable
public listing endpoint, so `live()` returns nothing.

Niconico is where a large share of Japanese VSingers publish original songs
and covers, so it is worth the adapter.

## VK

**Adapter:** `scripts/lib/platforms/vk.ts`
**Credentials:** `VK_ACCESS_TOKEN` (optional)

| Endpoint | Purpose |
| --- | --- |
| `GET /method/users.get` | Profile |
| `GET /method/users.search` | Channel discovery (requires `VK_ACCESS_TOKEN`) |
| `GET /method/video.get` | Uploads |
| `GET /method/channels/followers` | Follower count |

Without a token the adapter still resolves the profile from the screen name.

### Account linking

VK uses the **implicit OAuth flow**:

```
https://oauth.vk.com/authorize?client_id=…&scope=friends&response_type=token
```

The token comes back in the URL fragment.

VK has no concept of "subscribed channels" — the closest equivalent for the
VTuber scene is the user's **friend list**, which is what the provider
surfaces. The app labels it accordingly.

---

## External handles

Links found in YouTube channel descriptions and its dedicated About-page
Links section, plus other refreshed platform profile descriptions, are
harvested into `Channel.externals`. The dedicated YouTube Links section is
read during profile detail/import fetches:

| Key | Pattern |
| --- | --- |
| `youtube` | `youtube.com/channel/<id>`, `youtube.com/@<handle>`, `/user/<handle>` or `/c/<handle>` |
| `youtube_video` | `youtu.be/<video-id>`, `youtube.com/watch?v=<video-id>`, `/shorts/<id>` or `music.youtube.com/watch?v=<id>` |
| `youtube_playlist` | `youtube.com/playlist?list=<id>` or `music.youtube.com/playlist?list=<id>` |
| `twitch` | `twitch.tv/<login>` |
| `x` | `twitter.com/<handle>` or `x.com/<handle>` |
| `instagram` | `instagram.com/<handle>` |
| `tiktok` | `tiktok.com/@<handle>` |
| `bilibili` | `space.bilibili.com/<uid>` or `bilibili.com/space/<uid>` |
| `niconico` | `nicovideo.jp/user/<id>` |
| `vk` | `vk.com/<handle>` |
| `chzzk` | `chzzk.naver.com/<channel-id>` |
| `kick` | `kick.com/<slug>` |
| `soop` | `sooplive.com/station/<id>` or `ch.sooplive.co.kr/<id>` |
| `discord` | `discord.gg/<code>` |
| `spotify` | `open.spotify.com/artist/<id>` or `/user/<id>` |
| `ci.me` | `ci.me/<channel-handle>` |

The YouTube channel, Twitch, Bilibili, Niconico, VK, CHZZK, KICK, SOOP and
CI.ME patterns cover the supported platforms; social, music, YouTube video and
playlist links are collected as well. These are rendered in the "all links"
block next to the platform identities.

The YouTube profile's About-page Links section is read through InnerTube
during the details/import pass, including links to Bilibili, videos and
playlists.

YouTube playlist links collected in a DOCX can be imported with
`npm run data:import-playlist -- "path/to/playlist.docx"`. The importer uses
oEmbed metadata to match uploaders to existing channel ids or exact handles,
verifies a published country through InnerTube when available, and writes
unmatched or unclear entries to `.cache/playlist-import-unmatched.json` for
manual review instead of assigning a new channel kind.

Bilibili's broad live feed is filtered to known identities. Ranking results
can add a channel only when the Bilibili identity is explicitly curated or
linked to a known YouTube channel; Bilibili-only roster entries must be
curated rather than bulk-imported.

## CHZZK, KICK and SOOP

These platforms have public endpoints that need no credentials.

| Platform | Endpoint | Gives |
| --- | --- | --- |
| **CHZZK** (Naver) | `GET api.chzzk.naver.com/service/v1/channels/{id}` | name, image, description, follower count, live state |
| | `GET api.chzzk.naver.com/service/v3/channels/{id}/live-detail` | the live stream |
| | `GET api.chzzk.naver.com/service/v1/channels/followings` | the user's followed channels (needs a cookie) |
| **KICK** | `GET kick.com/api/v2/channels/{login}` | slug, follower count, bio, profile picture, the performer's social accounts, the live stream |
| | `GET kick.com/api/v2/channels/{login}/videos` | the recent VOD list (the adapter does not ingest it) |
| | `GET kick.com/api/v2/channels/followed` | the user's followed channels (needs a token) |
| | `GET api.kick.com/public/v1/users` | the signed-in user (needs a token) |

The sync discovers CHZZK channels with the public
`GET /service/v1/search/channels` endpoint, refreshes their profiles and checks
their current live streams. KICK profiles and live streams can be refreshed
for known identities, but its web search endpoint is not a usable public API,
so KICK candidates come from the global roster, a seed and the suggestions
queue rather than keyword discovery.

Two KICK details are easy to get wrong:

- **The picture is `user.profile_pic`.** `user.profile_image_url` is a
  YouTube-shaped name that KICK never sends, and an adapter that asks for it
  stores a null avatar for every KICK record. An account that never uploaded
  one answers `…/default1-fullsize.webp`, which
  `isPlaceholderAvatar()` rejects.
- **The timestamps are `"2026-10-29 10:17:56"`** — UTC, a space instead of
  the `T` and no zone. `Date.parse()` reads that as local time, so
  `kickTimestamp()` normalises it to ISO 8601 before it reaches an item.

Category discovery — `GET api.kick.com/public/v1/channels?category_id=…`, the
endpoint the KICK SDKs wrap — needs an **app access token**; without one the
`kick.com/public/…` paths answer 404 and `api.kick.com` answers 401. So the
pipeline does not enumerate the VTuber category: a KICK record has to be known
by its login first (roster, seed or suggestion), and the details pass then
refreshes it.

SOOP's unauthenticated `main_broad_list_api.php` endpoint provides a
paginated global live list with broadcast titles, streamer IDs and viewer
counts. The configured discovery terms are matched locally against the first
page; this is not a server-side channel search. The adapter cannot resolve
offline profiles or reliably find a channel outside that page. It filters
password-protected broadcasts, caches the page briefly, and uses the direct
play URL for the Watch link. SOOP's profile endpoint was not verified, so the
adapter does not depend on it.

## CI.ME

The [CI.ME Open API](https://developers.ci.me/docs/api-channels) documents
`GET /api/openapi/open/v1/channels` for
retrieving profile data by one or more channel IDs (up to 20 per request).
It returns channel name, handle, image, description and follower count. The
endpoint uses the app's `Client-Id` and `Client-Secret`; configure these as
`CI_ME_CLIENT_ID` and `CI_ME_CLIENT_SECRET` in the dataset sync environment.
The secret is never exposed to the web app. The adapter refreshes profiles
for known CI.ME IDs, and because the endpoint accepts a comma-separated list
it implements `resolveMany()`: the details pass hands it a batch and spends
one request per twenty records instead of one per record.

**Live status is public and per channel**:

```
GET https://ci.me/api/openapi/v1/{channelId}/live-status
```

It needs no credentials and answers `{ isLive, title, openedAt }`, so
`CiMeAdapter.live()` works in a run with no client ID — the platform-wide
live list (`GET /api/openapi/open/v1/lives`, the `cime-sdk`
`client.live.getLives()` path) is behind the client credentials and is no
longer used for live checking. That list also could not be attributed: it was
fetched once and returned for *every* channel, so each CI.ME record looked
live whenever anyone on the platform was streaming.

The documented API does not include a user follow-list endpoint, public
channel search or uploads. CI.ME therefore refreshes only known IDs when
credentials are configured; it does not discover channels or media. The
project does not offer CI.ME account linking or subscription import.

### Multi-platform live streaming

The sync checks live/upcoming status across platforms on every run:

- **YouTube** — InnerTube channel Live tab (`liveStreams()`), checked for all
  YouTube-keyed records (`maxLiveChannelsPerRun` default 50,000, not shard-limited).
- **Twitch** — Twitch GQL profile's `live` field, checked during the details pass
  for channels linked to Twitch.
- **Bilibili** — `GET /x/web-interface/online/list?rid=160` (VTuber partition
  live feed), fetched via `search()` once per run and filtered against known
  VTuber channel ids (`knownMids`). Ended streams are retired to `past`.
- **CHZZK** — `GET /service/v3/channels/{id}/live-detail`, checked for channels
  linked to CHZZK.
- **KICK** — `GET /api/v2/channels/{login}`, checked for channels linked to KICK.
- **SOOP** — `main_broad_list_api.php` live list, matched against SOOP-linked channels.

- **CI.ME** — `GET /api/openapi/v1/{channelId}/live-status`, checked for
  channels linked to CI.ME. It is public: no client ID is needed, and it is
  asked per channel, so a stream is attributed to the channel that is on air.
  CI.ME-keyed records are included even when they have no YouTube channel.

Ended streams are retired to `past` on every run so the Live page stays current.
Non-singing VTubers are included — the live check is not gated on `isSinging`.


## Sync discovery coverage

The scheduled and manually triggered sync runs the platform searches enabled
by the configured adapters:

| Platform | Discovery / collection |
| --- | --- |
| YouTube | InnerTube channel and video search, uploads and Live tab; Data API search and video details when configured and within quota |
| Twitch | Keyword channel search and live streams; requires `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` |
| Bilibili | Ranking results add only curated or YouTube-linked accounts; live streams and uploads are identity-filtered |
| Niconico | Keyword video search; stores matched videos and derives their author channels |
| VK | User search and recent videos; discovery requires `VK_ACCESS_TOKEN` |
| CHZZK | Public keyword channel search and live streams |
| SOOP | Matches configured terms against the first page of its global live feed |
| KICK | Refreshes known profiles, the performer's published accounts and live streams; category discovery needs an app access token |
| CI.ME | Refreshes known channel IDs with configured credentials; live status is public and per channel; public search/media endpoints are unavailable |

The sync logs when a platform is skipped because credentials are missing or
discovery is unavailable. `--no-search` skips keyword discovery across all
platforms while still refreshing known records.

Search results are only candidates, not proof that an account belongs in the
catalogue. Before adding a channel or its discovered media, sync requires its
platform ID or handle to match vdb, an existing dataset record, or the curated
seed catalog on non-YouTube platforms, including Niconico authors and broad
live feeds. YouTube is also allowed to add results from singing-focused
queries, but a new YouTube channel is added to the virtual dataset only after
at least two distinct videos mention both a VTuber/VSinger identity and
singing evidence in their titles, descriptions, or tags. Singing evidence
includes terms such as 歌枠, 歌枠リレー, 歌ってみた, 弾き語り, KARAOKE,
singing, or nyanyi. This supports changing relay hashtags (for example,
`#UNKNOWN歌枠リレー`) without maintaining a fixed list of event names, while
preventing an ordinary singer or karaoke streamer from being labelled virtual
based on singing terms alone. Existing records are never removed by these
filters. If vdb is unavailable, non-YouTube discovery fails closed and
accepts only existing or seeded identities.

### Discovery keywords and manual queries

The scheduled sync uses the per-platform terms in
[`config/platform-keywords.json`](../config/platform-keywords.json). A manual
workflow run can supply one `keyword` to query the enabled platforms instead
of their configured terms. Results vary by platform: some searches find
channels directly, while Niconico finds videos and infers their authors, and
SOOP only checks its first page of live broadcasts. All results still pass
through the identity allowlist above.

The YouTube API key is optional. YouTube discovery runs entirely through
InnerTube when the Data API key is absent or the search budget is exhausted:
channel queries find candidate channels, and video queries find singing uploads
whose channel is then verified. Twitch and VK discovery do need their Actions
secrets. A platform without search support is not searched just because a
manual keyword was provided; the run logs the limitation and continues with
supported platforms.

`--no-search` (or the workflow's **Skip discovery searches** input) skips
keyword discovery on YouTube and other platforms, but still refreshes known
channel profiles and their available media.

## Account-linking coverage

Account linking is separate from the pipeline adapters above. A platform can
be supported for channel profiles or live discovery without exposing a
user's followed channels.

| Platform | Followed channels available in the app | Link method / limitation |
| --- | --- | --- |
| YouTube | Yes — subscriptions | Google OAuth |
| Twitch | Yes — followed channels | OAuth 2.0 with PKCE |
| Bilibili | Yes — followed users | `SESSDATA` cookie |
| Niconico | Yes — followed users | `user_session` cookie |
| CHZZK | Yes — followed channels | `NaverLogin` cookie |
| KICK | Yes — followed channels | OAuth 2.1 with PKCE, or `kick_session` cookie |
| VK | Partial — friends, not channel subscriptions | Implicit OAuth; friend list is the closest equivalent |
| SOOP | No | Public live-list integration only; no account-link provider |
| CI.ME | No | Profile lookup only; no documented follow-list endpoint/provider |

## The source registry

`scripts/lib/sources.ts` lists every data source the project knows about,
what it provides, and whether the pipeline actually reads it. It exists so
that adding a source is one adapter plus one line, and so the project is
honest about the well-known databases it *cannot* read.

| Source | Read? | Provides |
| --- | --- | --- |
| YouTube Data API v3 | ✅ | Channels, uploads, live streams, statistics |
| Twitch Helix | ✅ | Live streams, follower counts, followed channels |
| Bilibili | ✅ | Chinese VTuber channels, uploads, follower counts |
| Niconico | ✅ | Japanese original songs and covers |
| VK | ✅ | The Russian VTuber scene |
| [vdb](https://vdb.vtbs.moe/json/list.json) | ✅ | 10,138 identity records (9,903 performers) on up to 35 platforms, their group and language |
| [Taiwan VTuber Tracking Data](https://taiwanvtuberdata.github.io/) | ✅ | YouTube and Twitch ids, aliases, nationality, debut and graduation dates |
| [VocaDB](https://vocadb.net) | ✅ | Artists with their platform links, their songs and their releases |
| [AiSList](https://github.com/Override92/AiSList) | ✅ | The channels that use AI-generated content |
| [VTuber Music Dataset](https://github.com/meihei3/VTuber-music-dataset) | ✅ | The song and the original artist for each cover |
| [Wikidata](https://query.wikidata.org/sparql) | ✅ | The YouTube id, the agency, the gender, the country, the inception |
| [Wikipedia REST](https://en.wikipedia.org/api/rest_v1/) | ✅ | A one-line description, the lead paragraph, the infobox image |
| [Virtual YouTuber Wiki](https://virtualyoutuber.fandom.com/) | — | Wiki identities and debut dates |
| [HoloList](https://hololist.net) | ✅ | 9,359 entries — 905 V-Singer, 3,751 V-Streamer, 9,127 V-Tuber, 143 V-UP — with the debut, birthday, affiliation, languages, status and the performer's Twitch / X / Instagram / TikTok / Bilibili / Niconico accounts; read from its sitemaps by `npm run data:hololist` (one page per entry, incremental on `<lastmod>`) |
| [bacharu](https://bacharu.io) | ✅ | A directory of 109,828 performers and 685 groups — a JSON API read by `npm run data:bacharu` (109,828 rows, ~1,099 pages). `npm run data:bacharu-import -- --links --apply` attaches social accounts to tracked records; `--hints --apply` fills empty region, debutDate and gender |
| [vTubie](https://vtubie.com/allvtubers/) | ✅ | A directory with follower counts — read with a browser, because the pages sit behind a Cloudflare challenge (`npm run data:discover`) |
| [AI VTuber DB](https://aivtuberdb.com) | — | A list of AI VTubers — no machine-readable file |
| [PVC.moe](https://pvc.moe) | — | Profile data — only in the client bundle |
| [VTuber.hk](https://vtuber.hk) | ✅ | 672 Hong Kong channels with their state (活動中 / 準備中 / 己引退), plus `/data/channels.json` statistics and `live-hkv` / `archive-hkv` — read by `npm run data:vtuberhk` |
| [Holodex](https://holodex.net) | — | A YouTube stream index with a clip index and Multiview — the API needs a key (`HOLODEX_API_KEY`) and answers `403` without one |
| [Musicdex](https://music.holodex.net) | — | Songs and set lists tagged out of singing streams — the same API and key |
| [Streams Charts](https://streamscharts.com/vtubers) | — | Channel statistics — blocks automated requests |

## The quota-free sources

| Platform | Official API | Quota-free equivalent | Credentials |
| --- | --- | --- | --- |
| YouTube | Data API v3 | **InnerTube** (`youtubei.js`) | none |
| Twitch | Helix | **GQL** (`gql.twitch.tv/gql`) | the public web client id |
| Bilibili | — | the WBI-signed public API | the visitor id (`buvid3`) |
| CHZZK | — | the public API | none |
| KICK | — | the public API | none |

All three go through `scripts/lib/rate-limit.ts`, which keeps a minimum gap
between requests, doubles it when a source pushes back, and relaxes it again
once the source is quiet.

With **no YouTube API key at all**, the pipeline still fills the dataset:
the profiles come from InnerTube and Twitch GQL, and the uploads from
InnerTube.

## The Bilibili risk-control wall

Bilibili protects its per-user profile endpoint
(`x/web-interface/card`) with a captcha: a request without a session cookie
is answered with **HTTP 412**, not a JSON error. Node's TLS fingerprint is
enough to trip it, so the profile cannot be fetched from the pipeline.

The endpoints that *are* reachable, and are used:

| Endpoint | Status | Used for |
| --- | --- | --- |
| `x/web-interface/ranking/v2?rid=160` | 200 | Discovering VTuber channels |
| `x/web-interface/online/list?rid=160` | 200 | Live VTuber streams |
| `x/space/arc/search?mid=` | 200 | A channel's uploads |
| `x/relation/stat?vmid=` | 200 | **The follower count** |
| `x/web-interface/card?mid=` | **412** without a visitor id | The name, avatar and signature |
| `x/space/arc/search?mid=` | 200 with a WBI signature | The uploads |

So the follower count is fetched and stored, and the channel *description*
from Bilibili is not — a channel that only exists there simply has no
description until the API can be reached. The WBI signature
(`scripts/lib/platforms/bilibili.ts`) is implemented anyway, because Bilibili
does require it for `space/arc/search` from some networks.

## Adding a platform

1. Write `scripts/lib/platforms/<name>.ts` implementing `PlatformAdapter`.
2. Register it in `scripts/lib/platform-registry.ts`.
3. Add discovery keywords to `config/platform-keywords.json`.
4. Add the platform to `PLATFORM_ID` in `scripts/lib/types.ts` and to
   `PLATFORM_LABELS` / `PLATFORM_URLS` in `scripts/lib/platforms.ts`.
5. Add a label and colour to `src/lib/links.ts`.

That is all — the sync, the dataset layout and the web app pick it up
automatically.
