import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import { Innertube } from "youtubei.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, "yt_singers_channel.db");

// Ensure the database file exists or will be created
if (!fs.existsSync(dbPath)) {
  console.log(`Creating new database file at: ${dbPath}`);
}

const db = new Database(dbPath);

async function startServer() {
  const app = express();
  const PORT = 3000;
  const youtube = await Innertube.create().catch(e => {
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
    db.exec("UPDATE channels SET discovered_at = strftime('%s', 'now') * 1000 WHERE discovered_at IS NULL");
  }

  try {
    db.prepare("SELECT discovered_at FROM items LIMIT 1").get();
  } catch (e) {
    console.log("Adding discovered_at to items table...");
    db.exec("ALTER TABLE items ADD COLUMN discovered_at INTEGER");
    db.exec("UPDATE items SET discovered_at = strftime('%s', 'now') * 1000 WHERE discovered_at IS NULL");
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
    if (str.includes('t') && !isNaN(Date.parse(str))) return relativeDate;

    const now = new Date();
    // Match relative time patterns, ignoring prefixes like "Streamed" or "Premiered"
    const match = str.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
    if (!match) return relativeDate;

    const amount = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'second': now.setSeconds(now.getSeconds() - amount); break;
      case 'minute': now.setMinutes(now.getMinutes() - amount); break;
      case 'hour': now.setHours(now.getHours() - amount); break;
      case 'day': now.setDate(now.getDate() - amount); break;
      case 'week': now.setDate(now.getDate() - amount * 7); break;
      case 'month': now.setMonth(now.getMonth() - amount); break;
      case 'year': now.setFullYear(now.getFullYear() - amount); break;
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

  app.use(express.json({ limit: '50mb' }));

  // Global error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  const getTitle = (item: any) => {
    if (!item) return 'Untitled';
    let t = item.title?.text || item.title?.toString() || item.title;
    if (typeof t === 'object' && t !== null) {
      t = t.text || t.toString();
    }
    if (t && typeof t === 'string' && t !== '[object Object]') return t;
    return 'Untitled';
  };

  // Helper to extract thumbnail from YouTube.js objects
  const getThumb = (item: any) => {
    if (!item) return null;

    // 1. Try arrays of thumbnails
    const thumbs = item.secondary_info?.owner?.thumbnails ||
      item.thumbnails ||
      item.thumbnail?.contents ||
      item.thumbnail?.thumbnail || // PlaylistVideoThumbnail
      (Array.isArray(item.thumbnail) ? item.thumbnail : null) ||
      (Array.isArray(item.video_thumbnails) && item.video_thumbnails.length > 0 ? (item.video_thumbnails[0].contents || item.video_thumbnails[0].thumbnail) : null) ||
      item.author?.thumbnails ||
      item.author?.thumbnail?.contents ||
      item.cover?.thumbnails ||
      item.cover?.thumbnail?.contents ||
      item.channel?.thumbnails ||
      item.avatar?.contents;

    if (Array.isArray(thumbs) && thumbs.length > 0) {
      return thumbs[thumbs.length - 1].url;
    }

    // 2. Try single thumbnail objects
    const singleThumb = item.thumbnail ||
      item.author?.thumbnail ||
      item.cover?.thumbnail ||
      item.channel?.thumbnail ||
      item.avatar;

    if (typeof singleThumb === 'string') return singleThumb;
    if (singleThumb?.url) return singleThumb.url;
    if (Array.isArray(singleThumb?.contents) && singleThumb.contents.length > 0) {
      return singleThumb.contents[singleThumb.contents.length - 1].url;
    }

    // 3. Last resort: check if item itself is a thumbnail object
    if (item.url && (item.width || item.height)) return item.url;

    console.warn("getThumb failed for item:", {
      type: item.type,
      constructor: item.constructor?.name,
      hasThumbnails: !!item.thumbnails,
      hasThumbnail: !!item.thumbnail,
      hasAuthor: !!item.author,
      hasCover: !!item.cover,
      hasAvatar: !!item.avatar
    });
    return null;
  };

  const getChannelId = (item: any) => {
    if (!item) return null;
    let id = item.secondary_info?.owner?.author?.id ||
      item.secondary_info?.owner?.id ||
      item.author?.id ||
      item.channel?.id ||
      item.channelId ||
      item.owner_id ||
      item.author_id ||
      (item.type?.toLowerCase() === 'channel' ? item.id : null);

    if (id && typeof id === 'object') id = id.toString();
    return id?.toString() || null;
  };

  const getChannelName = (item: any) => {
    if (!item) return 'Unknown';

    const nameObj = item.secondary_info?.owner?.author?.name ||
      item.secondary_info?.owner?.name ||
      item.owner?.name ||
      item.author?.name ||
      item.channel?.name ||
      item.author?.name?.text ||
      item.owner?.name?.text ||
      item.name;

    if (nameObj) {
      const n = typeof nameObj === 'object' && nameObj.text ? nameObj.text : nameObj.toString();
      if (n && n !== 'Unknown' && n !== '[object Object]') return n;
    }

    if (typeof item.owner === 'string') return item.owner;
    if (typeof item.author === 'string') return item.author;
    if (typeof item.channel === 'string') return item.channel;

    if (item.authors && Array.isArray(item.authors) && item.authors.length > 0) {
      const names = item.authors.map((a: any) => {
        if (typeof a === 'string') return a;
        return a.name?.text || a.name?.toString() || a.toString();
      }).filter((n: string) => n && n !== 'Unknown' && n !== '[object Object]');
      if (names.length > 0) return names.join(', ');
    }

    const byline = item.short_byline_text?.toString() || item.long_byline_text?.toString() || item.byline?.toString();
    if (byline && byline !== 'Unknown' && byline !== '[object Object]') return byline;

    return 'Unknown';
  };

  // API Routes
  app.get("/api/vsingers", (req, res) => {
    try {
      const collectedOnly = req.query.collected === "true";
      const sort = req.query.sort || 'name';

      let orderBy = "name COLLATE NOCASE ASC";
      if (sort === 'newest') orderBy = "discovered_at DESC";
      if (sort === 'oldest') orderBy = "discovered_at ASC";
      if (sort === 'synced_newest') orderBy = "last_synced DESC";
      if (sort === 'synced_oldest') orderBy = "last_synced ASC";
      if (sort === 'name_desc') orderBy = "name COLLATE NOCASE DESC";

      const query = collectedOnly
        ? `SELECT * FROM channels WHERE is_collected = 1 AND id NOT IN (SELECT id FROM blacklist) ORDER BY ${orderBy}`
        : `SELECT * FROM channels WHERE id NOT IN (SELECT id FROM blacklist) ORDER BY ${orderBy}`;
      const channels = db.prepare(query).all();
      res.json(channels);
    } catch (error) {
      console.error("Error fetching vsingers:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get("/api/items", (req, res) => {
    try {
      const collected = req.query.collected;
      const type = req.query.type; // 'video' or 'playlist'
      const sort = req.query.sort || 'newest';
      const keywords = req.query.keywords ? (req.query.keywords as string).split(',') : [];

      let query = `
        SELECT items.*, channels.name as channel_name 
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
        const keywordConditions = keywords.map(() => "(items.title LIKE ? OR items.tags LIKE ?)").join(" OR ");
        query += ` AND (${keywordConditions})`;
        keywords.forEach(k => {
          params.push(`%${k}%`);
          params.push(`%${k}%`);
        });
      }

      let orderBy = "discovered_at DESC";
      if (sort === 'oldest') orderBy = "discovered_at ASC";
      if (sort === 'title') orderBy = "title COLLATE NOCASE ASC";
      if (sort === 'title_desc') orderBy = "title COLLATE NOCASE DESC";
      if (sort === 'channel') orderBy = "channel_name COLLATE NOCASE ASC";
      if (sort === 'channel_desc') orderBy = "channel_name COLLATE NOCASE DESC";
      if (sort === 'published_newest') orderBy = "published_at DESC";
      if (sort === 'published_oldest') orderBy = "published_at ASC";

      query += ` ORDER BY ${orderBy} LIMIT 500`;

      const items = db.prepare(query).all(...params);
      res.json(items);
    } catch (error) {
      console.error("Error fetching items:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/toggle-favorite", async (req, res) => {
    try {
      const { id, type, collected, itemData: initialItemData } = req.body;
      const table = type === "channel" ? "channels" : "items";
      let itemData = initialItemData;

      // If it's a video and we're collecting it, try to get more info for better channel thumbnails
      if (type === "video" && collected && !itemData?.secondary_info && youtube) {
        try {
          const info = await youtube.getInfo(id);
          itemData = { ...itemData, ...info };
        } catch (e) {
          console.error("Error fetching extra info for video:", e);
        }
      }

      // If itemData is provided (from search results), ensure it exists in DB
      if (itemData) {
        if (type === "channel") {
          const thumbUrl = getThumb(itemData);
          const channelName = getChannelName(itemData);
          db.prepare(`
            INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
              name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
              handle = COALESCE(excluded.handle, channels.handle),
              thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
          `).run(id, channelName, itemData.handle || itemData.author?.handle, thumbUrl, Date.now(), Date.now());
        } else {
          // Try to get channel info from secondary_info if available
          const channelId = getChannelId(itemData);
          const channelName = getChannelName(itemData);
          const channelHandle = itemData.secondary_info?.owner?.author?.handle || itemData.author?.handle || itemData.channel?.handle;
          const channelThumbUrl = getThumb(itemData); // This will now check secondary_info.owner.thumbnails

          if (channelId && channelId !== id) {
            db.prepare(`
              INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at) 
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                handle = COALESCE(excluded.handle, channels.handle),
                thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
            `).run(channelId, channelName, channelHandle, channelThumbUrl, Date.now(), Date.now());
          }
          const thumbUrl = getThumb(itemData);
          const publishedStr = itemData.published?.toString() || itemData.publishedAt?.toString() || new Date().toISOString();
          const tags = Array.isArray(itemData.tags) ? itemData.tags.join(',') : (itemData.tags || null);
          db.prepare(`
            INSERT INTO items (id, channel_id, title, type, thumbnail, published_at, discovered_at, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title, tags = COALESCE(excluded.tags, items.tags)
          `).run(
            id,
            channelId || null,
            itemData.title?.toString() || itemData.title,
            type,
            thumbUrl,
            parseRelativeDate(publishedStr),
            Date.now(),
            tags
          );
        }
      }

      db.prepare(`UPDATE ${table} SET is_collected = ? WHERE id = ?`).run(collected ? 1 : 0, id);
      res.json({ status: "success" });
    } catch (error) {
      console.error("Error collecting item:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get("/api/blacklist", (req, res) => {
    try {
      const list = db.prepare("SELECT * FROM blacklist ORDER BY added_at DESC").all();
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/blacklist", (req, res) => {
    try {
      const { id, name, handle, thumbnail } = req.body;
      if (!id) return res.status(400).json({ error: "ID required" });

      db.prepare(`
        INSERT OR REPLACE INTO blacklist (id, name, handle, thumbnail, added_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, handle, thumbnail, Date.now());

      // Also remove from channels and items to clean up
      db.prepare("DELETE FROM channels WHERE id = ?").run(id);
      db.prepare("DELETE FROM items WHERE channel_id = ?").run(id);

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.delete("/api/blacklist/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM blacklist WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get("/api/search", async (req, res) => {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: "Query required" });
    if (!youtube) return res.status(503).json({ error: "YouTube service unavailable" });
    try {
      const searchOptions: any = {};
      if (type === 'video' || type === 'playlist' || type === 'channel') {
        searchOptions.type = type;
      }

      const search = await youtube.search(q as string, searchOptions);

      // Enrich results with database collection status
      const enrichedItems = (search.results || []).filter((item: any) => {
        // Filter out blacklisted channels from search results
        const channelId = getChannelId(item);
        const isBlacklisted = db.prepare("SELECT 1 FROM blacklist WHERE id = ?").get(channelId || item.id);
        return !isBlacklisted;
      }).map((item: any) => {
        const isChannel = item.type === 'Channel' || item.constructor.name.includes('Channel');
        const table = isChannel ? "channels" : "items";
        const dbItem = db.prepare(`SELECT is_collected FROM ${table} WHERE id = ?`).get(item.id) as any;

        const isVideo = item.type === 'Video' || item.constructor.name.includes('Video');
        const isPlaylist = item.type === 'Playlist' || item.constructor.name.includes('Playlist') || item.constructor.name.includes('GridPlaylist');

        let itemId = item.id;
        if (typeof itemId === 'object' && itemId !== null) {
          itemId = itemId.toString();
        }
        if (!itemId || itemId === '[object Object]' || itemId === 'undefined') {
          itemId = item.playlist_id || item.video_id || item.id;
          if (typeof itemId === 'object' && itemId !== null) {
            itemId = itemId.toString();
          }
        }
        itemId = itemId?.toString();

        // Final fallback for youtubei.js structures
        if (!itemId || itemId === '[object Object]' || itemId === 'undefined') {
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
            type: item.type
          });
        }

        const type = isChannel ? 'channel' : (isPlaylist ? 'playlist' : (isVideo ? 'video' : 'video'));
        const title = getTitle(item);
        const thumb = getThumb(item);

        // If it's a playlist and we still don't have a thumbnail, try to look into video_thumbnails
        let finalThumb = thumb;
        if (isPlaylist && !finalThumb && item.video_thumbnails) {
          if (Array.isArray(item.video_thumbnails) && item.video_thumbnails.length > 0) {
            finalThumb = getThumb(item.video_thumbnails[0]);
          }
        }

        if (isPlaylist) {
          console.log("Playlist search result mapping:", { itemId, type, title, hasThumb: !!finalThumb });
        }

        return {
          ...item,
          id: itemId,
          name: getChannelName(item),
          handle: item.author?.handle || item.handle,
          channel_name: getChannelName(item),
          title,
          published_at: item.published?.toString() || item.publishedAt || item.published,
          thumbnail: finalThumb,
          is_collected: dbItem ? dbItem.is_collected : 0,
          type
        };
      });

      res.json(enrichedItems);
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get("/api/export", (req, res) => {
    try {
      // Export ALL data from database (no limit) for full backup
      const channels = db.prepare("SELECT * FROM channels ORDER BY name").all();
      const items = db.prepare(`
        SELECT items.id, items.channel_id, items.title, items.type, items.thumbnail, items.published_at, items.is_collected, channels.name as channel_name
        FROM items
        LEFT JOIN channels ON items.channel_id = channels.id
        ORDER BY items.published_at DESC
      `).all();
      const blacklist = db.prepare("SELECT * FROM blacklist").all();
      const exportData = {
        exported_at: new Date().toISOString(),
        version: 1,
        channels,
        items,
        blacklist
      };
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", "attachment; filename=vsinger_tracker_export.json");
      res.json(exportData);
    } catch (error) {
      console.error("Export error:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/import", (req, res) => {
    try {
      const body = req.body as { channels?: any[]; items?: any[]; blacklist?: any[] };
      const channels = Array.isArray(body.channels) ? body.channels : [];
      const items = Array.isArray(body.items) ? body.items : [];
      const blacklist = Array.isArray(body.blacklist) ? body.blacklist : [];

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
            b.added_at ?? Date.now()
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
            (c.is_collected ?? 0) ? 1 : 0
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
            (i.is_collected ?? 0) ? 1 : 0
          ).changes;
        }
      });
      run();
      res.json({
        success: true,
        imported: { channels: channelsInserted, items: itemsInserted, blacklist: blacklistInserted },
        skipped: {
          channels: channels.length - channelsInserted,
          items: items.length - itemsInserted,
          blacklist: blacklist.length - blacklistInserted
        }
      });
    } catch (error) {
      console.error("Import error:", error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get("/api/summary", (req, res) => {
    try {
      const totalChannels = (db.prepare("SELECT COUNT(*) as count FROM channels").get() as any).count;
      const collectedChannels = (db.prepare("SELECT COUNT(*) as count FROM channels WHERE is_collected = 1").get() as any).count;
      const totalItems = (db.prepare("SELECT COUNT(*) as count FROM items").get() as any).count;
      const collectedPlaylists = (db.prepare("SELECT COUNT(*) as count FROM items WHERE is_collected = 1 AND type = 'playlist'").get() as any).count;
      const discoveryVideos = (db.prepare("SELECT COUNT(*) as count FROM items WHERE type = 'video' AND is_collected = 0").get() as any).count;
      const discoveryPlaylists = (db.prepare("SELECT COUNT(*) as count FROM items WHERE type = 'playlist' AND is_collected = 0").get() as any).count;

      res.json({
        totalChannels,
        collectedChannels,
        totalItems,
        collectedPlaylists,
        discoveryVideos,
        discoveryPlaylists
      });
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/sync", async (req, res) => {
    if (!youtube) return res.status(503).json({ error: "YouTube service unavailable" });
    try {
      const keywords = [
        'vsinger', '歌ってみた', '歌回', '歌枠', '弾き語り',
        '歌い手', 'VTuber 歌', 'Music Video', 'Cover', 'オリジナル曲'
      ];
      console.log("Starting sync with keywords:", keywords);

      const processItems = (items: any[]) => {
        for (const item of items) {
          const channelId = getChannelId(item);
          const isBlacklisted = db.prepare("SELECT 1 FROM blacklist WHERE id = ?").get(channelId || item.id);
          if (isBlacklisted) continue;

          if (item.type === 'Channel' || item.constructor.name.includes('Channel')) {
            const thumbUrl = getThumb(item);
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
            `).run(channelId, channelName, item.handle, thumbUrl, Date.now(), Date.now());
          } else if (item.type === 'Video' || item.type === 'Playlist' || item.constructor.name.includes('Video') || item.constructor.name.includes('Playlist') || item.constructor.name.includes('GridPlaylist')) {
            let itemId = item.id;
            if (typeof itemId === 'object' && itemId !== null) {
              itemId = itemId.toString();
            }
            if (!itemId || itemId === '[object Object]' || itemId === 'undefined') {
              itemId = item.playlist_id || item.video_id || item.id;
              if (typeof itemId === 'object' && itemId !== null) {
                itemId = itemId.toString();
              }
            }
            itemId = itemId?.toString();

            // Final fallback for youtubei.js structures
            if (!itemId || itemId === '[object Object]' || itemId === 'undefined') {
              if (item.playlistId) itemId = item.playlistId.toString();
              else if (item.videoId) itemId = item.videoId.toString();
            }

            const channelId = getChannelId(item);
            const channelName = getChannelName(item);
            const channelHandle = item.author?.handle || item.channel?.handle;
            if (channelId && channelId !== itemId) {
              const channelThumbUrl = getThumb(item.author || item.channel);
              db.prepare(`
                INSERT INTO channels (id, name, handle, thumbnail, last_synced, discovered_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET 
                  name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                  handle = COALESCE(excluded.handle, channels.handle),
                  thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
              `).run(channelId, channelName, channelHandle, channelThumbUrl, Date.now(), Date.now());
            }

            const isVideo = item.type === 'Video' || item.constructor.name.includes('Video');
            const isPlaylist = item.type === 'Playlist' || item.constructor.name.includes('Playlist') || item.constructor.name.includes('GridPlaylist');
            const type = isPlaylist ? "playlist" : (isVideo ? "video" : "video");

            const publishedStr = item.published?.toString() || new Date().toISOString();
            const tags = Array.isArray(item.tags) ? item.tags.join(',') : (item.tags || null);

            db.prepare(`
              INSERT OR IGNORE INTO items (id, channel_id, title, type, thumbnail, published_at, discovered_at, tags)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              itemId,
              channelId || null,
              getTitle(item),
              type,
              getThumb(item),
              parseRelativeDate(publishedStr),
              Date.now(),
              tags
            );
          }
        }
      };

      // 1. Sync keywords
      for (const keyword of keywords) {
        try {
          // Search for videos
          const videoSearch = await youtube.search(keyword, { type: 'video' });
          if (videoSearch.results) processItems(videoSearch.results);

          // Search for playlists
          const playlistSearch = await youtube.search(keyword, { type: 'playlist' });
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
      const collectedChannels = db.prepare("SELECT id FROM channels WHERE is_collected = 1").all() as { id: string }[];
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

      res.json({ status: "success", message: "Sync completed" });
    } catch (error) {
      console.error("Sync error:", error);
      res.status(500).json({ status: "error", message: (error as Error).message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist/index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Ready to handle requests");
  });
}

startServer();
