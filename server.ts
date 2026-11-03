#!/usr/bin/env oxnode
/**
 * Local development server for the VSinger & Singer Tracker.
 *
 * Uses uWebSockets.js (uNetworking/uWebSockets.js) instead of Express.js.
 *
 * WARNING: uWebSockets.js is a native C++ addon for Node.js. It requires
 * compilation or prebuilt binaries at install time. This conflicts with
 * AGENTS.md rule #13 ("no native modules so CI never needs a build step").
 * Use this only if you accept a native dependency in the dev server.
 *
 * Production is static (Vite build + committed JSON); this server is dev-only.
 */

import Database from "better-sqlite3";
import { Innertube } from "youtubei.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  App,
  HttpResponse,
  HttpRequest,
} from "uWebSockets.js";
import {
  addSuggestions,
  listSuggestions,
  removeSuggestions,
} from "./scripts/lib/suggestions";
import { importYouTubeChannels } from "./scripts/lib/import-channels";
import { fetchInnerTubeSubscriptions } from "./scripts/lib/innertube-subs";
import {
  fetchYouTubeChannelSnapshot,
  isChannelNotFound,
  isRateLimited,
} from "./scripts/lib/youtube-channel";
import { acquireRunLock } from "./scripts/lib/io";
import {
  readAllChannelRecords,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeChannelShards,
} from "./scripts/lib/dataset";
import { applyOfficialArtist } from "./scripts/lib/platforms";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, "yt_singers_channel.db");

// Ensure the database file exists or will be created
if (!fs.existsSync(dbPath)) {
  console.log(`Creating new database file at: ${dbPath}`);
}

const db = new Database(dbPath);

/* -------------------------------------------------------------------------- */
/* uWebSockets.js helpers                                                     */
/* -------------------------------------------------------------------------- */

/** Collect the full request body as a parsed JSON value. Returns null on failure or empty body.
 *  Returns `any` to match Express's `req.body` typing. */
async function readJsonBody(res: HttpResponse, req: HttpRequest): Promise<any> {
  return new Promise((resolve) => {
    res.onAborted(() => resolve(null));
    res.collectBody(50 * 1024 * 1024, (fullBody: ArrayBuffer | null) => {
      if (!fullBody) {
        resolve(null);
        return;
      }
      const text = Buffer.from(fullBody).toString("utf-8").trim();
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
  });
}

/** Send a JSON response, wrapped in cork() as uWS requires.
 *  Extra headers (e.g. cache-control) can be passed via `headers`. */
function json(
  res: HttpResponse,
  status: number,
  obj: unknown,
  headers?: Record<string, string>,
): void {
  const str = JSON.stringify(obj);
  const statusText =
    status === 200 ? "OK" :
    status === 201 ? "Created" :
    status === 400 ? "Bad Request" :
    status === 403 ? "Forbidden" :
    status === 404 ? "Not Found" :
    status === 409 ? "Conflict" :
    status === 413 ? "Payload Too Large" :
    status === 429 ? "Too Many Requests" :
    status === 502 ? "Bad Gateway" :
    status === 503 ? "Service Unavailable" :
    "Internal Server Error";
  res.cork(() => {
    res.writeStatus(`${status} ${statusText}`);
    res.writeHeader("content-type", "application/json");
    for (const [key, value] of Object.entries(headers ?? {})) {
      res.writeHeader(key, value);
    }
    res.writeHeader("content-length", Buffer.byteLength(str).toString());
    res.end(str);
  });
}

/** Read the Origin header (uWS headers are lowercase). */
function originOf(req: HttpRequest): string | undefined {
  return req.getHeader("origin");
}

/** Parse ?key=value query string from a URL. */
function queryOf(url: string): Record<string, string> {
  const [, q] = url.split("?", 2);
  if (!q) return {};
  const out: Record<string, string> = {};
  for (const pair of q.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      out[decodeURIComponent(pair)] = "";
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

/** Check Origin against localhost allow-list. */
function localOnly(origin: string | undefined): boolean {
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** Extract path parameter like /api/blacklist/:id -> id. */
function paramOf(url: string, pattern: string): string | null {
  const rx = new RegExp("^" + pattern.replace(/:\w+/g, "([^/]+)") + "$");
  const m = rx.exec(url);
  return m ? m[1] : null;
}

async function startServer(): Promise<void> {
  const PORT = 3000;
  const youtube = await Innertube.create().catch((e) => {
    console.error("Failed to create Innertube instance:", e);
    return null;
  });

  console.log("Innertube instance created:", !!youtube);

  // Initialize DB
  console.log("Initializing database...");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      handle TEXT,
      thumbnail TEXT,
      last_synced INTEGER,
      discovered_at INTEGER,
      is_collected INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      title TEXT NOT NULL,
      type TEXT, -- 'video' or 'playlist'
      thumbnail TEXT,
      published_at TEXT,
      discovered_at INTEGER,
      is_collected INTEGER DEFAULT 0,
      tags TEXT,
      video_count TEXT,
      FOREIGN KEY(channel_id) REFERENCES channels(id)
    );
    CREATE TABLE IF NOT EXISTS blacklist (
      id TEXT PRIMARY KEY,
      name TEXT,
      handle TEXT,
      thumbnail TEXT,
      added_at INTEGER
    );
  `);

  // Migration: Add is_collected if it doesn't exist (for existing databases)
  try {
    db.prepare("SELECT is_collected FROM channels LIMIT 1").get();
  } catch (e) {
    console.log("Adding is_collected to channels table...");
    db.exec("ALTER TABLE channels ADD COLUMN is_collected INTEGER DEFAULT 0");
  }

  try {
    db.prepare("SELECT is_collected FROM items LIMIT 1").get();
  } catch (e) {
    console.log("Adding is_collected to items table...");
    db.exec("ALTER TABLE items ADD COLUMN is_collected INTEGER DEFAULT 0");
  }

  try {
    db.prepare("SELECT video_count FROM items LIMIT 1").get();
  } catch (e) {
    console.log("Adding video_count to items table...");
    db.exec("ALTER TABLE items ADD COLUMN video_count TEXT");
  }

  try {
    db.prepare("SELECT handle FROM channels LIMIT 1").get();
  } catch (e) {
    console.log("Adding handle to channels table...");
    db.exec("ALTER TABLE channels ADD COLUMN handle TEXT");
  }

  try {
    db.prepare("SELECT discovered_at FROM channels LIMIT 1").get();
  } catch (e) {
    console.log("Adding discovered_at to channels table...");
    db.exec("ALTER TABLE channels ADD COLUMN discovered_at INTEGER");
    db.exec(
      "UPDATE channels SET discovered_at = strftime('%s', 'now') * 1000 WHERE discovered_at IS NULL",
    );
  }

  try {
    db.prepare("SELECT discovered_at FROM items LIMIT 1").get();
  } catch (e) {
    console.log("Adding discovered_at to items table...");
    db.exec("ALTER TABLE items ADD COLUMN discovered_at INTEGER");
    db.exec(
      "UPDATE items SET discovered_at = strftime('%s', 'now') * 1000 WHERE discovered_at IS NULL",
    );
  }

  try {
    db.prepare("SELECT tags FROM items LIMIT 1").get();
  } catch (e) {
    console.log("Adding tags to items table...");
    db.exec("ALTER TABLE items ADD COLUMN tags TEXT");
  }

  const parseRelativeDate = (relativeDate: string): string => {
    if (!relativeDate) return new Date().toISOString();
    const str = relativeDate.toLowerCase();

    // If it's already an ISO date or similar, return it
    if (str.includes("t") && !isNaN(Date.parse(str))) return relativeDate;

    const now = new Date();
    // Match relative time patterns, ignoring prefixes like "Streamed" or "Premiered"
    const match = str.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
    if (!match) return relativeDate;

    const amount = parseInt(match[1]!);
    const unit = match[2]!;

    switch (unit) {
      case "second": now.setSeconds(now.getSeconds() - amount); break;
      case "minute": now.setMinutes(now.getMinutes() - amount); break;
      case "hour": now.setHours(now.getHours() - amount); break;
      case "day": now.setDate(now.getDate() - amount); break;
      case "week": now.setDate(now.getDate() - amount * 7); break;
      case "month": now.setMonth(now.getMonth() - amount); break;
      case "year": now.setFullYear(now.getFullYear() - amount); break;
    }
    return now.toISOString();
  };

  // Migration: Convert existing relative dates to ISO
  try {
    const itemsWithRelativeDates = db.prepare("SELECT id, published_at FROM items WHERE published_at LIKE '% ago%'").all() as any[];
    if (itemsWithRelativeDates.length > 0) {
      console.log(`Converting ${itemsWithRelativeDates.length} relative dates to ISO...`);
      const updateStmt = db.prepare("UPDATE items SET published_at = ? WHERE id = ?");
      db.transaction(() => {
        for (const item of itemsWithRelativeDates) {
          updateStmt.run(parseRelativeDate(item.published_at), item.id);
        }
      })();
    }
  } catch (e) {
    console.error("Migration error (relative dates):", e);
  }

  /* ------------------------------------------------------------------------ */
  /* Routes                                                                   */
  /* ------------------------------------------------------------------------ */
  const app = App();

  // Health check
  app.get("/api/health", (res, req) => {
    json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
  });

  /* ------------------------------------------------------------------------ */
  /* Subscriptions through InnerTube (development only)                       */
  /* ------------------------------------------------------------------------ */
  app.post("/api/youtube/subscriptions", async (res, req) => {
    const origin = originOf(req);
    if (!localOnly(origin)) {
      return json(res, 403, { ok: false, error: "This endpoint is local only." });
    }
    const body = (await readJsonBody(res, req)) as { token?: unknown } | null;
    const token =
      typeof body?.token === "string" ? (body.token as string).trim() : "";
    if (!token || token.length > 4096) {
      return json(res, 400, { ok: false, error: "An OAuth access token is required." });
    }
    try {
      const result = await fetchInnerTubeSubscriptions(token);
      json(res, 200, { ok: true, source: "innertube", ...result });
    } catch (error) {
      const message = (error as Error).message || "InnerTube request failed";
      const rejected = /401|403|not recognise/i.test(message);
      json(res, rejected ? 401 : 502, { ok: false, error: message });
    }
  });

  /* ------------------------------------------------------------------------ */
  /* One YouTube channel's current state (development only)                   */
  /* ------------------------------------------------------------------------ */
  let activeChannelRequests = 0;
  const waitingChannelRequests: Array<() => void> = [];
  const withChannelSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (activeChannelRequests >= 2) {
      await new Promise<void>((resolve) => waitingChannelRequests.push(resolve));
    }
    activeChannelRequests += 1;
    try {
      return await work();
    } finally {
      activeChannelRequests -= 1;
      waitingChannelRequests.shift()?.();
    }
  };

  app.post("/api/youtube/channel", async (res, req) => {
    const origin = originOf(req);
    if (!localOnly(origin)) {
      return json(res, 403, { ok: false, error: "This endpoint is local only." });
    }
    const body = (await readJsonBody(res, req)) as { id?: unknown; detail?: unknown } | null;
    const channelId =
      typeof body?.id === "string" ? (body.id as string).trim() : "";
    if (!/^UC[\w-]{20,}$/.test(channelId)) {
      return json(res, 400, {
        ok: false,
        error: "A YouTube UC… channel id is required.",
      });
    }
    if (!youtube) {
      return json(res, 503, {
        ok: false,
        error: "InnerTube is unavailable in this server.",
      });
    }

    try {
      const snapshot = await withChannelSlot(() =>
        fetchYouTubeChannelSnapshot(
          youtube,
          channelId,
          body?.detail === true,
        ),
      );
      json(res, 200, { ok: true, ...snapshot }, { "cache-control": "no-store" });
    } catch (error) {
      const message = (error as Error).message || "YouTube channel request failed";
      if (isChannelNotFound(message)) {
        return json(res, 404, { ok: false, error: message });
      }
      if (isRateLimited(message)) {
        return json(res, 429, { ok: false, error: message });
      }
      json(res, 502, { ok: false, error: message });
    }
  });

  app.post("/api/dataset/youtube-official-artist", async (res, req) => {
    const origin = originOf(req);
    if (!localOnly(origin)) {
      return json(res, 403, { ok: false, error: "This endpoint is local only." });
    }
    const body = (await readJsonBody(res, req)) as {
      id?: unknown;
      officialArtist?: unknown;
    } | null;
    const channelId =
      typeof body?.id === "string" ? (body.id as string).trim() : "";
    const officialArtist = body?.officialArtist;
    if (!/^UC[\w-]{20,}$/.test(channelId)) {
      return json(res, 400, {
        ok: false,
        error: "A YouTube UC… channel id is required.",
      });
    }
    if (typeof officialArtist !== "boolean") {
      return json(res, 400, {
        ok: false,
        error: "officialArtist must be a boolean.",
      });
    }

    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = acquireRunLock("youtube-official-artist");
      const channels = readAllChannelRecords();
      const channel = channels.find((record) => record.id === channelId);
      if (!channel) return json(res, 200, { ok: true, saved: false });
      const now = new Date().toISOString();
      const changed = channel.isOfficialArtist !== officialArtist;
      applyOfficialArtist(channel, officialArtist, now);
      writeChannelShards(channels, now);
      if (changed) {
        rebuildChannelsManifest(channels, now);
        refreshManifestChannelCounts(channels, now);
      }
      return json(res, 200, { ok: true, saved: true, changed });
    } catch (error) {
      const message = (error as Error).message || "Could not save Official Artist status.";
      const conflict = message.includes("another run is writing the dataset");
      if (!conflict) console.error("[dataset] Official Artist save failed:", error);
      return json(res, conflict ? 409 : 500, { ok: false, error: message });
    } finally {
      releaseLock?.();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Dataset suggestions and import (development only)                        */
  /* ------------------------------------------------------------------------ */
  app.get("/api/dataset/suggestions", (res, _req) => {
    try {
      const suggestions = listSuggestions();
      json(res, 200, { ok: true, count: suggestions.length, suggestions });
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: (error as Error).message,
      });
    }
  });

  app.post("/api/dataset/suggestions", async (res, req) => {
    const body = (await readJsonBody(res, req)) as { entries?: unknown } | null;
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    if (entries.length === 0) {
      return json(res, 400, { ok: false, error: "entries is empty" });
    }
    try {
      const result = addSuggestions(entries.slice(0, 5000));
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      json(res, 500, { ok: false, error: (error as Error).message });
    }
  });

  app.post("/api/dataset/suggestions/remove", async (res, req) => {
    const body = (await readJsonBody(res, req)) as { keys?: unknown } | null;
    const keys = Array.isArray(body?.keys)
      ? body.keys.map((k: unknown) => String(k))
      : [];
    try {
      json(res, 200, { ok: true, removed: removeSuggestions(keys) });
    } catch (error) {
      json(res, 500, { ok: false, error: (error as Error).message });
    }
  });

  app.post("/api/dataset/sync", async (res, req) => {
    try {
      const body = (await readJsonBody(res, req)) as {
        consent?: unknown;
        ids?: unknown;
        offset?: unknown;
        limit?: unknown;
        rebuildIndex?: unknown;
      } | null;
      if (body?.consent !== true) {
        return json(res, 403, {
          ok: false,
          error:
            "Importing a subscription list needs explicit permission: pass consent: true. Only sync an account you own or have permission to use.",
        });
      }
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      if (ids.length === 0) {
        return json(res, 400, { ok: false, error: "ids is empty" });
      }
      if (ids.length > 10_000) {
        return json(res, 413, {
          ok: false,
          error: "at most 10,000 ids per request",
        });
      }

      const result = await importYouTubeChannels(ids, {
        offset: Number(body.offset) || 0,
        limit: Number(body.limit) || 12,
        rebuildIndex: body.rebuildIndex === true,
      });
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error("[import] failed:", error);
      json(res, 500, { ok: false, error: (error as Error).message });
    }
  });

  const getTitle = (item: any) => {
    if (!item) return "Untitled";
    let t = item.title?.text || item.title?.toString() || item.title;
    if (typeof t === "object" && t !== null) {
      t = t.text || t.toString();
    }
    if (t && typeof t === "string" && t !== "[object Object]") return t;
    return "Untitled";
  };

  // Media cards must use the video's own thumbnail, never its owner's avatar.
  const getThumb = (item: any, includeChannelAvatar = false) => {
    if (!item) return null;

    const thumbs =
      item.thumbnails ||
      item.thumbnail?.contents ||
      item.thumbnail?.thumbnail ||
      (Array.isArray(item.thumbnail) ? item.thumbnail : null) ||
      (Array.isArray(item.video_thumbnails) && item.video_thumbnails.length > 0
        ? item.video_thumbnails[0].contents || item.video_thumbnails[0].thumbnail
        : null) ||
      item.cover?.thumbnails ||
      item.cover?.thumbnail?.contents ||
      (includeChannelAvatar ? item.secondary_info?.owner?.thumbnails : null) ||
      (includeChannelAvatar ? item.secondary_info?.owner?.author?.thumbnails : null) ||
      (includeChannelAvatar ? item.author?.thumbnails : null) ||
      (includeChannelAvatar ? item.author?.thumbnail?.contents : null) ||
      (includeChannelAvatar ? item.channel?.thumbnails : null) ||
      (includeChannelAvatar ? item.channel?.thumbnail?.contents : null) ||
      (includeChannelAvatar ? item.avatar?.contents : null);

    if (Array.isArray(thumbs) && thumbs.length > 0) {
      return thumbs[thumbs.length - 1].url;
    }

    const singleThumb =
      item.thumbnail ||
      item.cover?.thumbnail ||
      (includeChannelAvatar ? item.secondary_info?.owner?.thumbnail : null) ||
      (includeChannelAvatar ? item.author?.thumbnail : null) ||
      (includeChannelAvatar ? item.channel?.thumbnail : null) ||
      (includeChannelAvatar ? item.avatar : null);

    if (typeof singleThumb === "string") return singleThumb;
    if (singleThumb?.url) return singleThumb.url;
    if (Array.isArray(singleThumb?.contents) && singleThumb.contents.length > 0) {
      return singleThumb.contents[singleThumb.contents.length - 1].url;
    }

    if (item.url && (item.width || item.height)) return item.url;
    return null;
  };

  const getChannelId = (item: any) => {
    if (!item) return null;
    let id =
      item.secondary_info?.owner?.author?.id ||
      item.secondary_info?.owner?.id ||
      item.author?.id ||
      item.channel?.id ||
      item.channelId ||
      item.owner_id ||
      item.author_id ||
      (item.type?.toLowerCase() === "channel" ? item.id : null);

    if (id && typeof id === "object") id = id.toString();
    return id?.toString() || null;
  };

  const getChannelName = (item: any) => {
    if (!item) return "Unknown";

    const nameObj =
      item.secondary_info?.owner?.author?.name ||
      item.secondary_info?.owner?.name ||
      item.owner?.name ||
      item.author?.name ||
      item.channel?.name ||
      item.author?.name?.text ||
      item.owner?.name?.text ||
      item.name;

    if (nameObj) {
      const n =
        typeof nameObj === "object" && nameObj.text
          ? nameObj.text
          : nameObj.toString();
      if (n && n !== "Unknown" && n !== "[object Object]") return n;
    }

    if (typeof item.owner === "string") return item.owner;
    if (typeof item.author === "string") return item.author;
    if (typeof item.channel === "string") return item.channel;

    if (item.authors && Array.isArray(item.authors) && item.authors.length > 0) {
      const names = item.authors.map((a: any) => {
        if (typeof a === "string") return a;
        return a.name?.text || a.name?.toString() || a.toString();
      }).filter(
        (n: string) => n && n !== "Unknown" && n !== "[object Object]",
      );
      if (names.length > 0) return names.join(", ");
    }

    const byline =
      item.short_byline_text?.toString() ||
      item.long_byline_text?.toString() ||
      item.byline?.toString();
    if (byline && byline !== "Unknown" && byline !== "[object Object]")
      return byline;

    return "Unknown";
  };

  // API Routes
  app.get("/api/vsingers", (res, req) => {
    try {
      const q = queryOf(req.getUrl());
      const collectedOnly = q.collected === "true";
      const sort = q.sort || "name";

      let orderBy = "name COLLATE NOCASE ASC";
      if (sort === "newest") orderBy = "discovered_at DESC";
      if (sort === "oldest") orderBy = "discovered_at ASC";
      if (sort === "synced_newest") orderBy = "last_synced DESC";
      if (sort === "synced_oldest") orderBy = "last_synced ASC";
      if (sort === "name_desc") orderBy = "name COLLATE NOCASE DESC";

      const query = collectedOnly
        ? `SELECT * FROM channels WHERE is_collected = 1 AND id NOT IN (SELECT id FROM blacklist) ORDER BY ${orderBy}`
        : `SELECT * FROM channels WHERE id NOT IN (SELECT id FROM blacklist) ORDER BY ${orderBy}`;
      const channels = db.prepare(query).all();
      json(res, 200, channels);
    } catch (error) {
      console.error("Error fetching vsingers:", error);
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.get("/api/items", (res, req) => {
    try {
      const q = queryOf(req.getUrl());
      const collected = q.collected;
      const type = q.type; // 'video' or 'playlist'
      const sort = q.sort || "newest";
      const keywords = q.keywords ? (q.keywords as string).split(",") : [];

      let query = `
        SELECT items.*, channels.name as channel_name,
          channels.thumbnail as channel_thumbnail
        FROM items 
        LEFT JOIN channels ON items.channel_id = channels.id 
        WHERE (items.channel_id IS NULL OR items.channel_id NOT IN (SELECT id FROM blacklist))
      `;

      const params: any[] = [];
      if (collected === "true") {
        query += " AND items.is_collected = 1";
      } else if (collected === "false") {
        query += " AND items.is_collected = 0";
      }
      if (type) {
        query += " AND items.type = ?";
        params.push(type);
      }

      if (keywords.length > 0) {
        const keywordConditions = keywords.map(
          () => "(items.title LIKE ? OR items.tags LIKE ?)",
        ).join(" OR ");
        query += ` AND (${keywordConditions})`;
        keywords.forEach((k) => {
          params.push(`%${k}%`);
          params.push(`%${k}%`);
        });
      }

      let orderBy = "discovered_at DESC";
      if (sort === "oldest") orderBy = "discovered_at ASC";
      if (sort === "title") orderBy = "title COLLATE NOCASE ASC";
      if (sort === "title_desc") orderBy = "title COLLATE NOCASE DESC";
      if (sort === "channel") orderBy = "channel_name COLLATE NOCASE ASC";
      if (sort === "channel_desc") orderBy = "channel_name COLLATE NOCASE DESC";
      if (sort === "published_newest") orderBy = "published_at DESC";
      if (sort === "published_oldest") orderBy = "published_at ASC";

      query += ` ORDER BY ${orderBy} LIMIT 500`;

      const items = db.prepare(query).all(...params) as Array<{
        id: string;
        type: string;
        thumbnail: string | null;
        channel_thumbnail: string | null;
        [key: string]: unknown;
      }>;
      json(
        res,
        200,
        items.map(({ channel_thumbnail, ...item }) => ({
          ...item,
          thumbnail:
            item.type === "video" &&
            item.thumbnail &&
            item.thumbnail === channel_thumbnail
              ? null
              : item.thumbnail,
        })),
      );
    } catch (error) {
      console.error("Error fetching items:", error);
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.post("/api/toggle-favorite", async (res, req) => {
    try {
      const body = (await readJsonBody(res, req)) as any;
      const { id, type, collected, itemData: initialItemData } = body ?? {};
      const table = type === "channel" ? "channels" : "items";
      let itemData = initialItemData;

      // If it's a video and we're collecting it, try to get more info for better channel thumbnails
      if (type === "video" && collected && !itemData?.secondary_info && youtube) {
        try {
          const info = await youtube.getInfo(id as string);
          itemData = { ...itemData, ...info };
        } catch (e) {
          console.error("Error fetching extra info for video:", e);
        }
      }

      // If itemData is provided (from search results), ensure it exists in DB
      if (itemData) {
        if (type === "channel") {
          const thumbUrl = getThumb(itemData, true);
          const channelName = getChannelName(itemData);
          db.prepare(`
            INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
              name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
              handle = COALESCE(excluded.handle, channels.handle),
              thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
          `).run(
            id,
            channelName,
            itemData.handle || itemData.author?.handle,
            thumbUrl,
            Date.now(),
            Date.now(),
          );
        } else {
          // Try to get channel info from secondary_info if available
          const channelId = getChannelId(itemData);
          const channelName = getChannelName(itemData);
          const channelHandle =
            itemData.secondary_info?.owner?.author?.handle ||
            itemData.author?.handle ||
            itemData.channel?.handle;
          const channelThumbUrl = getThumb(
            itemData.secondary_info?.owner?.author ||
              itemData.secondary_info?.owner ||
              itemData.author ||
              itemData.channel,
            true,
          );

          if (channelId && channelId !== id) {
            db.prepare(`
              INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at) 
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                handle = COALESCE(excluded.handle, channels.handle),
                thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
            `).run(
              channelId,
              channelName,
              channelHandle,
              channelThumbUrl,
              Date.now(),
              Date.now(),
            );
          }
          const thumbUrl = getThumb(itemData);
          const publishedStr =
            itemData.published?.toString() ||
            itemData.publishedAt?.toString() ||
            new Date().toISOString();
          const tags =
            Array.isArray(itemData.tags)
              ? itemData.tags.join(",")
              : itemData.tags || null;
          const videoCount =
            itemData.video_count?.toString() ||
            itemData.videoCount?.toString() ||
            null;
          db.prepare(`
            INSERT INTO items (id, channel_id, title, type, thumbnail, published_at, discovered_at, tags, video_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
              title = excluded.title, 
              thumbnail = COALESCE(excluded.thumbnail, items.thumbnail),
              tags = COALESCE(excluded.tags, items.tags),
              video_count = COALESCE(excluded.video_count, items.video_count)
          `).run(
            id,
            channelId || null,
            itemData.title?.toString() || itemData.title,
            type,
            thumbUrl,
            parseRelativeDate(publishedStr),
            Date.now(),
            tags,
            videoCount,
          );
        }
      }

      db.prepare(`UPDATE ${table} SET is_collected = ? WHERE id = ?`).run(
        collected ? 1 : 0,
        id,
      );
      json(res, 200, { status: "success" });
    } catch (error) {
      console.error("Error collecting item:", error);
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.get("/api/blacklist", (res, _req) => {
    try {
      const list = db
        .prepare("SELECT * FROM blacklist ORDER BY added_at DESC")
        .all();
      json(res, 200, list);
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.post("/api/blacklist", async (res, req) => {
    try {
      const body = (await readJsonBody(res, req)) as {
        id?: unknown;
        name?: unknown;
        handle?: unknown;
        thumbnail?: unknown;
      } | null;
      const { id, name, handle, thumbnail } = body ?? {};
      if (!id) return json(res, 400, { error: "ID required" });

      db.prepare(`
        INSERT OR REPLACE INTO blacklist (id, name, handle, thumbnail, added_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, handle, thumbnail, Date.now());

      // Also remove from channels and items to clean up
      db.prepare("DELETE FROM channels WHERE id = ?").run(id);
      db.prepare("DELETE FROM items WHERE channel_id = ?").run(id);

      json(res, 200, { success: true });
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.del("/api/blacklist/:id", (res, req) => {
    try {
      const url = req.getUrl();
      const id = paramOf(url, "/api/blacklist/:id");
      if (!id) return json(res, 400, { error: "ID required" });
      db.prepare("DELETE FROM blacklist WHERE id = ?").run(id);
      json(res, 200, { success: true });
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.get("/api/search", async (res, req) => {
    const q = queryOf(req.getUrl());
    const query = q.q;
    const type = q.type;
    if (!query) return json(res, 400, { error: "Query required" });
    if (!youtube) return json(res, 503, { error: "YouTube service unavailable" });
    try {
      const searchOptions: any = {};
      if (type === "video" || type === "playlist" || type === "channel") {
        searchOptions.type = type;
      }

      const search = await youtube.search(query, searchOptions);

      // Enrich results with database collection status
      const enrichedItems = ((search.results || []) as any[])
        .filter((item: any) => {
          // Filter out blacklisted channels from search results
          const channelId = getChannelId(item);
          const isBlacklisted = db
            .prepare("SELECT 1 FROM blacklist WHERE id = ?")
            .get(channelId || item.id);
          return !isBlacklisted;
        })
        .map((item: any) => {
          const isChannel =
            item.type === "Channel" ||
            item.constructor.name.includes("Channel");
          const table = isChannel ? "channels" : "items";
          const dbItem = db
            .prepare(`SELECT is_collected FROM ${table} WHERE id = ?`)
            .get(item.id) as any;

          const isVideo =
            item.type === "Video" || item.constructor.name.includes("Video");
          const isPlaylist =
            item.type === "Playlist" ||
            item.constructor.name.includes("Playlist") ||
            item.constructor.name.includes("GridPlaylist");

          let itemId = item.id;
          if (typeof itemId === "object" && itemId !== null) {
            itemId = itemId.toString();
          }
          if (
            !itemId ||
            itemId === "[object Object]" ||
            itemId === "undefined"
          ) {
            itemId = item.playlist_id || item.video_id || item.id;
            if (typeof itemId === "object" && itemId !== null) {
              itemId = itemId.toString();
            }
          }
          itemId = itemId?.toString();

          // Final fallback for youtubei.js structures
          if (
            !itemId ||
            itemId === "[object Object]" ||
            itemId === "undefined"
          ) {
            if (item.playlistId) itemId = item.playlistId.toString();
            else if (item.videoId) itemId = item.videoId.toString();
          }

          if (isPlaylist) {
            console.log("Found Playlist in search:", {
              rawId: item.id,
              playlist_id: item.playlist_id,
              itemId,
              title: item.title?.toString(),
              constructor: item.constructor.name,
              type: item.type,
            });
          }

          const itemType = isChannel
            ? "channel"
            : isPlaylist
              ? "playlist"
              : isVideo
                ? "video"
                : "video";
          const title = getTitle(item);
          const thumb = getThumb(item);
          const videoCount =
            item.video_count?.toString() || item.videoCount?.toString();

          // If it's a playlist and we still don't have a thumbnail, try to look into video_thumbnails
          let finalThumb = thumb;
          if (isPlaylist && !finalThumb && item.video_thumbnails) {
            if (
              Array.isArray(item.video_thumbnails) &&
              item.video_thumbnails.length > 0
            ) {
              finalThumb = getThumb(item.video_thumbnails[0]);
            }
          }

          if (isPlaylist) {
            console.log("Playlist search result mapping:", {
              itemId,
              type,
              title,
              hasThumb: !!finalThumb,
              videoCount,
            });
          }

          return {
            ...item,
            id: itemId,
            name: getChannelName(item),
            handle: item.author?.handle || item.handle,
            channel_name: getChannelName(item),
            title,
            published_at:
              item.published?.toString() || item.publishedAt || item.published,
            thumbnail: finalThumb,
            is_collected: dbItem ? dbItem.is_collected : 0,
            type: itemType,
            video_count: videoCount,
          };
        });

      json(res, 200, enrichedItems);
    } catch (error) {
      console.error("Search error:", error);
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.get("/api/export", (res, _req) => {
    try {
      // Export ALL data from database (no limit) for full backup
      const channels = db.prepare("SELECT * FROM channels ORDER BY name").all();
      const items = db
        .prepare(`
        SELECT items.id, items.channel_id, items.title, items.type, items.thumbnail, items.published_at, items.is_collected, channels.name as channel_name
        FROM items
        LEFT JOIN channels ON items.channel_id = channels.id
        ORDER BY items.published_at DESC
      `)
        .all();
      const blacklist = db.prepare("SELECT * FROM blacklist").all();
      const exportData = {
        exported_at: new Date().toISOString(),
        version: 1,
        channels,
        items,
        blacklist,
      };
      const str = JSON.stringify(exportData);
      res.writeStatus("200 OK");
      res.writeHeader("content-type", "application/json");
      res.writeHeader(
        "content-disposition",
        'attachment; filename=vsinger_tracker_export.json',
      );
      res.writeHeader("content-length", Buffer.byteLength(str).toString());
      res.end(str);
    } catch (error) {
      console.error("Export error:", error);
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.post("/api/import", async (res, req) => {
    try {
      const body = (await readJsonBody(res, req)) as any;
      const channels = Array.isArray(body?.channels) ? body.channels : [];
      const items = Array.isArray(body?.items) ? body.items : [];
      const blacklist = Array.isArray(body?.blacklist) ? body.blacklist : [];

      const insertChannel = db.prepare(`
        INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at, is_collected)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
          is_collected = excluded.is_collected,
          name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
          thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
      `);
      const insertItem = db.prepare(`
        INSERT INTO items (id, channel_id, title, type, thumbnail, published_at, discovered_at, is_collected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET is_collected = excluded.is_collected
      `);
      const insertBlacklist = db.prepare(`
        INSERT OR REPLACE INTO blacklist (id, name, handle, thumbnail, added_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      let channelsInserted = 0;
      let itemsInserted = 0;
      let blacklistInserted = 0;
      const run = db.transaction(() => {
        for (const b of blacklist) {
          if (!b?.id) continue;
          blacklistInserted += insertBlacklist.run(
            b.id,
            b.name ?? null,
            b.handle ?? null,
            b.thumbnail ?? null,
            b.added_at ?? Date.now(),
          ).changes;
        }
        for (const c of channels) {
          const id = c?.id;
          if (!id || typeof c.name !== "string") continue;
          // Skip if in blacklist
          const isBlacklisted = db.prepare("SELECT 1 FROM blacklist WHERE id = ?").get(id);
          if (isBlacklisted) continue;

          channelsInserted += insertChannel.run(
            id,
            c.name,
            c.handle ?? null,
            c.thumbnail ?? null,
            c.last_synced ?? null,
            c.discovered_at ?? Date.now(),
            (c.is_collected ?? 0) ? 1 : 0,
          ).changes;
        }
        for (const i of items) {
          const id = i?.id;
          if (!id || typeof i.title !== "string") continue;
          // Skip if channel is in blacklist
          if (i.channel_id) {
            const isBlacklisted = db.prepare("SELECT 1 FROM blacklist WHERE id = ?").get(i.channel_id);
            if (isBlacklisted) continue;
          }

          itemsInserted += insertItem.run(
            id,
            i.channel_id ?? null,
            i.title,
            i.type ?? null,
            i.thumbnail ?? null,
            i.published_at ?? null,
            i.discovered_at ?? Date.now(),
            (i.is_collected ?? 0) ? 1 : 0,
          ).changes;
        }
      });
      run();
      json(res, 200, {
        success: true,
        imported: { channels: channelsInserted, items: itemsInserted, blacklist: blacklistInserted },
        skipped: {
          channels: channels.length - channelsInserted,
          items: items.length - itemsInserted,
          blacklist: blacklist.length - blacklistInserted,
        },
      });
    } catch (error) {
      console.error("Import error:", error);
      json(res, 500, { success: false, error: (error as Error).message });
    }
  });

  app.get("/api/summary", (res, _req) => {
    try {
      const totalChannels = (db.prepare("SELECT COUNT(*) as count FROM channels").get() as any).count;
      const collectedChannels = (db.prepare("SELECT COUNT(*) as count FROM channels WHERE is_collected = 1").get() as any).count;
      const totalItems = (db.prepare("SELECT COUNT(*) as count FROM items").get() as any).count;
      const collectedPlaylists = (db.prepare("SELECT COUNT(*) as count FROM items WHERE is_collected = 1 AND type = 'playlist'").get() as any).count;
      const discoveryVideos = (db.prepare("SELECT COUNT(*) as count FROM items WHERE type = 'video' AND is_collected = 0").get() as any).count;
      const discoveryPlaylists = (db.prepare("SELECT COUNT(*) as count FROM items WHERE type = 'playlist' AND is_collected = 0").get() as any).count;

      json(res, 200, {
        totalChannels,
        collectedChannels,
        totalItems,
        collectedPlaylists,
        discoveryVideos,
        discoveryPlaylists,
      });
    } catch (error) {
      console.error("Error fetching stats:", error);
      json(res, 500, { error: (error as Error).message });
    }
  });

  app.post("/api/sync", async (res, req) => {
    if (!youtube) return json(res, 503, { error: "YouTube service unavailable" });
    try {
      const keywords = [
        "vsinger",
        "歌ってみた",
        "歌回",
        "歌枠",
        "弾き語り",
        "歌い手",
        "VTuber 歌",
        "Music Video",
        "Cover",
        "オリジナル曲",
      ];
      console.log("Starting sync with keywords:", keywords);

      const processItems = (items: any[]) => {
        for (const item of items) {
          const channelId = getChannelId(item);
          const isBlacklisted = db
            .prepare("SELECT 1 FROM blacklist WHERE id = ?")
            .get(channelId || item.id);
          if (isBlacklisted) continue;

          if (
            item.type === "Channel" ||
            item.constructor.name.includes("Channel")
          ) {
            const thumbUrl = getThumb(item, true);
            const channelName = getChannelName(item);
            const channelId = item.id?.toString() || item.id;
            db.prepare(`
              INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET 
                name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                handle = COALESCE(excluded.handle, channels.handle),
                thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail),
                last_synced = excluded.last_synced
            `).run(
              channelId,
              channelName,
              item.handle,
              thumbUrl,
              Date.now(),
              Date.now(),
            );
          } else if (
            item.type === "Video" ||
            item.type === "Playlist" ||
            item.constructor.name.includes("Video") ||
            item.constructor.name.includes("Playlist") ||
            item.constructor.name.includes("GridPlaylist")
          ) {
            let itemId = item.id;
            if (typeof itemId === "object" && itemId !== null) {
              itemId = itemId.toString();
            }
            if (
              !itemId ||
              itemId === "[object Object]" ||
              itemId === "undefined"
            ) {
              itemId = item.playlist_id || item.video_id || item.id;
              if (typeof itemId === "object" && itemId !== null) {
                itemId = itemId.toString();
              }
            }
            itemId = itemId?.toString();

            // Final fallback for youtubei.js structures
            if (
              !itemId ||
              itemId === "[object Object]" ||
              itemId === "undefined"
            ) {
              if (item.playlistId) itemId = item.playlistId.toString();
              else if (item.videoId) itemId = item.videoId.toString();
            }

            const channelId = getChannelId(item);
            const channelName = getChannelName(item);
            const channelHandle = item.author?.handle || item.channel?.handle;
            if (channelId && channelId !== itemId) {
              const channelThumbUrl = getThumb(item.author || item.channel, true);
              db.prepare(`
                INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET 
                  name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                  handle = COALESCE(excluded.handle, channels.handle),
                  thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
              `).run(
                channelId,
                channelName,
                channelHandle,
                channelThumbUrl,
                Date.now(),
                Date.now(),
              );
            }

            const isVideo =
              item.type === "Video" || item.constructor.name.includes("Video");
            const isPlaylist =
              item.type === "Playlist" ||
              item.constructor.name.includes("Playlist") ||
              item.constructor.name.includes("GridPlaylist");
            const type = isPlaylist ? "playlist" : isVideo ? "video" : "video";

            const publishedStr = item.published?.toString() || new Date().toISOString();
            const tags =
              Array.isArray(item.tags)
                ? item.tags.join(",")
                : item.tags || null;
            const videoCount =
              item.video_count?.toString() ||
              item.videoCount?.toString() ||
              null;

            db.prepare(`
              INSERT OR IGNORE INTO items (id, channel_id, title, type, thumbnail, published_at, discovered_at, tags, video_count)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              itemId,
              channelId || null,
              getTitle(item),
              type,
              getThumb(item),
              parseRelativeDate(publishedStr),
              Date.now(),
              tags,
              videoCount,
            );
          }
        }
      };

      // 1. Sync keywords
      for (const keyword of keywords) {
        try {
          // Search for videos
          const videoSearch = await youtube.search(keyword, { type: "video" });
          if (videoSearch.results) processItems(videoSearch.results);

          // Search for playlists
          const playlistSearch = await youtube.search(keyword, { type: "playlist" });
          if (playlistSearch.results) processItems(playlistSearch.results);

          // Get some continuations for videos
          let currentPage = videoSearch;
          for (let i = 0; i < 2; i++) {
            const nextResults = await currentPage.getContinuation();
            if (nextResults.results && nextResults.results.length > 0) {
              processItems(nextResults.results);
              currentPage = nextResults;
            } else break;
          }
        } catch (e) {
          console.warn(`Search sync failed for ${keyword}:`, e);
        }
      }

      // 2. Sync collected channels specifically
      const collectedChannels = db
        .prepare("SELECT id FROM channels WHERE is_collected = 1")
        .all() as { id: string }[];
      console.log(`Syncing ${collectedChannels.length} collected channels...`);
      for (const colChannel of collectedChannels) {
        try {
          const channel = await youtube.getChannel(colChannel.id);
          const videos = await channel.getVideos();
          if (videos.videos) processItems(videos.videos);
        } catch (e) {
          console.warn(`Channel sync failed for ${colChannel.id}:`, e);
        }
      }

      json(res, 200, { status: "success", message: "Sync completed" });
    } catch (error) {
      console.error("Sync error:", error);
      json(res, 500, { status: "error", message: (error as Error).message });
    }
  });

  // Static file serving
  if (process.env.NODE_ENV !== "production") {
    // uWebSockets.js can't use Vite's Express middleware. Non-API routes are
    // proxied to `npm run dev:web` (Vite on :5173). Start both terminals:
    // `npm run dev:web` (frontend) + `npm run dev` (API).
    //
    // `data/` files (e.g. data/songs/*) are served directly from disk since
    // prepare-public.ts skips large directories like songs/ when copying to
    // public/. This keeps local dev working without duplicating gigabytes.
    app.any("/*", async (res, req) => {
      // uWebSockets.js requires attaching an abort handler when responding
      // asynchronously; otherwise returning at the first await crashes.
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });
      const url = req.getUrl();

      // Serve /data/* files directly from disk in dev mode.
      if (url.startsWith("/data/")) {
        const filePath = path.join(__dirname, "data", url.slice("/data/".length));
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const contentType =
              ext === ".js" ? "application/javascript" :
              ext === ".css" ? "text/css" :
              ext === ".json" ? "application/json" :
              ext === ".html" ? "text/html" :
              ext === ".png" ? "image/png" :
              ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
              ext === ".svg" ? "image/svg+xml" :
              "application/octet-stream";
            const data = await fs.promises.readFile(filePath);
            if (aborted) return;
            res.cork(() => {
              res.writeStatus("200 OK");
              res.writeHeader("content-type", contentType);
              res.writeHeader("content-length", data.byteLength.toString());
              res.end(data);
            });
            return;
          }
        } catch {
          // File doesn't exist — fall through to Vite proxy.
        }
      }

      try {
        const target = `http://localhost:5173${url}`;
        const upstream = await fetch(target, {
          headers: { Accept: req.getHeader("accept") ?? "*/*" },
        });
        const body = await upstream.arrayBuffer();
        if (aborted) return;
        res.cork(() => {
          res.writeStatus(`${upstream.status} ${upstream.statusText}`);
          for (const [key, value] of upstream.headers.entries()) {
            if (key.toLowerCase() === "content-length") continue;
            res.writeHeader(key, value);
          }
          res.writeHeader("content-length", body.byteLength.toString());
          res.end(body);
        });
      } catch {
        if (aborted) return;
        res.cork(() => {
          res.writeStatus("502 Bad Gateway");
          res.writeHeader("content-type", "text/plain");
          res.end(
            "Vite dev server not running on :5173 — start it with `npm run dev:web`.",
          );
        });
      }
    });
  } else {
    const distDir = path.resolve("dist");
    app.any("/*", (res, req) => {
      const url = req.getUrl();
      const filePath = path.join(distDir, url === "/" ? "index.html" : url);
      fs.stat(filePath, (err, stat) => {
        res.cork(() => {
          if (err || !stat?.isFile()) {
            res.writeStatus("200 OK");
            res.writeHeader("content-type", "text/html");
            res.end(fs.readFileSync(path.join(distDir, "index.html"), "utf-8"));
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          const contentType =
            ext === ".js" ? "application/javascript" :
            ext === ".css" ? "text/css" :
            ext === ".json" ? "application/json" :
            ext === ".html" ? "text/html" :
            ext === ".png" ? "image/png" :
            ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
            ext === ".svg" ? "image/svg+xml" :
            "application/octet-stream";
          const data = fs.readFileSync(filePath);
          res.writeStatus("200 OK");
          res.writeHeader("content-type", contentType);
          res.writeHeader("content-length", data.byteLength.toString());
          res.end(data);
        });
      });
    });
  }

  app.listen(PORT, (socket) => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Ready to handle requests");
  });
}

startServer();
