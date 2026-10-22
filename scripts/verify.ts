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
 * npm run data:verify -- --min-confidence 0.8
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
import {
  COUNTRY_TO_REGION,
  lookupByChannelId,
  lookupByName,
  wikipediaSummary,
  wikidataUrl,
} from "./lib/wikidata";
import type { Channel, ChannelFile, ItemFile, Verification } from "./lib/types";
import { SCHEMA_VERSION } from "./lib/types";

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface Args {
  limit: number;
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
  /** A human-written description of the performer. */
  description?: string;
  /** A verified avatar URL, e.g. the Wikipedia infobox image. */
  avatar?: string;
  /** The verification record — what was looked up, and where. */
  verification?: Verification;
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

  /**
   * The API key is optional.
   *
   * Wikidata and Wikipedia need no key and no model — they are the
   * authoritative sources, and they answer most of the questions. The
   * search-grounded model is the fallback for the performers neither of them
   * covers, and it is only used when a key is available.
   */
  if (!apiKey) {
    console.log(
      "[verify] GEMINI_API_KEY is not set — using Wikidata and Wikipedia only.",
    );
  }

  /* --- load the dataset ------------------------------------------------ */
  const channels: Channel[] = readAllChannelRecords();

  const overrides: OverrideMap = readJson<OverrideMap>(layout.overrides, {});

  /* --- pick the candidates ---------------------------------------------- */
  /**
   * The verification queue.
   *
   * There is no confidence score to sort by, and that is the point: the
   * queue is ordered by **what is not known**. A record with an unknown
   * region is worth checking; a record that was already verified in
   * Wikidata is not.
   */
  const missingFacts = (channel: Channel): string[] => {
    const missing: string[] = [];
    if (channel.region === "unknown") missing.push("region");
    if (channel.role === "unknown") missing.push("role");
    if (channel.gender === "unknown") missing.push("gender");
    if (!channel.description) missing.push("description");
    if (!channel.agency && channel.affiliation === "unknown") {
      missing.push("affiliation");
    }
    return missing;
  };

  let candidates = channels.filter((c) => {
    if (args.ids.length) return args.ids.includes(c.id);
    if (c.source === "seed") return false; // already curated by hand
    if (overrides[c.id]?.verifiedAt) return false; // already verified
    return true;
  });

  // The records that are missing the most come first; the confidence
  // estimate breaks the tie between records that are equally incomplete.
  candidates.sort((a, b) => {
    const byMissing = missingFacts(b).length - missingFacts(a).length;
    if (byMissing !== 0) return byMissing;
    return (
      (a.confidence?.overall ?? 1) - (b.confidence?.overall ?? 1)
    );
  });
  candidates = candidates.slice(0, args.limit);

  console.log(
    `[verify] ${channels.length} channels · ${candidates.length} to verify · model ${args.model}${args.noSearch ? " (no search)" : ""}`,
  );
  if (!candidates.length) {
    console.log("[verify] nothing to do");
    return;
  }

  const verifier = apiKey
    ? new Verifier({
        apiKey,
        model: args.model,
        minConfidence: args.minConfidence,
        useSearch: !args.noSearch,
        delayMs: args.delayMs,
        onLog: (m) => console.log(m),
      })
    : null;

  const results: VerificationResult[] = [];
  let changed = 0;
  let wikidataChecked = 0;

  for (const [index, channel] of candidates.entries()) {
    const missing = missingFacts(channel);
    console.log(
      `[verify] ${index + 1}/${candidates.length} ${channel.name} ` +
        `(${channel.kind}/${channel.role}/${channel.region}` +
        `${missing.length ? `, missing ${missing.join("/")}` : ""})`,
    );

    /**
     * Wikidata first.
     *
     * A Wikidata item whose YouTube channel id matches the record is a
     * *fact*, not an estimate: the two ids are the same performer, stated in
     * a curated knowledge base. It is cheaper, more precise and more
     * defensible than asking a model to guess — and the Wikipedia extract
     * gives a real, human-written description.
     */
    const wikidata =
      (channel.id.startsWith("UC")
        ? await lookupByChannelId(channel.id)
        : null) ?? (await lookupByName(channel.name));

    if (wikidata) {
      wikidataChecked++;
      const identity = wikidata.identity;
      const summary = identity.article
        ? await wikipediaSummary(identity.article)
        : null;

      const override: Record<string, unknown> = {};
      const checked: string[] = [];
      const sources: string[] = [wikidataUrl(identity.id)];

      if (identity.agency && identity.agency !== channel.agency) {
        override.agency = identity.agency;
        checked.push("affiliation");
      }
      if (identity.gender && identity.gender !== channel.gender) {
        override.gender = identity.gender;
        checked.push("gender");
      }
      if (identity.country) {
        const region = COUNTRY_TO_REGION[identity.country.toLowerCase()];
        if (region && region !== channel.region) {
          override.region = region;
          checked.push("region");
        }
      }
      /**
       * Only use the Wikipedia text and image when the article is actually
       * about the *performer*.
       *
       * A Wikipedia article about a person who later became a VTuber often
       * leads with their pre-fame career — "Japanese former pornographic
       * actress" — and its infobox image is a photograph of them. Neither is
       * an appropriate description or avatar for a VTuber record, so the
       * article has to be about the virtual performer before any of it is
       * used.
       */
      const isPerformerArticle =
        /vtuber|virtual\s+(youtuber|idol|streamer|singer)|v-singer/i.test(
          [
            summary?.description ?? "",
            summary?.extract ?? "",
            identity.description ?? "",
          ].join(" "),
        );

      if (isPerformerArticle && summary?.description) {
        override.description = summary.description;
        checked.push("description");
        sources.push(summary.url ?? "");
      }
      if (isPerformerArticle && summary?.image) {
        // The Wikipedia infobox portrait is a good channel avatar — but only
        // when the article is about the performer.
        override.avatar = summary.image;
        checked.push("description");
      }

      const verified: Verification = {
        status: checked.length ? "verified" : "verified",
        source: summary ? "wikipedia" : "wikidata",
        checked: checked as Verification["checked"],
        confidence: wikidata.matchedBy === "channel" ? 1 : 0.7,
        at: new Date().toISOString(),
        sources: sources.filter(Boolean),
        note: [
          identity.label,
          identity.description ?? summary?.description ?? null,
          identity.agency ? `affiliated with ${identity.agency}` : null,
        ]
          .filter(Boolean)
          .join(" — "),
      };

      if (Object.keys(override).length) {
        changed++;
        console.log(
          `  ✓ wikidata ${identity.id}: ${JSON.stringify(override)}` +
            `\n    ${verified.note}`,
        );
        if (!args.dryRun) {
          overrides[channel.id] = {
            ...overrides[channel.id],
            ...override,
            verification: verified,
            verifiedBy: `wikidata:${identity.id}`,
            verifiedAt: verified.at,
            note: verified.note,
          };
        }
      } else {
        console.log(
          `  ✓ wikidata ${identity.id} confirms the record` +
            (verified.note ? `\n    ${verified.note}` : ""),
        );
        if (!args.dryRun) {
          overrides[channel.id] = {
            ...overrides[channel.id],
            verification: verified,
            verifiedBy: `wikidata:${identity.id}`,
            verifiedAt: verified.at,
            note: verified.note,
          };
        }
      }
      if (verifier) await verifier.throttle();
      continue;
    }

    // No Wikidata item — fall back to the search-grounded model.
    if (!verifier) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
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
        confidence: 1,
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
      confidence: 1,
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
    `[verify] ${results.length} verified by search, ${wikidataChecked} verified by Wikidata, ` +
      `${results.filter((r) => r.isAggregator).length} aggregator(s), ` +
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
