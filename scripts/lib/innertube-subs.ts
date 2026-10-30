/**
 * Subscriptions through InnerTube, signed with the account's OAuth token.
 *
 * The YouTube Data API stops a `mine=true` subscription list at 1,000 items.
 * The signed-in account's feed does not: the TV client answers `FEchannels`
 * with a tile list and follows the continuation in a handful of pages. This
 * module is the server half of that, because the browser cannot call
 * `youtube.com` cross-origin (no CORS headers). The web client answers the same
 * bearer token with `400 invalid argument`; only the TV client is used.
 *
 * The token is used only for the `Authorization` header of these requests. It
 * is never logged and never stored here.
 */

const TV_CLIENT_VERSION = "7.20260311.12.00";
const TV_USER_AGENT = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_PAGES = 2000;
const PAGE_TIMEOUT_MS = 20_000;

export interface InnerTubeSubscription {
  channelId: string;
  name: string;
  handle: string | null;
  thumbnail: string | null;
  description: string | null;
}

export interface InnerTubeSubscriptionsResult {
  items: InnerTubeSubscription[];
  pages: number;
  complete: boolean;
}

interface ClientConfig {
  apiKey: string;
  visitorData: string;
}

let configPromise: Promise<ClientConfig> | null = null;

/**
 * The public homepage's InnerTube API key and visitor data, scraped once.
 * The TV client version is a constant; the homepage's branding is only used
 * for the web client, which this module does not call.
 */
function getClientConfig(): Promise<ClientConfig> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const res = await fetch("https://www.youtube.com/", {
          signal: AbortSignal.timeout(10_000),
          headers: { "User-Agent": BROWSER_UA },
        });
        const html = await res.text();
        const apiKey = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1] ?? "";
        const rawVisitor = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1] ?? "";
        let visitorData = rawVisitor;
        try {
          visitorData = decodeURIComponent(rawVisitor);
        } catch {
          /* keep the raw value */
        }
        return { apiKey, visitorData };
      } catch {
        return { apiKey: "", visitorData: "" };
      }
    })();
  }
  return configPromise;
}

function textOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const title = value as {
    simpleText?: unknown;
    runs?: Array<{ text?: unknown }>;
  };
  if (typeof title.simpleText === "string") return title.simpleText;
  if (Array.isArray(title.runs)) {
    return title.runs.map((run) => (typeof run?.text === "string" ? run.text : "")).join("");
  }
  return "";
}

function thumbnailOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const thumbnails = (value as { thumbnails?: Array<{ url?: unknown }> }).thumbnails;
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  for (let i = thumbnails.length - 1; i >= 0; i--) {
    const url = thumbnails[i]?.url;
    if (typeof url === "string") {
      return url.startsWith("//") ? `https:${url}` : url;
    }
  }
  return null;
}

/**
 * Collects channel renderers and the feed continuation from one response.
 *
 * The browse response has changed shape several times (a grid at the top, then
 * `appendContinuationItemsAction`), so this walks the tree instead of naming
 * one path. `FEchannels` has a single continuation; the last one found is the
 * feed's.
 */
function parsePage(json: unknown): {
  items: InnerTubeSubscription[];
  continuation: string;
  loggedIn: boolean | null;
} {
  const items = new Map<string, InnerTubeSubscription>();
  let continuation = "";
  let loggedIn: boolean | null = null;

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;

    for (const param of (node.serviceTrackingParams as
      | Array<{ params?: Array<{ key?: string; value?: string }> }>
      | undefined) ?? []) {
      for (const pair of param?.params ?? []) {
        if (pair?.key === "logged_in") {
          loggedIn = pair.value === "1";
        }
      }
    }

    const renderer = (node.channelRenderer ?? node.gridChannelRenderer) as
      | Record<string, unknown>
      | undefined;
    if (renderer && typeof renderer.channelId === "string") {
      const channelId = renderer.channelId;
      if (!items.has(channelId)) {
        const navigation = renderer.navigationEndpoint as
          | { browseEndpoint?: { canonicalBaseUrl?: unknown } }
          | undefined;
        const canonical = navigation?.browseEndpoint?.canonicalBaseUrl;
        const handle =
          typeof canonical === "string" && canonical.startsWith("/@") ? canonical.slice(1) : null;
        const description = renderer.descriptionSnippet
          ? textOf(renderer.descriptionSnippet)
          : null;
        items.set(channelId, {
          channelId,
          name: textOf(renderer.title) || channelId,
          handle,
          thumbnail: thumbnailOf(renderer.thumbnail),
          description: description || null,
        });
      }
    }

    /**
     * The TV client renders the same `FEchannels` feed as tiles rather than
     * channel cards. The channel id is the tile's browse target, the name is
     * in the metadata title, and the handle is the first metadata line.
     */
    const tile = node.tileRenderer as Record<string, unknown> | undefined;
    if (tile) {
      const target = (
        tile.onSelectCommand as { browseEndpoint?: { browseId?: unknown } } | undefined
      )?.browseEndpoint;
      const channelId = target?.browseId;
      if (
        typeof channelId === "string" &&
        /^UC[\w-]{20,}$/.test(channelId) &&
        !items.has(channelId)
      ) {
        const metadata = (
          tile.metadata as { tileMetadataRenderer?: Record<string, unknown> } | undefined
        )?.tileMetadataRenderer;
        const header = (tile.header as { tileHeaderRenderer?: Record<string, unknown> } | undefined)
          ?.tileHeaderRenderer;
        const lineTexts: string[] = [];
        for (const line of (metadata?.lines as unknown[] | undefined) ?? []) {
          const lineItems = (line as { lineRenderer?: { items?: unknown[] } })?.lineRenderer?.items;
          for (const item of lineItems ?? []) {
            const text = (item as { lineItemRenderer?: { text?: unknown } })?.lineItemRenderer
              ?.text;
            const value = textOf(text);
            if (value) lineTexts.push(value);
          }
        }
        const handle = lineTexts.find((value) => value.startsWith("@")) ?? null;
        items.set(channelId, {
          channelId,
          name: textOf(metadata?.title) || textOf(header?.title) || channelId,
          handle,
          thumbnail: thumbnailOf(header?.thumbnail) ?? thumbnailOf(metadata?.thumbnail),
          description: null,
        });
      }
    }

    const endpoint = node.continuationEndpoint as
      | { continuationCommand?: { token?: unknown } }
      | undefined;
    const token = endpoint?.continuationCommand?.token;
    if (typeof token === "string" && token) continuation = token;

    const oldContinuation = (node.nextContinuationData as { continuation?: unknown } | undefined)
      ?.continuation;
    if (typeof oldContinuation === "string" && oldContinuation) {
      continuation = oldContinuation;
    }

    for (const key of Object.keys(node)) visit(node[key]);
  };

  visit(json);
  return { items: [...items.values()], continuation, loggedIn };
}

async function browse(
  token: string,
  body: Record<string, unknown>,
  config: ClientConfig,
): Promise<unknown> {
  const query = config.apiKey
    ? `?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`
    : "?prettyPrint=false";
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": TV_USER_AGENT,
      "X-Origin": "https://www.youtube.com",
      "X-Youtube-Client-Name": "7",
      "X-Youtube-Client-Version": TV_CLIENT_VERSION,
      ...(config.visitorData ? { "X-Goog-Visitor-Id": config.visitorData } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`InnerTube answered ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }
  return res.json();
}

/**
 * Fetches every subscription of the account the token belongs to.
 *
 * Throws when the token is not accepted or a page fails: the caller falls back
 * to the Data API (which at least returns the first thousand) rather than
 * showing a silently truncated list.
 */
export async function fetchInnerTubeSubscriptions(
  token: string,
): Promise<InnerTubeSubscriptionsResult> {
  const config = await getClientConfig();
  const context = {
    client: {
      clientName: "TVHTML5",
      clientVersion: TV_CLIENT_VERSION,
      hl: "en",
      gl: "US",
      platform: "DESKTOP",
      clientFormFactor: "UNKNOWN_FORM_FACTOR",
      originalUrl: "https://www.youtube.com",
      userAgent: TV_USER_AGENT,
      ...(config.visitorData ? { visitorData: config.visitorData } : {}),
    },
    user: { lockedSafetyMode: false },
  };

  const items = new Map<string, InnerTubeSubscription>();
  const seenTokens = new Set<string>();
  let continuation = "";
  let pages = 0;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = continuation
      ? { context, continuation }
      : { context, browseId: "FEchannels" };

    const json = await browse(token, body, config);
    pages += 1;
    const parsed = parsePage(json);

    if (parsed.loggedIn === false) {
      throw new Error("InnerTube did not recognise the signed-in account");
    }

    for (const item of parsed.items) {
      if (!items.has(item.channelId)) items.set(item.channelId, item);
    }

    if (!parsed.continuation) {
      complete = true;
      break;
    }
    if (seenTokens.has(parsed.continuation)) {
      throw new Error("InnerTube repeated a continuation token");
    }
    seenTokens.add(parsed.continuation);
    continuation = parsed.continuation;

    if (parsed.items.length === 0 && page > 0) {
      // A page with no channels means the feed has ended, even if it carried a
      // token for an unrelated shelf.
      complete = true;
      break;
    }
  }

  return { items: [...items.values()], pages, complete };
}
