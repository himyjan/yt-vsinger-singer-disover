# Platforms

> The five platforms the project tracks, how each adapter works, and what
> each one can and cannot do.

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

`scripts/lib/platform-registry.ts` assembles the concrete adapters. Adding a
platform means writing one file and registering it — nothing else in the
pipeline changes.

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
  activity: Activity;
  lastCheckedAt: string;
}
```

So one performer can be present on YouTube *and* Twitch *and* Bilibili, and
the web app renders every one of them in the "all links" block.

### Linking performers across platforms

`src/lib/auth.ts` matches a user's subscriptions against the local dataset
in two steps:

1. **Exact** — the platform channel id equals a dataset channel id.
2. **By name** — the normalised display name matches. `normalizeForMatch()`
   strips emoji, punctuation and case, so 「Sameko Saba」 and
   `sameko saba` are the same performer.

The second step is what lets a YouTube subscription of a VTuber who also
streams on Twitch be recognised.

---

## YouTube

**Adapter:** `scripts/lib/platform-registry.ts` → `YouTubeAdapter`
**Client:** `scripts/lib/youtube.ts`
**Credentials:** `YOUTUBE_API_KEY` (required)

The primary platform. See `docs/YOUTUBE-API.md` for the quota details.

- `resolve()` — `channels.list?forHandle=@handle` (1 unit).
- `uploads()` — the `UU` trick plus `playlistItems.list` and `videos.list`
  (2 units per channel for 50 videos).
- `live()` — `liveBroadcasts.list` (1 unit per 50 channels).

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
| `GET /helix/channels/followers?broadcaster_id=…` | free |

Twitch follower counts are always public, so they map straight to
`{ tag: "has", count }`.

Without credentials the whole Twitch integration is skipped and the pipeline
logs why.

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
| `GET /x/web-interface/card?mid=…` | Profile, avatar, follower count |
| `GET /x/space/arc/search?mid=…` | Recent uploads |
| `GET /x/web-interface/search/type?search_type=bili_user` | User search |
| `GET /x/relation/followings?vmid=…` | The user's follow list (needs a cookie) |
| `GET /x/web-interface/nav` | The signed-in user's id (needs a cookie) |

> **Note on the WBI signature.** In 2023 Bilibili added a WBI signature
> requirement to `space/arc/search` and `space/wbi/acc/info`. This adapter
> uses the legacy unsigned endpoints where possible and degrades to "no
> uploads" when Bilibili rejects a request, rather than failing the run.

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
`contentType`. Niconico Live has no comparable public listing endpoint, so
`live()` returns nothing.

Niconico is where a large share of Japanese VSingers publish original songs
and covers, so it is worth the adapter.

## VK

**Adapter:** `scripts/lib/platforms/vk.ts`
**Credentials:** `VK_ACCESS_TOKEN` (optional)

| Endpoint | Purpose |
| --- | --- |
| `GET /method/users.get` | Profile |
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

Whatever a channel's description links to is harvested into
`Channel.externals`:

| Key | Pattern |
| --- | --- |
| `x` | `twitter.com/<handle>` or `x.com/<handle>` |
| `instagram` | `instagram.com/<handle>` |
| `tiktok` | `tiktok.com/@<handle>` |
| `bilibili` | `bilibili.com/<space>` |
| `niconico` | `nicovideo.jp/user/<id>` |
| `discord` | `discord.gg/<code>` |
| `spotify` | `open.spotify.com/artist/<id>` |

These are rendered in the "all links" block next to the platform identities.

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
| [vdb](https://vdb.vtbs.moe/json/list.json) | ✅ | ~10,100 performers on 35 platforms, their group and language |
| [Taiwan VTuber Tracking Data](https://taiwanvtuberdata.github.io/) | ✅ | YouTube and Twitch ids, aliases, nationality, debut and graduation dates |
| [VocaDB](https://vocadb.net) | ✅ | Artists with their platform links, their songs and their releases |
| [AiSList](https://github.com/Override92/AiSList) | ✅ | The channels that use AI-generated content |
| [VTuber Music Dataset](https://github.com/meihei3/VTuber-music-dataset) | ✅ | The song and the original artist for each cover |
| [Wikidata](https://query.wikidata.org/sparql) | ✅ | The YouTube id, the agency, the gender, the country, the inception |
| [Wikipedia REST](https://en.wikipedia.org/api/rest_v1/) | ✅ | A one-line description, the lead paragraph, the infobox image |
| [Virtual YouTuber Wiki](https://virtualyoutuber.fandom.com/) | — | Wiki identities and debut dates |
| [Hololist](https://hololist.net) | — | Hololive talents — agency-limited, so it adds little |
| [bacharu](https://bacharu.io) | — | A Japanese directory — a client-side app with no public data |
| [Vtubie](https://vtubie.com) | — | A directory with follower counts — blocks automated requests |
| [AI VTuber DB](https://aivtuberdb.com) | — | A list of AI VTubers — no machine-readable file |
| [PVC.moe](https://pvc.moe) | — | Profile data — only in the client bundle |
| [VTuber.hk](https://vtuber.hk) | — | Hong Kong VTubers — no documented format |
| [Streams Charts](https://streamscharts.com/vtubers) | — | Channel statistics — blocks automated requests |

## The quota-free sources

| Platform | Official API | Quota-free equivalent | Credentials |
| --- | --- | --- | --- |
| YouTube | Data API v3 | **InnerTube** (`youtubei.js`) | none |
| Twitch | Helix | **GQL** (`gql.twitch.tv/gql`) | the public web client id |
| Bilibili | — | the WBI-signed public API | the visitor id (`buvid3`) |

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
