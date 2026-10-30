# Deployment

> GitHub Actions, GitHub Pages, secrets, Git LFS and the size limits that
> shape all of it.

## The workflows that matter

### `live.yml` — refresh who is streaming

```yaml
on:
  schedule:
    - cron: "7 */2 * * *" # every two hours
  workflow_dispatch:
    inputs:
      shard-count: { default: "4" }
      limit-live: { default: "6000" }
      limit-multi-platform-live: { default: "400" }
      dry-run: { default: "false" }
```

Runs `npm run data:live` (`--live-only`): it loads `data/`, asks every platform
who is streaming, retires the streams that ended to `past` with a real
duration, and writes **only** the item files — a live check changes no channel
record, so rewriting the channel shards and the `songs` projection would spend
the run's history on files that did not change. The search index is rebuilt by
the sync, not here: a broadcast the live run discovers is searchable after the
next six-hourly sync, not immediately, which is why `validate` reports the
index drift as a warning rather than an error.

It is separate from `sync-data.yml` because the live phase is the one whose
cost is proportional to the whole catalogue: one InnerTube Live-tab lookup per
YouTube channel, 63,000 of them, at roughly a second or two each. In the full
sync it outlived the job's `timeout-minutes` and the run was killed at 68% with
no commit. Here it is the whole run, so `limit-live` decides how much of the
rotation it covers and the job finishes: 6,000 channels, ~40 minutes at the
measured ~0.39 s a check, and 12 runs a day is 72,000 checks against 63,662
channels — one full sweep a day. Raise it only with that multiplication in
hand; runtime scales linearly with it.

The sync therefore **skips** this phase unless the run asks for it with
`--limit-live N`; `sync-data.yml` never passes it. That is the fix, not the
360-minute ceiling: a ceiling only buys a longer run that still dies before the
write.

`live.yml`, `sync-data.yml`, `verify-data.yml` and `data-squash.yml` share the
`dataset-writer-*` concurrency group, so a live run waits for a sync rather than
writing the same shards at the same time. Every workflow in the group sets
`cancel-in-progress: false` **and `queue: max`**:

```yaml
concurrency:
  group: dataset-writer-${{ github.repository }}
  cancel-in-progress: false
  queue: max
```

Without `queue: max` a group holds one running and one pending run, and a new
arrival cancels the *pending* one. That is how a scheduled sync disappears
behind another run while looking like it was merely queued. With
`queue: max` up to 100 runs wait for the group in FIFO order and a waiting sync
is never replaced. It is rejected by workflow validation when combined with
`cancel-in-progress: true`.

### `sync-data.yml` — refresh the dataset

```yaml
on:
  schedule:
    - cron: "17 */6 * * *" # every 6 hours
  workflow_dispatch:
    inputs:
      budget: { default: "2500" }
      no-search: { default: "false" }
      keyword: { default: "" }
      dry-run: { default: "false" }
      shard-count: { default: "4" }
      channels: { default: "" }
```

Steps: checkout → install LFS → install dependencies → restore the quota
cache → sync → append daily analytics to the separate archive (when configured)
→ build the search index → validate → rebase generated data onto the latest
branch → commit `data/`.

The catalogue is larger than one run can refresh, so the refresh rotation is
sharded deterministically by channel id (`--shard N/M`), and the live
rotation checks the catalogue volume-by-volume (`npm run data:volumes -- --count N`).
`volumeOf(id)` is rendezvous hashing, so a channel lives in exactly one volume
and adding a volume moves about `1/(N+1)` of the catalogue.

The scheduled live workflow computes the volume count from its `volume-count`
input (default 10) and checks every volume sequentially in one job (~5,000–7,000
channels each, ~2–4 min per volume), giving full catalogue coverage every sweep
instead of ~1 day with the shard rotation. The manual `shard-count` input on
sync changes the number of shards (`1` disables sharding) and `channels` caps
the number of channels refreshed in the run.

The manual `keyword` input replaces the configured discovery terms for
platforms that support keyword search. The `no-search` input skips discovery
and still refreshes known records. Platform search coverage and credential
requirements vary; see [PLATFORMS.md](PLATFORMS.md). Non-YouTube discovery
only accepts identities already in vdb, the dataset, or the seed catalog.
YouTube adds a new channel to virtual data only after at least two distinct
videos each show both virtual-creator identity and singing evidence.

The commit uses `stefanzweifel/git-auto-commit-action@v7`, so a run that
finds nothing new produces no commit and the git history stays clean.
The sync and verification workflows share a repository-wide concurrency group
and rebase generated changes onto the latest branch before committing.

### Discovery is not scheduled

`npm run data:discover` is a deliberate run, not a cron job: it reads the
Virtual YouTuber Wiki and the vTubie directory, and `--promote` writes channel
records. Its output is `data/identities.json`, which is committed like any
other dataset file, so a run that finds nothing new produces no diff at all.

vTubie needs a Chrome binary. The Ubuntu runners have `google-chrome`
installed; anywhere else, point `VTUBIE_CHROME_PATH` at one. `puppeteer-core`
is an optional dependency, and a checkout without it discovers nothing from
that source and says so in the log rather than failing.

### `verify-data.yml` — verify, and fill the missing cross-platform links

```yaml
on:
  schedule:
    - cron: "43 4 * * *"
  workflow_dispatch:
    inputs:
      limit: { default: "40" }
      max-confidence: { default: "1" }
      min-confidence: { default: "0.7" }
      links: { default: "120" }
```

Steps: verify the least-certain records with search grounding → resolve the
missing cross-platform links (`npm run data:links`) → re-sync known records
(`--no-search`) → rebuild the index → validate → commit `data/`.

`links` caps the link-resolution pass and `0` disables it. The pass is
sharded **eight ways** by `GITHUB_RUN_NUMBER`, so the Bilibili-only backlog is
covered a slice at a time instead of re-reading the same first hundred records.
It runs with `--web`, the optional search-grounded fallback, which needs
`GEMINI_API_KEY`; without the secret the deterministic sources (the
performer's own text, their X bio through FxTwitter, Wikidata) still run.

### `deploy-pages.yml` — publish the site

Runs on every push to `main`: checkout → install → validate → build → upload
the artifact → deploy to GitHub Pages.

The dataset is committed to the repository and copied into `dist/data/` by
`npm run prepare:public`, so Pages serves the app and the data from the same
origin. No CORS configuration is needed.

### `ci.yml` — gate every change

Runs on pushes and pull requests: validate → type-check → build. A broken
dataset or a broken build never reaches `main`.

### `repo-size.yml` — the history, not the tree

Runs weekly and on demand: checkout with `fetch-depth: 0`, then
`npm run repo:size`. It reports what GitHub actually stores — the packed
history, the loose objects, where the bytes went per top-level path, and the
largest blobs ever committed — writes it to the job summary, warns above
600 MB and fails above 1 GB.

**No workflow can shrink the repository.** `git gc` in a run cleans a
throwaway clone; GitHub does its own housekeeping on its side. A schedule here
is a smoke alarm, not a mop. The cheap fix is almost never a rewrite: this
repository once carried 8.37 GiB of packs of which 107 MB was reachable — a
reset and an aborted rebase had left three 2.7 GB copies of the same history
that nothing reached — and `git gc --prune=now` in a local clone reclaimed all
of it without touching a commit.

`fetch-depth: 0` is not optional: a shallow clone has almost no history, so it
reports a few megabytes and passes forever.

## Repository secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret                 | Required | Purpose                                                                                                                                |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_API_KEY`      | no       | YouTube Data API v3 extras: richer video statistics, exact broadcast times and a fallback for failed InnerTube lookups; discovery, uploads and live status work without it |
| `TWITCH_CLIENT_ID`     | no       | Twitch application client ID; used with the secret for sync channel discovery and live data                                            |
| `TWITCH_CLIENT_SECRET` | no       | Twitch application client secret; used with the client ID for sync channel discovery and live data                                     |
| `VK_ACCESS_TOKEN`      | no       | VK service token; required for keyword discovery and API-backed upload collection                                                     |
| `CI_ME_CLIENT_ID`      | no       | CI.ME Open API application client ID; enables profile refresh for known channel IDs                                                   |
| `CI_ME_CLIENT_SECRET`  | no       | CI.ME Open API application client secret; enables profile refresh for known channel IDs                                                |
| `GEMINI_API_KEY`       | no       | Search-grounded verification (`data:verify`) and the optional `--web` link discovery; the free tier is enough                       |
| `ANALYTICS_REPO_TOKEN` | no       | Fine-grained token with Contents read/write access to `himyjan/yt-vsinger-singer-disover-analytics`; enables daily analytics archiving |

`GITHUB_TOKEN` is provided automatically and needs no configuration.

Analytics is optional for the original site and appears automatically when
the public archive has daily data. The site checks the archive index once at
startup; when the index is unavailable or empty, it hides the Analytics view
and does not fetch history shards. The sync workflow can collect the archive
independently.

When available, the Analytics view reads daily snapshots from the public
[`yt-vsinger-singer-disover-analytics`](https://github.com/himyjan/yt-vsinger-singer-disover-analytics)
repository. The sync workflow samples platform profiles incrementally and
appends date-sharded JSON there, keeping unbounded history out of this
repository's 180 MB dataset budget. Without `ANALYTICS_REPO_TOKEN`, sync
continues normally but emits a workflow warning and skips the history archive.
Some metrics are unavailable unless their platform publishes them or the
corresponding API credentials are configured; the Analytics view identifies
those limitations rather than treating missing metrics as zero.

## Repository variables

| Variable         | Default         | Purpose                                       |
| ---------------- | --------------- | --------------------------------------------- |
| `VITE_BASE_PATH` | `/<repo-name>/` | Overrides the base path the deploy workflow derives; set `/` for a custom domain |

## Build-time variables for the web app

These are **not** secret — they are baked into the public bundle. They are
set as repository _variables_ so the deploy workflow can inject them.

| Variable                | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `VITE_GOOGLE_CLIENT_ID` | Enables YouTube account linking (Google Identity Services) |
| `VITE_TWITCH_CLIENT_ID` | Enables Twitch account linking (public client, PKCE)       |
| `VITE_VK_CLIENT_ID`     | Enables VK account linking                                 |
| `VITE_KICK_CLIENT_ID`   | Enables KICK account linking (OAuth 2.1 PKCE, public client) |

Bilibili account linking needs no configuration — the user supplies their own
`SESSDATA`.

The Google OAuth client must list the app's origin, and `http://localhost:3000`
for development, and allow the `https://www.googleapis.com/auth/youtube` scope.
That full scope is deliberate: InnerTube's subscription feed refuses
`youtube.readonly` above 1,000, so **Refresh** asks for “Manage your YouTube
account” and reads the complete list through the local dev server bridge (see
`docs/ARCHITECTURE.md`). A static build has no bridge and falls back to the Data
API's 1,000-item cap. The token is never stored server-side.

The local dev server also exposes the unauthenticated
`POST /api/youtube/channel` bridge for subscription cards. It reads the channel
header (the 🎵 Official Artist badge) and, on an untracked card that is opened,
the Live and Releases tabs. It makes no OAuth call, uses no token, and is not
part of the static build: on GitHub Pages the dataset's own badges still show,
but the per-subscription sync and the untracked-card detail modal are off.

When the subscription badge sync runs locally, checked badge values for
channels already in `data/` are also written to their channel shards. The
**Official artist** channel filter immediately uses the browser's fresh badge
cache while this write is running. On the static site, badge values remain
browser-only because GitHub Pages cannot write to the repository.

> **Never put a client secret in a `VITE_*` variable.** Anything prefixed
> `VITE_` ends up in the public bundle. The Twitch flow is deliberately
> PKCE-based so that a secret is never needed in the browser.

CI.ME credentials are only used by the scheduled data-sync pipeline and must
remain repository secrets; never configure them as frontend build variables.

## Enabling GitHub Pages

1. **Settings → Pages → Build and deployment → Source**: _GitHub Actions_.
2. Push to `main`, or run the `deploy-pages.yml` workflow manually.

**That source setting is not optional.** Left on _Deploy from a branch_,
Pages publishes the repository root rather than `dist/`: the raw
`index.html`, `/src/main.ts`, `server.ts` and the docs, none of which a
browser can run as the app. The page loads and stays blank.

A project site is served from `/<repo>/`, so the deploy workflow derives
the base path from the repository name and the repository variable only
overrides it:

{% raw %}
```yaml
VITE_BASE_PATH: ${{ vars.VITE_BASE_PATH || format('/{0}/', github.event.repository.name) }}
```
{% endraw %}

The Vite config reads it (`base: env.VITE_BASE_PATH || "/"`) and the data
loader prefixes every request with `import.meta.env.BASE_URL`, so the app
and the dataset resolve on either shape.

### The custom domain

`CNAME` named `ytvsingerdisover.music`. That domain resolves to nothing —
its nameservers are `ns.trs-dns.com` / `trs-ops.tucows.com`, and it answers
NXDOMAIN for A, AAAA and CNAME — and once a custom domain is configured,
Pages redirects **every** path of the project site to it. The site was
therefore unreachable from every URL it had, and the certificate Pages
served for that hostname was `*.github.io`. The file is gone; the site is
served from `https://himyjan.github.io/yt-vsinger-singer-disover/`.

Bringing the domain back takes all three steps, in this order:

1. At the registrar, point the apex at Pages and `www` at the user site:

   | type  | name | value               |
   | ----- | ---- | ------------------- |
   | A     | @    | 185.199.108.153     |
   | A     | @    | 185.199.109.153     |
   | A     | @    | 185.199.110.153     |
   | A     | @    | 185.199.111.153     |
   | AAAA  | @    | 2606:50c0:8000::153 |
   | AAAA  | @    | 2606:50c0:8001::153 |
   | AAAA  | @    | 2606:50c0:8002::153 |
   | AAAA  | @    | 2606:50c0:8003::153 |
   | CNAME | www  | himyjan.github.io   |

2. Add it back under **Settings → Pages → Custom domain**, wait for the
   certificate, then enable **Enforce HTTPS**.
3. Set the repository variable `VITE_BASE_PATH` to `/` — a custom domain is
   served from the root, not from `/<repo>/`.

## Serving from Vercel

The site is also deployed on Vercel (`yt-song-disover.vercel.app`), built from
the default branch — so a change reaches it when it lands on `main`.
`vercel.json` carries the two things a static host needs and Vercel does not
apply on its own:

- **Cache headers.** A bundle under `/assets/` is content-hashed and never
  changes under its own name, so it is cached for a year as `immutable`. The
  dataset under `/data/` is rewritten by the sync workflow every six hours, so
  it stays open for ten minutes with a day-long `stale-while-revalidate`: the
  next visit is served from cache immediately and refreshed in the background.
- **The routing chain.** Filesystem first, then a `404` for anything under
  `/assets/` or `/data/` that no file matches, and the app for everything
  else. A plain SPA fallback answers `200` with the app's HTML for a shard
  that is not there, which hides the miss from the browser, the network panel
  and any uptime check; naming those two prefixes keeps a missing file a plain
  `404` without losing the fallback the app needs.

GitHub Pages does not let a repository set response headers, so the same
deployment there is served with `Cache-Control: max-age=600` on everything —
hashed bundles included.

## Git LFS

GitHub recommends keeping a repository under **1 GB** (10 GB of `.git` is the
documented maximum) and caps a single LFS file at **2 GB** on the Free plan.

The JSON dataset is deliberately **not** in LFS: it is small, it needs to
diff cleanly in pull requests, and Pages has to serve it as plain text.

LFS is configured for the binary artefacts instead, via `.gitattributes`:

```gitattributes
*.db     filter=lfs diff=lfs merge=lfs -text
*.zip    filter=lfs diff=lfs merge=lfs -text
*.png    filter=lfs diff=lfs merge=lfs -text
```

If you add large media, remember:

```bash
git lfs install
git lfs track "*.mp4"
git add .gitattributes && git commit -m "track media with LFS"
```

The workflows install the LFS client explicitly:

```yaml
- name: Install Git LFS
  run: git lfs install --skip-repo && git lfs pull || true
```

### Keeping the repository small

- `reference/` and the reference checkouts are **git-ignored**. They are
  several GB and would destroy the repository budget. They exist for
  research only.
- `node_modules/` and `public/data/` are ignored — the second is the copy
  `prepare:public` makes for the build, and committing it stored the dataset
  twice.
- The dataset has hard size budgets — 8 MB per file, 180 MB for `data/` —
  enforced on write and checked in CI.
- Retention rules keep the dataset bounded: 30 items per channel, 1095-day
  (three-year) age limit, live and upcoming items always kept.

#### The limits that apply

| Limit | Value | Enforced? |
| --- | --- | --- |
| repository on disk (`.git`) | 10 GB | recommended maximum |
| a comfortable repository | 1 GB | recommendation |
| **published site** | **1 GB** | **enforced** — the deploy fails |
| a single push | 2 GB | **enforced** |
| a single object | 100 MB | **enforced** (1 MB recommended) |
| files in one diff | 300, or 1 MB of raw diff | the UI truncates the rest |
| entries in one directory | 3,000 | recommendation |
| pushes | 6 per minute | recommendation |

#### What actually binds

Two of those measure **different things**, and they are an order of magnitude
apart:

| | Repository | Site |
| --- | --- | --- |
| measures | every snapshot ever committed | the one snapshot that is published |
| ceiling | 10 GB | **1 GB** |
| grows by | every commit | the catalogue |

`prepare:public` checks the site, not the repository: it warns at 75 % of the
Pages ceiling and fails the build above it, because a deploy that runs for ten
minutes and is then refused is the worst place to learn the size.

At 1,773 bytes per record (72,113 records in 121.9 MB) the 1 GB ceiling lands
at roughly **580,000 channels** — about eight times today's catalogue, and
while the repository is still around 250 MB. That is the number the plan is
actually racing.

So the gate is 900 MB and the volume trigger is 700 MB, not 7.5 GB. A 7.5 GB
*catalogue* is a reasonable target; a 7.5 GB *repository* is not, because it
could only be published as a site ten times the ceiling. The way to own 7.5 GB
is ten volumes of ~750 MB, each with its own site, which is what the ladder's
third rung does — and then the gate is checked **per volume**, not for the
catalogue as a whole.

#### The tree is not the repository

`trackedRepoSize()` in `validate.ts` sums the files git tracks *now*.
GitHub stores the **history**: every shard a run rewrites adds a blob, and a
reset, an aborted rebase or a force-push can leave packs behind that no ref
reaches. Measured on 2026-10-28, after the last of those were cleared:

| | |
| --- | --- |
| one `data/` snapshot, packed | 28 MiB |
| code, `docs/` and skills history | 5 MiB |
| the whole repository after 78 data commits | 134.6 MiB |
| a routine data commit (median) | 0.3 MiB |
| a bulk rewrite — `reclassify --apply` over the catalogue | 20 MiB |
| the 10,254-record import plus that reclassify, together | 27 MiB |

Two things follow. A snapshot is not what costs; the *number of them* is, and
delta compression keeps each one cheap. And the expensive commit is the bulk
rewrite, not the daily refresh.

#### The capacity ladder

Four rungs, each with its own trigger. Do not skip one.

| When | Do this | Leaves |
| --- | --- | --- |
| weekly | `repo-size.yml` reports the stored size | a number, once a week |
| **the 1st of every month** | squash the data history to one snapshot | ~28 MiB now, ~55 MiB by the next squash |
| still above 700 MB after a squash, or two squashes inside six months | split the catalogue into **volumes** — `npm run data:volumes -- --count N`, then `--verify` | each volume under 700 MB |
| the sync's `repo:size --max-mb 900` gate fails | **stop** — the run refuses to commit and a person decides | never crosses 1 GB |

The gate is what makes the ladder work: no run can push the repository past
900 MB, so there is always 100 MB of room to act in.

#### The monthly squash

Data history older than a month is **disposable**. The records are generated,
and `addedAt`, `source`, the aliases and `verification` carry everything a
commit would show, so a squash costs a review window, not information.

```bash
git clone --no-local . /tmp/squash     # a fresh clone, not a working copy
cd /tmp/squash
pip install git-filter-repo            # the tool GitHub itself recommends

cp -a data /tmp/data-current           # filter-repo deletes it
git filter-repo --path data --invert-paths --force
cp -a /tmp/data-current data
git add data
git commit -m "data: snapshot $(date +%F)"
git push --force-with-lease origin main
```

Then check, in the repository:

```bash
npm run data:validate                  # the rewritten tree must still be valid
git log --oneline -- data | wc -l       # 1
npm run repo:size
```

`data-squash.yml` does the same, `workflow_dispatch` only: it takes a typed
confirmation, shares the dataset writers' concurrency group, validates before
it pushes, and uses `--force-with-lease`, so it can never overwrite a run that
committed while it was rewriting.

Two things to expect afterwards:

- **GitHub does not shrink immediately.** The old objects become unreachable
  and GitHub's own housekeeping prunes them (occasionally after asking
  Support). A fresh clone is the honest measurement.
- **Every clone, fork and open pull request is invalidated**, because a
  rewrite changes every commit sha. Announce it, or run it when nobody is
  mid-branch.

#### When a squash is not enough: volumes

If two squashes inside six months still leave the repository climbing, the
catalogue has outgrown one repository and the data moves to **volumes**: one
repository per slice, each written by its own workflow, each refreshed
independently.

One rule makes it safe:

> `volumeOf(id)` is a pure function of the channel id, and a channel lives in
> exactly one volume.

`shardOf()` in `scripts/lib/shard.ts` is that function for the rotation;
`volumeOf()` in `scripts/lib/volume.ts` is the one for the split. It uses
rendezvous hashing — `argmax hash(id, i)` — rather than `hash % N`, because
`% N` remaps about 80 % of the catalogue when a fourth volume becomes a fifth.
Rendezvous moves about `1/(N+1)`, and never moves a record between the volumes
that already exist.

A volume is **not** a rotation. An old volume keeps receiving updates — a
rename, an avatar, a live status — for the channels it owns, for as long as
the project runs. What it never receives is a channel that belongs to another
volume.

**Planning a split** writes to `.volumes/` (git-ignored) and never touches
`data/`:

```bash
npm run data:volumes -- --dry-run        # counts, sizes, and the cost of one more volume
npm run data:volumes -- --count 4        # write .volumes/vol-0 … vol-3
npm run data:volumes -- --count auto     # the smallest split whose largest volume fits --budget-mb (700)
npm run data:volumes -- --count 4 --index # …and build each volume's search packs
npm run data:volumes -- --verify .volumes # prove the partition holds
npm run data:volumes -- --self-test       # check volumeOf() itself
```

Each volume directory is a **site root with its dataset under `data/`** — the
same layout `prepare:public` produces — so it can be pushed straight into its
own repository and published as that repository's site. Inside `data/` it
holds `channels/<kind>/<region>/`, `channels/manifest.json`, `items/`
(partitioned by `volumeOf(item.channelId)`, so a video is in exactly one
volume too), its own `manifest.json` with its own counts, `overrides.json` —
curation is **copied, not split**, because an override that hides a fan
channel has to reach the volume that would otherwise publish it — and
`volumes.json`, the descriptor a client reads to find the others:

```bash
# every volume beside the primary, under /volumes/ — one site, several origins
npm run data:volumes -- --count 4 --base-url "/volumes/{name}/"

# one GitHub Pages repository per volume
npm run data:volumes -- --count 4 \
  --base-url "https://<user>.github.io/yt-vsinger-disover-{name}/"
```

`{name}` is `vol-0`…`vol-N` and `{index}` is the number; the default is
`{name}/`. Volume 0 is the origin the page was served from, so its `base` is
always `""` and its records are the ones under `/data`.

`--verify` reads the volumes *and* `data/`, and fails when a record is in two
volumes, in none, or in a volume other than the one `volumeOf()` names — a
verification that only looked at the volumes would accept a split that lost a
million records. `--self-test` checks the other half: that the function is
deterministic, balanced, and moves about `1/(N+1)` when the count grows.

**Taking a split live is still manual**, and deliberately so: create one
repository per volume, push `<out>/vol-N` into it, run the sync per volume, and
publish it at the address written into `volumes.json`. The client already
reads N origins — `src/lib/origins.ts` discovers them from `data/volumes.json`
and every loader merges — so the only thing that changes on the day is that
the file exists. Until then the file is absent and the app reads one origin
exactly as it always has. Keeping the split planned and verified before it is
needed is what makes that day a deployment rather than a migration.

Check the pages locally before publishing: copy `vol-0/data` to `public/data`
and the other volumes to `public/volumes/vol-N`, then load the app and confirm
the region counts add up to the whole catalogue.

## Local development

```bash
npm install
cp .env.example .env        # add YOUTUBE_API_KEY
npm run dev                 # Express dev server on :3000
npm run dev:web             # Vite dev server on :5173
```

The web app reads the dataset from `public/data/`, so run
`npm run prepare:public` after any dataset change.

## Running the pipeline by hand

```bash
npm run data:sync -- --dry-run          # fetch and classify, write nothing
npm run data:sync -- --budget 500       # cap the spend at 500 units
npm run data:sync -- --no-search        # refresh known channels only
npm run data:sync -- --shard 2/4        # refresh the second of four shards
npm run data:sync -- --limit-channels 50 --limit-live 100
npm run data:sync -- --keyword "vtuber 歌い手"
npm run data:index                      # rebuild the search index
npm run data:validate                   # check structure and budgets
npm run data:volumes -- --dry-run       # plan the split into volumes
```

`--shard N/M` is 1-based and selects the channels whose deterministic hash
falls in shard `N`; `M=1` disables sharding. `--limit-channels` and
`--limit-live` override the per-run caps in `config/sync.config.json` for a
bounded local run. Neither affects the dataset content beyond how much is
refreshed this time.

`--keyword` uses the same query on each enabled platform adapter that
implements search; it does not enable search on platforms without a usable
public search endpoint. The scheduled run uses the per-platform queries in
[`../config/platform-keywords.json`](../config/platform-keywords.json).
Non-YouTube search results do not add arbitrary accounts: sync only admits
identities already present in vdb, the dataset, or the curated seed catalog.
YouTube additionally admits a new channel into virtual data only after at
least two distinct videos mention both VTuber/VSinger identity and singing in
their titles, descriptions, or tags.

## Troubleshooting

**The sync workflow fails with a quota error** — the daily allowance is
spent. Check the quota state in the run summary, and lower
`maxSearchesPerRun` in `config/sync.config.json`.

**The site loads but shows no data** — the dataset was not committed, or
`prepare:public` did not run. Check that `data/manifest.json` exists and that
`dist/data/` is populated.

**Data requests 404 on Pages** — `VITE_BASE_PATH` does not match the page
path. For a project page it must be `/<repo>/`, with both leading and
trailing slashes.

**The push is rejected for being too large** — something large got committed.
Check `git count-objects -vH` and `npm run repo:size`. If the packs are far
larger than the reachable history (`repo:size` says so outright, and
`--repack` measures it), a reset or an aborted rebase left packs nobody
reaches: `git gc --prune=now` in a clone reclaims them. Only if the reachable
history itself is over budget do you need a rewrite, and rewriting is a
force-push that every clone has to follow.
