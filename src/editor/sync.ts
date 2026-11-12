// Which copy of the booklet an editor opens with, and what it then saves:
// pure decisions, kept apart from React so they can be tested
// (tools/verify-sync.ts).
//
// Two copies exist. The server's, with its stamp (X-Saved-At, server/index.ts),
// and this browser's (IndexedDB, cache.ts): the booklet as last shown here,
// the stamp of the server copy it was based on, and whether it holds changes
// the server has not confirmed (`dirty`: set on every change, cleared only by
// a save that went through).

export interface LocalCopy<T> {
  value: T;
  /** Stamp of the server copy this one started from (0: none). */
  basedOn: number;
  /** Changes made here that no save has confirmed yet. */
  dirty: boolean;
}
export interface RemoteCopy<T> {
  value: T | null;
  savedAt: number;
}

export type Choice =
  /** Open the server's copy (this browser's is replaced by it). */
  | { use: 'remote' }
  /** Open this browser's copy and save it: `normal` over the server's
   * current copy, or `restore` (handed back under its own stamp, to a server
   * that lost it). */
  | { use: 'local'; save: 'normal' | 'restore' | null }
  /** Both changed: this browser's unsaved edits started from an older copy
   * than the server now holds. Only the person can say which to keep. */
  | { use: 'ask' }
  /** Neither has one: a fresh booklet. */
  | { use: 'none' };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function chooseCopy<T>(local: LocalCopy<T> | undefined, remote: RemoteCopy<T>): Choice {
  if (!local) return remote.value ? { use: 'remote' } : { use: 'none' };
  // The server has none: a server without durable storage lost it (or it was
  // never saved). This browser's copy goes back.
  if (!remote.value) return { use: 'local', save: local.dirty || !local.basedOn ? 'normal' : 'restore' };
  // Already the same (a save sent as the page closed went through).
  if (same(local.value, remote.value)) return { use: 'remote' };
  if (local.dirty) {
    // Edits made on top of the server's current copy (or of a newer one it
    // lost): they win and are saved.
    if (local.basedOn >= remote.savedAt) return { use: 'local', save: 'normal' };
    return { use: 'ask' };
  }
  // Nothing unsaved here: the newer copy wins. A server holding an older copy
  // than this browser saw lost the newer one, which goes back.
  if (local.basedOn > remote.savedAt) return { use: 'local', save: 'restore' };
  return { use: 'remote' };
}

/** A new session opens on today's date, unless the booklet is already set
 * for a later day (tomorrow's booklet, prepared tonight). */
export const sessionDate = (stored: string | undefined, today: string) => (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored) && stored >= today ? stored : today);

/** Pause before the next try of a save that failed (`failures` so far). */
export const retryDelay = (failures: number) => Math.min(60_000, 2000 * 2 ** Math.max(0, failures - 1));
