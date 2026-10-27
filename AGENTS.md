# AGENTS.md

> Guide for AI agents working in this repository.

## What this project is

A tracker and discovery platform for **virtual singers (VTuber / VSinger)** and
**real human singers / music producers**, with YouTube as the primary platform
and supported identities across **YouTube, Twitch, Bilibili, Niconico, VK,
CHZZK, KICK, SOOP and CI.ME**.

Three things it does:

1. **Collects** VTuber singing videos, music videos, covers, originals and live
   streams.
2. **Stores** the result as JSON committed to this repository (`data/`), so it
   is versioned, diffable and served straight from a static host (GitHub Pages,
   and a separate Vercel deployment with real cache headers).
3. **Searches** it instantly with an inverted index built at pipeline time.

## Before you change anything

```bash
npm install
npm run data:validate   # the dataset must be valid
npm run lint            # vue-tsc must pass
npm run build           # the app must build
```

All three also run in CI (`ci.yml`), so a green local run means a green PR.

## The two halves of the repository

They share `scripts/lib/types.ts` and `scripts/lib/search.ts` through the
`@shared/*` alias. There is exactly **one** definition of the data model and
**one** tokenizer.

### The pipeline (`scripts/`)

Node + TypeScript, no native dependencies. It runs unchanged in GitHub Actions.

```
scripts/
├── sync.ts            fetch → classify → merge → write
├── build-index.ts     build the inverted search index
├── fill-details.ts    fill the missing avatars, names and details
├── resolve-links.ts   find the missing cross-platform accounts
├── discover.ts        discover new performers into data/identities.json
├── validate.ts        CI gate
├── verify.ts          verify classifications with web-search grounding
├── import-legacy-db.ts  one-off SQLite migration
├── prepare-public.ts  copy data/ into public/ for the build
└── lib/               types, youtube, twitch, platforms, classify, regions,
                       identity, discovery-evidence, debut-sources,
                       promote-candidates, search, link-discovery, shard,
                       aislist, music-dataset, seeds, dataset, io
```

### The web app (`src/`)

Vue 3 + Tailwind v4 + Vite. Static — it reads the committed JSON and never
talks to a backend.

```
src/
├── App.vue            the shell: header, filters, views, drawer, mobile nav
├── lib/store.ts       reactive state: scope, filters, accounts, theme
├── lib/dataset.ts     loads and filters the dataset
├── lib/auth.ts        account linking for four platforms
├── lib/links.ts       the "all links" block
├── lib/env.ts         build-time environment
└── components/        LiveCard.vue, ChannelDrawer.vue
```

## The rules that matter

### 1. The scope switch is applied in the data layer

`Virtual` / `Real` / `Both` is enforced in `filterItems()` and
`filterChannels()` in `src/lib/dataset.ts` — **not** in individual views. Any
new view must funnel its results through those functions. Do not add a
per-view `kind` check.

### 2. The platform is the source of truth for a name

A performer renames. The rosters record the name they saw, which can be
months out of date, so every record carries the provenance of its name —
`nameSource`: `manual`, `platform`, `seed` or `roster`. The **platform**
is the primary source; a hand-written override in `data/overrides.json` is
the final word.

Two rules follow:

- **Only the record's own platform may rename it.** A Chinese Bilibili
  account must not rename a Japanese YouTube channel.
- **A placeholder is not a name.** 「账号已注销」 and 「(알 수 없음)」 are
  tombstones, and they are rejected.
- **The platform's name has a language too.** YouTube publishes a title per
  localization, so the profile is fetched in the language of the record's
  region — `ja` for a Japanese channel. The English localization of
  「向葵 / あおい」 is `Aoi / Vtuber`, and storing that as the name is how a
  Japanese channel looks Chinese: the other localizations become aliases.

A rename is **recorded**: the old name goes into `aliases`, and the aliases
are indexed for search, so a channel that renamed is still findable under
the name someone remembers.

A channel title is often **several names in one string** —
「空星きらめ/Sorahoshi Kirame【にじさんじ】」 is the Japanese name, the
romanised name and the agency. Every part becomes an alias, so a search for
any of them finds the channel. The rosters' own language variants do the
same: vdb lists a name per locale, and they all become aliases.

**The roster does not own the name.** A roster's name is a snapshot; the
name on disk is at least as fresh. So a merge never lets a roster's name
replace one the platform has confirmed.

### 3. A mirror is not an origin

A performer's region is where they belong, not where their accounts are
hosted. A Japanese VTuber with a Bilibili mirror is `jp`; a Hololive EN
member with one is `en`; a Filipino VTuber with a Japanese stage name is
`sea`.

The sources are ranked, and a merge keeps the more trusted one — the full
order is in `docs/DATA-SCHEMA.md`. Two of the rankings are easy to get
wrong:

- **vdb's `name.default` is the weakest.** It is the language the catalogue
  *displays*, and vdb is a Chinese wiki, so it lists 「巫てんり」 as `cn`.
  It never outranks kana, an agency branch or a published country.
- **Kana mean Japanese.** They occur in Japanese and nowhere else — but only
  as evidence, never as proof: a performer whose own country is published,
  or who belongs to a known agency, is decided by that instead. Two kana,
  not one: a single の or め is a Chinese stylisation.
- **A link is not a statement.** A channel that cross-posts to Bilibili lists
  `space.bilibili.com` in its description; that does not make the performer
  Chinese. Only a channel that exists **only** on Bilibili gets the platform
  prior, and the country YouTube publishes outranks it.

vdb files thousands of performers under Bilibili alone, which is how a
Japanese performer ends up as `cn`: the Bilibili account is the mirror, and
the roster has no YouTube link. `npm run data:links` finds the missing
account, and the **country** YouTube publishes then corrects the region —
`country` outranks `platform`, so the correction is allowed, and a stronger
source (agency, roster, override) is never overwritten. Discovery adds
links and a region fact; it never renames a record, because the performer's
own platform is still the authority for the name.

A link found by **searching a name** is only a candidate, and it is confirmed
against the record's **display name** — never an alias. Aliases are
romanisations the pipeline added (vdb lists 「维多利亚」 as `Victoria`), and a
common romanisation belongs to something else: the Canadian city of Victoria
has a YouTube channel. A link found in the performer's **own text** is taken
at face value, because there the performer said it themselves.

Note that vdb's `jp` **name field is not kana evidence**: it stores kana
readings of Chinese names (「小卯」 → 「コウサギ」), which would re-file
thousands of Chinese performers as Japanese. Only the display name counts,
in both `classifyChannel()` and `vdb.ts`.

### 4. The id is the immutable platform id

`UC…` for YouTube, the numeric id for Twitch, `<platform>:<id>` for the rest.
A `@handle` and a Twitch login are **names**: unique today, renameable
tomorrow, and a record keyed by one breaks the day the performer changes it.
They live in `handle`, beside the id, and are refreshed from the profile.

`scripts/lib/youtubei.ts` returns the real id from the response — not the one
that was asked for — because that is the only one that can be trusted.

### 5. A channel is stored once

In `virtual/` or `real/`, never both — that is the scope switch, served
without downloading the other dataset. `writeChannelShards()` writes each
record to its own kind and nothing else, and `readAllChannelRecords()` reads
the pair back, so there is no second copy a run could leave stale.

The list views are a **projection**, not a file: the app builds them from the
records it has already downloaded for the drawer (`toSummary()` in
`scripts/lib/summary.ts`). Do not reintroduce `regions/` or `summaries/` —
`validate.ts` fails when either appears.

**A shard is one channel per line.** `writeChannelShards()` writes a compact
form: one record per line, fields equal to their default omitted. Written as
pretty-printed JSON, removing one record rewrote the file and git showed
thousands of unchanged lines — which is how a 344-record fix became an
88,000-line diff. Both readers restore the defaults (`expandChannel()` in
`scripts/lib/dataset.ts` and in `src/lib/dataset.ts`); keep their
`CHANNEL_DEFAULTS` tables in step.

**A fan account is not a performer.** 搬运组, 字幕组, 切片/烤肉 channels and
accounts named after their subject (「Petra的极地考察队」) are duplicates of
the artist they publish for. `detectClipAccount()` and `isFanAccountName()`
in `scripts/lib/classify.ts` find them; the ones already in the dataset are
hidden with `"hidden": true` in `data/overrides.json`, never deleted by hand.
A curated `kind` outranks the test — a person filing a channel is not a
name pattern.

### 6. One writer at a time

`acquireRunLock()` refuses to start when another run holds the dataset. Both
the sync and the details fill read the whole dataset before they write it, so
two at once lose each other's work.

### 7. A confidence score is not a fact

`confidence` is **optional** and the dataset does not populate it. A computed
number is a guess dressed up as a measurement, and what a record needs to say
is `verification`: what was looked up, by what, and what was found.

The verification queue is ordered by *what is not known* — an unknown region,
an unknown role, no description — not by a score. The type still allows
`confidence` for a producer that wants to record an estimate, and
`docs/DATA-SCHEMA.md` documents its shape.

### 8. The classifier is deterministic

`scripts/lib/classify.ts` has no randomness and no network calls. The same
input always produces the same record. This is what keeps the git history of
`data/` readable — do not introduce `Math.random()`, timestamps or
network-derived values into a record's classification.

### 9. Never write a file over the size budget

`scripts/lib/io.ts` throws when a file exceeds 8 MB, and `data/` is capped at
180 MB. GitHub Free allows ~1 GB for the whole repository. If a change makes
the dataset grow, add a retention rule rather than raising the budget.

### 10. Every record keeps its provenance

`mergeById()` preserves `addedAt`, and preserves `source: "seed"` and
`source: "manual"` across API refreshes. Do not overwrite provenance.

### 11. Never let a failing source break the run

Every network call in the pipeline is wrapped, and every one of them carries
a timeout — a `fetch` with no timeout never rejects, it just hangs, and a
hung request in a loop of thousands stalls the run with no output and no
error. A source that is unreachable must return an empty result and log
why. A broken Bilibili endpoint must never take the YouTube sync down.

When a source pushes back — Bilibili's risk control, for instance — the
run **backs off and leaves it alone** rather than grinding through
thousands of doomed requests.

### 12. Quota is a hard constraint

The YouTube free tier is 10,000 units/day and `search.list` costs 100. The
`QuotaBudget` refuses calls that would exceed the limit. Never bypass it with
a direct `fetch` to the API.

### 13. `better-sqlite3` is an optional dependency

It is only used by the one-off legacy migration. The CI path must stay free
of native modules.

### 14. YouTube Refresh needs the full scope and the local bridge

The YouTube link asks for `https://www.googleapis.com/auth/youtube`, not
`youtube.readonly`: InnerTube's `FEchannels` feed answers a read-only token with
403 `insufficientPermissions`. The browser cannot call `youtube.com` (no CORS
headers), so `server.ts` proxies the request to the **TVHTML5** client, which
returns channel `tileRenderer`s rather than `channelRenderer`s. A static build
has no bridge and falls back to the Data API's 1,000 cap. The token stays in
the browser; the server only forwards it to YouTube and never stores or logs
it. Do not change the scope back to read-only — that breaks Refresh for
accounts above 1,000.

### 15. Automatic discovery has admission gates

Non-YouTube automatic discovery only accepts platform identities already
listed in vdb, present in the dataset, or explicitly added through
`data/seed-catalog.json`. If vdb is unavailable, do not admit new
non-YouTube identities automatically. Existing records are never deleted by
this discovery filter. A curated directory — vTubie's groups, bacharu's
roster — is a roster of the same kind: an entry there is the **claim**, and
the performer gate above still decides whether it is admitted.

YouTube has a deliberate discovery exception because singing-stream and relay
hashtags vary. A new YouTube identity can enter virtual data only after at
least two distinct videos each show both virtual-creator identity (VTuber,
VSinger, or localized equivalents) and singing evidence (for example 歌枠,
歌ってみた, 弾き語り, KARAOKE, or relay hashtags) in available titles,
descriptions, or tags. Singing evidence alone must not classify an ordinary
singer or karaoke streamer as virtual. `--no-search` skips keyword searches,
but a run without a Data API key may still rebuild the roster, discover
channels and videos through InnerTube, and refresh live status; that roster is
filtered against vdb, existing records, and curated seeds.

**A curated or community harvest is a different path and has a different
gate.** The dataset tracks VTubers who stream variety, not only singers — of
14,307 virtual records only 1,206 set `isSinging` — so singing is **not** an
admission requirement for a performer. What a harvest must exclude is a
**fan**, not a non-singer:

- a virtual-creator claim must appear somewhere — the platform bio, the X
  bio, or the display name;
- `detectClipAccount()` and `isFanAccountName()` must both be false, because a
  clip channel happily puts 「Vtuber」 in its name while being a duplicate of
  the performer it clips;
- an account that never claims a virtual identity is **reported for review**,
  not admitted and not silently dropped.

A community is not a roster: r/VirtualYoutubers and the X "VTubers!"
community both admit "any VTubers & VTuber fans", so membership says nothing
about whether an account is a performer. See
`.cache/x-community-suggest.ts` for the implementation.

### 16. One run owns one shard of the catalogue

The catalogue is far larger than a single run can refresh. Do not refresh the
same `slice(0, N)` every run: filter the refresh, live and discovered-candidate
sets through `inShard()` in `scripts/sync.ts`. The shard is
`FNV-1a(channel id) % shardCount`, so it is stable across machines and the
scheduled workflow rotates `--shard N/M` with `GITHUB_RUN_NUMBER`. Within a
shard, channels that have gone longest without a refresh are ordered first.
Keep the assignment deterministic — a cursor file or `Math.random()` would make
`data/` history unreviewable.

InnerTube is the primary YouTube source (channel and video search, profiles,
uploads, releases, Live tab) and spends no Data API quota. The Data API is
optional and supplies richer video statistics, exact broadcast times and a
fallback for failed InnerTube lookups. `liveBroadcasts.list` must not replace
the Live tab: it requires OAuth, and the scheduled pipeline only has an API
key.

The sync and verification GitHub workflows both write `data/`. Keep them in
the same repository-wide concurrency group and rebase generated changes onto
the latest branch before committing, so concurrent dataset writers do not
create non-fast-forward push failures.

## Common tasks

| Task | Where |
| --- | --- |
| Fix a misclassified channel | `data/overrides.json`, then `npm run data:sync -- --no-search` |
| Import a subscription list | Subs view → **Import CSV / JSON** (Takeout CSV, PocketTube backup, or **Export from YouTube**) |
| Import a song playlist DOCX | `npm run data:import-playlist -- "path/to/playlist.docx"`; only matched existing channels and clearly classified songs are imported; unmatched links are written to `.cache/playlist-import-unmatched.json` |
| Refresh all YouTube subscriptions | **Refresh** (InnerTube through `server.ts`); **Reconnect** when the token expired; a static build falls back to **Export from YouTube** |
| Fix the 🎵 badge on a subscription card | `scripts/lib/youtube-channel.ts` (header read), `server.ts` (`POST /api/youtube/channel`), `src/App.vue` (sync/cache), `src/components/OfficialArtistBadge.vue` (official icon, right of the name); cache is `vst.youtubeBadges` |
| Change an untracked subscription's detail modal | `src/components/SubscriptionDetail.vue`, `src/lib/youtube-detail.ts`, `src/lib/store.ts` (`vst.youtubeDetails`) |
| Suggest channels for the dataset | Subs view → **＋ Suggest** / **Suggest all** (`data/suggestions.json`), then **Add to dataset** |
| Fix an outdated channel name | the platform corrects it; `npm run data:details -- --name-only` to apply it now |
| Fix a Bilibili avatar (mixed content / 403) | `scripts/lib/platforms/bilibili.ts` (`absoluteUrl`), `src/lib/image.ts`, and `referrerpolicy="no-referrer"` on `<img>` |
| A record keyed by a handle | `npm run data:ids` — resolves it to the `UC…` id |
| Fill the missing avatars | `npm run data:details -- --limit 2000` |
| Fill the missing follower counts | `npm run data:details -- --counts-only --limit 500` |
| A Bilibili-only record with no YouTube/Twitch link | `npm run data:links -- --limit 200` (add `--platform bilibili --shard 2/4` to slice it) |
| A record filed under `cn` that is really Japanese | `npm run data:details -- --weak-region` re-derives it; `data:links` corrects it from the discovered YouTube country |
| Fix the classifier itself | `scripts/lib/classify.ts` |
| Add a curated channel | `data/seed-catalog.json` |
| Discover new performers | `npm run data:discover` — vTubie's directory, read with a browser (`puppeteer-core`, optional); candidates land in `data/identities.json`, and `--promote` adds the ones that pass the two-video gate to `data/channels/` |
| Add a VTuber group's members | `npm run data:vtubie-groups` (browser, resumable) then `npm run data:vtubie-import -- --apply`; the group page is the only vTubie path that publishes the `UC…` id, so no name search is involved |
| Add new VTubers from the bacharu roster | `npm run data:bacharu` (JSON API, resumable) then `npm run data:bacharu-import -- --apply`; a row with only an `@handle` needs `--resolve-handles` first |
| Add a region | `scripts/lib/types.ts`, `scripts/lib/regions.ts` |
| Add a platform | `scripts/lib/platforms/<name>.ts` + `platform-registry.ts` |
| Add a discovery source | `scripts/lib/debut-sources/<name>.ts` |
| Change the search behaviour | `scripts/lib/search.ts`, then `npm run data:index` |
| Add a UI filter | `src/lib/dataset.ts` (`filterItems`) + `src/App.vue` |

## Running things

```bash
npm run data:sync -- --dry-run       # fetch and classify, write nothing
npm run data:sync -- --budget 500    # cap the spend
npm run data:sync -- --no-search     # refresh known channels only
npm run data:sync -- --shard 2/4     # one deterministic slice of the rotation
npm run data:sync -- --limit-channels 50 --limit-live 100
npm run data:sync -- --keyword "…"   # run one discovery query
npm run data:import-playlist -- "playlist.docx" --dry-run # preview a DOCX import
npm run data:verify                   # verify classifications with search grounding
npm run data:index                   # rebuild the search index
npm run data:details -- --limit 2000 # fill the missing avatars
npm run data:details -- --counts-only --limit 500 # fill the hidden follower counts
npm run data:details -- --name-only  # correct the names and the aliases
npm run data:details -- --platform bilibili --dry-run
npm run data:links -- --limit 200    # find the missing cross-platform accounts
npm run data:links -- --shard 2/4 --web --dry-run  # + search-grounded fallback
npm run data:discover                # new performers from the directory sources (vTubie)
npm run data:discover -- --promote   # + add the ones that pass the virtual-and-singing gate
npm run data:vtubie-groups            # vTubie groups → .cache/vtubie-groups.json (browser, resumable)
npm run data:vtubie-import -- --apply # add the harvested YouTube channels that pass the performer gate
npm run data:bacharu                  # the bacharu roster → .cache/bacharu-vtubers.json (JSON, resumable)
npm run data:bacharu -- --merge-only  # rebuild the snapshot from the page files
npm run data:bacharu-import           # report what the roster adds; --apply to import the ids
npm run data:ids                     # re-key handle ids to UC… ids
npm run data:validate                # structure + budgets
npm run data:import-legacy           # migrate the old SQLite database
```

## Skills

Task-specific instructions live in `.opencode/skills/`:

| Skill | Use it when |
| --- | --- |
| `sync-dataset` | Running, debugging or extending the sync pipeline |
| `curate-data` | Fixing classifications, adding seeds, editing overrides |
| `verify-data` | Verifying records against Wikidata, Wikipedia and search grounding |
| `search-index` | Changing tokenisation, ranking or the index format |
| `add-platform` | Adding a platform adapter |
| `web-ui` | Building or changing views, filters or the theme |

Load one with the `skill` tool, e.g. `skill({ id: "sync-dataset" })`.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/REQUIREMENTS.md` | The original brief, with status markers |
| `docs/ARCHITECTURE.md` | How the pieces fit together |
| `docs/DATA-SCHEMA.md` | Every field, every file, every enum |
| `docs/YOUTUBE-API.md` | Quota maths and endpoint costs |
| `docs/PLATFORMS.md` | The platform adapters and their discovery coverage |
| `docs/SOURCES.md` | Every data source, and which are read |
| `docs/DEPLOY.md` | GitHub Actions, Pages, secrets, LFS |
| `docs/CONTRIBUTING.md` | How to add a channel, a region, a platform |

## External data sources

| Source | URL | Used for |
| --- | --- | --- |
| YouTube Data API v3 | `developers.google.com/youtube/v3` | Optional video statistics, exact broadcast times and a fallback; InnerTube (`youtubei.js`) is the primary source for channel/video search, profiles, uploads, releases and live status |
| YouTube InnerTube | `youtubei.js` | Quota-free YouTube channel and video search, profiles, uploads, releases and the Live tab |
| AiSList | `github.com/Override92/AiSList` | Which channels are AI-generated |
| VTuber Music Dataset | `github.com/meihei3/VTuber-music-dataset` | Curated song and original-artist metadata |
| Virtual YouTuber Wiki | `virtualyoutuber.fandom.com/api.php` | Debut dates, graduation dates, wiki identities |
| Moegirl encyclopedia | `zh.moegirl.org.cn/zh-tw/虚拟UP主用语与梗` | Chinese VTuber terminology — the 勢 (camp) system, 歌勢, 中之人, 切片 |
| Wikidata | `query.wikidata.org/sparql` | The YouTube id, the agency, the gender, the country |
| Wikipedia | `en.wikipedia.org/api/rest_v1/` | A sourced description and the infobox image |
| VocaDB | `vocadb.net` | Artists with their platform links, and their songs |
| Bilibili | `api.bilibili.com` | Chinese VTuber channels |
| CHZZK | `api.chzzk.naver.com` | The Korean VTuber scene |
| KICK | `kick.com/api/v2` | The growing Western scene on KICK |
| SOOP | `live.sooplive.co.kr/api/main_broad_list_api.php` | Public live streams; no verified offline profile API |
| CI.ME | `ci.me/api/openapi/open/v1/channels` | Profile details for known CI.ME channel IDs; requires CI.ME app credentials |
| Niconico | `api.search.nicovideo.jp/api/v2` | Japanese original songs and covers |
| VK | `api.vk.com/method` | Russian VTuber channels |

Reference sites worth looking at:
[holodex.net](https://holodex.net) ·
[music.holodex.net](https://music.holodex.net) ·
[taiwanvtuberdata.github.io](https://taiwanvtuberdata.github.io/) ·
[vdb.vtbs.moe](https://vdb.vtbs.moe)
