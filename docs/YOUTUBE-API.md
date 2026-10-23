# YouTube Data API v3

> How the pipeline talks to YouTube, what it costs, and how to stay inside the
> free tier.

YouTube is the project's primary platform. InnerTube (`youtubei.js`) is the
default source for handle resolution, channel profiles and uploads. The
YouTube Data API v3 is optional and supplements InnerTube with discovery,
live-broadcast data and detailed video metadata; it is also a fallback when
InnerTube cannot retrieve a channel profile or uploads. When the API key is
missing or the search quota runs out, channel discovery falls back to
InnerTube's public channel search (no Data API quota). InnerTube fallback
currently discovers channels only; video search and its richer metadata
require the Data API. These are access methods for YouTube data, not separate
platforms. See `docs/SOURCES.md` for the source overview.

Search hits are candidates, not automatic channel admissions. For a new
YouTube identity to enter the virtual dataset, sync checks two or more distinct
uploads and requires each video to show both virtual-creator identity (such as
VTuber, VSinger, or localized equivalents) and singing evidence (such as
歌枠, 歌ってみた, 弾き語り, KARAOKE, or a singing-relay hashtag) in its
title, description, or tags. With InnerTube-only discovery, verification uses
the upload titles it can retrieve; with the Data API, video descriptions and
tags are available too. An existing dataset, vdb, or curated seed identity
does not need to pass this new-channel gate. This rejects ordinary singers and
karaoke streamers based on singing terms alone while allowing varying event
hashtag names.

## Optional API key

You can run the sync pipeline without a key. Add one only if you want the
Data API features listed above:
1. Open the [Google Cloud console](https://console.cloud.google.com/apis/credentials).
2. Create a project.
3. Enable **YouTube Data API v3**.
4. Create an **API key**.
5. Store it as the repository secret `YOUTUBE_API_KEY`.

The key is only ever used server-side, from the sync pipeline. It is **not**
baked into the web app — the browser app uses the committed dataset, and the
only browser-side API calls are the account-scoped ones, which use an OAuth
token instead.

## Quota costs

A default project gets **10,000 units per day**. The costs that matter:

| Request | Units | Used for |
| --- | ---: | --- |
| `search.list` | **100** | Discovery — finding new channels and videos |
| `channels.list` | 1 | Channel details, up to 50 ids per call |
| `videos.list` | 1 | Video details, up to 50 ids per call |
| `playlistItems.list` | 1 | A channel's uploads, 50 per page |
| `playlists.list` | 1 | Playlist details |
| `liveBroadcasts.list` | 1 | Live and upcoming streams, 50 channels per call |
| `subscriptions.list` | 1 | The user's subscriptions (browser-side, OAuth) |
| `activities.list` | 1 | Channel activity |

The asymmetry is the whole game: **one search costs as much as fifty channel
lookups**. The pipeline is built around that:

- known channels are refreshed with `channels.list` (1 unit per 50);
- their uploads come from `playlistItems.list` (1 unit per 50);
- video details come from `videos.list` (1 unit per 50);
- `search.list` is spent only on discovery, and only for as many keywords as
  the budget allows.

### What a run costs

A typical run with 40 discovery searches, 60 refreshed channels and their
uploads:

| Step | Calls | Units |
| --- | ---: | ---: |
| Discovery searches | 40 | 4,000 |
| Seeded channels | 3 | 3 |
| Known channels | 20 | 20 |
| Uploads (60 channels) | 60 | 60 |
| Video details | 60 | 60 |
| Live broadcasts | 2 | 2 |
| **Total** | | **~4,145** |

Which is why the workflow runs every six hours with a **2,500-unit** budget
by default: four runs a day stay comfortably inside 10,000, and the quota
state is cached between runs so the budget is cumulative, not per-run.
For each new YouTube candidate that reaches the qualification check, the Data
API may additionally spend one unit on its first ten uploads and one unit on
their video details. The quota-free InnerTube upload check is used first.

## The quota guard

`scripts/lib/youtube.ts` implements `QuotaBudget`:

- the spent counter is persisted to `.cache/quota.json` and **reset daily**,
  matching YouTube's own reset;
- `canAfford(cost)` refuses any call that would exceed the limit;
- quota and permission errors (`quotaExceeded`, `accessNotConfigured`,
  `forbidden`) are **never retried** — retrying cannot help;
- 429 and 5xx responses are retried with exponential backoff and jitter.

The sync workflow restores `.cache` between runs with `actions/cache`, so the
budget really is cumulative across the day.

## Caching

Every response is written to `.cache/youtube/<hash>.json`, keyed by the request
URL. A re-run of the sync re-uses the cached responses and only spends quota
on genuinely new data.

To force a clean run:

```bash
rm -rf .cache && npm run data:sync
```

## The caching trick that saves the most quota

A YouTube channel id `UCxxxxx` has an uploads playlist `UUxxxxx` — the same
id with the first two characters replaced. So the pipeline never needs
`playlists.list` to find a channel's uploads: it derives the playlist id
directly.

```ts
uploadsPlaylistId("UC1234567890") === "UU1234567890"
```

## Useful endpoints in detail

### `channels.list`

```http
GET /youtube/v3/channels?part=snippet,contentDetails,statistics,brandingSettings&id=UC...,UC...
```

Returns the display name, description, tags, avatar, banner, subscriber count
and the uploads playlist for up to 50 channels in one unit.

`contentDetails.relatedPlaylists.uploads` is the playlist id. When it is
absent, the `UU` trick still works for `UC` ids.

### `playlistItems.list`

```http
GET /youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=UU...&maxResults=50
```

One unit per 50 videos. `snippet.resourceId.videoId` is the video id.

### `videos.list`

```http
GET /youtube/v3/videos?part=snippet,statistics,contentDetails,liveStreamingDetails,status&id=...
```

One unit per 50. This is where the useful extras come from:

- `contentDetails.duration` — the ISO-8601 duration (`PT3M42S`);
- `liveStreamingDetails.scheduledStartTime` — when a premiere or stream is set
  to start;
- `liveStreamingDetails.actualStartTime` / `actualEndTime`;
- `liveStreamingDetails.concurrentViewers` — the live viewer count;
- `statistics.viewCount`, `statistics.likeCount`.

### `liveBroadcasts.list`

```http
GET /youtube/v3/liveBroadcasts?part=snippet,contentDetails,status&broadcastStatus=all&id=UC...,UC...
```

One unit per 50 channels. `broadcastStatus=all` returns **upcoming**,
**live** and finished broadcasts — this is the cheapest way to collect the
"live now" and "scheduled" data.

### `search.list`

```http
GET /youtube/v3/search?part=snippet&type=channel|video&q=...&order=date|viewCount&maxResults=50
```

**100 units.** `order=date` can surface newer results; the sync uses its
configured channel/video queries and treats hits as candidates. New YouTube
channels must still pass the two-distinct-video virtual-identity and singing
evidence check above. `eventType=live` restricts results to live streams.

Channel searches find candidate identities. Video searches can surface
singing-related uploads; their channel still has to pass the same two-distinct
video qualification check before a new record is admitted.

## The `UU` trick and `forHandle`

To resolve an `@handle` to a canonical channel id:

```http
GET /youtube/v3/channels?part=snippet&forHandle=@someone
```

One unit per handle. The curated seed list uses handles, and each one costs a
unit to resolve — so the seed list is resolved once and the result is
committed.

## InnerTube and authentication

The pipeline uses **`youtubei.js`** (InnerTube) by default for quota-free
profile, upload and channel-discovery data. It is an unofficial interface and
can change without notice; when configured, the Data API is used for
discovery, live-broadcast data, detailed video metadata and as a fallback for
failed InnerTube lookups. The `Sync dataset` GitHub Action runs the configured
searches; a manual run can provide a custom `keyword` instead. Without an API
key, channel keyword searches still run through InnerTube. The optional local
dev server also uses InnerTube for interactive YouTube features.

The pipeline reads public data only, so no OAuth token is required
server-side. The browser app uses OAuth for account-scoped features such as
the user's own subscriptions.

## Troubleshooting

**`403 quotaExceeded`** — the daily allowance is spent. The quota state file
shows the total. Reduce `maxSearchesPerRun` in `config/sync.config.json`, or
raise the budget in the Google Cloud console.

**`403 accessNotConfigured`** — the YouTube Data API v3 is not enabled for
the project, or the key belongs to a different project.

**`403 keyInvalid`** — the key was deleted or the API key was restricted to
an API that is not enabled.

**Empty results, no errors** — the channel's uploads are private, or the
channel id was a `UU…` id that was never converted back to `UC…`.
