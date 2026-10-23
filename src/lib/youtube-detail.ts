/**
 * The browser half of the local YouTube channel bridge.
 *
 * The subscription list and the channel cache must stay separate: a refresh
 * replaces the list, while the 🎵 badge fact belongs to the channel and
 * outlives any one list. This module only defines the request and the cached
 * shape; the reactive state lives in `store.ts`.
 */

import type { YouTubeChannelSnapshot } from "@shared/lib/types";

/** A snapshot plus when this browser fetched it. */
export interface YouTubeChannelDetail extends YouTubeChannelSnapshot {
  fetchedAt: number;
}

interface BridgeError extends Error {
  status?: number;
}

/**
 * Reads one channel.
 *
 * `detail: false` is the badge-only path used by the background sync: one
 * InnerTube request, no Live or Releases tabs. `detail: true` is used when a
 * subscription card is opened and adds live/upcoming and releases.
 */
export async function fetchYouTubeChannel(
  channelId: string,
  detail = true,
): Promise<YouTubeChannelDetail> {
  const res = await fetch("/api/youtube/channel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ id: channelId, detail }),
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* an HTML error page or an empty response */
  }

  const body = json as
    | { ok?: unknown; error?: unknown; id?: unknown }
    | null;
  if (!res.ok || !body?.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : `YouTube channel bridge answered ${res.status}`;
    const error = new Error(message) as BridgeError;
    error.status = res.status;
    throw error;
  }

  return {
    ...(json as YouTubeChannelSnapshot),
    fetchedAt: Date.now(),
  };
}
