/**
 * Per-tab capture ring buffer — the single definition of the `since` / `limit`
 * read semantics that both read tools (readConsoleMessages / readNetworkRequests)
 * and the service-worker capture store rely on.
 *
 * Why a pure data structure with no Chrome dependency:
 *
 *   - The two read tools answer "what happened since the caller last looked".
 *     That only works if there is exactly one carefully tested definition of the
 *     cursor arithmetic, the wrap-around behaviour, and what happens when the
 *     caller's cursor is stale. Keeping it dependency-free means it is
 *     exhaustively unit-testable in Node before any browser glue exists.
 *
 * Cursor model:
 *
 *   - Every `push` stamps the entry with a monotonic `seq` starting at 1. A
 *     `seq` is never reused for the life of the buffer, including across
 *     wrap-around and across `clear()` (clear empties the entries but does not
 *     rewind the counter).
 *   - `read({ since, limit })` returns the entries with `seq > since`, ascending,
 *     at most `limit` of them. `nextSince` is the `seq` of the last returned
 *     entry, or the caller's `since` when nothing new matched. Reads never
 *     mutate the buffer.
 *   - `dropped` is true when the oldest still-retained entry has a `seq` greater
 *     than `since + 1` — i.e. the ring overwrote entries the caller never saw.
 *   - `truncated` is true only when strictly more entries matched than `limit`
 *     returned (a match count exactly equal to `limit` is NOT truncation).
 *
 * Stale cursor rule:
 *
 *   A `since` greater than the newest `seq` is treated as `0` (a full window),
 *   never as an error and never as a permanently empty window. This happens when
 *   the MV3 service worker was suspended and restarted: the in-memory buffers
 *   and their `seq` counter reset to zero while a caller still holds a large
 *   `since` from before the restart. Resetting such a `since` to `0` lets the
 *   caller immediately see everything currently held instead of being stuck with
 *   an empty window forever. A `since` exactly equal to the newest `seq` is NOT
 *   stale — it stays an empty read.
 */

/** Default ring capacity when `createCaptureRing` is called with no argument. */
export const DEFAULT_MAX_ENTRIES = 500;

/** Default page size a read tool applies when the caller passes no `limit`. */
export const DEFAULT_READ_LIMIT = 100;

/** Hard ceiling on a single read's `limit`, clamped inside `read`. */
export const MAX_READ_LIMIT = 500;

/** The result of one non-destructive `read` against a capture ring. */
export interface CaptureRead<T> {
  /** Matching entries, ascending by `seq`, at most `limit` of them. */
  readonly entries: ReadonlyArray<T & { seq: number }>;
  /** The cursor to pass as `since` on the next read to get only newer entries. */
  readonly nextSince: number;
  /** True when the ring overwrote entries the caller's `since` never covered. */
  readonly dropped: boolean;
  /** True when strictly more entries matched than were returned. */
  readonly truncated: boolean;
}

/** A bounded, sequence-stamped, non-destructively readable ring of entries. */
export interface CaptureRing<T> {
  /** Append an entry; returns the monotonic `seq` assigned to it. */
  push(entry: T): number;
  /** Non-destructive window read; see {@link CaptureRead}. */
  read(query: { since: number; limit: number }): CaptureRead<T>;
  /** Number of entries currently retained (never exceeds `maxEntries`). */
  size(): number;
  /** Drop every retained entry; does NOT rewind the `seq` counter. */
  clear(): void;
}

function normalizeSince(since: number): number {
  // A non-integer, negative or NaN cursor is meaningless — read from the start.
  if (!Number.isInteger(since) || since < 0) return 0;
  return since;
}

function normalizeLimit(limit: number): number {
  // Policy: a non-positive or non-integer limit yields an empty page; a limit
  // above the exported ceiling is clamped down to it. Never throws.
  if (!Number.isInteger(limit) || limit <= 0) return 0;
  return Math.min(limit, MAX_READ_LIMIT);
}

/**
 * Create a bounded ring buffer holding at most `maxEntries` entries (default
 * {@link DEFAULT_MAX_ENTRIES}). Uses a push/shift pair rather than a fixed
 * modulo-indexed array so there are never `undefined` holes to narrow away.
 *
 * @throws RangeError when `maxEntries` is not a positive integer.
 */
export function createCaptureRing<T extends object>(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): CaptureRing<T> {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      `createCaptureRing: maxEntries must be a positive integer, got ${String(maxEntries)}`,
    );
  }

  // Entries are held in ascending `seq` order at all times: push appends to the
  // end, shift removes the oldest from the front once capacity is exceeded.
  const buf: Array<T & { seq: number }> = [];
  let counter = 0;

  return {
    push(entry: T): number {
      counter += 1;
      const stamped = { ...entry, seq: counter };
      buf.push(stamped);
      if (buf.length > maxEntries) {
        buf.shift();
      }
      return counter;
    },

    read(query: { since: number; limit: number }): CaptureRead<T> {
      const limit = normalizeLimit(query.limit);
      let since = normalizeSince(query.since);

      const newestSeq = counter;
      // Stale cursor (e.g. after a service-worker restart rewound the counter):
      // a since past the newest seq becomes a full window. Equal-to-newest is
      // not stale and stays an empty read.
      if (since > newestSeq) {
        since = 0;
      }

      const matched = buf.filter((e) => e.seq > since);
      const entries = matched.slice(0, limit);
      const truncated = matched.length > entries.length;

      const lastReturned = entries[entries.length - 1];
      const nextSince = lastReturned === undefined ? since : lastReturned.seq;

      const oldestRetained = buf[0];
      const dropped =
        oldestRetained !== undefined && oldestRetained.seq > since + 1;

      return { entries, nextSince, dropped, truncated };
    },

    size(): number {
      return buf.length;
    },

    clear(): void {
      buf.length = 0;
    },
  };
}
