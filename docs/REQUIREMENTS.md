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
| `manual`      | Curated by hand in `data/overrides.json`       |

> The legacy SQLite database has been **removed**. The dataset is now built
> from authoritative public sources (below), so no record is ever carried over
> from the old, unreliable classification.

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
- `[x]` **CHZZK** (Naver) — the public API, no credentials. The biggest Korean
      VTuber scene.
- `[x]` **KICK** — the public API, no credentials. Where a lot of the
      Western scene has moved.
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

## 5b2. The region is authoritative; the language follows it

- `[x]` The `language` is derived from the **region**, not from the name.
      Before this was fixed, 5,895 mainland Chinese channels were recorded as
      Japanese because their stage names use kana.
- `[x]` Hong Kong is Cantonese — `yue`, its own language rather than
      `zh-Hant`.
- `[x]` Cantonese markers (粵語 · 廣東話 · 廣州話) identify the Cantonese
      performers in the mainland scene too.
- `[x]` `regionSource` records which source decided the region.

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

## 5f. Independent vs. business group

- `[x]` `affiliation` — `independent` · `group` · `unknown`, stored on every
      channel and filterable from the web app.
- `[x]` The **business group name** is stored in `agency`, from vdb's
      `group_name` and the Taiwan roster's `Group Name` column (e.g.
      `VirtuaReal`, `NIJISANJI`, `极光社`, `ChaosLiveSprout`).
- `[x]` `unknown` is distinct from `independent` — the sources not saying is
      not the same as the performer being a solo act.
- `[x]` The affiliation is re-evaluated when a description arrives, because
      that is where a performer states it.

## 5f2. Verification, not a confidence score

- `[x]` There is **no** `confidence` field. A computed number is a guess
      dressed up as a measurement.
- `[x]` A `verification` record instead: what was looked up, by what, when,
      and the URLs that were read.
- `[x]` The verification queue is ordered by **what is not known** — an
      unknown region, an unknown role, no description — not by a score.
- `[x]` **Wikidata**, queried by the YouTube channel id. A hit is a fact:
      the id in Wikidata either is the same performer or is not. The same
      query returns the agency, the gender, the country and the inception
      date.
- `[x]` **Wikipedia**, through the REST API: a human-written description, the
      lead paragraph and the infobox image.
- `[x]` The Wikipedia text and image are only used when the article is
      actually *about the performer* — an article about someone who later
      became a VTuber often leads with their pre-fame career, and its
      infobox image is a photograph of them.
- `[x]` A search-grounded model remains the fallback for the performers
      neither of them covers.

## 5g. Channel details from the source

- `[x]` The profile — description, follower count, avatar, handle — is
      fetched from the platform's own API.
- `[x]` It is fetched **one channel at a time**, so it is rotated: the
      channels that have never been resolved come first, then the least
      recently resolved. 120 per run by default.
- `[x]` The description then feeds back into the classification: it can
      reveal the affiliation (「个人势」) and the activity (「已毕业」).

## 5h2. Upstream revision tracking

- `[x]` The commit SHA of every upstream is recorded in `data/upstream.json`
      and committed, so the dataset can be traced to the exact revision it
      was built from.
- `[x]` Each run compares the recorded revision with the current one and
      reports what moved — so a change in the data can be explained by the
      upstream commit that caused it.
- `[x]` A sync that finds nothing new upstream does not redo the work.
- `[x]` The upstreams tracked: **vdb**, the **Taiwan VTuber Tracking Data**,
      **AiSList**, the **VTuber Music Dataset** and **YouTube.js**.

## 5i. Twitch link correctness

- `[x]` The Taiwan track list stores the Twitch **numeric id** and the
      **login** in two columns, and its logins go stale when a performer
      renames their channel.
- `[x]` The numeric id is the stable identifier, so it is what the Twitch API
      is asked about; the API answers with the *current* login, which
      corrects the stale one.
- `[x]` The track list's login is only the fallback, for when the API cannot
      be reached.
- `[x]` The resolution is budgeted per run, so a run stays bounded and the
      rest are corrected on later runs.

## 5j. isSinging

- `[x]` True when the channel publishes singing **content** — a cover, an MV,
      an original song or a performance.
- `[x]` A live stream alone is not evidence — every channel streams — so it
      counts only on a channel that is already a singing one.
- `[x]` The channel's own **description** counts: a channel that says
      「VTuber / VSinger」 or 「歌い手」 in its bio is a singing channel. The
      description is fetched by the details pass, and the channel is
      re-classified once it arrives.
- `[x]` Filterable in the web app, and shown as a 🎤 badge on the card.

## 5k2. Graduation

- `[x]` A performer whose **name or description** says they have finished —
      「已停播」, 「已畢業」, 「畢業」, 「卒業」, 「活動終了」, 「retired»,
      «закрыт», 「은퇴」 — is marked `"activity": "graduated"`.
- `[x]` The markers are multilingual, because the performers are.
- `[x]` The status is a fact about the **performer**, not about one account:
      the record carries one `activity` and the platform links carry none.
- `[x]` A graduation is **never downgraded**. The classifier's silence is
      not evidence, and a source that states a graduation is right.
- `[x]` A hand-written `activity` in `data/overrides.json` is the final word.

## 5k. The name

- `[x]` The **platform** is the primary source for a name. A performer
      renames and the platform knows; a public roster records the name it
      saw, which can be months out of date.
- `[x]` Every record carries the provenance of its name — `manual`,
      `platform`, `seed` or `roster` — so a stale roster can never undo a
      platform's correction on the next run.
- `[x]` A hand-written name in `data/overrides.json` outranks everything.
- `[x]` Only the record's **own** platform may rename it. A Chinese
      Bilibili account must not rename a Japanese YouTube channel — the two
      names are different languages for the same performer.
- `[x]` A deleted account answers with a placeholder — 「账号已注销」 on
      Bilibili, 「(알 수 없음)」 on CHZZK. A placeholder is not a name, and
      it is rejected.
- `[x]` The name a record had is kept as an **alias**, and the aliases are
      indexed for search, so a channel that renamed is still findable under
      the name someone remembers.
- `[x]` The aliases the public rosters publish are kept too — the Taiwan
      track list records alias names that its own JSON API drops, and vdb
      lists the performer's name in every locale.
- `[x]` A channel title is often **several names in one string** —
      「空星きらめ/Sorahoshi Kirame【にじさんじ】」. Every part becomes an
      alias, so a search for the Japanese name, the romanised name or the
      agency all find the same channel.

## 5l. The avatars

- `[x]` Every card shows the channel's avatar. A missing avatar is a broken
      image, which is the first thing anyone sees.
- `[x]` The avatar comes from the **primary** platform, so a record never
      shows a Bilibili avatar on a YouTube channel.
- `[x]` A dedicated script fills the backlog:
      `npm run data:avatars -- --limit 2000`, with `--platform` to target
      one platform and `--dry-run` to preview.
- `[x]` `--name-only` corrects the names and the aliases without touching
      anything else — the cheapest pass, because the name comes from the
      same request as the avatar.
- `[x]` The script **re-reads each shard before writing it**, so a sync
      that runs at the same time is not clobbered by a stale snapshot.
- `[x]` It writes **only** what it fetched — the avatar, the current name,
      the description, the follower count — and leaves the rest of the
      record and the file layout untouched.
- `[x]` The normal sync's details pass takes a **per-platform share** of its
      budget, so the largest platform cannot take all of it and leave the
      others unresolved.

## 5h. Enrichment from the quota-free sources

- `[x]` The descriptions, avatars and follower counts are filled in from the
      platform APIs, one channel at a time, cumulatively across runs.
- `[x]` **InnerTube** (`youtubei.js`) for YouTube — no API quota.
- `[x]` **Twitch GQL** (`gql.twitch.tv/gql`) — the public web client id, so
      no secret and no quota.
- `[x]` **Bilibili's WBI-signed public API** — with the visitor id, which is
      what stops the risk-control system answering with HTTP 412.
- `[x]` An adaptive **rate limiter** shared by the three: the gap widens when
      a source pushes back and relaxes when it goes quiet.
- `[x]` The channels missing the most visible fields are resolved first.
- `[x]` With **no YouTube API key at all** the dataset still fills up.
- `[x]` A record without an avatar shows the performer's initials on a
      stable colour, never a broken image.

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

### 7.3 Account linking

Every platform the dataset covers can be linked, using whatever mechanism the
platform actually offers. The four that have no public OAuth ask the user for
their session cookie; the three that do use it.

| Platform | Mechanism | Configuration |
| --- | --- | --- |
| **YouTube** | Google Identity Services | `VITE_GOOGLE_CLIENT_ID` |
| **Twitch** | OAuth 2.0 with PKCE | `VITE_TWITCH_CLIENT_ID` |
| **VK** | implicit OAuth | `VITE_VK_CLIENT_ID` |
| **KICK** | OAuth 2.1 with PKCE | `VITE_KICK_CLIENT_ID` + `VITE_KICK_CLIENT_SECRET` |
| **Bilibili** | the `SESSDATA` cookie | none |
| **CHZZK** | the `NaverLogin` cookie | none |
| **Niconico** | the `user_session` cookie | none |

- `[x]` Client-side Google OAuth via Google Identity Services — works on a
      static site, no backend.
- `[x]` Scope: `https://www.googleapis.com/auth/youtube.readonly`.
- `[x]` **Twitch** — OAuth 2.0 with PKCE, so no client secret is needed in
      the browser.
- `[x]` **Bilibili** — the user pastes their `SESSDATA` cookie, because
      Bilibili offers no public OAuth for a follow list.
- `[x]` **VK** — implicit OAuth. VK has no channel-subscription concept, so
      the provider surfaces the user's friend list.
- `[x]` **Niconico** — the user pastes their `user_session` cookie. The API
      is the v2 one, and it needs the `X-Frontend-Id` headers the web app
      sends — without them the request never reaches the application.
- `[x]` **CHZZK** — the user pastes their `NaverLogin` cookie. The
      followed-channel list is published by
      `api.chzzk.naver.com/service/v1/channels/followings`, which is the
      endpoint the CHZZK web app itself calls.
- `[x]` **KICK** — OAuth 2.1 with PKCE against `id.kick.com`, the OAuth
      host, which is *not* the API host. The token exchange asks for the
      client secret, so a registered KICK app is needed; without one the user
      pastes their `kick_session` cookie instead, which needs no
      configuration at all.
- `[x]` Every provider that needs no configuration works **out of the box** —
      four of the seven need nothing but a cookie.
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
- `[x]` `docs/SOURCES.md` — every data source, what it provides, and which
      ones the pipeline actually reads.
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
