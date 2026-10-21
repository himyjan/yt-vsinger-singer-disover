# VSinger & Singer Tracker — Development Requirements

> Living document. Every requirement below traces back to a request made during
> the project kickoff. Status markers: `[x]` done · `[~]` in progress ·
> `[ ]` not started.

---

## 1. Project purpose

A discovery and tracking platform for **virtual singers (VTuber / VSinger)** and
**real human singers / music producers**, focused on **YouTube** and **Twitch**,
with additional support for **Bilibili**, **Niconico** and **VK**.

The three things the product must do well:

1. **Collect** every VTuber singing video, music video (MV) and music cover.
2. **Store** that data *inside the Git repository* so it is versioned, diffable
   and served directly from GitHub Pages.
3. **Search** it fast — an inverted index, not a linear scan.

---

## 2. Data collection

### 2.1 What to collect

- `[x]` VTuber / VSinger singing uploads.
- `[x]` Music videos (MV).
- `[x]` Music covers (歌ってみた / cover songs).
- `[x]` Original songs.
- `[x]` Live streams — currently live.
- `[x]` Scheduled / upcoming streams and premieres ("preorder" in the original
      brief → modelled as `status: "upcoming"` and `category: "premiere"`).
- `[x]` Playlists (cover playlists, song collections).
- `[x]` Both VTuber channels **and** VSingers — these are the same record with
      a different `role`.

### 2.2 Channels to track

- `[x]` VTuber channels.
- `[x]` VSingers (virtual singers who are not primarily VTubers).
- `[x]` Real (human) singers, songwriters and music producers — kept as a
      **separate dataset**.

### 2.3 Data provenance

Every record carries `source`:

| Value         | Meaning                                        |
| ------------- | ---------------------------------------------- |
| `api`         | Fetched from a platform API                    |
| `seed`        | From the curated seed catalogue                |
| `legacy-db`   | Imported from the old SQLite database          |
| `manual`      | Curated by hand in `data/overrides.json`       |

---

## 3. Separate datasets: virtual vs. real

- `[x]` `data/channels/virtual.json` — the VTuber / VSinger dataset.
- `[x]` `data/channels/real.json` — the real human singer / producer dataset.
- `[x]` A **global scope switch** — `Virtual` / `Real` / `Both` — that applies
      to **every** web function: search, live, upcoming, songs, channels,
      subscriptions and saved items.
- `[x]` The scope is applied in the data layer, not per view, so no view can
      accidentally leak the wrong kind.
- `[x]` Manual overrides in `data/overrides.json` can force a channel's kind,
      role or region.

---

## 4. Regions

- `[x]` Region is a first-class field on both channels and items.
- `[x]` Regions: `jp`, `cn`, `tw`, `hk`, `kr`, `en`, `id`, `my`, `sea`,
      `unknown`.
- `[x]` Region is derived from, in order of confidence:
      1. curated seed / manual override,
      2. agency (hololive JP vs. hololive ID, nijisanji EN, …),
      3. `brandingSettings.country`,
      4. script detection of the description (Japanese, Korean, Traditional vs.
         Simplified Chinese),
      5. explicit textual markers.
- `[x]` Channels are stored **per region** so the region filter never needs a
      client-side scan over the whole dataset.
- `[x]` Region is exposed in search results and in the live/info blocks.

---

## 5. Multi-platform support

- `[x]` YouTube — primary. YouTube Data API v3 (free tier) + optional
      `youtubei.js` for the local dev server.
- `[x]` Twitch — Helix API, optional (`TWITCH_CLIENT_ID` /
      `TWITCH_CLIENT_SECRET`).
- `[x]` Bilibili — public web API, no credentials needed.
- `[x]` Niconico — public search API v2, no credentials needed.
- `[x]` VK — official API with `VK_ACCESS_TOKEN`; degrades to profile-only
      without it.
- `[x]` A common `PlatformAdapter` interface so adding a platform is one file.
- `[x]` A channel record carries a **list** of platform identities
      (`platforms[]`), so one performer can be present on YouTube *and*
      Twitch *and* Bilibili.

---

## 5b. Verification before publishing

The keyword classifier is fast and free but wrong often enough to matter. A
verification step checks uncertain records against the web **before** the data
is published.

- `[x]` Web-search grounding — a model that actually looks the channel up,
      rather than answering from memory.
- `[x]` Verifies: virtual vs. real, role, region, gender, AI-generated,
      and whether the channel is a fan/clip aggregator at all.
- `[x]` Corrections are written as **overrides**, never as direct edits, so
      every change is reviewable in a diff and can be reverted by deleting
      one entry.
- `[x]` The sources the model read are recorded next to each answer.
- `[x]` Confidence thresholds: corrections below `--min-confidence` are
      discarded, because a wrong correction is worse than none.
- `[x]` The model is instructed never to guess a gender from a name or a
      photo, and to answer "unknown" rather than guess.
- `[x]` Runs daily in GitHub Actions, then re-applies the corrections,
      rebuilds the index and validates.

## 5c. Gender, AI and the combined variant

- `[x]` `gender` — `female` · `male` · `unknown`. Explicit self-descriptions
      win; honorifics are only a fallback.
- `[x]` `isAi` — AI VTubers, AI singers and synthesised voices. The
      community-maintained [AiSList](https://github.com/Override92/AiSList)
      blocklist and warnlist are the authoritative source; the keyword
      heuristics are only the fallback.
- `[x]` `variant` — the combined label stored on every channel and item:
      `female_vtuber`, `male_vtuber`, `ai_vtuber`, `female_vsinger`,
      `ai_vsinger`, … AI takes precedence over gender.
- `[x]` Filters for gender, AI and the combined variant, applied by the same
      data-layer funnel as every other filter.

## 5d. Acoustic / 弾き語り

- `[x]` `isAcoustic` — "singing while playing an instrument": 弾き語り, 彈唱,
      自弹自唱, acoustic, fingerstyle, unplugged.
- `[x]` A **flag**, not a category, because these uploads are usually covers
      as well — filtering for them must not remove them from the cover bucket.
- `[x]` A quick filter chip in the web app.

## 5e. The songs dataset

- `[x]` `data/songs/` — a music-centric projection of the dataset: one record
      per performance, carrying the song, the original artist, the
      collaboration flag, the acoustic flag and the duration.
- `[x]` Sharded by region and by category, so "every cover" is one cheap
      fetch.
- `[x]` Song metadata from the
      [VTuber Music Dataset](https://github.com/meihei3/VTuber-music-dataset)
      overrides the heuristic extraction, because the curated data is
      authoritative.

## 6. Live page (modelled on the `camlisted` reference)

- `[x]` A dedicated **Live** view listing every currently-live VTuber / singer.
- `[x]` Each entry shows a **thumbnail**.
- `[x]` Each entry shows an **info block**:
      title · channel · viewer count · started at · elapsed duration ·
      category · region · artist kind · agency.
- `[x]` Each entry shows **all links**: YouTube, Twitch, X/Twitter, Bilibili,
      Niconico, VK and any other handles found in the channel description.
- `[x]` A channel detail view showing every live + recent upload, with the
      same all-links block.
- `[x]` A separate **Upcoming** view for scheduled streams and premieres.
- `[x]` Live data is cheap to refresh: `liveBroadcasts.list` costs 1 unit per
      50 channels, versus 100 units for a `search.list` call.

---

## 7. Web application

### 7.1 Layout

- `[x]` Responsive: mobile-first single column with a bottom tab bar, widening
      to a multi-column grid on tablet/desktop.
- `[x]` Desktop sidebar / mobile bottom bar for primary navigation.
- `[x]` Light and dark themes.
- `[x]` Theme toggle, persisted in `localStorage`, defaulting to the OS
      preference.
- `[x]` No layout shift on theme change (`color-scheme` + Tailwind `dark`
      variant).

### 7.2 Search

- `[x]` Client-side, instant, no round trip to a server.
- `[x]` **Inverted index** per region: sorted token list + posting lists + IDF
      weights, so a query is a few binary searches rather than a full scan.
- `[x]` **Prefix matching** via binary search over the sorted token array —
      typing `holo` matches `hololive`.
- `[x]` **CJK bigram tokenisation** — Japanese and Chinese are not
      space-delimited, so CJK runs are indexed as overlapping bigrams
      (`歌い手` → `歌い`, `い手`).
- `[x]` IDF weighting so rare tokens rank higher.
- `[x]` Search results carry the display-ready fields (title, thumbnail,
      channel, region, kind) so results render without another fetch.
- `[x]` Search respects the global scope switch and the region filter.

### 7.3 YouTube account linking

- `[x]` Client-side Google OAuth via Google Identity Services — works on a
      static site, no backend.
- `[x]` Scope: `https://www.googleapis.com/auth/youtube.readonly`.
- `[x]` **Twitch** — OAuth 2.0 with PKCE, so no client secret is needed in
      the browser.
- `[x]` **Bilibili** — the user pastes their `SESSDATA` cookie, because
      Bilibili offers no public OAuth for a follow list.
- `[x]` **VK** — implicit OAuth. VK has no channel-subscription concept, so
      the provider surfaces the user's friend list.
- `[x]` **Several accounts per platform** — a user can link two Twitch
      accounts, or two Google profiles.
- `[x]` **Switch account** — the active account is stored per platform, so
      switching is instant and needs no re-authentication.
- `[x]` **Sign out** — per account, revoking it locally and dropping its
      subscriptions.
- `[x]` After linking:
      - list the user's **YouTube subscriptions**,
      - match each subscription against the local dataset,
      - show subscribed VTubers / singers in their own view,
      - flag which subscriptions are *not yet in the dataset* so the user can
          add them.
- `[x]` The token stays in `localStorage` only; it is never sent to a server.
- `[x]` Sign-out clears the token and the subscription list.
- `[x]` Failures (denied consent, expired token, missing client id) degrade to
      a clear message instead of breaking the app.
- `[x]` A **tracked / not tracked** filter on the subscription list, so the
      user can see which subscriptions the dataset does not cover yet.
- `[x]` Subscriptions are matched by channel id first, then by normalised
      display name, so a YouTube subscription of a VTuber who also streams on
      Twitch is recognised.

---

## 8. Repository & CI

- `[x]` The dataset is **committed to the repository** under `data/`.
- `[x]` A GitHub Actions workflow refreshes it on a schedule (every 6 hours)
      and commits the result.
- `[x]` A second workflow builds the app and deploys it to GitHub Pages.
- `[x]` A third workflow validates the dataset and builds the app on every
      push and pull request.
- `[x]` Everything runs with plain Node — **no native modules in the CI path**
      (`better-sqlite3` is an `optionalDependency`; only the local migration
      script uses it).
- `[x] `npm run data:validate` fails the build on a malformed, oversized or
      inconsistent dataset.
- `[x]` The quota state is cached between workflow runs so several runs a day
      can never exceed the daily allowance.

### 8.1 Repository size (GitHub Free)

GitHub Free allows ~1 GB of repository content (hard limit 2 GB) and a 2 GB
maximum for a single Git LFS file.

- `[x]` The dataset is **sharded** — by region, then by id bucket — so no
      single file gets large and the browser only downloads the slice it needs.
- `[x]` Hard per-file budget: **8 MB**. Hard `data/` budget: **180 MB**.
      Both are enforced by the writer and checked by the validator.
- `[x]` Retention policy: at most 30 items per channel, items older than 365
      days dropped, live/upcoming items always kept.
- `[x]` `.gitattributes` routes binaries (`*.db`, `*.zip`, media) through
      **Git LFS**; the JSON dataset stays as plain text so diffs and Pages
      serving work.
- `[x]` `reference/` and the reference checkouts are git-ignored — they are
      several GB and would destroy the repository size budget.

---

## 9. YouTube API & quota

- `[x]` Free tier: 10,000 units/day.
- `[x]` Cost awareness is built into the client:
      `search.list` = 100 · `channels.list` = 1 · `videos.list` = 1 ·
      `playlistItems.list` = 1 · `liveBroadcasts.list` = 1.
- `[x]` A `QuotaBudget` refuses any call that would exceed the budget.
- `[x]` Every response is cached on disk, so re-running the sync only spends
      quota on genuinely new data.
- `[x]` Retry with exponential backoff on 429/5xx; quota and permission
      errors are never retried.
- `[x]` Usage is reported in `data/manifest.json`.

---

## 10. Daily discovery of new performers

- `[x]` A daily task that looks for **newly debuted** performers.
- `[x]` Sources:
      - **Virtual YouTuber Wiki (Fandom)** — MediaWiki API, free, no key.
        Its `{{Character}}` infobox carries debut date, retirement date,
        YouTube channel, X handle and affiliation.
      - **YouTube** — `search.list?type=channel&order=date` surfaces newly
        created channels.
      - **X (Twitter)** — token-gated (`X_BEARER_TOKEN`); also harvests X
        handles from wiki infoboxes for free.
      - **Facebook** — token-gated (`FACEBOOK_ACCESS_TOKEN`,
        `FACEBOOK_PAGE_IDS`); the Graph API is the only supported route.
- `[x]` **De-duplication** is mandatory. An identity registry
      (`data/identities.json`) stores every known performer with:
      - strong keys — YouTube channel id, handle, X handle, wiki page title;
      - weak keys — normalised display name, matched with a bounded edit
        distance and only within the same region.
      Records sharing a key are **merged**, never duplicated.
- `[x]` The registry also enriches existing channels with debut / graduation
      dates that the YouTube API does not expose.

---

## 11. Reference projects consulted

| Reference | What was taken | What was improved |
| --- | --- | --- |
| `TaiwanVTuberTrackingDataJson` | `agency`/`group`, `originalArtist`, `isCollab`, MV flag, live/upcoming streams, `activity` (active/graduated), `debutDate`/`graduateDate` | Added the `{tag:"has"\|"hidden"\|"no"}` count union so a hidden subscriber count is not rendered as `0` |
| `VTuber-music-dataset` | `songTitle`, `originalArtist`, `isCollab` | Added automatic extraction from titles/descriptions |
| `Musicdex` | `is_mv` flag, `original_artist` | Generalised into the `category` enum |
| `Holodex` / `Holodex-Plus` | multi-platform channel model, YouTube + Twitch | Extended to five platforms behind one adapter interface |
| `camlisted` | the **Live** page pattern: thumbnail + info block + per-channel pages + all links | Made the info block interactive and joined it to the dataset |
| `TaiwanVtuberTrackingData` | region segmentation (TW/HK/MY/JP) | Generalised to ten regions with script detection |

---

## 12. Documentation & agent skills

- `[x]` `docs/ARCHITECTURE.md` — how the system fits together.
- `[x]` `docs/DATA-SCHEMA.md` — every field, every file, every enum.
- `[x]` `docs/YOUTUBE-API.md` — quota maths and endpoint costs.
- `[x]` `docs/PLATFORMS.md` — the five platform adapters.
- `[x]` `docs/DEPLOY.md` — GitHub Actions, Pages, secrets, LFS.
- `[x]` `docs/CONTRIBUTING.md` — how to add a channel, a region, a platform.
- `[x]` `AGENTS.md` — repository guide for AI agents.
- `[x]` `.opencode/skills/*` — task-specific agent skills:

| Skill | Purpose |
| --- | --- |
| `sync-dataset` | Run, debug and extend the sync pipeline |
| `curate-data` | Fix classifications, add seeds, edit overrides |
| `verify-data` | Verify records against the web with search grounding |
| `search-index` | Tokenisation, ranking and the index format |
| `add-platform` | Add a platform adapter |
| `web-ui` | Views, filters, theme and the account menu |
