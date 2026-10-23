/**
 * Account linking for every platform.
 *
 * The user can link their YouTube, Twitch, Bilibili and VK accounts. Each
 * provider implements the same small interface, so adding a platform is one
 * file. The linked account's followed channels / singers are then matched
 * against the local dataset, so the user sees which of their subscriptions
 * are already tracked — and which are not.
 *
 * ## Design notes
 *
 * - **Tokens stay in the browser.** They live in `localStorage` and are only
 *   sent to the platform's own API. The one exception is YouTube: the token is
 *   posted to the app's own local dev server, which forwards it to
 *   `youtube.com` because InnerTube sends no CORS headers. That server never
 *   stores or logs it, and a static build has no server at all.
 * - **Twitch** uses the OAuth 2.0 authorization-code flow with PKCE. A public
 *   client needs no client secret, so this works entirely client-side.
 * - **YouTube** uses Google Identity Services. It asks for the full `youtube`
 *   scope, not `youtube.readonly`: InnerTube refuses the read-only token with
 *   `insufficientPermissions` when it reads a subscription list beyond 1,000.
 *   The Data API path only reads, whatever the scope allows.
 * - **Bilibili** has no public OAuth that exposes "who I follow", so the user
 *   pastes their `SESSDATA` cookie value. It is stored locally like any
 *   other token.
 * - **VK** uses the implicit OAuth flow. VK has no channel-subscription
 *   concept, so the provider surfaces the user's *friends* — which for the
 *   VTuber scene is the closest equivalent — and matches them by name.
 */

import type { PlatformId } from "@shared/lib/types";
import type { LinkedAccount as StoredLinkedAccount } from "./store";
import { env } from "./env";

export interface RemoteSubscription {
  /** Platform-native channel / user id. */
  channelId: string;
  /** Display name. */
  name: string;
  /** Handle / login / space id, when known. */
  handle: string | null;
  /** Profile image. */
  thumbnail: string | null;
  /** Profile description. */
  description: string | null;
}

/**
 * The account a provider returns after linking.
 *
 * The `id` is assigned by the app, not the provider, so the same shape can be
 * stored for several accounts on one platform.
 */
export type ProviderAccount = Omit<StoredLinkedAccount, "id">;

export interface AuthProvider {
  id: PlatformId;
  label: string;
  /** Colour used for the provider badge. */
  color: string;
  /** True when the provider can be linked in the current configuration. */
  isConfigured(): boolean;
  /** Why the provider cannot be linked, when it cannot. */
  unavailableReason(): string | null;
  /**
   * Starts the linking flow.
   * Resolves with the linked account, or `null` when the user cancels.
   *
   * `prompt: ""` asks Google for a token without a consent screen when the
   * scope is already granted — used when reconnecting an expired account.
   * The default is the full consent flow, which is what a first link needs.
   */
  link(options?: { prompt?: "consent" | "" }): Promise<ProviderAccount | null>;
  /**
   * Fetches the account's followed channels / singers.
   *
   * `onProgress` is called after each page when the platform paginates, so a
   * large list can show "450 / 4,000" instead of freezing.
   */
  subscriptions(
    account: ProviderAccount,
    onProgress?: (progress: { loaded: number; total: number | null }) => void,
  ): Promise<RemoteSubscription[]>;
  /** Ends the session. */
  unlink(account: ProviderAccount): void;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function currentOrigin(): string {
  return window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "/");
}

/** Generates a random string for OAuth `state` / PKCE challenges. */
function randomString(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 digest, base64url encoded — used for the PKCE challenge. */
async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Normalises a name for matching against the local dataset. */
export function normalizeForMatch(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* YouTube — Google Identity Services                                         */
/* -------------------------------------------------------------------------- */

/**
 * The full YouTube scope, not `youtube.readonly`.
 *
 * InnerTube's `FEchannels` feed rejects a read-only token with 403
 * `insufficientPermissions`; the signed-in web client asks for the management
 * scope. The app uses it to read the subscription list (the Data API path
 * still only reads), and the token stays in this browser — it is sent to the
 * local dev server only to make the same-origin InnerTube request.
 */
const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

/**
 * Reads the whole subscription list through the local dev server, which can
 * reach InnerTube (the browser cannot: `youtube.com` sends no CORS headers).
 *
 * Returns `null` whenever the bridge is unavailable — a static build has no
 * `/api` at all, or an old read-only token is refused — so the caller falls
 * back to the Data API and its own error reporting. The token is only placed
 * in the request body to the same origin; it is not stored or logged.
 */
async function fetchInnerTubeSubscriptions(
  token: string,
  onProgress?: (progress: { loaded: number; total: number | null }) => void,
): Promise<RemoteSubscription[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch("/api/youtube/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | {
          ok?: boolean;
          items?: Array<{
            channelId?: unknown;
            name?: unknown;
            handle?: unknown;
            thumbnail?: unknown;
            description?: unknown;
          }>;
        }
      | null;
    if (!json?.ok || !Array.isArray(json.items)) return null;

    const items: RemoteSubscription[] = [];
    for (const entry of json.items) {
      if (typeof entry?.channelId !== "string" || !/^UC[\w-]{20,}$/.test(entry.channelId)) {
        continue;
      }
      items.push({
        channelId: entry.channelId,
        name: typeof entry.name === "string" && entry.name ? entry.name : entry.channelId,
        handle: typeof entry.handle === "string" ? entry.handle : null,
        thumbnail: typeof entry.thumbnail === "string" ? entry.thumbnail : null,
        description: typeof entry.description === "string" ? entry.description : null,
      });
    }
    if (items.length === 0) return null;
    onProgress?.({ loaded: items.length, total: null });
    return items;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const youtubeProvider: AuthProvider = {
  id: "youtube",
  label: "YouTube",
  color: "#ff0000",

  isConfigured() {
    return !!env.googleClientId;
  },

  unavailableReason() {
    return env.googleClientId
      ? null
      : "Set VITE_GOOGLE_CLIENT_ID to enable YouTube account linking.";
  },

  async link(options?: { prompt?: "consent" | "" }): Promise<ProviderAccount | null> {
    if (!env.googleClientId) return null;

    return new Promise((resolve, reject) => {
      /**
       * A popup that never comes back — blocked, closed, or a consent screen
       * that cannot reach the opener — would otherwise leave this promise
       * pending forever, and with it the UI's "linking" state.
       */
      const timer = setTimeout(() => {
        reject(
          new Error(
            "The Google sign-in window did not return. Allow popups for this site and try again.",
          ),
        );
      }, 180_000);
      const finish = (): void => clearTimeout(timer);

      const onToken = async (response: {
        access_token?: string;
        expires_in?: number;
        error?: string;
      }): Promise<void> => {
        finish();
        if (!response.access_token) {
          if (response.error === "access_denied") {
            reject(
              new Error(
                "Google refused access — the account shown in the popup must be listed under Google Auth Platform → Audience → Test users.",
              ),
            );
            return;
          }
          resolve(null);
          return;
        }
        let name: string | null = null;
        let picture: string | null = null;
        try {
          const profile = await fetchProfile(response.access_token);
          name = profile.name;
          picture = profile.picture;
        } catch {
          /* the profile is a nice-to-have */
        }
        resolve({
          provider: "youtube",
          name,
          picture,
          token: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
        });
      };

      const onError = (error: { type?: string; message?: string }): void => {
        finish();
        /**
         * Closing the popup is a cancel; everything else is a real failure
         * (a misconfigured origin, an account missing from the test users)
         * and must be reported — silently resolving `null` made every one of
         * them look like the user changing their mind.
         */
        if (
          error?.type === "popup_closed" ||
          error?.type === "popup_closed_by_user"
        ) {
          resolve(null);
          return;
        }
        reject(new Error(googleLinkError(error?.type, error?.message)));
      };

      /**
       * **The callback must be registered on `initTokenClient`.** The
       * `requestAccessToken` override only accepts `prompt`, `scope`,
       * `login_hint`, `state` and the consent flags — a `callback` passed
       * there is silently discarded, so the token arrived at the no-op
       * callback and the link hung forever. (The COOP `window.closed` warning
       * in the console is unrelated noise from Google's own script.)
       */
      getGoogleTokenClient(onToken, onError)
        .then((client) => {
          if (!client) {
            finish();
            reject(new Error("Google sign-in is not available in this browser."));
            return;
          }
          client.requestAccessToken({ prompt: options?.prompt ?? "consent" });
        })
        .catch(() => {
          finish();
          reject(
            new Error(
              "Google's sign-in script could not be loaded — check the network (or an ad-blocker) and try again.",
            ),
          );
        });
    });
  },

  async subscriptions(
    account: ProviderAccount,
    onProgress?: (progress: { loaded: number; total: number | null }) => void,
  ): Promise<RemoteSubscription[]> {
    /**
     * The Data API caps a subscription list at 1,000. The dev server can read
     * the same account through InnerTube, which does not; when it is not
     * available (static build) or the token is refused, the API path below is
     * the fallback and reports its own truncation.
     */
    const viaInnerTube = await fetchInnerTubeSubscriptions(account.token, onProgress);
    if (viaInnerTube) return viaInnerTube;

    const all: RemoteSubscription[] = [];
    let pageToken: string | undefined;
    let total: number | null = null;

    do {
      const params = new URLSearchParams({
        part: "snippet",
        maxResults: "50",
        mine: "true",
        order: "alphabetical",
        ...(pageToken ? { pageToken } : {}),
      });
      const url = `https://www.googleapis.com/youtube/v3/subscriptions?${params}`;
      const headers = {
        Authorization: `Bearer ${account.token}`,
        Accept: "application/json",
      };

      /**
       * A page is retried twice: a single transient 500 halfway through a
       * 4,000-subscription list must not silently truncate it. Client errors
       * (401/403/400) are not retried — the same request cannot succeed.
       */
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(url, { headers });
        if (res.ok || res.status < 500) break;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      if (!res || !res.ok) {
        /**
         * A failed page must not look like "this account subscribes to
         * nothing": the reason is read out of the body and thrown, so the
         * toast can name the actual cause (API disabled, scope missing…).
         */
        const body = await res?.text().catch(() => "") ?? "";
        throw new Error(googleApiError(res?.status ?? 0, body));
      }
      const json = await res.json();
      /**
       * `pageInfo.totalResults` is what Google says the account has. Keeping
       * it lets the UI say "loaded 956 of 4,000" instead of pretending the
       * list is complete — the API caps what it will return, and the number
       * it reports is the only way to see that.
       */
      if (typeof json.pageInfo?.totalResults === "number") {
        total = json.pageInfo.totalResults;
      }
      for (const entry of json.items ?? []) {
        const snippet = entry.snippet ?? {};
        all.push({
          channelId: snippet.resourceId?.channelId ?? "",
          name: snippet.title ?? "Unknown",
          handle: null,
          thumbnail:
            snippet.thumbnails?.default?.url ??
            snippet.thumbnails?.medium?.url ??
            null,
          description: snippet.description ?? null,
        });
      }
      pageToken = json.nextPageToken;
      onProgress?.({ loaded: all.length, total });
    } while (pageToken);

    return all;
  },

  unlink() {
    /* the token simply expires; nothing to revoke client-side */
  },
};

async function getGoogleTokenClient(
  onToken: (response: {
    access_token?: string;
    expires_in?: number;
    error?: string;
  }) => void | Promise<void>,
  onError: (error: { type?: string; message?: string }) => void,
): Promise<GoogleTokenClient | null> {
  await loadScript("https://accounts.google.com/gsi/client");
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) return null;
  return oauth2.initTokenClient({
    client_id: env.googleClientId ?? "",
    scope: YOUTUBE_SCOPE,
    callback: onToken,
    error_callback: onError,
  });
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      /**
       * The script may already have run without the app having loaded it —
       * another script tag, or a reload that kept the global. Waiting for a
       * `load` event that already fired would hang the link forever, so the
       * presence of the SDK is the check that matters.
       */
      if (existing.dataset.loaded === "true" || window.google?.accounts?.oauth2) {
        existing.dataset.loaded = "true";
        return resolve();
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("script failed")));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () => reject(new Error("script failed")));
    document.head.appendChild(script);
  });
}

/**
 * The linked account's own identity, for the account menu.
 *
 * `channels.list(mine=true)` is allowed by the full `youtube` scope the link
 * requests (a read-only token would also allow it) — `oauth2/v3/userinfo`
 * needs `profile`, which the token client never asked for, so it fails with a
 * 403 and left the account with no name and no avatar (the "the UI did not
 * change" symptom). The channel is also the better identity: the name and
 * picture the user knows.
 */
async function fetchProfile(
  token: string,
): Promise<{ name: string | null; picture: string | null }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  try {
    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) {
      const json = await res.json();
      const snippet = json.items?.[0]?.snippet;
      if (snippet) {
        return {
          name: snippet.title ?? null,
          picture:
            snippet.thumbnails?.default?.url ??
            snippet.thumbnails?.medium?.url ??
            null,
        };
      }
    }
  } catch {
    /* fall through to userinfo */
  }

  const res = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error("profile request failed");
  const json = await res.json();
  return { name: json.name ?? null, picture: json.picture ?? null };
}

/**
 * Turns a Google Identity Services failure into something the user can act
 * on. The type is what the SDK reports; the message is a hint, not a spec.
 */
function googleLinkError(type?: string, message?: string): string {
  switch (type) {
    case "access_denied":
      return "Google refused the request — the signed-in account is not on the OAuth consent screen's test-user list.";
    case "origin_mismatch":
      return "This origin is not in the OAuth client's Authorized JavaScript origins.";
    case "popup_failed_to_open":
      return "The sign-in popup was blocked — allow popups for this site and try again.";
    case "idpiframe_initialization_failed":
      return "Google could not initialise in this browser (third-party cookies are often the cause).";
    case "immediate_failed":
      return "Google rejected the silent sign-in — link the account again.";
    default:
      return `Google sign-in failed${type ? ` (${type})` : ""}${message ? `: ${message}` : ""}.`;
  }
}

/**
 * Reads the reason out of a failed YouTube Data API response.
 *
 * The API answers with `{ error: { message, errors: [{ reason }] } }`, and the
 * `reason` is the part that tells the operator what to change — almost always
 * "the API is not enabled", "the scope was not granted" or "quota".
 */
function googleApiError(status: number, body: string): string {
  let reason = "";
  let message = "";
  try {
    const json = JSON.parse(body);
    reason = json?.error?.errors?.[0]?.reason ?? "";
    message = json?.error?.message ?? "";
  } catch {
    /* not JSON — the status is all we have */
  }

  switch (reason) {
    case "accessNotConfigured":
      return "the YouTube Data API v3 is not enabled for this Google Cloud project — enable it under APIs & Services → Library, then retry.";
    case "quotaExceeded":
    case "rateLimitExceeded":
      return "the YouTube Data API quota for today is exhausted — try again tomorrow or raise the quota.";
    case "youtubeSignupRequired":
      return "this Google account has no YouTube channel.";
    case "insufficientPermissions":
    case "ACCESS_TOKEN_SCOPE_INSUFFICIENT":
      return "the token was granted without the YouTube permission — use Linked accounts → Reconnect and leave the YouTube checkbox ticked.";
  }

  if (status === 401) {
    return "the Google token expired — use Linked accounts → Reconnect.";
  }
  if (status === 403) {
    return `Google denied the request${message ? `: ${message}` : "."}`;
  }
  return `YouTube returned ${status}${message ? `: ${message}` : ""}.`;
}

interface GoogleTokenClient {
  /**
   * Only [`OverridableTokenClientConfig`] fields are honoured here — a
   * `callback` passed in this object is ignored, which is why the real one is
   * registered on `initTokenClient`.
   */
  requestAccessToken(options?: { prompt?: string; login_hint?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (response: {
              access_token?: string;
              expires_in?: number;
              error?: string;
            }) => void;
            error_callback: (error: { type?: string; message?: string }) => void;
          }): GoogleTokenClient;
        };
      };
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Twitch — OAuth 2.0 with PKCE                                               */
/* -------------------------------------------------------------------------- */

export const twitchProvider: AuthProvider = {
  id: "twitch",
  label: "Twitch",
  color: "#9146ff",

  isConfigured() {
    return !!env.twitchClientId;
  },

  unavailableReason() {
    return env.twitchClientId
      ? null
      : "Set VITE_TWITCH_CLIENT_ID to enable Twitch account linking.";
  },

  async link(): Promise<ProviderAccount | null> {
    const clientId = env.twitchClientId;
    if (!clientId) return null;

    const verifier = randomString(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomString(24);
    const redirectUri = currentOrigin();

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "user:read:follows",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const result = await runPopupFlow(
      `https://id.twitch.tv/oauth2/authorize?${params}`,
      state,
    );
    if (!result.code) return null;

    // Exchange the code for an access token. A public client sends an empty
    // client_secret and relies on the PKCE verifier.
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: "",
      code: result.code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const json = await res.json();

    return {
      provider: "twitch",
      name: null,
      picture: null,
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  },

  async subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]> {
    const clientId = env.twitchClientId;
    if (!clientId) return [];

    // Resolve our own user id first.
    const meRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-Id": clientId,
        Authorization: `Bearer ${account.token}`,
      },
    });
    if (!meRes.ok) return [];
    const me = await meRes.json();
    const myId = me?.data?.[0]?.id;
    if (!myId) return [];

    const out: RemoteSubscription[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        user_id: myId,
        first: "100",
        ...(cursor ? { after: cursor } : {}),
      });
      const res = await fetch(
        `https://api.twitch.tv/helix/channels/followed?${params}`,
        {
          headers: {
            "Client-Id": clientId,
            Authorization: `Bearer ${account.token}`,
          },
        },
      );
      if (!res.ok) break;
      const json = await res.json();
      for (const entry of json.data ?? []) {
        out.push({
          channelId: entry.broadcaster_id,
          name: entry.broadcaster_name,
          handle: entry.broadcaster_login,
          thumbnail: entry.broadcaster_image_language_placeholder
            ? entry.broadcaster_image
            : entry.broadcaster_image,
          description: null,
        });
      }
      cursor = json.pagination?.cursor;
    } while (cursor);

    return out;
  },

  unlink() {
    /* the token expires on its own */
  },
};

/**
 * Runs an OAuth redirect flow inside a popup window and waits for the
 * provider to redirect back with a `code` (or a fragment token).
 */
async function runPopupFlow(
  url: string,
  state: string,
): Promise<{ code?: string; accessToken?: string; state?: string }> {
  return new Promise((resolve) => {
    const popup = window.open(url, "oauth-popup", "width=520,height=680");
    if (!popup) {
      resolve({});
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | { type: string; code?: string; accessToken?: string; state?: string }
        | undefined;
      if (!data || data.type !== "oauth-callback") return;
      window.removeEventListener("message", onMessage);
      popup.close();
      resolve(data);
    };
    window.addEventListener("message", onMessage);

    // Watch for the popup navigating back to our origin with a code.
    const timer = window.setInterval(() => {
      try {
        const href = popup.location.href;
        if (!href.startsWith(window.location.origin)) return;
        const url = new URL(href);
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const hash = url.hash ? new URLSearchParams(url.hash.slice(1)) : null;
        const accessToken = hash?.get("access_token") ?? undefined;
        if (code || accessToken) {
          window.clearInterval(timer);
          window.removeEventListener("message", onMessage);
          popup.close();
          resolve({ code: code ?? undefined, accessToken, state: returnedState ?? undefined });
        }
      } catch {
        /* cross-origin — still loading */
      }
    }, 400);

    window.setTimeout(() => {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      popup.close();
      resolve({});
    }, 180_000);
  });
}

/* -------------------------------------------------------------------------- */
/* Bilibili — session cookie                                                  */
/* -------------------------------------------------------------------------- */

export const bilibiliProvider: AuthProvider = {
  id: "bilibili",
  label: "Bilibili",
  color: "#fb7299",

  isConfigured() {
    // Works without configuration: the user supplies their own SESSDATA.
    return true;
  },

  unavailableReason() {
    return null;
  },

  async link(): Promise<ProviderAccount | null> {
    const token = window.prompt(
      [
        "Bilibili does not offer a public OAuth for your follow list.",
        "",
        "1. Open https://www.bilibili.com and sign in.",
        "2. Open the developer tools → Application → Cookies.",
        "3. Copy the value of the `SESSDATA` cookie.",
        "",
        "It is stored only in this browser and is never sent anywhere except",
        "Bilibili's own API.",
      ].join("\n"),
    );
    if (!token?.trim()) return null;

    const account: ProviderAccount = {
      provider: "bilibili",
      name: null,
      picture: null,
      token: token.trim(),
      expiresAt: null,
    };

    // Verify the cookie and grab the user's numeric id.
    const nav = await bilibiliFetch<{
      code: number;
      data?: { mid?: number; uname?: string };
    }>("https://api.bilibili.com/x/web-interface/nav", account);
    if (nav?.code !== 0 || !nav?.data?.mid) return null;

    account.name = nav.data.uname ?? null;
    account.extra = { mid: String(nav.data.mid) };
    return account;
  },

  async subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]> {
    const mid = account.extra?.mid;
    if (!mid) return [];

    const out: RemoteSubscription[] = [];
    let page = 1;
    do {
      const json = await bilibiliFetch<{
        code: number;
        data?: { list?: { mid: number; uname: string; face: string }[] };
      }>(
        `https://api.bilibili.com/x/relation/followings?vmid=${mid}&pn=${page}&ps=50&order=desc`,
        account,
      );
      const list = json?.data?.list ?? [];
      for (const entry of list) {
        out.push({
          channelId: String(entry.mid),
          name: entry.uname,
          handle: String(entry.mid),
          thumbnail: entry.face
            ? entry.face.startsWith("//")
              ? `https:${entry.face}`
              : entry.face
            : null,
          description: null,
        });
      }
      page++;
    } while (out.length > 0 && out.length % 50 === 0 && page < 40);

    return out;
  },

  unlink() {
    /* the cookie simply stops being used */
  },
};

async function bilibiliFetch<T>(
  url: string,
  account: ProviderAccount,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Cookie: `SESSDATA=${account.token}`,
        Referer: "https://www.bilibili.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* VK — implicit OAuth                                                         */
/* -------------------------------------------------------------------------- */

export const vkProvider: AuthProvider = {
  id: "vk",
  label: "VK",
  color: "#0077ff",

  isConfigured() {
    return !!env.vkClientId;
  },

  unavailableReason() {
    return env.vkClientId
      ? null
      : "Set VITE_VK_CLIENT_ID to enable VK account linking.";
  },

  async link(): Promise<ProviderAccount | null> {
    const clientId = env.vkClientId;
    if (!clientId) return null;

    const params = new URLSearchParams({
      client_id: clientId,
      scope: "friends,offline",
      response_type: "token",
      redirect_uri: currentOrigin(),
    });

    const result = await runPopupFlow(
      `https://oauth.vk.com/authorize?${params}`,
      "",
    );
    if (!result.accessToken) return null;

    const profile = await vkFetch<{
      response?: { first_name?: string; last_name?: string; photo_100?: string };
    }>(
      "https://api.vk.com/method/users.get?fields=photo_100&v=5.199",
      result.accessToken,
    );

    return {
      provider: "vk",
      name:
        profile?.response?.first_name
          ? `${profile.response.first_name} ${profile.response.last_name ?? ""}`.trim()
          : null,
      picture: profile?.response?.photo_100 ?? null,
      token: result.accessToken,
      expiresAt: null,
    };
  },

  async subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]> {
    /**
     * VK has no "subscribed channels" concept — the closest equivalent for
     * the VTuber scene is the user's friend list, which is what we surface.
     */
    const json = await vkFetch<{
      response?: {
        items?: {
          id: number;
          first_name: string;
          last_name: string;
          screen_name: string;
          photo_100?: string;
        }[];
      };
    }>(
      "https://api.vk.com/method/friends.get?fields=screen_name,photo_100&count=200&v=5.199",
      account.token,
    );

    return (json?.response?.items ?? []).map((friend) => ({
      channelId: String(friend.id),
      name: `${friend.first_name} ${friend.last_name ?? ""}`.trim(),
      handle: friend.screen_name,
      thumbnail: friend.photo_100 ?? null,
      description: null,
    }));
  },

  unlink() {
    /* the token expires on its own */
  },
};

async function vkFetch<T>(url: string, token: string): Promise<T | null> {
  try {
    const separator = url.includes("?") ? "&" : "?";
    const res = await fetch(
      `${url}${separator}access_token=${encodeURIComponent(token)}&v=5.199`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* KICK — OAuth 2.1 with PKCE                                                  */
/* -------------------------------------------------------------------------- */

/**
 * KICK's OAuth 2.1 flow.
 *
 * The authorization endpoint is `id.kick.com/oauth/authorize` and the token
 * endpoint is `id.kick.com/oauth/token` — a *different* host from the API
 * server, which is the usual source of confusion.
 *
 * The token exchange asks for the client secret, so the OAuth route needs a
 * registered KICK app. The cookie route below needs nothing.
 */
export const kickProvider: AuthProvider = {
  id: "kick",
  label: "KICK",
  color: "#53fc18",

  isConfigured() {
    // The cookie route works without any configuration.
    return true;
  },

  unavailableReason() {
    return null;
  },

  async link(): Promise<ProviderAccount | null> {
    const clientId = env.kickClientId;
    const clientSecret = env.kickClientSecret;

    /**
     * With a registered app the OAuth flow is used. Without one the user
     * pastes their KICK session token, exactly as on Bilibili.
     */
    if (!clientId || !clientSecret) {
      const token = window.prompt(
        [
          "KICK's OAuth flow needs a registered KICK app (VITE_KICK_CLIENT_ID",
          "and VITE_KICK_CLIENT_SECRET).",
          "",
          "You can link with your session token instead:",
          "",
          "1. Open https://kick.com and sign in.",
          "2. Open the developer tools → Application → Cookies.",
          "3. Copy the value of the `kick_session` cookie.",
          "",
          "It is stored only in this browser and is never sent anywhere except",
          "KICK's own API.",
        ].join("\n"),
      );
      if (!token?.trim()) return null;

      const account: ProviderAccount = {
        provider: "kick",
        name: null,
        picture: null,
        token: token.trim(),
        expiresAt: null,
      };
      const profile = await kickApi<{
        data?: {
          user_id?: number;
          username?: string;
          profile_pic?: string;
        };
      }>("https://kick.com/api/v2/users/my", account);
      if (profile?.data) {
        account.name = profile.data.username ?? null;
        account.picture = profile.data.profile_pic ?? null;
        account.extra = { userId: String(profile.data.user_id ?? "") };
      }
      return account;
    }

    const verifier = randomString(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomString(24);
    const redirectUri = currentOrigin();

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "user:read channel:read",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const result = await runPopupFlow(
      `https://id.kick.com/oauth/authorize?${params}`,
      state,
    );
    if (!result.code) return null;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: result.code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const res = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const json = await res.json();

    const account: ProviderAccount = {
      provider: "kick",
      name: null,
      picture: null,
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };

    const profile = await kickApi<{
      data?: {
        user_id?: number;
        username?: string;
        profile_picture?: string;
      }[];
    }>("https://api.kick.com/public/v1/users", account);
    const me = profile?.data?.[0];
    if (me) {
      account.name = me.username ?? null;
      account.picture = me.profile_picture ?? null;
      account.extra = { userId: String(me.user_id ?? "") };
    }
    return account;
  },

  async subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]> {
    /**
     * KICK's web API is the only place the followed-channel list is
     * published, and it wants the session token in the `Authorization`
     * header. The Dev API has no equivalent endpoint.
     */
    const json = await kickApi<{
      data?: {
        id?: number;
        slug?: string;
        user_id?: number;
        user?: { username?: string; profile_image_url?: string };
        livestream?: unknown;
      }[];
    }>("https://kick.com/api/v2/channels/followed", account);

    const list = json?.data ?? [];
    return list.map((entry) => ({
      channelId: String(entry.user_id ?? entry.id ?? entry.slug ?? ""),
      name: entry.user?.username ?? entry.slug ?? "Unknown",
      handle: entry.slug ?? null,
      thumbnail: entry.user?.profile_image_url ?? null,
      description: null,
    }));
  },

  unlink() {
    /* the token simply stops being used */
  },
};

async function kickApi<T>(
  url: string,
  account: ProviderAccount,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${account.token}`,
        Referer: "https://kick.com/",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* CHZZK — Naver's session cookie                                              */
/* -------------------------------------------------------------------------- */

/**
 * CHZZK — Naver's streaming platform, and the biggest Korean VTuber scene.
 *
 * There is no public OAuth, so the user supplies their Naver session cookie.
 * The followed-channel list is published by
 * `api.chzzk.naver.com/service/v1/channels/followings`, which is what the
 * CHZZK web app itself calls.
 */
export const chzzkProvider: AuthProvider = {
  id: "chzzk",
  label: "CHZZK",
  color: "#03c75a",

  isConfigured() {
    return true;
  },

  unavailableReason() {
    return null;
  },

  async link(): Promise<ProviderAccount | null> {
    const token = window.prompt(
      [
        "CHZZK does not offer a public OAuth for your follow list.",
        "",
        "1. Open https://chzzk.naver.com and sign in.",
        "2. Open the developer tools → Application → Cookies.",
        "3. Copy the value of the `NaverLogin` cookie.",
        "",
        "It is stored only in this browser and is never sent anywhere except",
        "Naver's own API.",
      ].join("\n"),
    );
    if (!token?.trim()) return null;

    const account: ProviderAccount = {
      provider: "chzzk",
      name: null,
      picture: null,
      token: token.trim(),
      expiresAt: null,
    };

    // Verify the cookie and read the user's own channels.
    const mine = await chzzkApi<{
      code: number;
      content?: { channelId?: string; channelName?: string };
    }>("https://api.chzzk.naver.com/service/v1/users/me/channels", account);
    if (mine?.code !== 200) return null;
    account.name = mine.content?.channelName ?? null;
    account.extra = { channelId: mine.content?.channelId ?? "" };
    return account;
  },

  async subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]> {
    const out: RemoteSubscription[] = [];
    let page = 0;
    do {
      const json = await chzzkApi<{
        code: number;
        content?: {
          channelFollowings?: {
            channelId?: string;
            channelName?: string;
            channelImageUrl?: string;
          }[];
        } | {
          channelId?: string;
          channelName?: string;
          channelImageUrl?: string;
        }[];
      }>(
        `https://api.chzzk.naver.com/service/v1/channels/followings?page=${page}&size=50&sortType=FOLLOW`,
        account,
      );
      if (json?.code !== 200) break;

      /**
       * The payload is a list of channels, either directly or under a
       * `channelFollowings` key — both shapes are accepted.
       */
      const content = json.content as
        | { channelFollowings?: unknown[] }
        | unknown[];
      const list = Array.isArray(content)
        ? content
        : ((content?.channelFollowings ?? []) as unknown[]);

      for (const raw of list) {
        const entry = raw as {
          channelId?: string;
          channelName?: string;
          channelImageUrl?: string;
        };
        if (!entry.channelId) continue;
        out.push({
          channelId: entry.channelId,
          name: entry.channelName ?? "Unknown",
          handle: entry.channelId,
          thumbnail: entry.channelImageUrl ?? null,
          description: null,
        });
      }
      page++;
    } while (out.length > 0 && out.length % 50 === 0 && page < 40);

    return out;
  },

  unlink() {
    /* the cookie simply stops being used */
  },
};

async function chzzkApi<T>(
  url: string,
  account: ProviderAccount,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Cookie: `NaverLogin=${account.token}`,
        Referer: "https://chzzk.naver.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Niconico — the session cookie                                               */
/* -------------------------------------------------------------------------- */

/**
 * Niconico.
 *
 * The API is the v2 one, and it needs the `X-Frontend-Id` headers the web
 * app sends — without them the request never reaches the application. The
 * session cookie is `user_session`.
 */
export const niconicoProvider: AuthProvider = {
  id: "niconico",
  label: "Niconico",
  color: "#252525",

  isConfigured() {
    return true;
  },

  unavailableReason() {
    return null;
  },

  async link(): Promise<ProviderAccount | null> {
    const token = window.prompt(
      [
        "Niconico does not offer a public OAuth for your follow list.",
        "",
        "1. Open https://www.nicovideo.jp and sign in.",
        "2. Open the developer tools → Application → Cookies.",
        "3. Copy the value of the `user_session` cookie.",
        "",
        "It is stored only in this browser and is never sent anywhere except",
        "Niconico's own API.",
      ].join("\n"),
    );
    if (!token?.trim()) return null;

    const account: ProviderAccount = {
      provider: "niconico",
      name: null,
      picture: null,
      token: token.trim(),
      expiresAt: null,
    };

    const nickname = await niconicoApi<{
      data?: { nickname?: string; user_id?: string };
    }>("https://api.nicovideo.jp/api/v2/user/my/nickname", account);
    if (!nickname?.data) return null;
    account.name = nickname.data.nickname ?? null;
    account.extra = { userId: nickname.data.user_id ?? "" };
    return account;
  },

  async subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]> {
    const out: RemoteSubscription[] = [];
    let offset = 0;
    let items: {
      id?: string;
      nickname?: string;
      description?: string;
      icon_url?: string;
    }[] = [];
    do {
      const json = await niconicoApi<{
        data?: {
          items?: {
            id?: string;
            nickname?: string;
            description?: string;
            icon_url?: string;
          }[];
        };
      }>(
        `https://api.nicovideo.jp/api/v2/user/my/follow?limit=50&offset=${offset}`,
        account,
      );
      items = json?.data?.items ?? [];
      for (const entry of items) {
        if (!entry.id) continue;
        out.push({
          channelId: entry.id,
          name: entry.nickname ?? "Unknown",
          handle: entry.id,
          thumbnail: entry.icon_url ?? null,
          description: entry.description ?? null,
        });
      }
      offset += 50;
    } while (items.length > 0 && out.length < 500);

    return out;
  },

  unlink() {
    /* the cookie simply stops being used */
  },
};

async function niconicoApi<T>(
  url: string,
  account: ProviderAccount,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Cookie: `user_session=${account.token}`,
        Referer: "https://www.nicovideo.jp/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        // The API rejects a request without the web client's headers.
        "X-Frontend-Id": "2",
        "X-Frontend-Version": "9.46",
        "X-Niconico-Language": "ja-jp",
        "X-Client-Os-Type": "others",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** Every provider, in the order they are shown. */
export const AUTH_PROVIDERS: AuthProvider[] = [
  youtubeProvider,
  twitchProvider,
  bilibiliProvider,
  niconicoProvider,
  vkProvider,
  chzzkProvider,
  kickProvider,
];


