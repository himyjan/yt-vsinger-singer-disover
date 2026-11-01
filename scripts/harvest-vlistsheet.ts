#!/usr/bin/env tsx
/**
 * Harvest VTuber channels from the VLIST Google Sheets spreadsheet.
 *
 * https://docs.google.com/spreadsheets/d/1Zsc_Ray2d5b7rtgbGcznlHiM4KFDDD9VJZofX_WQBio/edit?gid=1800837790#gid=1800837790
 *
 * This is a one-time harvest of an unmaintained spreadsheet. The sheet
 * (VLIST v1.8) documents English-speaking VTubers with name, Twitter,
 * Twitch, YouTube channel URL, debut date, gender, country, languages,
 * tags, and other metadata. Because the sheet is no longer maintained,
 * this is a one-time import — there is no scheduled workflow for it.
 *
 *   npm run data:vlistsheet              # harvest the spreadsheet
 *   npm run data:vlistsheet-import       # report what would be imported
 *   npm run data:vlistsheet-import -- --apply  # import the new channels
 *
 * Nothing here writes data/ — adding the channels is a separate step
 * through npm run data:vlistsheet-import.
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_URL =
  "https://docs.google.com/spreadsheets/d/1Zsc_Ray2d5b7rtgbGcznlHiM4KFDDD9VJZofX_WQBio/export?gid=1800837790&format=csv";
const CACHE_DIR = ".cache/vlistsheet";
const OUT_PATH = path.join(CACHE_DIR, "vlistsheet.json");

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
            "Usage: npm run data:vlistsheet [--limit <n>]",
            "",
            "  --limit <n>  stop after n rows in this pass",
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

/** Parse a single CSV line respecting quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      fields.push(field);
      if (i < line.length && line[i] === ",") i++; // skip comma
    } else {
      // Unquoted field
      const end = line.indexOf(",", i);
      if (end < 0) {
        fields.push(line.slice(i));
        i = line.length;
      } else {
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
  }
  return fields;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`vlistsheet: fetching ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent": "yt-vsinger-singer-tracker/1.0 (dataset builder)",
      Accept: "text/csv",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.error(
      `vlistsheet: HTTP ${res.status} — leaving previous cache untouched`,
    );
    process.exit(0);
  }
  const text = await res.text();

  const lines = text.split("\n");
  if (lines.length < 3) {
    console.error("vlistsheet: no data rows — leaving previous cache untouched");
    process.exit(0);
  }

  // Parse header to find column indices
  const header = parseCsvLine(lines[1]);
  const colIndex: Record<string, number> = {};
  header.forEach((h, i) => {
    colIndex[h.trim()] = i;
  });

  console.log(`vlistsheet: header columns: ${header.join(", ")}`);

  const entries: Array<{
    name: string;
    youtubeUrl: string | null;
    twitterUrl: string | null;
    twitchUrl: string | null;
    debutDate: string | null;
    gender: string | null;
    country: string | null;
    languages: string | null;
    tags: string | null;
    region: string | null;
    ethnicity: string | null;
  }> = [];

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvLine(line);
    if (fields.length < 10) continue;

    const name = fields[2]?.trim() || "";
    if (!name || name.startsWith("#REF!")) continue;

    const youtubeUrl = fields[9]?.trim() || null;
    if (!youtubeUrl || !youtubeUrl.includes("youtube.com")) continue;

    const twitterUrl = fields[3]?.trim() || null;
    const twitchUrl = fields[6]?.trim() || null;
    const debutDate = fields[15]?.trim() || null;
    const gender = fields[20]?.trim() || null;
    const country = fields[23]?.trim() || null;
    const languages = fields[14]?.trim() || null;
    const tags = fields[12]?.trim() || null;
    const region = country;
    const ethnicity = fields[22]?.trim() || null;

    entries.push({
      name,
      youtubeUrl,
      twitterUrl,
      twitchUrl,
      debutDate,
      gender,
      country,
      languages,
      tags,
      region,
      ethnicity,
    });
  }

  if (options.limit) {
    entries.length = Math.min(entries.length, options.limit);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "vlistsheet",
    count: entries.length,
    data: entries,
    sourceUrl: SOURCE_URL,
    note:
      "One-time harvest of unmaintained VLIST v1.8 spreadsheet. Not refreshed on a schedule.",
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    `vlistsheet: ${entries.length} entr(y/ies) with YouTube URLs harvested → ${OUT_PATH}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
