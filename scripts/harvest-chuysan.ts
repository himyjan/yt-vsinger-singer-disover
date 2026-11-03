#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Chuysan (vtuber.chuysan.com).
 *
 * Chuysan is a Next.js directory website. Channel data is loaded client-side,
 * but channel links appear in the rendered HTML. This script uses Playwright
 * to render the page and extract channel information.
 *
 *   npm run data:chuysan              # harvest VTuber candidates
 *   npm run data:chuysan -- --limit 200   # maximum channels to extract
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:chuysan-import`.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const SITE_URL = "https://vtuber.chuysan.com/channels";
const CACHE_DIR = ".cache/chuysan";
const OUT_PATH = path.join(CACHE_DIR, "chuysan.json");

interface ChuYsanChannel {
  channelId?: string | null;
  channelName?: string | null;
  description?: string;
  thumbnail?: string | null;
  subscribers?: number;
  views?: number;
  publishedAt?: string;
  region?: string | null;
  gender?: string | null;
  languages?: string[];
}

interface Options {
  limit: number | null;
  executablePath?: string;
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
      case "--executable-path":
        options.executablePath = value ?? null;
        i++;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:chuysan [--limit <n>] [--executable-path <path>]",
            "",
            "  --limit <n>             maximum number of channels to scrape",
            "  --executable-path <path>  path to Chrome/Chromium executable",
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`chuysan: harvesting from ${SITE_URL}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: options.executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-features=site-per-process,VizDisplayCompositor",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-accelerated-2d-canvas",
      "--disable-web-security",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    console.log(`navigating to ${SITE_URL}`);
    await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for page to fully render - wait for network to be idle
    await page.waitForTimeout(5000);

    const allEntries: Array<{
      channelId: string | null;
      channelName: string | null;
    }> = [];

    let currentPage = 1;
    const maxPages = 50; // Safety limit to prevent infinite loops

    while (true) {
      console.log(`  scraping page ${currentPage}`);

      // Wait for channel cards to appear
      await page.waitForTimeout(3000);

      const pageEntries = await page.evaluate(() => {
        const entries: Array<{
          channelId: string | null;
          channelName: string | null;
        }> = [];

        // Method 1: Look for YouTube channel links directly
        const links = document.querySelectorAll<HTMLElement>(
          'a[href*="youtube.com/channel/"]'
        );
        for (const link of links) {
          const href = link.getAttribute("href");
          if (!href) continue;
          const match = href.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
          if (match) {
            const channelId = match[1];
            const channelName =
              link.textContent?.trim() || link.getAttribute("aria-label") || null;
            entries.push({ channelId, channelName });
          }
        }

        // Method 2: Look for channel cards with data attributes
        const channelCards = document.querySelectorAll<HTMLElement>(
          '[data-channel-id]'
        );
        for (const card of channelCards) {
          const channelId = card.getAttribute("data-channel-id");
          const channelName =
            card.getAttribute("data-channel-name") ||
            card.textContent?.trim() ||
            null;
          if (channelId) {
            entries.push({ channelId, channelName });
          }
        }

        // Method 3: Look for any UC... pattern in the page
        const textContent = document.body.innerText || "";
        const youtubeChannelRegex = /UC[a-zA-Z0-9_-]{22}/g;
        const matches = textContent.match(youtubeChannelRegex);
        if (matches) {
          for (const channelId of matches) {
            const existing = entries.find((e) => e.channelId === channelId);
            if (!existing) {
              entries.push({ channelId, channelName: null });
            }
          }
        }

        return entries;
      });

      const pageEntriesCount = pageEntries.length;
      console.log(`    found ${pageEntriesCount} channels on this page`);
      allEntries.push(...pageEntries);

      // Check if we've reached the limit
      if (options.limit && allEntries.length >= options.limit) {
        console.log(`reached limit of ${options.limit} entries`);
        break;
      }

      // Check for next page button
      const hasNextPage = await page.evaluate(() => {
        // Look for pagination links
        const nextLink = document.querySelector<HTMLElement>(
          'a[href*="page="], a[href*="page="], a[aria-label="next"], .next, .pagination-next'
        );
        if (nextLink && !nextLink.classList.contains("disabled")) {
          return true;
        }
        return false;
      });

      if (!hasNextPage) {
        console.log("no more pages found");
        break;
      }

      // Go to next page
      await page.evaluate(() => {
        const nextLink = document.querySelector<HTMLElement>(
          'a[href*="page="], a[href*="page="], a[aria-label="next"], .next, .pagination-next'
        );
        if (nextLink) {
          (nextLink as HTMLAnchorElement).click();
        }
      });

      currentPage++;
      if (currentPage > 50) {
        console.log("reached max pages limit");
        break;
      }

      // Wait for next page to load
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 5000)));
    }

    // Deduplicate by channel id
    const seen = new Set<string>();
    const uniqueEntries: ChuYsanChannel[] = [];
    for (const entry of allEntries) {
      if (!entry.channelId || seen.has(entry.channelId)) continue;
      seen.add(entry.channelId);
      uniqueEntries.push(entry);
    }

    const snapshot = {
      generatedAt: new Date().toISOString(),
      source: "vtuber.chuysan.com",
      count: uniqueEntries.length,
      data: uniqueEntries,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(
      `chuysan: ${uniqueEntries.length} entr(y/ies) harvested → ${OUT_PATH}`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});