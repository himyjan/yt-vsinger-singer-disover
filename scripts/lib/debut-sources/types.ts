/**
 * Debut discovery sources.
 *
 * A "debut source" produces candidate performers that may be new to the
 * dataset. Sources are best-effort: an unreachable or changed API degrades to
 * "no candidates" rather than failing the run.
 */

import type { Candidate } from "../identity";

export interface DebutSource {
  /** Stable id used in logs and in the registry's `sources` field. */
  id: string;
  /** Display name. */
  label: string;
  /** True when the source has everything it needs to run. */
  isConfigured(): boolean;
  /** Why the source is unavailable, when it is. */
  unavailableReason?(): string | null;
  /**
   * Fetches candidates.
   * @param since Only return candidates first seen after this ISO date.
   */
  fetch(since: string | null): Promise<Candidate[]>;
}
