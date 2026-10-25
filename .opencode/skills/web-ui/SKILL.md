---
name: Web UI
description: Build and change views, filters, the theme and the account menu in the Vue app — the scope switch, responsive layout and the live info block
---

# The web app

Vue 3 + Tailwind v4 + Vite. The app is **static**: it reads the committed
JSON dataset and never talks to a backend.

```
src/
├── App.vue              shell: header, filters, views, drawer, mobile nav
├── lib/store.ts         reactive state: scope, filters, accounts, theme
├── lib/dataset.ts       loads and filters the dataset
├── lib/auth.ts          account linking for four platforms
├── lib/links.ts         the "all links" block
├── lib/env.ts           build-time environment
└── components/
    ├── LiveCard.vue     thumbnail + info block + all links
    └── ChannelDrawer.vue  channel detail, links, recent uploads
```

## The scope switch is enforced in the data layer

`Virtual` / `Real` / `Both` is applied by `filterItems()` and
`filterChannels()` in `src/lib/dataset.ts` — **not** in the views.

**Any new view must funnel its results through those functions.** Do not add
a per-view `kind` check; that is how the two datasets end up mixed.

The same functions apply the region, the categories, the gender, the AI
filter and the acoustic filter. One funnel, one place to change the rules.

## State

`src/lib/store.ts` holds one reactive object. Persisted to `localStorage`:
theme, scope, region, view, saved items, linked accounts, subscriptions.

```ts
state.scope        // "virtual" | "real" | "both"
state.region       // RegionCode | "all"
state.categories   // ItemCategory[] — multi-select, so MV + Covers combine
state.acousticOnly // boolean
state.gender       // Gender | "all"
state.ai           // "ai" | "human" | "all"
state.oac          // "all" | "oac" — the 🎵 Official Artist Channel badge
state.role         // "all" | "vsinger" | "vtuber" | "singer" | "producer"
state.vtuberOnly   // "all" | "vtuber" | "vsinger" (vsinger = role OR isSinging)
state.subsTracked  // "all" | "tracked" | "untracked"
state.channelSubs   // "all" | "subscribed" | "not-subscribed" (Channels view)
state.upcomingType  // "all" | "stream" | "schedule" (Upcoming view)
state.accounts     // Record<provider, LinkedAccount[]>
state.activeAccount// Record<provider, accountId | null>
```

## Links

`channelLinks()` in `src/lib/links.ts` merges `platforms[]` (or a summary's
`links[]`) with `externals`. A `platforms[].url` from a roster is not always
an href — vdb stores percent-encoded addresses and bare hosts — so it goes
through `toHref()` (`scripts/lib/address.ts`), and an `other` / `web` /
`email` link is labelled by its host. An external value is either a **handle** for a
known platform or, under `web:<n>`, an **address** — `externalUrl()` returns
`null` for a key it cannot build a URL for, and the link is omitted. Never
fall back to `https://<key>/<handle>`: a 404 is worse than no link.

## The 🎵 badge

The badge is **in the record** (`isOfficialArtist`) and `officialArtistCheckedAt`
says when YouTube was asked. `officialArtistOf(channel)` in `App.vue` picks
the newer of the record and `state.youtubeBadges`, and everything — cards,
search hits, the drawer, the `oac` filter — goes through it, so a badge seen
in **My subscriptions** is the badge in **Channels**.

A summary also carries `officialArtistChecked`, so "YouTube said no" and
"nobody asked" are different things and the background sync only queues the
second.

## Adding a filter

1. Add the state field to `src/lib/store.ts`.
2. Add the check to `filterItems()` / `filterChannels()` in
   `src/lib/dataset.ts`.
3. Pass it from the computed views in `src/App.vue`.
4. Add a chip to the filter bar.
5. If it applies to search results too, add the field to the search entry and
   rebuild the index — see the `search-index` skill.

**The 🎵 Official Artist filter** is `state.oac`. The badge is not in the Data
API; `InnerTubeSource.profile()` reads it from the channel header
(`AUDIO_BADGE` / `BADGE_STYLE_TYPE_VERIFIED_ARTIST`) into
`isOfficialArtist`. The field is **optional** on `Channel` — absent means the
details pass has not asked yet — so the filter matches `=== true` only.

**A view-specific filter lives in that view's header**, not the global bar —
see the segmented controls in Channels (`CHANNEL_SUB_FILTERS`), My
subscriptions (`SUB_FILTERS`) and Upcoming (`UPCOMING_FILTERS`).

**Schedule streams are not events.** A performer announces the week with a
stream whose title *is* the schedule — 「週表」「日程」, 「Weekly Schedule」,
「スケジュール」, 「타임테이블」 — so the Upcoming tab offers `All` /
`🎤 Streams` / `📅 Schedule`. The test is `isScheduleTitle()` in
`scripts/lib/classify.ts`: it runs on `normalize()`d text, which folds the
styled spellings (`𝗐𝖾𝖾𝗄𝗅𝗒 𝗌𝖼𝗁𝖾𝖽𝗎𝗅𝖾`) and full-width letters to ASCII.
When adding a language, add its term to `SCHEDULE_TITLE_TERMS`; the English
ones are word-boundary regexes so `schedule` does not match `scheduled`.
`LiveCard` shows a 📅 Schedule pill on a matching upcoming card.

**The badge itself is `src/components/OfficialArtistBadge.vue`** — YouTube's
monochrome inline SVG, not an emoji. Put it **after** the channel name
(`name <OfficialArtistBadge />`), not before it. It accepts `size="xs"` for
small cards and the default `sm` for drawer/modal titles, and inherits the
surrounding text colour. The subscription cards and their drawer use the
30-day `vst.youtubeBadges` result ahead of a stale dataset flag.

## The live info block

`src/components/LiveCard.vue` is the reference for how a card should look:
a large thumbnail, a status pill (`LIVE` / `UPCOMING`), a kind badge
(`VTuber` / `Real`), an `🤖 AI` badge, and a dense information block with
category, region, viewers, duration, gender, acoustic style and the song.

Below that is the **all links** row — one coloured pill per platform, plus a
`Watch` button. `channelLinks()` in `src/lib/links.ts` builds it from the
channel's `platforms[]` and `externals`.

## Theme

Tailwind's `dark` variant is configured in `src/index.css`:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

The `dark` class is set on `<html>` by `initTheme()`, and `index.html` has an
inline script that applies it **before the first paint** so the page never
flashes the wrong colours.

The toggle lives in `state.theme`; `toggleTheme()` writes it to
`localStorage` and toggles the class.

## Responsive layout

- **Mobile** — a single column, a fixed bottom tab bar, and the scope switch
  moves into the filter row.
- **Desktop** (`md:` and up) — the scope switch moves into the header, the
  bottom bar disappears.

Use Tailwind's responsive prefixes rather than media queries.

## Account menu

The header has an account button that opens a popover listing every linked
account, grouped by platform. Each entry has:

- **Switch** — makes it the active account for that platform.
- **Reconnect** (YouTube) — requests a fresh token for the same account id and
  reloads its subscriptions. It tries the silent GIS path first; an account
  linked before the full scope was added falls back to the consent screen.
- **Sign out** — revokes it locally and removes its subscriptions.

`+ Link another <platform> account` adds a second account on the same
platform. The active account is stored per platform, so switching is instant.

**A failed request must say why.** `AuthProvider.subscriptions()` throws the
platform's reason rather than returning `[]` — an empty list and a broken one
look identical to the user. For YouTube, `accessNotConfigured` means the
YouTube Data API v3 is not enabled in the Cloud project,
`insufficientPermissions` means the token predates the full `youtube` scope
(use **Reconnect**), and a 401 means the token expired. After a successful link
the app switches to the `subs` view, so a link that produced nothing is never
silent.

**Paging.** `subscriptions(account, onProgress)` calls `onProgress({loaded,
total})` after every page; `total` is Google's `pageInfo.totalResults`, and the
Subs header renders “loading 200 / 956…”. A 5xx is retried twice. If the API
returns fewer than `totalResults`, the toast says so — never report a truncated
list as complete. The InnerTube bridge pages on the server and reports
`{loaded: <all>, total: null}` once, so there is no Google total to compare —
the feed itself has no total.

**Refresh reads InnerTube first; the Data API is the fallback.**
`src/lib/auth.ts` posts the account token to `POST
/api/youtube/subscriptions` before it calls `subscriptions.list`. The bridge is
`scripts/lib/innertube-subs.ts` in `server.ts`:

- The link requests the full `https://www.googleapis.com/auth/youtube` scope.
  A `youtube.readonly` token gets **403 `insufficientPermissions`** from
  `FEchannels`; the read-only scope is not enough.
- The browser cannot call `youtube.com` — InnerTube sends no CORS headers — so
  the local dev server forwards the request. It uses the bearer token, the
  **TVHTML5** client, and `browseId: "FEchannels"`. The **WEB** client answers
  `400 invalid argument` with the same token; do not switch it back.
- The TV feed is a `tvBrowseRenderer` → `tileRenderer`, not
  `channelRenderer`/`gridChannelRenderer`: the channel id is
  `onSelectCommand.browseEndpoint.browseId`, the title is
  `metadata.tileMetadataRenderer.title`, the handle is the first
  `lineRenderer` line, and the avatar is the tile header thumbnail.
- Verified live on 2026-10-23: **4,804 subscriptions in 5 pages (~2.4 s)**,
  exactly the export script's count, with a single
  `/api/youtube/subscriptions` request and **no** Data API
  `subscriptions.list` call during Refresh.
- On a static build `/api/…` is not a JSON endpoint, the helper returns `null`,
  and the Data API path (capped at 1,000) runs with its truncation warning. The
  same fallback covers a refused token.
- The token is sent only to the same-origin dev server, which checks the
  `Origin`, uses it for the `Authorization` header, and never stores or logs
  it. It is not a place to add analytics or request logging.

**Subscription cards read one channel page for the 🎵 badge.**
The TV `FEchannels` feed used by Refresh has no `AUDIO_BADGE`, so the subs view
has a second, unauthenticated bridge: `POST /api/youtube/channel` in
`server.ts`, backed by `scripts/lib/youtube-channel.ts`. The client side is
`src/lib/youtube-detail.ts`.

```ts
// badge-only: one getChannel, header read
fetchYouTubeChannel(channelId, false)

// opened card: adds getLiveStreams() and getReleases()
fetchYouTubeChannel(channelId, true)
```

- **Badge sync** starts when `state.view === "subs"`, the local bridge is
  available, and some `UC…` id has no cached result. It runs two workers with
  a 120 ms gap; the server also caps itself at two in-flight channel requests.
  The banner shows progress and **Stop / Resume**; a 429 stops the run instead
  of retrying thousands of times.
- **Caches:** `vst.youtubeBadges` (`{ officialArtist, checkedAt }`, 30 days)
  and `vst.youtubeDetails` (last 200 opened channels). They are separate from
  `vst.subscriptions`, so Refresh cannot erase them. Actions live in
  `src/lib/store.ts` (`setYouTubeBadge`, `setYouTubeDetail`,
  `YOUTUBE_BADGE_TTL_MS`).
- **Tracked vs untracked:** `openSubscription()` checks
  `summaryById`/`knownSubscription`. A tracked channel calls `openChannel()`
  and opens the normal `ChannelDrawer`; an untracked one opens
  `src/components/SubscriptionDetail.vue` and fetches `detail: true` on open.
  Its live/upcoming/songs come from the snapshot; tracked cards use
  `liveByChannel`, `upcomingByChannel` and `songCountByChannel` from the
  dataset.
- **Static build:** no `/api/youtube/channel`; the sync is skipped and the
  modal reports that the local dev server is required. The dataset's own
  `isOfficialArtist` badge still renders in `ChannelCard` and
  `ChannelDrawer`.
- **Do not add auth or request logging to this route.** It is unauthenticated
  by design, checks `Origin`, accepts only `UC…` ids, and returns 404 for a
  gone channel, 429 for a rate limit and 502 otherwise.

**The Data API cap is real; files still carry the rest.**
The YouTube Data API returns at most 1,000 items for a subscription list,
whatever the account holds. Linking more accounts merges their lists but does
not lift the API's cap. InnerTube does (above). A file carries the rest:

- **Import CSV / JSON** (`src/lib/takeout.ts`) reads a Google Takeout
  `subscriptions.csv`, the CSV from **Export from YouTube**, or a
  **PocketTube backup** (JSON, groups → `UC…` ids). `parseSubscriptionsFile()`
  picks the reader from the content; the result is stored under the synthetic
  account `youtube:takeout` so Refresh never overwrites it.
- **Export from YouTube** (`src/lib/subs-export.ts`) is the complete
  no-link/static path. On
  `youtube.com/feed/channels` it reads the session's `SAPISID`, signs the
  request with `SAPISIDHASH`, and walks the `FEchannels` continuation through
  `/youtubei/v1/browse` roughly 100 channels at a time. The page renders only
  1,000 cards, but the continuation does not stop there: a 4,804-subscription
  account exported all 4,804 in 49 pages (verified 2026-10-23). The script
  falls back to scrolling the rendered page only when the signed request is
  unavailable, and says which mode produced the file.
- **Never log or emit the cookie or the hash.** The script returns only
  channel ids and titles; `SAPISID` exists in the page to sign requests to
  `youtube.com` and is not sent anywhere else.
- The number in the tab title is the **unread notification count**, not the
  subscription count — do not present it as a total. The page's rendered count
  and the API's `totalResults` can both differ from the true subscription count.

**Suggestions.** An untracked subscription can be added to the suggestion
queue — per card (`＋ Suggest`) or in bulk (`Suggest all`) — and removed again
(`✕` on the card, `clear` in the toolbar); the **Suggested** filter lists the
queue. With the local dev server the queue is `data/suggestions.json`
(`GET/POST /api/dataset/suggestions`,
`POST /api/dataset/suggestions/remove`); a static build keeps keys in
`localStorage` (`vst.suggested`) and offers a `suggestions.json` download.
**Add to dataset** imports them in batches through `/api/dataset/sync` and is
refused without `consent: true` — a subscription list is private and importing
it publishes third-party records.

## Data loading

`src/lib/dataset.ts` loads lazily and caches in **plain** module-level
variables — deliberately *not* `reactive()`, because deep-proxying the search
packs made lookups take seconds.

```ts
loadManifest()          // always
loadSummaries()         // always
loadChannels("virtual") // on demand
loadLive() / loadUpcoming()
loadItems(regions)      // sharded by region
loadSearchPack(region)
```

**A search hit is not a channel.** `search()` returns index entries — `k`
(`c` channel / `i` item), `id`, `n`, `g`, `r`, `th` — while the drawer needs
a `Channel`. `openSearchHit()` in `App.vue` maps one to the other: a video hit
opens the channel it is filed under (`hit.ch`), and a hit whose record is not
in the loaded region filter clears the query and loads all channels first.
Passing the entry straight to `openChannel()` renders an empty drawer, which
is what a search result with "no detail page" looks like.

## Gotchas

- **`import.meta.env.BASE_URL`** — every data URL goes through `url()`, so
  the app works from a GitHub Pages sub-path.
- **Shared code** — import types and the search engine from `@shared/lib/…`,
  not from a copy.
- **No new dependencies** — the bundle is ~46 KB gzipped and that is a
  feature.
- **`@/` is `src/`**, `@shared/` is `scripts/`. Both are configured in
  `vite.config.ts` and `tsconfig.json` — keep them in sync.

## After a change

```bash
npm run lint      # vue-tsc
npm run build     # type-check + bundle
npm run dev:web   # look at it
```
