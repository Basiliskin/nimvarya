/**
 * Per-tab capture store — the service worker's long-lived home for captured
 * console messages and network requests, and the intake glue that fills it
 * from the forwarder's runtime messages.
 *
 * Why it lives in the service worker:
 *
 *   The service worker is the only extension context that outlives a single
 *   page. Captured entries have to accumulate somewhere the read tools
 *   (readConsoleMessages / readNetworkRequests, added in the final phase) can
 *   query later, so the store holds one console ring and one network ring
 *   *per browser tab*. Keying by tab id means a chatty tab cannot pollute
 *   another tab's results, and closing a tab frees both of its rings.
 *
 * Trust boundary:
 *
 *   `installCaptureIntake`'s runtime-message listener is the second of the
 *   two points every inbound envelope is validated (the first is the
 *   forwarder's `message` listener). It re-checks `isCaptureEnvelope`,
 *   requires a real sender tab id, and `ingest` defensively re-applies the
 *   contract byte caps — a forged or oversize runtime message from a
 *   compromised content script must not reach a ring at full size or under a
 *   phantom tab key.
 *
 * No capture code touches the bridge-client outbox: delivery is pull-only,
 * so nothing here emits an observation frame.
 */

import {
  boundText,
  isCaptureEnvelope,
  MAX_BODY_PREVIEW_BYTES,
  MAX_CONSOLE_TEXT_BYTES,
} from "../protocol/capture.js";
import type {
  CaptureEnvelope,
  ConsoleEntry,
  NetworkEntry,
} from "../protocol/capture.js";
import { createCaptureRing } from "./capture-buffer.js";
import type { CaptureRead, CaptureRing } from "./capture-buffer.js";
import type { CapturePorts } from "./capture-ports.js";

/** The `since` / `limit` window a read tool forwards to the store unchanged. */
export interface CaptureQuery {
  readonly since: number;
  readonly limit: number;
}

/** A per-tab pair of rings, created lazily on that tab's first ingest. */
interface TabRings {
  readonly console: CaptureRing<ConsoleEntry>;
  readonly network: CaptureRing<NetworkEntry>;
}

/**
 * The per-tab capture store. Reads are non-destructive and reads of a tab
 * with no buffers (never seen, or already evicted) return an empty-but-valid
 * `CaptureRead` rather than throwing — the read-tool handlers serialise the
 * result directly.
 */
export interface CaptureStore {
  /** Route one validated envelope into the sending tab's matching ring. */
  ingest(tabId: number, envelope: CaptureEnvelope): void;
  /** Non-destructive window read of a tab's console ring. */
  readConsole(tabId: number, query: CaptureQuery): CaptureRead<ConsoleEntry>;
  /** Non-destructive window read of a tab's network ring. */
  readNetwork(tabId: number, query: CaptureQuery): CaptureRead<NetworkEntry>;
  /** Free both of a tab's rings; safe to call for a tab with no buffers. */
  evict(tabId: number): void;
}

function emptyRead<T>(): CaptureRead<T> {
  return { entries: [], nextSince: 0, dropped: false, truncated: false };
}

/** Re-bound a console entry's `text` to the contract cap, never trusting the sender. */
function reboundConsole(entry: ConsoleEntry): ConsoleEntry {
  const bounded = boundText(entry.text, MAX_CONSOLE_TEXT_BYTES);
  return {
    ...entry,
    text: bounded.text,
    truncated: entry.truncated || bounded.truncated,
  };
}

/** Re-bound a network entry's `bodyPreview` to the contract cap; `null` stays `null`. */
function reboundNetwork(entry: NetworkEntry): NetworkEntry {
  if (entry.bodyPreview === null) return entry;
  const bounded = boundText(entry.bodyPreview, MAX_BODY_PREVIEW_BYTES);
  return {
    ...entry,
    bodyPreview: bounded.text,
    truncated: entry.truncated || bounded.truncated,
  };
}

/**
 * Create a per-tab capture store. `maxEntries` (optional) is passed through to
 * every ring the store creates; omitting it uses the ring buffer's own
 * default capacity.
 */
export function createCaptureStore(maxEntries?: number): CaptureStore {
  const tabs = new Map<number, TabRings>();

  function ringsFor(tabId: number): TabRings {
    const existing = tabs.get(tabId);
    if (existing !== undefined) return existing;
    const created: TabRings = {
      console:
        maxEntries === undefined
          ? createCaptureRing<ConsoleEntry>()
          : createCaptureRing<ConsoleEntry>(maxEntries),
      network:
        maxEntries === undefined
          ? createCaptureRing<NetworkEntry>()
          : createCaptureRing<NetworkEntry>(maxEntries),
    };
    tabs.set(tabId, created);
    return created;
  }

  return {
    ingest(tabId, envelope) {
      const rings = ringsFor(tabId);
      if (envelope.channel === "console") {
        rings.console.push(reboundConsole(envelope.entry));
      } else {
        rings.network.push(reboundNetwork(envelope.entry));
      }
    },

    readConsole(tabId, query) {
      const rings = tabs.get(tabId);
      if (rings === undefined) return emptyRead<ConsoleEntry>();
      return rings.console.read(query);
    },

    readNetwork(tabId, query) {
      const rings = tabs.get(tabId);
      if (rings === undefined) return emptyRead<NetworkEntry>();
      return rings.network.read(query);
    },

    evict(tabId) {
      tabs.delete(tabId);
    },
  };
}

/**
 * Wire a `CaptureStore` to the two Chrome surfaces it feeds from. Runtime
 * messages that fail `isCaptureEnvelope` or arrive without a real sender tab
 * id (`undefined`, or `chrome.tabs.TAB_ID_NONE` / any negative) are dropped;
 * a tab-removal frees that tab's buffers.
 */
export function installCaptureIntake(
  ports: CapturePorts,
  store: CaptureStore,
): void {
  ports.onRuntimeMessage((message, senderTabId) => {
    if (senderTabId === undefined || senderTabId < 0) return;
    if (!isCaptureEnvelope(message)) return;
    store.ingest(senderTabId, message);
  });
  ports.onTabRemoved((tabId) => {
    store.evict(tabId);
  });
}
