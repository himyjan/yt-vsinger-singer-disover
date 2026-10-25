#!/usr/bin/env tsx
/**
 * Discovers performers and records them in the identity registry.
 *
 * The debut sources (`scripts/lib/debut-sources/`) each publish "performers we
 * have not seen before" in their own shape — a wiki infobox, a directory
 * listing. This script runs them, feeds every candidate through
 * `IdentityRegistry.upsert()`, and writes `data/identities.json`.
 *
 * The registry is the discovery database the project documents: it keys a
 * performer by every strong identity a source knows (YouTube channel id,
 * handle, X handle, wiki page), merges records that share one, and keeps the
 * alternative names so one performer is reachable under every name they are
 * known by.
 *
 * A directory entry is a name, not a record — it carries no channel id. With
 * `--promote` the runner also resolves each name to its YouTube channel and
 * adds the ones that pass the virtual-and-singing gate in
 * `scripts/lib/discovery-evidence.ts` (the same two-video rule the sync
 * applies to a discovered channel), through `importYouTubeChannels()`.
 *
 *   npm run data:discover
 *   npm run data:discover -- --source all --pages 50
 *   npm run data:discover -- --promote
 *   npm run data:discover -- --dry-run
 *
 * vTubie is read through a real browser (their directory is behind a
 * Cloudflare challenge and has no API); `puppeteer-core` is an optional
 * dependency, so a checkout without it simply discovers nothing from that
 * source and says so.
 */

import { acquireRunLock } from "./lib/io";
import { IdentityRegistry, identityPath } from "./lib/identity";
import type { Candidate } from "./lib/identity";
import { promoteCandidates } from "./lib/promote-candidates";
import { FandomSource } from "./lib/debut-sources/fandom";
import { VtubieSource } from "./lib/debut-sources/vtubie";
import type { DebutSource } from "./lib/debut-sources/types";

interface Options {
  /** `vtubie`, `fandom`, or `all`. */
  source: string;
  /** Directory pages to read (vTubie). */
  pages: number;
  /** Only candidates first seen after this ISO date, when a source knows it. */
  since: string | null;
  /** Report without writing. */
  dryRun: boolean;
  /** Stop after this many candidates, across every source. */
  limit: number | null;
  /** Resolve the candidates to channels and add the ones the gate passes. */
  promote: boolean;
  /** How many candidates one promotion run may resolve. */
  promoteLimit: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    source: "vtubie",
    pages: 20,
    since: null,
    dryRun: false,
    limit: null,
    promote: false,
    promoteLimit: 25,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--source":
        options.source = (value ?? options.source).toLowerCase();
        i++;
        break;
      case "--pages":
        options.pages = Math.max(1, Number(value ?? options.pages));
        i++;
        break;
      case "--since":
        options.since = value ?? null;
        i++;
        break;
      case "--limit":
        options.limit = Math.max(1, Number(value ?? 1));
        i++;
        break;
      case "--promote":
        options.promote = true;
        break;
      case "--promote-limit":
        options.promoteLimit = Math.max(1, Number(value ?? options.promoteLimit));
        i++;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run data:discover -- [options]",
            "",
            "  --source <vtubie|fandom|all>  which sources to run (default vtubie)",
            "  --pages <n>                   directory pages to read (default 20)",
            "  --since <ISO date>            only candidates first seen after this date",
            "  --limit <n>                   stop after n candidates",
            "  --promote                     add the candidates that pass the",
            "                                virtual + singing gate to data/channels",
            "  --promote-limit <n>           how many names to resolve (default 25)",
            "  --dry-run                     read and report, write nothing",
          ].join("\n"),
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

function log(message: string): void {
  console.log(message);
}

/** Builds the sources the run asked for. */
function sourcesFor(options: Options): DebutSource[] {
  const wantAll = options.source === "all";
  const sources: DebutSource[] = [];

  if (wantAll || options.source === "vtubie") {
    sources.push(
      new VtubieSource({
        maxPages: options.pages,
        onLog: (message) => log(`  ${message}`),
      }),
    );
  }
  if (wantAll || options.source === "fandom") {
    sources.push(new FandomSource());
  }
  if (!sources.length) {
    console.error(
      `unknown source: ${options.source} (expected vtubie, fandom, or all)`,
    );
    process.exit(1);
  }
  return sources;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const release = acquireRunLock("discover");

  try {
    const registry = IdentityRegistry.loadFromDisk();
    const startedWith = registry.size;
    /**
     * Every upsert stamps `updatedAt`, so a rerun that finds what the registry
     * already knows would still rewrite the file. The snapshot lets the run
     * tell a real change from a timestamp and leave `data/` alone when there
     * is nothing new to say.
     */
    const before = new Map(
      registry.all.map((record) => [record.id, comparable(record)]),
    );
    let candidates = 0;
    const added: string[] = [];
    /** Everything the sources named, for `--promote`. */
    const pool: Candidate[] = [];

    for (const source of sourcesFor(options)) {
      if (!source.isConfigured()) {
        const reason = source.unavailableReason?.() ?? "not configured";
        log(`discover: ${source.label} — skipped (${reason})`);
        continue;
      }

      log(`discover: ${source.label}`);
      const found = await source.fetch(options.since);
      log(`discover: ${source.label} → ${found.length} candidates`);
      if (!found.length) continue;

      for (const candidate of found) {
        if (options.limit !== null && candidates >= options.limit) break;
        const outcome = registry.upsert(candidate);
        candidates++;
        pool.push(candidate);
        if (outcome.kind === "new") {
          added.push(
            `${outcome.record.id}  ${outcome.record.names.join(" / ") || "(unnamed)"}`,
          );
        }
      }
    }

    const grew = registry.size - startedWith;
    log(
      `discover: ${candidates} candidates · ${grew} new identities · ` +
        `${registry.size} known`,
    );

    if (added.length) {
      log("discover: new identities");
      for (const line of added.slice(0, 40)) log(`  ${line}`);
      if (added.length > 40) log(`  … and ${added.length - 40} more`);
    }

    if (options.promote) {
      if (options.dryRun) {
        log("discover: --promote writes channels, so it is skipped under --dry-run");
      } else {
        await promoteAndReport(pool, options);
      }
    }

    if (options.dryRun) {
      log(`discover: --dry-run, ${identityPath} left untouched`);
      return;
    }
    const changed = registry.all.some(
      (record) => before.get(record.id) !== comparable(record),
    );
    if (!changed) {
      log("discover: nothing changed, the registry is untouched");
      return;
    }

    registry.save();
    log(`discover: wrote ${identityPath}`);
  } finally {
    release();
  }
}

/**
 * Resolves the pooled candidates to channels and imports the ones the
 * virtual-and-singing gate accepts.
 */
async function promoteAndReport(
  pool: Candidate[],
  options: Options,
): Promise<void> {
  const outcome = await promoteCandidates(
    pool.map((candidate) => ({
      name: candidate.name ?? null,
      source: candidate.source,
    })),
    {
      limit: options.promoteLimit,
      onLog: (message) => log(`  ${message}`),
    },
  );

  log(
    `discover: promotion — ${outcome.considered} names · ` +
      `${outcome.added.length} added · ${outcome.existing} already known · ` +
      `${outcome.rejected.length} rejected · ${outcome.failed.length} failed`,
  );
  for (const rejected of outcome.rejected.slice(0, 20)) {
    log(`  rejected ${rejected.name}: ${rejected.reason}`);
  }
  for (const failed of outcome.failed.slice(0, 10)) {
    log(`  failed ${failed.name}: ${failed.reason}`);
  }
}

/** A record with the fields a rerun always rewrites removed. */
function comparable(record: { id: string; updatedAt: string }): string {
  return JSON.stringify({ ...record, updatedAt: null });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
