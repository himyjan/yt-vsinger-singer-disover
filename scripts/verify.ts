#!/usr/bin/env tsx
/**
 * Verifies the dataset with web search grounding.
 *
 * The keyword classifier is fast and free but wrong often enough to matter.
 * This script asks a search-grounded model to check each uncertain channel
 * and writes the answers as **overrides** into `data/overrides.json` — so a
 * verification run is reviewable in a diff, and a wrong answer can be undone
 * by deleting one entry.
 *
 * ```bash
 * npm run data:verify -- --limit 40
 * npm run data:verify -- --confidence 0.5 --min-confidence 0.8
 * npm run data:verify -- --dry-run
 * npm run data:verify -- --id UCxxxxxxxxxxxxxxxxxxxxxx
 * ```
 *
 * Requires `GEMINI_API_KEY` (the free tier is enough — the default model is
 * `gemini-2.5-flash`).
 */

import path from "node:path";
import { ROOT, readJson, writeJson } from "./lib/io";
import { layout, readAllChannelRecords } from "./lib/dataset";
import { Verifier, type VerificationResult } from "./lib/verify";
import type { Channel, ChannelFile, ItemFile } from "./lib/types";
import { SCHEMA_VERSION } from "./lib/types";

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface Args {
  limit: number;
  maxConfidence: number;
  minConfidence: number;
  dryRun: boolean;
  noSearch: boolean;
  model: string;
  delayMs: number;
  ids: string[];
  includeAggregatorCandidates: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 25,
    maxConfidence: 1,
    minConfidence: 0.7,
    dryRun: false,
    noSearch: false,
    model: "gemini-2.5-flash",
    delayMs: 1200,
    ids: [],
    includeAggregatorCandidates: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--confidence") args.maxConfidence = Number(argv[++i]);
    else if (a === "--min-confidence") args.minConfidence = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-search") args.noSearch = true;
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--delay") args.delayMs = Number(argv[++i]);
    else if (a === "--id") args.ids.push(argv[++i]);
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* Override file                                                              */
/* -------------------------------------------------------------------------- */

interface Override {
  kind?: string;
  role?: string;
  region?: string;
  agency?: string | null;
  gender?: string;
  isAi?: boolean;
  isSinging?: boolean;
  hidden?: boolean;
  /** Who verified it, and when. */
  verifiedBy?: string;
  verifiedAt?: string;
  /** Why the correction was made. */
  note?: string;
}

type OverrideMap = Record<string, Override>;

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) {
    console.error(
      "[verify] GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey.",
    );
    process.exit(1);
  }

  /* --- load the dataset ------------------------------------------------ */
  const channels: Channel[] = readAllChannelRecords();

  const overrides: OverrideMap = readJson<OverrideMap>(layout.overrides, {});

  /* --- pick the candidates ---------------------------------------------- */
  let candidates = channels.filter((c) => {
    if (args.ids.length) return args.ids.includes(c.id);
    if (c.source === "seed") return false; // already curated by hand
    if (c.confidence > args.maxConfidence) return false;
    if (overrides[c.id]?.verifiedAt) return false; // already verified
    return true;
  });

  // The ones the classifier is least sure about go first.
  candidates.sort((a, b) => a.confidence - b.confidence);
  candidates = candidates.slice(0, args.limit);

  console.log(
    `[verify] ${channels.length} channels · ${candidates.length} to verify · model ${args.model}${args.noSearch ? " (no search)" : ""}`,
  );
  if (!candidates.length) {
    console.log("[verify] nothing to do");
    return;
  }

  const verifier = new Verifier({
    apiKey,
    model: args.model,
    minConfidence: args.minConfidence,
    useSearch: !args.noSearch,
    delayMs: args.delayMs,
    onLog: (m) => console.log(m),
  });

  const results: VerificationResult[] = [];
  let changed = 0;

  for (const [index, channel] of candidates.entries()) {
    console.log(
      `[verify] ${index + 1}/${candidates.length} ${channel.name} ` +
        `(${channel.kind}/${channel.role}/${channel.region}, conf ${channel.confidence.toFixed(2)})`,
    );

    const result = await verifier.verify({
      id: channel.id,
      name: channel.name,
      handle: channel.handle,
      description: channel.description,
      tags: channel.tags,
      current: {
        kind: channel.kind,
        role: channel.role,
        region: channel.region,
        gender: channel.gender,
        isAi: channel.isAi,
        confidence: channel.confidence,
      },
    });

    if (!result) {
      await verifier.throttle();
      continue;
    }
    results.push(result);

    const override = verifier.toOverride(result, {
      kind: channel.kind,
      role: channel.role,
      region: channel.region,
      gender: channel.gender,
      isAi: channel.isAi,
      confidence: channel.confidence,
    });

    if (override) {
      changed++;
      console.log(
        `  ✓ ${JSON.stringify(override)}` +
          (result.sources.length ? `\n    sources: ${result.sources.slice(0, 2).join(", ")}` : "") +
          (result.reasoning ? `\n    ${result.reasoning}` : ""),
      );
      if (!args.dryRun) {
        overrides[channel.id] = {
          ...override,
          verifiedBy: args.model,
          verifiedAt: new Date().toISOString(),
          note: result.reasoning.slice(0, 200),
        };
      }
    } else {
      console.log(
        `  · no change (confidence ${result.confidence.toFixed(2)}${
          result.confidence < args.minConfidence ? ", below the threshold" : ""
        })`,
      );
    }

    await verifier.throttle();
  }

  if (!args.dryRun && changed > 0) {
    writeJson(layout.overrides, overrides);
    console.log(`[verify] wrote ${changed} correction(s) to data/overrides.json`);
  } else if (args.dryRun) {
    console.log(`[verify] dry run — ${changed} correction(s) would be written`);
  } else {
    console.log("[verify] no corrections needed");
  }

  console.log(
    `[verify] ${results.length} verified, ${results.filter((r) => r.isAggregator).length} aggregator(s), ` +
      `${results.filter((r) => r.isAi).length} AI`,
  );
  console.log(
    "[verify] next: npm run data:sync -- --no-search && npm run data:index && npm run data:validate",
  );
}

main().catch((err) => {
  console.error("[verify] fatal:", err);
  process.exit(1);
});
