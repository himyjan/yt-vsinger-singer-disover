#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from V-SLive (v-sai.com/vtuber).
 *
 * v-sai.com/vtuber is a Vietnamese VTuber directory that publishes channel
 * data via a ConnectRPC (gRPC-web) JSON API at
 * `https://api.v-sai.com/api.vtubers.v1.VtuberProfilesService/GetAllVtuberProfiles`.
 *
 * No authentication required.
 *
 *   npm run data:v-sai              # harvest VTuber candidates from V-SLive
 *   npm run data:v-sai -- --limit 100   # max entries per page
 *
 * Nothing here writes `data/` — adding the channels is a separate step
 * through `npm run data:v-sai-import`.
 */

import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://api.v-sai.com";
const CACHE_DIR = ".cache/v-sai";
const OUT_PATH = path.join(CACHE_DIR, "v-sai.json");

interface VtuberProfile {
  id: string;
  userId: string;
  displayName: string;
  furigana?: string;
  image?: string;
  bannerImage?: string;
  socialMediaLinks?: {
    twitter?: string;
    youtube?: string;
  };
  description?: string;
  username?: string;
  isPublished?: boolean;
}

interface PaginationDetails {
  totalItems: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  nextPage: number;
  prevPage: number;
}

interface VtuberApiResponse {
  data: VtuberProfile[];
  paginationDetails?: PaginationDetails;
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
            "Usage: npm run data:v-sai [--limit <n>]",
            "",
            "  --limit <n>  page size for the ConnectRPC listing API",
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

async function fetchPage(offset: number, size: number): Promise<VtuberApiResponse | null> {
  try {
    const res = await fetch(
      "https://api.v-sai.com/api.vtubers.v1.VtuberProfilesService/GetAllVtuberProfiles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ offset, size }),
      },
    );
    if (!res.ok) {
      console.error(`  fetch failed: HTTP ${res.status} at offset ${offset}`);
      return null;
    }
    return (await res.json()) as VtuberApiResponse;
  } catch (err) {
    console.error(`  fetch failed at offset ${offset}:`, (err as Error).message);
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pageSize = options.limit ?? 100;

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const allProfiles: VtuberProfile[] = [];
  let offset = 0;
  let pageNum = 1;
  const MAX_PAGES = 100; // Safety limit to prevent infinite loops

  while (true) {
    console.log(`v-sai: fetching page ${pageNum} (offset ${offset}, limit ${pageSize})`);
    const page = await fetchPage(offset, pageSize);

    if (!page) {
      console.error(`v-sai: API request failed at offset ${offset}, stopping`);
      break;
    }

    const pageData = page.data || [];
    if (pageData.length === 0) {
      console.log("v-sai: no more items returned, stopping");
      break;
    }

    allProfiles.push(...pageData);
    console.log(
      `v-sai: page ${pageNum}: got ${page.data.length} items (total so far: ${allProfiles.length})`,
    );

    // Check if we've reached the user limit
    if (options.limit && allProfiles.length >= options.limit) {
      console.log(`reached limit of ${options.limit} entries`);
      allProfiles.length = options.limit;
      break;
    }

    // Check pagination details to see if there's more
    const { paginationDetails } = page;
    if (!paginationDetails) {
      console.log("v-sai: no pagination info in response, checking if we got fewer than pageSize items");
      if (page.data.length < pageSize) {
        console.log("v-sai: got fewer items than page size, assuming last page");
        break;
      }
    } else {
      const { totalItems, totalPages } = paginationDetails;
      console.log(`v-sai: pagination totalItems=${totalItems} totalPages=${totalPages} currentPage=${paginationDetails.currentPage}`);

      // If we've reached or passed totalItems, we're done
      if (totalItems > 0 && allProfiles.length >= totalItems) {
        console.log(`v-sai: reached totalItems (${totalItems}), stopping`);
        break;
      }
      if (paginationDetails.totalPages && pageNum >= paginationDetails.totalPages) {
        console.log(`v-sai: reached totalPages (${totalPages}), stopping`);
        break;
      }
    }

    offset += pageSize;
    pageNum++;

    if (pageNum > MAX_PAGES) {
      console.log(`reached max page limit (${MAX_PAGES}), stopping`);
      break;
    }
  }

  console.log(`v-sai: harvested ${allProfiles.length} total profiles before filtering`);

  // Filter to profiles that have a YouTube link (the dataset keys VTubers by YouTube id)
  const withYoutube = allProfiles.filter(
    (p) => p.socialMediaLinks?.youtube,
  );

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "v-sai.com",
    count: allProfiles.length,
    youtubeCount: withYoutube.length,
    data: allProfiles,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `v-sai: ${allProfiles.length} profile(s) harvested (${withYoutube.length} with YouTube links) → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});