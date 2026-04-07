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
  const youtube = await Innertube.create();

  // Initialize DB
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      handle TEXT,
      thumbnail TEXT,
      last_synced INTEGER,
      is_collected INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      title TEXT NOT NULL,
      type TEXT, -- 'video' or 'playlist'
      thumbnail TEXT,
      published_at TEXT,
      is_collected INTEGER DEFAULT 0,
      FOREIGN KEY(channel_id) REFERENCES channels(id)
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

  app.use(express.json({ limit: '50mb' }));

  // Helper to extract thumbnail from YouTube.js objects
  const getThumb = (item: any) => {
    if (!item) return null;
    if (item.secondary_info?.owner?.thumbnails && item.secondary_info.owner.thumbnails.length > 0) {
      return item.secondary_info.owner.thumbnails[item.secondary_info.owner.thumbnails.length - 1].url;
    }
    if (item.thumbnails && item.thumbnails.length > 0) {
      return item.thumbnails[item.thumbnails.length - 1].url;
    }
    if (item.thumbnail && item.thumbnail.contents && item.thumbnail.contents.length > 0) {
      return item.thumbnail.contents[item.thumbnail.contents.length - 1].url;
    }
    if (item.author?.thumbnails && item.author.thumbnails.length > 0) {
      return item.author.thumbnails[item.author.thumbnails.length - 1].url;
    }
    if (item.author?.thumbnail && item.author.thumbnail.contents && item.author.thumbnail.contents.length > 0) {
      return item.author.thumbnail.contents[item.author.thumbnail.contents.length - 1].url;
    }
    return null;
  };

  const getChannelId = (item: any) => {
    if (!item) return null;
    return item.secondary_info?.owner?.author?.id ||
      item.secondary_info?.owner?.id ||
      item.author?.id ||
      item.channel?.id ||
      item.channelId ||
      item.owner_id ||
      item.author_id ||
      (item.type === 'Channel' ? item.id : null);
  };

  const getChannelName = (item: any) => {
    if (!item) return 'Unknown';

    // 1. Try secondary info (owner of the video) - most reliable for full video info
    const secondaryName = item.secondary_info?.owner?.author?.name || item.secondary_info?.owner?.name;
    if (secondaryName) {
      const s = secondaryName.toString();
      if (s && s !== 'Unknown' && s !== '[object Object]') return s;
    }

    // 1.5 Try owner object
    const ownerName = item.owner?.name || (typeof item.owner === 'string' ? item.owner : null);
    if (ownerName) {
      const o = ownerName.toString();
      if (o && o !== 'Unknown' && o !== '[object Object]') return o;
    }

    // 2. Try author object (common in search results)
    const authorName = item.author?.name || (typeof item.author === 'string' ? item.author : null);
    if (authorName) {
      const a = authorName.toString();
      if (a && a !== 'Unknown' && a !== '[object Object]') return a;
    }

    // 3. Try channel object
    const channelName = item.channel?.name || (typeof item.channel === 'string' ? item.channel : null);
    if (channelName) {
      const c = channelName.toString();
      if (c && c !== 'Unknown' && c !== '[object Object]') return c;
    }

    // 4. Try multiple authors
    if (item.authors && Array.isArray(item.authors) && item.authors.length > 0) {
      const names = item.authors.map((a: any) => a.name?.toString() || a.toString()).filter((n: string) => n && n !== 'Unknown' && n !== '[object Object]');
      if (names.length > 0) return names.join(', ');
    }

    // 5. Try byline texts
    const shortByline = item.short_byline_text?.toString();
    if (shortByline && shortByline !== 'Unknown' && shortByline !== '[object Object]') return shortByline;

    const longByline = item.long_byline_text?.toString();
    if (longByline && longByline !== 'Unknown' && longByline !== '[object Object]') return longByline;

    // 6. Try top-level name (for Channel items)
    if (item.name) {
      const n = item.name.toString();
      if (n && n !== 'Unknown' && n !== '[object Object]') return n;
    }

    return 'Unknown';
  };

  // API Routes
  app.get("/api/vsingers", (req, res) => {
    try {
      const collectedOnly = req.query.collected === "true";
      const sort = req.query.sort || 'name';

      let orderBy = "name ASC";
      if (sort === 'newest') orderBy = "last_synced DESC";
      if (sort === 'oldest') orderBy = "last_synced ASC";

      const query = collectedOnly
        ? `SELECT * FROM channels WHERE is_collected = 1 ORDER BY ${orderBy}`
        : `SELECT * FROM channels ORDER BY ${orderBy}`;
      const channels = db.prepare(query).all();
      res.json(channels);
    } catch (error) {
      console.error("Error fetching vsingers:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get("/api/items", (req, res) => {
    try {
      const collectedOnly = req.query.collected === "true";
      const type = req.query.type; // 'video' or 'playlist'
      const sort = req.query.sort || 'newest';

      let query = `
        SELECT items.*, channels.name as channel_name 
        FROM items 
        LEFT JOIN channels ON items.channel_id = channels.id 
        WHERE 1=1
      `;

      const params: any[] = [];
      if (collectedOnly) {
        query += " AND items.is_collected = 1";
      }
      if (type) {
        query += " AND items.type = ?";
        params.push(type);
      }

      let orderBy = "published_at DESC";
      if (sort === 'oldest') orderBy = "published_at ASC";
      if (sort === 'title') orderBy = "title ASC";
      if (sort === 'channel') orderBy = "channel_name ASC";

      query += ` ORDER BY ${orderBy} LIMIT 500`;

      const items = db.prepare(query).all(...params);
      res.json(items);
    } catch (error) {
      console.error("Error fetching items:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/collect", async (req, res) => {
    try {
      const { id, type, collected, itemData: initialItemData } = req.body;
      const table = type === "channel" ? "channels" : "items";
      let itemData = initialItemData;

      // If it's a video and we're collecting it, try to get more info for better channel thumbnails
      if (type === "video" && collected && !itemData?.secondary_info) {
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
            INSERT INTO channels (id, name, handle, thumbnail, last_synced)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
              name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
              handle = COALESCE(excluded.handle, channels.handle),
              thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
          `).run(id, channelName, itemData.handle || itemData.author?.handle, thumbUrl, Date.now());
        } else {
          // Try to get channel info from secondary_info if available
          const channelId = getChannelId(itemData);
          const channelName = getChannelName(itemData);
          const channelHandle = itemData.secondary_info?.owner?.author?.handle || itemData.author?.handle || itemData.channel?.handle;
          const channelThumbUrl = getThumb(itemData); // This will now check secondary_info.owner.thumbnails

          if (channelId && channelId !== id) {
            db.prepare(`
              INSERT INTO channels (id, name, handle, thumbnail, last_synced) 
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                handle = COALESCE(excluded.handle, channels.handle),
                thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
            `).run(channelId, channelName, channelHandle, channelThumbUrl, Date.now());
          }
          const thumbUrl = getThumb(itemData);
          db.prepare(`
            INSERT INTO items (id, channel_id, title, type, thumbnail, published_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title
          `).run(
            id,
            channelId || null,
            itemData.title?.toString() || itemData.title,
            type,
            thumbUrl,
            itemData.published?.toString() || new Date().toISOString()
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

  app.get("/api/search", async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Query required" });
    try {
      const search = await youtube.search(q as string);

      // Enrich results with database collection status
      const enrichedItems = (search.results || []).map((item: any) => {
        const isChannel = item.type === 'Channel';
        const table = isChannel ? "channels" : "items";
        const dbItem = db.prepare(`SELECT is_collected FROM ${table} WHERE id = ?`).get(item.id) as any;

        return {
          ...item,
          id: item.id,
          name: getChannelName(item),
          handle: item.author?.handle || item.handle,
          channel_name: getChannelName(item),
          title: item.title?.toString() || item.title,
          published_at: item.published?.toString() || item.publishedAt || item.published,
          thumbnail: getThumb(item),
          is_collected: dbItem ? dbItem.is_collected : 0,
          type: isChannel ? 'channel' : (item.type === 'Video' ? 'video' : 'playlist')
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
      const exportData = {
        exported_at: new Date().toISOString(),
        version: 1,
        channels,
        items
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
      const body = req.body as { channels?: any[]; items?: any[] };
      const channels = Array.isArray(body.channels) ? body.channels : [];
      const items = Array.isArray(body.items) ? body.items : [];

      const insertChannel = db.prepare(`
        INSERT OR IGNORE INTO channels (id, name, handle, thumbnail, last_synced, is_collected)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertItem = db.prepare(`
        INSERT OR IGNORE INTO items (id, channel_id, title, type, thumbnail, published_at, is_collected)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      let channelsInserted = 0;
      let itemsInserted = 0;
      const run = db.transaction(() => {
        for (const c of channels) {
          const id = c?.id;
          if (!id || typeof c.name !== "string") continue;
          channelsInserted += insertChannel.run(
            id,
            c.name,
            c.handle ?? null,
            c.thumbnail ?? null,
            c.last_synced ?? null,
            (c.is_collected ?? 0) ? 1 : 0
          ).changes;
        }
        for (const i of items) {
          const id = i?.id;
          if (!id || typeof i.title !== "string") continue;
          itemsInserted += insertItem.run(
            id,
            i.channel_id ?? null,
            i.title,
            i.type ?? null,
            i.thumbnail ?? null,
            i.published_at ?? null,
            (i.is_collected ?? 0) ? 1 : 0
          ).changes;
        }
      });
      run();
      res.json({
        success: true,
        imported: { channels: channelsInserted, items: itemsInserted },
        skipped: {
          channels: channels.length - channelsInserted,
          items: items.length - itemsInserted
        }
      });
    } catch (error) {
      console.error("Import error:", error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  app.get("/api/stats", (req, res) => {
    try {
      const totalChannels = (db.prepare("SELECT COUNT(*) as count FROM channels").get() as any).count;
      const collectedChannels = (db.prepare("SELECT COUNT(*) as count FROM channels WHERE is_collected = 1").get() as any).count;
      const totalItems = (db.prepare("SELECT COUNT(*) as count FROM items").get() as any).count;
      const collectedPlaylists = (db.prepare("SELECT COUNT(*) as count FROM items WHERE is_collected = 1 AND type = 'playlist'").get() as any).count;
      res.json({ totalChannels, collectedChannels, totalItems, collectedPlaylists });
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/sync", async (req, res) => {
    try {
      const keywords = [
        'vsinger', '歌ってみた', '歌回', '歌枠', '弾き語り',
        '歌い手', 'VTuber 歌', 'Music Video', 'Cover', 'オリジナル曲'
      ];
      console.log("Starting sync with keywords:", keywords);

      for (const keyword of keywords) {
        const search = await youtube.search(keyword);

        const processItems = (items: any[]) => {
          for (const item of items) {
            if (item.type === 'Channel') {
              const thumbUrl = getThumb(item);
              const channelName = getChannelName(item);
              console.log(`Saving channel ${channelName} (${item.id}) with thumbnail: ${thumbUrl}`);
              db.prepare(`
                INSERT INTO channels (id, name, handle, thumbnail, last_synced)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET 
                  name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                  handle = COALESCE(excluded.handle, channels.handle),
                  thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail),
                  last_synced = excluded.last_synced
              `).run(item.id, channelName, item.handle, thumbUrl, Date.now());
            } else if (item.type === 'Video' || item.type === 'Playlist') {
              const channelId = getChannelId(item);
              const channelName = getChannelName(item);
              const channelHandle = item.author?.handle || item.channel?.handle;
              if (channelId && channelId !== item.id) {
                const channelThumbUrl = getThumb(item.author || item.channel);
                if (channelThumbUrl) console.log(`Saving channel ${channelName} (${channelId}) from video with thumbnail: ${channelThumbUrl}`);
                db.prepare(`
                  INSERT INTO channels (id, name, handle, thumbnail, last_synced)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET 
                    name = CASE WHEN excluded.name != 'Unknown' THEN excluded.name ELSE channels.name END,
                    handle = COALESCE(excluded.handle, channels.handle),
                    thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail)
                `).run(channelId, channelName, channelHandle, channelThumbUrl, Date.now());
              }

              const type = item.type === 'Video' ? "video" : "playlist";
              const publishedAt = item.published?.toString() || new Date().toISOString();

              db.prepare(`
                INSERT OR IGNORE INTO items (id, channel_id, title, type, thumbnail, published_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `).run(
                item.id,
                channelId || null,
                item.title?.toString() || item.title,
                type,
                getThumb(item),
                publishedAt
              );
            }
          }
        };

        // Process first page
        if (search.results) {
          processItems(search.results);
        }

        // Load and process more pages for deeper discovery
        let currentPage = search;
        for (let i = 0; i < 4; i++) { // Fetch 4 more pages (5 total)
          try {
            const nextResults = await currentPage.getContinuation();
            if (nextResults.results && nextResults.results.length > 0) {
              processItems(nextResults.results);
              currentPage = nextResults;
            } else {
              break;
            }
          } catch (nextError) {
            console.warn(`Could not load page ${i + 2} for keyword: ${keyword}`, nextError);
            break;
          }
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
  });
}

startServer();
