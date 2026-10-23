# Deployment

> GitHub Actions, GitHub Pages, secrets, Git LFS and the size limits that
> shape all of it.

## The workflows that matter

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
```

Steps: checkout → install LFS → install dependencies → restore the quota
cache → sync → append daily analytics to the separate archive (when configured)
→ build the search index → validate → rebase generated data onto the latest
branch → commit `data/`.

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

### `deploy-pages.yml` — publish the site

Runs on every push to `main`: checkout → install → validate → build → upload
the artifact → deploy to GitHub Pages.

The dataset is committed to the repository and copied into `dist/data/` by
`npm run prepare:public`, so Pages serves the app and the data from the same
origin. No CORS configuration is needed.

### `ci.yml` — gate every change

Runs on pushes and pull requests: validate → type-check → build. A broken
dataset or a broken build never reaches `main`.

## Repository secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret                 | Required | Purpose                                                                                                                                |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_API_KEY`      | no       | YouTube Data API v3 discovery and additional live/video metadata; InnerTube provides channel-search fallback                          |
| `TWITCH_CLIENT_ID`     | no       | Twitch application client ID; used with the secret for sync channel discovery and live data                                            |
| `TWITCH_CLIENT_SECRET` | no       | Twitch application client secret; used with the client ID for sync channel discovery and live data                                     |
| `VK_ACCESS_TOKEN`      | no       | VK service token; required for keyword discovery and API-backed upload collection                                                     |
| `CI_ME_CLIENT_ID`      | no       | CI.ME Open API application client ID; enables profile refresh for known channel IDs                                                   |
| `CI_ME_CLIENT_SECRET`  | no       | CI.ME Open API application client secret; enables profile refresh for known channel IDs                                                |
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

| Variable         | Default | Purpose                                   |
| ---------------- | ------- | ----------------------------------------- |
| `VITE_BASE_PATH` | `/`     | Set to `/<repo-name>/` for a project page |

## Build-time variables for the web app

These are **not** secret — they are baked into the public bundle. They are
set as repository _variables_ so the deploy workflow can inject them.

| Variable                | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `VITE_GOOGLE_CLIENT_ID` | Enables YouTube account linking (Google Identity Services) |
| `VITE_TWITCH_CLIENT_ID` | Enables Twitch account linking (public client, PKCE)       |
| `VITE_VK_CLIENT_ID`     | Enables VK account linking                                 |

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

For a project page (`https://<user>.github.io/<repo>/`), set the repository
variable `VITE_BASE_PATH` to `/<repo>/`. The Vite config reads it:

```ts
base: env.VITE_BASE_PATH || "/";
```

and the data loader prefixes every request with `import.meta.env.BASE_URL`,
so both the app and the dataset resolve correctly.

## Git LFS

GitHub Free allows roughly **1 GB** of repository content (hard limit 2 GB)
and a **2 GB** maximum for a single LFS file.

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
- `node_modules/` is ignored.
- The dataset has hard size budgets — 8 MB per file, 180 MB for `data/` —
  enforced on write and checked in CI.
- Retention rules keep the dataset bounded: 30 items per channel, 365-day age
  limit, live and upcoming items always kept.

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
npm run data:sync -- --keyword "vtuber 歌い手"
npm run data:index                      # rebuild the search index
npm run data:validate                   # check structure and budgets
```

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
Check `git count-objects -vH`, and confirm the offending path is matched by
`.gitignore` or `.gitattributes`.
