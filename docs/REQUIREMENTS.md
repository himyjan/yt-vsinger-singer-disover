# VSinger & Singer Tracker — Development Requirements

> Living document. Every requirement below traces back to a request made during
> the project kickoff. Status markers: `[x]` done · `[~]` in progress ·
> `[ ]` not started.

---

## 1. Project purpose

A discovery and tracking platform for **virtual singers (VTuber / VSinger)** and
**real human singers / music producers**, focused on **YouTube** and **Twitch**,
with additional support for **Bilibili**, **Niconico**, **VK**, **CHZZK**,
**KICK** and **SOOP**. Available **CI.ME** profile links and other discovered
external links are shown where present.

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

- `[x]` YouTube — primary. InnerTube is the default pipeline source; the
      optional YouTube Data API v3 adds search and metadata, with InnerTube
      channel-search fallback when the key is missing or quota is exhausted.
- `[x]` Twitch — Helix API adapter with keyword discovery and live data when
      `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are configured.
- `[x]` Bilibili — public web API, no credentials needed.
- `[x]` Niconico — public video search API v2; discovery stores matched videos
      and derives their author channels. The public endpoint may be unavailable
      in some environments.
- `[x]` VK — official API with `VK_ACCESS_TOKEN` for keyword discovery and
      uploads; without it, known identities can only be refreshed in reduced
      mode.
- `[x]` **CHZZK** (Naver) — public keyword search, profile and live endpoints;
      no credentials required.
- `[x]` **KICK** — public known-channel profile and live endpoints; a usable
      public keyword-search endpoint is not available.
- `[x]` **SOOP** — public live-list adapter for discoverable public
      broadcasts; offline profile lookup is unavailable through a verified
      endpoint.
- `[x]` **CI.ME** — profile adapter for known channel IDs using the official
      Open API; requires server-side app credentials and does not expose
      documented public search, uploads or live endpoints.
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
- `[x]` The record's `id` is the **immutable** platform id — a YouTube
      `UC…` channel id. A `@handle` is unique but renameable, so a handle is
      stored in `handle` and never used as the identity. `data:details --
      --normalize-ids` re-keyed the 46 records that were stored as handles
      (42 resolved; 4 handles no longer resolve at all).
- `[x]` **A mirror is not an origin.** A Japanese VTuber with a Bilibili
      channel is `jp`, a Hololive EN member with one is `en`, and a Filipino
      VTuber with a Japanese stage name is `sea`. Fixing this moved 163
      records out of the wrong region — 135 Japanese performers who were
      filed under China, including 「巫てんり / Kannagi Tenri」, 「博衣こより」
      and 「獅白ぼたん」.
- `[x]` The region sources are **ranked**: an override, then the Taiwan track
      list's nationality, then the agency's branch, then the channel's
      published country, then kana in the Japanese name, then the platform,
      then vdb's display language, then a script guess. A merge keeps the
      more trusted one. The agency outranks the country because a branch is
      the scene the performer works in — a Hololive EN member stays `en`
      even if the channel's about page says Japan.
- `[x]` The channel's **published country** is read from YouTube's about page
      (`"country":"日本"`), which the InnerTube client did not fetch before —
      so every record had `country: null` unless the Data API supplied one,
      and a country could never outrank a mirror. 「向葵 / あおい」 publishes
      Japan, has a Bilibili account, and was stored as `cn`; it is now `jp`.
- `[x]` **A link is not a statement.** The word "bilibili" in a description
      used to be an explicit `cn` marker, so any Japanese channel that listed
      its Bilibili account was filed under China. It is no longer a marker:
      only a channel that exists *only* on Bilibili gets the platform prior.
      49 records were sitting in `cn` because of their own Bilibili link.
- `[x]` **A channel publishes a name per language.** YouTube answers with a
      different title for each `hl` — `Aoi / Vtuber` in English,
      「向葵 / あおい」 in Japanese — and the pipeline only ever asked in
      English. The profile is now requested in the language of the record's
      region, so the Japanese name is the one stored and the English
      localization becomes an alias; when the region is corrected the
      profile is fetched again in the new language.
- `[x]` A region is re-read for **every** record on every sync, from the
      stored name, description, tags and country, and only a more trusted
      source replaces a less trusted one — an override, a roster and an
      agency are never overwritten. `npm run data:details -- --weak-region`
      does the networked half: it fetches the country and the localized
      name for the records whose region is still a guess.
- `[x]` vdb's `name.default` is **not** a statement of origin — it is the
      language the Chinese wiki *displays*, so it lists 「巫てんり」 under the
      Chinese rendition of her name. It is the second-weakest signal.
- `[x]` A rename by hand — `region` in `data/overrides.json` — sets
      `regionSource: "override"` and is the final word.

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
- `[x]` The **agency is read out of the description** too, not only from the
      rosters: 「〇〇所属」 (Japanese), 「所属：〇〇」 · 「隶属于〇〇」 ·
      「〇〇旗下」 (Chinese), 「〇〇 소속」 (Korean), "affiliated with ○〇" ·
      "member of ○〇" (English). A stated agency sets `affiliation: "group"`
      in the same pass — 「にじさんじ所属」 is both facts at once.
- `[x]` 「無所属」 · 「无所属」 · 「非所属」 are checked **before** the
      patterns, because they deny an agency and contain the marker:
      `affiliation: "independent"`, no agency.
- `[x]` The big agencies are canonicalised — 「ホロライブ」, 「彩虹社」 and
      「니지산지」 become `hololive` and `nijisanji`, so one agency is not
      split across four spellings in the grouping.
- `[x]` An agency read out of a description **never decides the region**: it
      names the group, not the branch, and a Hololive EN member writes the
      same line as a Japanese one.

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
- `[x]` The phrase is matched with its **inflections** too, in the name *and*
      the description: 「活動を終了しました」, 「活動は終了」, 「活動終えました」,
      and the Chinese forms of the same message 「停止活動」/「停止活动」
      (「目前停止活動中」, 「无限期停止活动」) and 「活动终了」. The bare 「活動終了」
      was recognised but 「活動を終了」 was not, so 14 channels that had
      announced a retirement were still `unknown` or `active`.
- `[x]` The markers are multilingual, because the performers are.
- `[x]` A negated marker is **not** evidence: 「不會畢業」, 「不畢業」,
      「永不毕业」, 「卒業しません」, 「은퇴하지 않습니다», «не закрыт» and
      "not graduated" do not mark a channel as graduated. The check is per
      occurrence and clause-aware, so a positive marker elsewhere still wins.
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
      `npm run data:details -- --limit 2000`, with `--platform` to target
      one platform and `--dry-run` to preview.
- `[x]` `--name-only` corrects the names and the aliases without touching
      anything else — the cheapest pass, because the name comes from the
      same request as the avatar.
- `[x]` The script **re-reads the dataset before writing it**, so a sync
      that runs at the same time is not clobbered by a stale snapshot.
- `[x]` It writes the records through `writeChannelShards()`, which is the
      one writer and puts each channel in the dataset of its kind. It used to
      write only the copy it read, and the next sync, reading `virtual/`, put
      the roster's old name back: 「NoWorld Official」 reverted to
      「NoWorld」, 「巫てんり / Kannagi Tenri」 to 「巫天翼」. With one copy
      left there is nothing to drift.
- `[x]` It writes **only** what it fetched — the avatar, the current name,
      the description, the follower count — and leaves the rest of the
      record and the file layout untouched.
- `[x]` The script is called `fill-details.ts` / `npm run data:details` — it
      fills the details, of which the avatar is only the first. The old name,
      `fill-avatars`, described a fifth of what it does.
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
      Niconico, VK, CHZZK, KICK and SOOP, plus CI.ME and any other links found in
      the channel description when available.
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

Account linking is available only where the app has a provider that can fetch
the user's follows (or the closest available equivalent). Platform adapters
for discovery/profile refresh do not by themselves provide account linking.

| Platform | Can import follows? | Link method / notes |
| --- | --- | --- |
| **YouTube** | Yes — subscriptions | Google Identity Services OAuth |
| **Twitch** | Yes — followed channels | OAuth 2.0 with PKCE |
| **Bilibili** | Yes — followed users | `SESSDATA` session cookie |
| **Niconico** | Yes — followed users | `user_session` session cookie |
| **CHZZK** | Yes — followed channels | `NaverLogin` session cookie |
| **KICK** | Yes — followed channels | OAuth 2.1 with PKCE, or `kick_session` cookie |
| **VK** | Partial — friends, not channel subscriptions | Implicit OAuth; friend list is the closest equivalent |
| **SOOP** | No | No account-link provider; current integration reads public live listings |
| **CI.ME** | No | Profile lookup only; no documented follow-list endpoint/provider |

- `[x]` Client-side Google OAuth via Google Identity Services — works on a
      static site, no backend.
- `[x]` Scope: `https://www.googleapis.com/auth/youtube` (the full scope;
      InnerTube refuses `youtube.readonly` for a list above 1,000, and the
      Data API path still only reads).
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
- `[x]` **SOOP** and **CI.ME** are not presented as account-link options:
      SOOP has no follow-list provider, and CI.ME's documented API does not
      expose a follow-list endpoint.
- `[x]` The VK friend list is labelled as an approximation, not as channel
      subscriptions.
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
- `[x]` A **subscribed / not subscribed** filter on the Channels view, shown
      once an account is linked — the discovery direction: the performers the
      user does *not* follow yet.
- `[x]` After linking, the app switches to the subscription list and reports
      how many were linked, so a link that produced nothing is never silent.
- `[x]` A failed platform request names its cause instead of looking like an
      empty result: full YouTube permission missing (a stale read-only token),
      YouTube Data API v3 not enabled in the project, quota exhausted, account
      without a channel, expired token, or a consent-screen refusal
      (`access_denied`, `origin_mismatch`).
- `[x]` The linked account's own name and avatar come from
      `channels.list(mine=true)`. The full `youtube` scope the link now
      requests allows it (a read-only token would too); `oauth2/v3/userinfo`
      needs the `profile` scope and is only a fallback.
- `[x]` Subscription paging runs to the end and shows progress
      (“loading 200 / 956…”). A page is retried twice on a 5xx, so one
      transient error cannot truncate a long list.
- `[x]` `pageInfo.totalResults` is compared with what arrived: if Google
      reports more than the API returned, the app says so instead of showing a
      silently truncated list. This is the **fallback** path (a static build,
      or a token InnerTube refuses). The YouTube Data API returns at most
      **1,000** items for a list such as subscriptions, whatever the account
      holds; the account's own channels count is the other common reason the
      numbers differ.
- `[x]` Several accounts on the same platform are merged — a second YouTube
      channel's subscriptions add to the first rather than replacing them.

### 7h. Large accounts, suggestions and Official Artist Channels

- `[x]` The sign-in page states the trade-off plainly. YouTube linking asks
      for the full `youtube` scope, not `youtube.readonly`: InnerTube's
      `FEchannels` feed answers a read-only token with **403
      `insufficientPermissions`**. The token still lives in `localStorage`; the
      local dev server forwards it to `youtube.com` (which sends no CORS
      headers) and never stores or logs it. A static build has no `/api/…`
      JSON endpoint, and a 401/502 from the bridge means the token was refused
      or the request failed; either way the Data API path — capped at 1,000 —
      runs instead, and its truncation message points at **Export from
      YouTube** and the file import.
- `[x]` (2026-10-23) **Refresh** reads the complete list through that bridge.
      The TV client (`TVHTML5`, `browseId: FEchannels`) accepts the OAuth
      bearer token; the web client answers `400 invalid argument`. The TV feed
      returns channel `tileRenderer`s (id, title, handle, avatar), not
      `channelRenderer`s. Verified live: **4,804 subscriptions in 5 pages,
      ~2.4 s**, and the network log showed a single
      `/api/youtube/subscriptions` request and **no** Data API
      `subscriptions.list` call. If the bridge fails, the Data API path and its
      truncation warning remain.
- `[x]` The linked-account menu has **Reconnect**. It requests a fresh token
      (silently when the scope is already granted, otherwise with the consent
      screen) and keeps the account id, so the stored subscription list is
      replaced rather than duplicated. “The Google token expired” now points
      there instead of asking for an unlink.
- `[x]` Subscription lists are imported from a file — **Import CSV / JSON**
      reads a Google Takeout `subscriptions.csv`, the CSV produced by
      **Export from YouTube**, or a **PocketTube backup** (`Backup → Export`,
      a JSON of groups → `UC…` ids). One parser
      (`parseSubscriptionsFile()`) tells the formats apart from the content,
      and the rows are stored under the synthetic account `youtube:takeout`,
      so Refresh never overwrites them.
- `[x]` **Export from YouTube** copies a script that runs on
      `youtube.com/feed/channels` in the user's own session and downloads the
      same three-column CSV — instantly, with no Takeout queue, and it also
      covers legacy accounts whose Takeout zip comes out empty.
- `[x]` (2026-10-23) The export now reads the **whole** list, not the page's
      first 1,000 cards. It computes `SAPISIDHASH` from the session's
      `SAPISID` and walks the `FEchannels` continuation of
      `/youtubei/v1/browse` (~100 channels per page). Verified on a live
      account: **4,804 subscriptions in 49 pages**, exactly the ids the page
      rendered plus every continuation page, with names. The cookie and hash
      are used only to sign requests to `youtube.com` and never logged. If the
      signed request is refused, the script falls back to the rendered page and
      says so. A PocketTube backup or a Takeout CSV remains a valid import, but
      is no longer required for accounts above 1,000. Refresh now reads the
      same complete list through InnerTube when the dev server is available;
      this script remains the no-link and static-build path. The `(N)` in the
      tab title is the **unread notification count**, not the subscription
      count — never read it as a total.
- `[x]` Untracked subscriptions can be marked **Suggested** — per card
      (`＋ Suggest`) or in bulk (`Suggest all`) — which writes
      `data/suggestions.json` through the local dev server. On a static build
      the list stays in `localStorage` and can be downloaded as
      `suggestions.json`.
- `[x]` A suggestion can be removed again: per card (`✕`) or all at once
      (`clear`). A **Suggested** filter in the subs view lists the queue —
      including channels that are already tracked — so every suggested
      channel has a visible remove control.
- `[x]` Removal tells the truth about where the list lives: the dev server
      rewrites `data/suggestions.json` through
      `POST /api/dataset/suggestions/remove`; a failed write puts the keys
      back instead of claiming success; a static build clears only the
      browser copy. A `vst.suggested` value from an older build (a keyed
      object rather than an array) is normalized on read.
- `[x]` Importing suggestions into `data/` requires **explicit permission**
      (`consent: true`). The server refuses without it, and the UI asks the
      user to confirm they own the account or have permission — a
      subscription list is private and importing it publishes third-party
      channel records.
- `[x]` The import is batched (`offset`/`limit`) through the dev server: each
      id is resolved with InnerTube, re-fetched in the language of the region
      it implies, classified exactly as a sync would, merged, written, and the
      search index is rebuilt on the last batch.
- `[x]` The 🎵/🎶 badge beside a YouTube name marks an **Official Artist
      Channel**. The Data API does not expose it; it is read from the channel
      page (`AUDIO_BADGE` / `BADGE_STYLE_TYPE_VERIFIED_ARTIST`), stored as
      `isOfficialArtist` (filled by the details pass and the import), and the
      Channels view has a **🎵 Official artist** filter. The badge is also
      rendered in `ChannelCard`, `ChannelDrawer` and the subscription cards,
      so the channel list and the subscription list agree. It is YouTube's
      own inline SVG (`OfficialArtistBadge.vue`), not an emoji, and it sits to
      the **right** of the name.
- `[x]` (2026-10-23) **My subscriptions** shows the 🎵 badge too. The TV
      `FEchannels` feed that supplies the list does **not** carry
      `AUDIO_BADGE`, so a new local bridge,
      `POST /api/youtube/channel` (`scripts/lib/youtube-channel.ts`), reads
      `getChannel(id).header` one channel at a time. The result is cached per
      immutable `UC…` id in `vst.youtubeBadges` for **30 days**, separately
      from the subscription list, so Refresh cannot erase it. The sync starts
      automatically when the subs view opens, keeps two requests in flight,
      shows progress and has **Stop / Resume**; a 429 stops the run rather
      than turning a rate limit into 4,804 failed requests. Verified samples:
      `*HIROMI*singer` → `true`, Lofi Girl → `true`.
- `[x]` A subscription card's **live now / upcoming / songs** state comes
      from the dataset for a tracked channel. An untracked channel fetches it
      once when the card is opened (`detail: true` in the same bridge request)
      and shows a modal; a tracked card still opens the normal
      `ChannelDrawer`. The detail request adds `getLiveStreams()` and
      `getReleases()`; the background badge sync never asks for those tabs.
      The last 200 detail snapshots are cached in `vst.youtubeDetails`.
- `[x]` On a static build (`GitHub Pages`) there is no local bridge, so the
      background badge sync and the untracked-card modal stay off; the
      dataset's existing `isOfficialArtist` badges and its live/upcoming/song
      data still render. The local dev server exposes the bridge.

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

- `[x]` A channel is stored **once**, in `virtual/` or `real/` — the
      dataset of its kind. The scope switch is served without downloading the
      other one, so the two must stay separate.
- `[x]` `regions/` and `summaries/` are gone. They were extra copies of the
      same records (a details job corrected one, the sync read another and
      put the old name back) and the summaries were downloaded *and then
      ignored*, because the app loads the full records anyway. The list is
      now a projection of those records (`toSummary()` in
      `scripts/lib/summary.ts`) and `validate.ts` fails if a stray
      `channels/regions/` or `channels/summaries/` reappears. `data/` went
      from 69 MB to 30 MB.
- `[x]` **One writer at a time.** `acquireRunLock()` refuses to start when
      another run holds the dataset; two runs at once lose each other's work.
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
