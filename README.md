<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>
# VSinger & Singer Tracker

# Run and deploy your AI Studio app
A discovery and tracking platform for **virtual singers (VTuber / VSinger)** and
**real human singers / music producers**, across **YouTube, Twitch, Bilibili,
Niconico and VK**.

- Collects VTuber singing streams, music videos, covers and original songs.
- Keeps the dataset **in the repository** as versioned JSON, so it is
  diffable, auditable and served directly from GitHub Pages.
- Searches it instantly with an inverted index built at pipeline time.
- Separates the **virtual** and **real** datasets, and splits everything by
  **region**.
- Lets you link your YouTube, Twitch, Bilibili and VK accounts to see the
  VTubers and singers you already follow.

View your app in AI Studio: https://ai.studio/apps/c2f26ca6-d056-4d97-8e93-41a4fa322e91
---

## Quick start

```bash
npm install
cp .env.example .env        # add YOUTUBE_API_KEY
npm run dev:web             # the web app on :5173
```

The web app reads the committed dataset in `data/`. To refresh it:

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
```bash
npm run data:sync           # fetch from the platform APIs
npm run data:index          # rebuild the search index
npm run data:validate       # check structure and size budgets
```

`npm run data:all` does all three.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | The brief, with status markers |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit together |
| [docs/DATA-SCHEMA.md](docs/DATA-SCHEMA.md) | Every field, every file, every enum |
| [docs/YOUTUBE-API.md](docs/YOUTUBE-API.md) | Quota maths and endpoint costs |
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | The five platform adapters |
| [docs/DEPLOY.md](docs/DEPLOY.md) | GitHub Actions, Pages, secrets, LFS |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | How to add a channel, a region, a platform |
| [AGENTS.md](AGENTS.md) | Guide for AI agents |

## How it works

```
scripts/sync.ts   →  classify  →  data/*.json  →  committed
                                        ↓
                              GitHub Pages (static Vue app)
```

The sync pipeline talks to the YouTube Data API v3 (free tier, 10,000 units a
day), and optionally to Twitch, Bilibili, Niconico and VK. A quota budget
refuses any call that would exceed the daily allowance, and every response is
cached so a re-run only spends quota on genuinely new data.

GitHub Actions refreshes the dataset every six hours, validates it, and
commits the result.

## The data layout

```
data/
├── manifest.json        counts, region table, quota usage
├── channels/            virtual.json · real.json · regions/<r>.json
├── items/               <region>/<bucket>.json · live.json · upcoming.json
├── songs/               the music-centric projection
└── search/              the inverted index, per region
```

Everything is sharded so no single file grows large — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#2-sharding-is-a-product-decision-not-an-implementation-detail).

## Classification

Each channel is classified along several axes, deterministically:

| Axis | Values |
| --- | --- |
| `kind` | `virtual` · `real` |
| `role` | `vtuber` · `vsinger` · `singer` · `musician` · `producer` · `composer` |
| `region` | `jp` · `cn` · `tw` · `hk` · `kr` · `en` · `id` · `my` · `sea` |
| `gender` | `female` · `male` · `unknown` |
| `isAi` | AI-generated performers (AI VTuber, AI singer) |
| `variant` | the combined label — `female_vtuber`, `ai_vsinger`, … |

Uploads are classified as `cover`, `mv`, `original`, `live`, `premiere` or
`performance`, and carry an `isAcoustic` flag for 弾き語り / 彈唱 — singing
while playing an instrument.

## License

The dataset is committed to this repository. The code is MIT licensed.
