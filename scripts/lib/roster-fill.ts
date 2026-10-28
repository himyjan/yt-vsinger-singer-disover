/**
 * Filling a field of a **tracked** record from the roster that knows it.
 *
 * Every roster importer ends up with the same second job: the channels it
 * *imported* came from a profile, but the channels it only *matched* already
 * exist, and the roster still knows something about them the profile does not
 * publish — a Twitch handle, a debut date, the country it files the performer
 * under. vtuber.hk fills counts, hololist and bacharu fill links.
 *
 * Reading, editing and writing the whole catalogue is the same work in every
 * case, so it lives here: `applyChannelEdits()` takes the edits, takes the run
 * lock, **re-reads the dataset** (the report that planned the edits ran
 * outside the lock, and a sync may have written in between), applies each edit
 * to the record on disk, and writes the shards and the manifests once.
 *
 * An edit returns whether it changed anything, because a record that already
 * has the value is not a diff. Nothing here decides *which* value wins: the
 * caller does, and every caller fills an empty field only.
 */

import {
  readAllChannelRecords,
  rebuildChannelsManifest,
  refreshManifestChannelCounts,
  writeChannelShards,
} from "./dataset";
import { acquireRunLock } from "./io";
import type { Channel } from "./types";

export interface ChannelEdit {
  /** The record's id — the dataset's key, not the roster's. */
  id: string;
  /** Applies the value, and answers `true` when the record changed. */
  update: (channel: Channel) => boolean;
}

/**
 * Applies the edits and writes once.
 *
 * Returns how many records changed — zero is a normal answer, and it writes
 * nothing at all in that case: a run that fills an already-filled field must
 * not touch the shards, or every no-op pass becomes a commit.
 */
export function applyChannelEdits(
  edits: ChannelEdit[],
  lock: string,
  at: string,
): number {
  if (!edits.length) return 0;
  const release = acquireRunLock(lock);
  try {
    const all = readAllChannelRecords();
    const fresh = new Map(all.map((channel) => [channel.id, channel]));
    let written = 0;
    for (const edit of edits) {
      const channel = fresh.get(edit.id);
      if (!channel) continue;
      if (edit.update(channel)) written++;
    }
    if (written) {
      writeChannelShards(all, at);
      rebuildChannelsManifest(all, at);
      refreshManifestChannelCounts(all, at);
    }
    return written;
  } finally {
    release();
  }
}
