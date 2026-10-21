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
 * - **Tokens never leave the browser.** They live in `localStorage` and are
 *   only ever sent to the platform's own API.
 * - **Twitch** uses the OAuth 2.0 authorization-code flow with PKCE. A public
 *   client needs no client secret, so this works entirely client-side.
 * - **YouTube** uses Google Identity Services.
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
   */
  link(): Promise<ProviderAccount | null>;
  /** Fetches the account's followed channels / singers. */
  subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]>;
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

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

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

  async link(): Promise<ProviderAccount | null> {
    if (!env.googleClientId) return null;

    const client = await getGoogleTokenClient();
    if (!client) return null;

    return new Promise((resolve) => {
      client.requestAccessToken({
        prompt: "consent",
        callback: async (response) => {
          if (!response.access_token) {
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
        },
        error_callback: () => resolve(null),
      });
    });
  },

  async subscriptions(account: ProviderAccount): Promise<RemoteSubscription[]> {
    const all: RemoteSubscription[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        part: "snippet",
        maxResults: "50",
        mine: "true",
        order: "alphabetical",
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/subscriptions?${params}`,
        {
          headers: {
            Authorization: `Bearer ${account.token}`,
            Accept: "application/json",
          },
        },
      );
      if (!res.ok) break;
      const json = await res.json();
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
    } while (pageToken);

    return all;
  },

  unlink() {
    /* the token simply expires; nothing to revoke client-side */
  },
};

let gisReady = false;

async function getGoogleTokenClient(): Promise<GoogleTokenClient | null> {
  await loadScript("https://accounts.google.com/gsi/client");
  gisReady = true;
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) return null;
  return oauth2.initTokenClient({
    client_id: env.googleClientId ?? "",
    scope: YOUTUBE_SCOPE,
    callback: () => {},
    error_callback: () => {},
  });
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      if (existing.dataset.loaded === "true") return resolve();
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

async function fetchProfile(
  token: string,
): Promise<{ name: string | null; picture: string | null }> {
  const res = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error("profile request failed");
  const json = await res.json();
  return { name: json.name ?? null, picture: json.picture ?? null };
}

interface GoogleTokenClient {
  requestAccessToken(options: {
    prompt?: string;
    callback?: (response: {
      access_token?: string;
      expires_in?: number;
    }) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): void;
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
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** Every provider, in the order they are shown. */
export const AUTH_PROVIDERS: AuthProvider[] = [
  youtubeProvider,
  twitchProvider,
  bilibiliProvider,
  vkProvider,
];


