# YouTube: InnerTube and the Data API

> How the pipeline talks to YouTube, what it costs, and how to stay inside the
> free tier.

YouTube is the project's primary platform. **InnerTube** (`youtubei.js`) is the
default and primary source: handle resolution, channel search, video search,
channel profiles, uploads, releases and the channel Live tab all go through it,
with **no API key and no Data API quota**. The YouTube Data API v3 is optional;
it adds richer video statistics, exact broadcast start/end times and a fallback
when InnerTube cannot answer. These are access methods for YouTube data, not
separate platforms. See `docs/SOURCES.md` for the source overview.

Search hits are candidates, not automatic channel admissions. For a new
YouTube identity to enter the virtual dataset, sync checks two or more distinct
uploads and requires each video to show both virtual-creator identity (such as
VTuber, VSinger, or localized equivalents) and singing evidence (such as
歌枠, 歌ってみた, 弾き語り, KARAOKE, or a singing-relay hashtag) in its
title, description, or tags. InnerTube search results carry a title and a
description snippet, which is enough for the gate; with the Data API, tags are
available too. An existing dataset, vdb, or curated seed identity does not need
to pass this new-channel gate. This rejects ordinary singers and karaoke
streamers based on singing terms alone while allowing varying event hashtag
names.

## What InnerTube provides

| Capability | Method | Cost |
| --- | --- | --- |
| Resolve a handle or channel URL | `InnerTubeSource.profile()` | none |
| Channel keyword discovery | `InnerTubeSource.searchChannels()` | none |
| Video keyword discovery | `InnerTubeSource.searchVideos()` | none |
| Video discovery restricted to live | `searchVideos(q, n, { liveOnly: true })` | none |
| Channel uploads | `InnerTubeSource.channelCatalog()` | none |
| YouTube Music releases | `channelCatalog()` / `channelReleases()` | none |
| Live and upcoming broadcasts | `InnerTubeSource.liveStreams()` | none |

`searchVideos()` reads the public search result's title, description snippet,
owning channel id, thumbnail and view count. `liveStreams()` reads the channel's
**Live** tab, which mixes live, upcoming and finished broadcasts; only the first
two are collected, and a finished broadcast is already represented by the
uploads tab. The tab has two renderers (`LockupView` and `GridVideo`), so the
state is read from the thumbnail badge and the metadata rows rather than from a
single field.

The badge decides *whether to ask*, not *what the answer is*. A card keeps its
`Upcoming` badge after the broadcast has aired, and the only schedule it prints
is a localized string in the client's timezone (`Scheduled for 10/31/26,
12:00 AM`) — a timezone and a locale the pipeline would have to guess. Each
badged card is therefore confirmed against the video's own player response,
`getBasicInfo()`, which costs one request (~0.13 s, measured) **per badged
card** rather than per channel, and states `is_upcoming`, `is_live` and the
exact `start_timestamp`. A card the player disagrees with is dropped; a
confirmed one is stored with `scheduledStart` (upcoming) or `actualStart`
(live) taken from that timestamp, so a stream found hours after it began
records when it began rather than when the run polled it. On a failed
`getBasicInfo()` the badge stands, because an unreachable video is not evidence
that a stream ended.

`liveStreams()` returns `null` when the check failed and `[]` when the channel
was checked and nothing is live. The distinction matters: on an empty successful
check the previously stored live item is retired to `past`, while a failed check
changes nothing.

`liveStreams()` returns `null` when the check failed and `[]` when the channel
was checked and nothing is live. The distinction matters: on an empty successful
check the previously stored live item is retired to `past`, while a failed check
changes nothing.

## Optional API key

You can run the sync pipeline without a key. Add one only if you want the
Data API extras listed above:
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
| `search.list` | **100** | Optional discovery; InnerTube search is the default |
| `channels.list` | 1 | Channel details, up to 50 ids per call |
| `videos.list` | 1 | Video details, up to 50 ids per call |
| `playlistItems.list` | 1 | A channel's uploads, 50 per page |
| `playlists.list` | 1 | Playlist details |
| `subscriptions.list` | 1 | The user's subscriptions (browser-side, OAuth) |
| `activities.list` | 1 | Channel activity |

The asymmetry is the whole game: **one search costs as much as fifty channel
lookups**. The pipeline is built around that:

- discovery, uploads, profiles, releases and the Live tab go through
  InnerTube and cost nothing;
- the Data API is spent only when it is configured and adds something
  InnerTube does not carry — detailed video statistics, exact broadcast
  times and a fallback for a failed InnerTube lookup.

### What a run costs

A typical run with up to 40 discovery searches, 150 refreshed channels and
their uploads, when the Data API **is** configured:

| Step | Calls | Units |
| --- | ---: | ---: |
| Discovery searches | 40 | 4,000 |
| Known channels | 150 | 150 |
| Uploads (150 channels) | 150 | 150 |
| Video details | 150 | 150 |
| Live detail enrichment | up to 50 | 1 |
| **Total** | | **~4,451** |

Without an API key the same run spends **zero** units: InnerTube supplies
discovery, profiles, uploads, live status and the search-result metadata used
for discovered videos.

Which is why the workflow runs every six hours with a **2,500-unit** budget
by default: four runs a day stay comfortably inside 10,000, and the quota
state is cached between runs so the budget is cumulative, not per-run.
For each new YouTube candidate that reaches the qualification check, the Data
API may additionally spend one unit on its first ten uploads and one unit on
their video details. The quota-free InnerTube upload check is used first.

### Why the scheduled pipeline does not use `liveBroadcasts.list`

`liveBroadcasts.list` requires OAuth. An API key alone is rejected with a
permission error, and the scheduled workflow only has `YOUTUBE_API_KEY`. The
channel Live tab through InnerTube is the live source instead; the Data API's
`videos.list` optionally enriches a discovered broadcast with its exact
scheduled/actual times, concurrent viewers and statistics.

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

Every Data API response is written to `.cache/youtube/<hash>.json`, keyed by
the request URL. A re-run of the sync re-uses the cached responses and only
spends quota on genuinely new data.

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
GET /youtube/v3/liveBroadcasts?part=snippet,contentDetails,status&broadcastStatus=all&id=...
```

**Not used by the scheduled pipeline.** This endpoint requires an OAuth token
with a YouTube scope; an API key alone is rejected, and the scheduled workflow
has only a key. Live and upcoming broadcasts are read from the channel's Live
tab through InnerTube instead, and `videos.list` optionally enriches them.

### `search.list`

```http
GET /youtube/v3/search?part=snippet&type=channel|video&q=...&order=date|viewCount&maxResults=50
```

**100 units**, so it is optional. `order=date` can surface newer results; the
sync uses its configured channel/video queries and treats hits as candidates.
New YouTube channels must still pass the two-distinct-video virtual-identity
and singing evidence check above. `eventType=live` restricts results to live
streams, which InnerTube mirrors with `features: ["live"]`.

Channel searches find candidate identities. Video searches can surface
singing-related uploads; their channel still has to pass the same two-distinct
video qualification check before a new record is admitted. When the Data API is
not configured, InnerTube performs both kinds of search instead.

## The `UU` trick and `forHandle`

To resolve an `@handle` to a canonical channel id:

```http
GET /youtube/v3/channels?part=snippet&forHandle=@someone
```

One unit per handle. The curated seed list uses handles, and each one costs a
unit to resolve — so the seed list is resolved once and the result is
committed.

## InnerTube and authentication

The pipeline uses **`youtubei.js`** (InnerTube) as the primary quota-free
source for handle resolution, channel and video search, profiles, uploads,
releases and the Live tab. It is an unofficial interface and can change
without notice; when configured, the Data API supplements it with detailed
video metadata and acts as a fallback for a failed InnerTube lookup. The
`Sync dataset` GitHub Action runs the configured searches; a manual run can
provide a custom `keyword` instead. Without an API key every search still runs
through InnerTube. The optional local dev server also uses InnerTube for
interactive YouTube features.

The pipeline reads public data only, so no OAuth token is required
server-side. The browser app uses OAuth for account-scoped features such as
the user's own subscriptions.

## Scaling to the whole catalogue

The catalogue is much larger than one run can refresh, so the refresh, live
and discovery candidate sets are split into **deterministic shards**:

- the shard is `FNV-1a(channel id) % shardCount`, so a channel always lands in
  the same shard on every machine and every run;
- `--shard N/M` selects one shard (1-based; `M=1` disables sharding);
- the scheduled workflow rotates `N` by `GITHUB_RUN_NUMBER`, so successive runs
  cover the whole catalogue without a persisted cursor;
- within a shard, channels that have gone longest without a refresh are picked
  first, and `maxChannelsPerRun` / `maxLiveChannelsPerRun` cap the work.

`--limit-channels N` and `--limit-live N` override the per-run caps for a
bounded local run.

The live pass reads each channel's Live tab through InnerTube, so
`maxLiveChannelsPerRun` is a bound on **run time**, not on spend: it costs no
quota, but it costs a request and a second or two per channel. The catalogue
holds ~63,000 YouTube channels, so a full sweep is ~26 hours — longer than any
job may live. That is why the pass has its own entry point (`--live-only`,
`live.yml`): the workflow takes a deterministic shard and checks
`maxLiveChannelsPerRun` (default 6,000) of it per run. 12 runs a day is 72,000
checks against 63,662 channels, so every channel is polled once a day. That is
the trade-off the budget forces, not a bug: checking every channel every two
hours would be 63,662 checks in a two-hour window, about seven hours of work.

A check costs ~0.39 s (InnerTube plus the 250 ms delay) and the dataset load is
~20 s, so a 6,000-channel run is ~40 minutes. Raise the limit only with that
multiplication in hand: runtime scales linearly, quarantine does not.

The window advances by one **page** per visit to the shard (`--live-page`), and
that page is the count of visits to *that shard*, not the run number: with four
shards one shard is visited every fourth run, so a page derived from the run
number would stride by four windows and overlap itself, covering about a third
of the catalogue and then stopping.

There is deliberately no cursor file and no "last checked" stamp on the channel
record: the live pass writes only the item files, so a timestamp it set would
never be persisted — which is exactly what broke the earlier rotation. It
ordered candidates by `lastItemsFetchedAt`, a field only the full sync's upload
pass writes (150 channels a run), so every run on a shard selected the same
1,000 channels: 4,000 distinct out of 63,662 a day, with 59,662 never checked.
The sync skips the pass entirely unless it is given `--limit-live N`.

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
