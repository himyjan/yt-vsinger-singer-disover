#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from Chuysan (vtuber.chuysan.com).
 *
 * Chuysan is a Next.js directory website. Channel data is loaded client-side,
 * but channel links appear in the rendered HTML. This script uses puppeteer-core
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
import puppeteer from "puppeteer-core";

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

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: options.executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    console.log(`navigating to ${SITE_URL}`);
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // Wait for channel cards to appear
    await page.waitForSelector("a[href*='/channel/']", { timeout: 10000 });

    const rawEntries = await page.evaluate(() => {
      const entries: Array<{
        channelId: string | null;
        channelName: string | null;
      }> = [];

      // Find all links to /channel/UC... pages
      const links = document.querySelectorAll('a[href^="/channel/"]');
      for (const link of links) {
        const href = link.getAttribute("href");
        if (!href) continue;
        const match = href.match(/^\/channel\/(UC[\w-]{22})/);
        if (!match) continue;
        const channelId = match[1];
        const channelName =
          link.textContent?.trim() || link.getAttribute("aria-label") || null;
        entries.push({ channelId, channelName });
      }
      return entries;
    });

    const entries: ChuYsanChannel[] = rawEntries.map((e) => ({
      channelId: e.channelId,
      channelName: e.channelName,
    }));

    const snapshot = {
      generatedAt: new Date().toISOString(),
      source: "vtuber.chuysan.com",
      count: entries.length,
      data: entries,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(
      `chuysan: ${entries.length} entr(y/ies) harvested → ${OUT_PATH}`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});