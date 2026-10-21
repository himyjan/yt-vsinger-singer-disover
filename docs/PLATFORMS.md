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

## Adding a platform

1. Write `scripts/lib/platforms/<name>.ts` implementing `PlatformAdapter`.
2. Register it in `scripts/lib/platform-registry.ts`.
3. Add discovery keywords to `config/platform-keywords.json`.
4. Add the platform to `PLATFORM_ID` in `scripts/lib/types.ts` and to
   `PLATFORM_LABELS` / `PLATFORM_URLS` in `scripts/lib/platforms.ts`.
5. Add a label and colour to `src/lib/links.ts`.

That is all — the sync, the dataset layout and the web app pick it up
automatically.
