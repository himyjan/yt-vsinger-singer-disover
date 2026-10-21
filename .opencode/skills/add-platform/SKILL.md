---
name: Add Platform
description: Add a new streaming platform — the adapter interface, channel identity, account linking, discovery keywords and the UI wiring
---

# Add a platform

The project tracks YouTube, Twitch, Bilibili, Niconico and VK. Adding one is
five steps.

## 1. The adapter

Create `scripts/lib/platforms/<name>.ts`:

```ts
import type { CountRef, PlatformId } from "../types";
import type {
  PlatformAdapter,
  PlatformChannel,
  PlatformUpload,
} from "../platforms";

export class NameAdapter implements PlatformAdapter {
  readonly id: PlatformId = "name";
  readonly label = "Name";
  readonly color = "#123456";

  isConfigured(): boolean {
    return true;                       // or check for credentials
  }

  async resolve(query: string): Promise<PlatformChannel | null> { … }

  async uploads(channel: PlatformChannel, limit: number): Promise<PlatformUpload[]> { … }

  async live(channel: PlatformChannel): Promise<PlatformUpload[]> { … }

  async search?(query: string, limit: number): Promise<PlatformChannel[]> { … }
}
```

The contract:

- `resolve()` — turn a handle, id or URL into a channel.
- `uploads()` — recent uploads, newest first.
- `live()` — live and scheduled streams.
- `search()` — optional, for discovery.

**Every network call must degrade gracefully.** Return an empty array on
failure; never throw. A broken endpoint must never take the YouTube sync
down with it.

## 2. Register it

`scripts/lib/platform-registry.ts`:

```ts
import { NameAdapter } from "./platforms/name";

const name = new NameAdapter();
if (name.isConfigured()) adapters.push(name);
```

## 3. The types and URLs

`scripts/lib/types.ts` — add the platform to `PlatformId` and `ALL_PLATFORMS`.

`scripts/lib/platforms.ts` — add its profile URL to `PLATFORM_URLS`, and its
detection patterns to `detectPlatform()` and `extractPlatformId()`.

`src/lib/links.ts` — add its label, colour and icon to `PLATFORM_META` so the
"all links" block renders it.

## 4. Discovery keywords

`config/platform-keywords.json`:

```jsonc
{
  "name": ["keyword one", "keyword two"]
}
```

## 5. Account linking (optional)

`src/lib/auth.ts` implements `AuthProvider`:

```ts
export interface AuthProvider {
  id: PlatformId;
  label: string;
  color: string;
  isConfigured(): boolean;
  unavailableReason(): string | null;
  link(): Promise<ProviderAccount | null>;
  subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]>;
  unlink(account: ProviderAccount): void;
}
```

Then add it to `AUTH_PROVIDERS`. The account menu, the switcher and the
logout button all work off that list — no UI change is needed.

### OAuth in the browser

Two patterns are already implemented:

- **Google Identity Services** (`youtubeProvider`) — an implicit token flow
  through Google's script.
- **Authorization code + PKCE** (`twitchProvider`) — a public client, so no
  secret is needed in the browser. `runPopupFlow()` handles the popup and the
  callback; `sha256Base64Url()` builds the challenge.

**Never put a client secret in a `VITE_*` variable** — those are baked into
the public bundle. If a platform requires a secret, use PKCE or a backend
proxy.

A platform with no OAuth at all can use a pasted token — Bilibili works this
way with the `SESSDATA` cookie.

## Channel identity across platforms

A `Channel` carries a list of `PlatformLink`s, so one performer can be on
several platforms. The pipeline links them:

1. **Exact** — the platform channel id equals a dataset channel id.
2. **By name** — `findChannelByName()` in `scripts/sync.ts` compares
   normalised display names, and `normalizeForMatch()` in `src/lib/auth.ts`
   does the same for the browser.

When no YouTube counterpart exists, the adapter's channel becomes a
standalone dataset record with a namespaced id: `<platform>:<id>`.

## After the change

```bash
npm run data:sync -- --no-search
npm run data:index
npm run data:validate
npm run lint
npm run build
```

Then check that the platform's records appear in `data/channels/` with the
right `platforms[]` array, and that the links render in the channel drawer.

## Reference

`docs/PLATFORMS.md` documents the five existing adapters, their endpoints
and their quirks.
