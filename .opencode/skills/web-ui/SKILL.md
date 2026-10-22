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
state.subsTracked  // "all" | "tracked" | "untracked"
state.channelSubs   // "all" | "subscribed" | "not-subscribed" (Channels view)
state.accounts     // Record<provider, LinkedAccount[]>
state.activeAccount// Record<provider, accountId | null>
```

## Adding a filter

1. Add the state field to `src/lib/store.ts`.
2. Add the check to `filterItems()` / `filterChannels()` in
   `src/lib/dataset.ts`.
3. Pass it from the computed views in `src/App.vue`.
4. Add a chip to the filter bar.
5. If it applies to search results too, add the field to the search entry and
   rebuild the index — see the `search-index` skill.

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
- **Sign out** — revokes it locally and removes its subscriptions.

`+ Link another <platform> account` adds a second account on the same
platform. The active account is stored per platform, so switching is instant.

**A failed request must say why.** `AuthProvider.subscriptions()` throws the
platform's reason rather than returning `[]` — an empty list and a broken one
look identical to the user. For YouTube, `accessNotConfigured` means the
YouTube Data API v3 is not enabled in the Cloud project,
`insufficientPermissions` means the token lacks `youtube.readonly`, and a
401 means the token expired. After a successful link the app switches to the
`subs` view, so a link that produced nothing is never silent.

**Paging.** `subscriptions(account, onProgress)` calls `onProgress({loaded,
total})` after every page; `total` is Google's `pageInfo.totalResults`, and the
Subs header renders “loading 200 / 956…”. A 5xx is retried twice. If the API
returns fewer than `totalResults`, the toast says so — never report a truncated
list as complete. The API caps `mine=true` at about 1,000; an account that
subscribes more must be linked as a second account (they are merged).

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
