#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Virtuallife (virtuallife.tv).
 *
 * virtuallife.tv is a German VTuber directory with no JSON API. The listing
 * page at /?site=vtuber lists VTuber cards with name and Discord ID.
 * Each individual profile page (?site=vtuber&vtuber=<discord_id>) carries the
 * YouTube channel ID, Twitch handle, Twitter/X handle, Instagram handle,
 * TikTok handle, and activity status.
 *
 * No authentication required.
 *
 *   npm run data:virtuallife              # harvest all
 *   npm run data:virtuallife -- --limit 50   # sample for parser check
 *
 * The harvest writes to .cache/virtuallife/virtuallife.json.
 * Importing is a separate step: npm run data:virtuallife-import
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://virtuallife.tv";
const CACHE_DIR = ".cache/virtuallife";
const OUT_PATH = path.join(CACHE_DIR, "virtuallife.json");

interface VirtuallifeEntry {
  id: string;
  name: string;
  youtubeId?: string;
  twitch?: string;
  twitter?: string;
  instagram?: string;
  tiktok?: string;
  activity?: string;
}

interface Options {
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:virtuallife -- [options]",
            "",
            "  --limit <n>  max entries to harvest",
          ].join("\n")
        );
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return options;
}

/** Parses VTuber cards from the listing page HTML. */
function parseListingCards(html: string): Array<{ name: string; id: string }> {
  const entries: Array<{ name: string; id: string }> = [];
  const seen = new Set<string>();

  // Match: <div class='searchP vt-user' style='background-image: url(./img/users/<id>.webp);'>
  //        <div id='<id>' class='vt-overlay'>
  //        ... <h2 class='searchT'>Name</h2>
  const cardRegex = /<div class='searchP vt-user' style='background-image: url\(.\/img\/users\/(\d+)\.webp\);'>[\s\S]*?<h2 class='searchT'>\s*([^<]+?)\s*<\/h2>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRegex.exec(html)) !== null) {
    const id = match[1];
    const name = match[2].trim();

    if (!name || seen.has(name)) continue;
    seen.add(name);

    entries.push({ name, id });
  }

  return entries;
}

/** Fetches an individual VTuber profile page and extracts platform links and activity status. */
async function fetchVtuberProfile(discordId: string): Promise<{
  youtubeId?: string;
  twitch?: string;
  twitter?: string;
  instagram?: string;
  tiktok?: string;
  activity?: string;
}> {
  try {
    const res = await fetch(`${SOURCE_URL}/?site=vtuber&vtuber=${discordId}`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return {};
    const html = await res.text();

    const youtubeMatch = html.match(/youtube\.com\/channel\/(UC[\w-]{22})/) ||
      html.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/);
    const twitchMatch = html.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
    const twitterMatch = html.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i);
    const instagramMatch = html.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
    const tiktokMatch = html.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);

    // Check activity status
    let activity = "aktiv";
    const inaktivMatch = html.match(/inaktiv/i);
    const pensioniertMatch = html.match(/pensioniert/i);
    const retiredMatch = html.match(/retired/i);
    if (inaktivMatch || pensioniertMatch || retiredMatch) {
      activity = "inaktiv";
    }

    return {
      youtubeId: youtubeMatch?.[1],
      twitch: twitchMatch?.[1],
      twitter: twitterMatch?.[1],
      instagram: instagramMatch?.[1],
      tiktok: tiktokMatch?.[1],
      activity,
    };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`virtuallife: fetching listing page ${SOURCE_URL}/?site=vtuber`);
  let html: string;
  try {
    const res = await fetch(`${SOURCE_URL}/?site=vtuber`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(
        `virtuallife: HTTP ${res.status} — leaving previous cache untouched`,
      );
      process.exit(0);
    }
    html = await res.text();
  } catch {
    console.error(
      "virtuallife: listing fetch failed — leaving previous cache untouched",
    );
    process.exit(0);
  }

  const cards = parseListingCards(html);
  if (!cards.length) {
    console.error(
      "virtuallife: no VTuber cards found — leaving previous cache untouched",
    );
    process.exit(0);
  }

  console.log(`virtuallife: ${cards.length} VTuber cards found on listing page`);

  let limited = cards;
  if (options.limit) limited = cards.slice(0, options.limit);

  // Fetch each individual profile page to get YouTube ID and social links
  const entries: VirtuallifeEntry[] = [];
  for (let i = 0; i < limited.length; i++) {
    const card = limited[i];
    console.log(`  [${i + 1}/${limited.length}] ${card.name}`);
    const profile = await fetchVtuberProfile(card.id);

    // Skip inactive accounts
    if (profile.activity === "inaktiv") {
      console.log(`    → skipping (inaktiv/pensioniert)`);
      continue;
    }

    entries.push({
      id: card.id,
      name: card.name,
      youtubeId: profile.youtubeId,
      twitch: profile.twitch,
      twitter: profile.twitter,
      instagram: profile.instagram,
      tiktok: profile.tiktok,
      activity: profile.activity ?? "aktiv",
    });

    // Small delay to be respectful to the server
    if (i < limited.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "virtuallife.tv",
    count: entries.length,
    data: entries,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  const withYt = entries.filter(e => e.youtubeId).length;
  console.log(
    `virtuallife: ${entries.length} entr(y/ies) harvested (${withYt} with YouTube IDs) → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
