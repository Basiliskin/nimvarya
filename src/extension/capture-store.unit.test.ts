import { describe, expect, it } from "vitest";

import {
  CAPTURE_NAMESPACE,
  MAX_BODY_PREVIEW_BYTES,
  MAX_CONSOLE_TEXT_BYTES,
} from "../protocol/capture.js";
import type {
  CaptureEnvelope,
  ConsoleEntry,
  NetworkEntry,
} from "../protocol/capture.js";
import type { CapturePorts } from "./capture-ports.js";
import {
  createCaptureStore,
  installCaptureIntake,
  type CaptureQuery,
  type CaptureStore,
} from "./capture-store.js";

const consoleEntry = (text: string): ConsoleEntry => ({
  level: "log",
  text,
  timestamp: 1,
  truncated: false,
});

const networkEntry = (
  url: string,
  bodyPreview: string | null,
): NetworkEntry => ({
  requestId: url,
  method: "GET",
  url,
  status: 200,
  durationMs: 5,
  contentType: "text/plain",
  bodyPreview,
  truncated: false,
  failed: false,
  timestamp: 1,
});

const consoleEnvelope = (text: string): CaptureEnvelope => ({
  ns: CAPTURE_NAMESPACE,
  channel: "console",
  entry: consoleEntry(text),
});

const networkEnvelope = (
  url: string,
  bodyPreview: string | null,
): CaptureEnvelope => ({
  ns: CAPTURE_NAMESPACE,
  channel: "network",
  entry: networkEntry(url, bodyPreview),
});

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

const FULL: CaptureQuery = { since: 0, limit: 100 };

/** A fake `CapturePorts` exposing the listeners `installCaptureIntake` registers. */
function fakeCapturePorts(): {
  port: CapturePorts;
  fireMessage: (message: unknown, senderTabId: number | undefined) => void;
  fireTabRemoved: (tabId: number) => void;
} {
  let runtime:
    ((message: unknown, senderTabId: number | undefined) => void) | undefined;
  let tabRemoved: ((tabId: number) => void) | undefined;
  return {
    port: {
      onRuntimeMessage: (listener) => {
        runtime = listener;
      },
      onTabRemoved: (listener) => {
        tabRemoved = listener;
      },
    },
    fireMessage: (message, senderTabId) => {
      if (runtime === undefined)
        throw new Error("no runtime listener registered");
      runtime(message, senderTabId);
    },
    fireTabRemoved: (tabId) => {
      if (tabRemoved === undefined) {
        throw new Error("no tab-removed listener registered");
      }
      tabRemoved(tabId);
    },
  };
}

describe("createCaptureStore — per-tab isolation and console/network routing", () => {
  it("keeps console and network entries for interleaved tabs fully separated", () => {
    const store: CaptureStore = createCaptureStore();
    // interleave 1, 2, 1, 2
    store.ingest(1, consoleEnvelope("c-tab1-a"));
    store.ingest(2, consoleEnvelope("c-tab2-a"));
    store.ingest(1, networkEnvelope("https://tab1/a", "b1"));
    store.ingest(2, networkEnvelope("https://tab2/a", "b2"));
    store.ingest(1, consoleEnvelope("c-tab1-b"));
    store.ingest(2, networkEnvelope("https://tab2/b", "b3"));

    expect(store.readConsole(1, FULL).entries.map((e) => e.text)).toEqual([
      "c-tab1-a",
      "c-tab1-b",
    ]);
    expect(store.readConsole(2, FULL).entries.map((e) => e.text)).toEqual([
      "c-tab2-a",
    ]);
    expect(store.readNetwork(1, FULL).entries.map((e) => e.url)).toEqual([
      "https://tab1/a",
    ]);
    expect(store.readNetwork(2, FULL).entries.map((e) => e.url)).toEqual([
      "https://tab2/a",
      "https://tab2/b",
    ]);
  });

  it("gives a tab's console and network rings independent nextSince cursors", () => {
    const store = createCaptureStore();
    store.ingest(1, consoleEnvelope("a"));
    store.ingest(1, consoleEnvelope("b"));
    store.ingest(1, consoleEnvelope("c"));
    store.ingest(1, networkEnvelope("https://x", null));

    // console ring has seen 3 entries; the lone network entry must not push it forward
    expect(store.readConsole(1, FULL).nextSince).toBe(3);
    expect(store.readNetwork(1, FULL).nextSince).toBe(1);
  });

  it("forwards since and limit unchanged to the underlying ring", () => {
    const store = createCaptureStore();
    for (const t of ["a", "b", "c", "d", "e"])
      store.ingest(7, consoleEnvelope(t));

    const windowed = store.readConsole(7, { since: 2, limit: 2 });
    expect(windowed.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(windowed.nextSince).toBe(4);
    expect(windowed.truncated).toBe(true);
  });
});

describe("createCaptureStore — eviction and unknown-tab reads", () => {
  it("returns an empty-but-valid read for a tab that was never ingested", () => {
    const store = createCaptureStore();
    expect(store.readConsole(999, FULL)).toEqual({
      entries: [],
      nextSince: 0,
      dropped: false,
      truncated: false,
    });
    expect(store.readNetwork(999, FULL)).toEqual({
      entries: [],
      nextSince: 0,
      dropped: false,
      truncated: false,
    });
  });

  it("evict frees both rings and later reads are empty-but-valid", () => {
    const store = createCaptureStore();
    store.ingest(3, consoleEnvelope("a"));
    store.ingest(3, networkEnvelope("https://x", "y"));
    store.evict(3);
    expect(store.readConsole(3, FULL)).toEqual({
      entries: [],
      nextSince: 0,
      dropped: false,
      truncated: false,
    });
    expect(store.readNetwork(3, FULL)).toEqual({
      entries: [],
      nextSince: 0,
      dropped: false,
      truncated: false,
    });
  });

  it("evict deletes the map key so a re-ingested tab starts a fresh ring at seq 1", () => {
    const store = createCaptureStore();
    store.ingest(4, consoleEnvelope("a"));
    store.ingest(4, consoleEnvelope("b"));
    store.evict(4);
    store.ingest(4, consoleEnvelope("c"));
    expect(store.readConsole(4, FULL).entries.map((e) => e.seq)).toEqual([1]);
  });

  it("evict on a tab with no buffers does not throw", () => {
    const store = createCaptureStore();
    expect(() => {
      store.evict(123);
    }).not.toThrow();
  });
});

describe("createCaptureStore — defensive re-bounding at intake", () => {
  it("re-bounds an oversize console text to the contract cap and flags truncated", () => {
    const store = createCaptureStore();
    const huge = "x".repeat(MAX_CONSOLE_TEXT_BYTES + 500);
    store.ingest(1, {
      ns: CAPTURE_NAMESPACE,
      channel: "console",
      entry: { ...consoleEntry(huge), truncated: false },
    });
    const [entry] = store.readConsole(1, FULL).entries;
    expect(entry).toBeDefined();
    expect(byteLength(entry?.text ?? "")).toBeLessThanOrEqual(
      MAX_CONSOLE_TEXT_BYTES,
    );
    expect(entry?.truncated).toBe(true);
  });

  it("re-bounds an oversize network bodyPreview to the contract cap and flags truncated", () => {
    const store = createCaptureStore();
    const huge = "y".repeat(MAX_BODY_PREVIEW_BYTES + 500);
    store.ingest(1, networkEnvelope("https://x", huge));
    const [entry] = store.readNetwork(1, FULL).entries;
    expect(entry).toBeDefined();
    expect(byteLength(entry?.bodyPreview ?? "")).toBeLessThanOrEqual(
      MAX_BODY_PREVIEW_BYTES,
    );
    expect(entry?.truncated).toBe(true);
  });

  it("leaves a null bodyPreview as null", () => {
    const store = createCaptureStore();
    store.ingest(1, networkEnvelope("https://x", null));
    expect(store.readNetwork(1, FULL).entries[0]?.bodyPreview).toBeNull();
  });
});

describe("installCaptureIntake", () => {
  it("ingests a valid envelope keyed by the sender tab id", () => {
    const store = createCaptureStore();
    const ports = fakeCapturePorts();
    installCaptureIntake(ports.port, store);

    ports.fireMessage(consoleEnvelope("hello"), 5);
    expect(store.readConsole(5, FULL).entries.map((e) => e.text)).toEqual([
      "hello",
    ]);
  });

  it("drops non-envelope runtime messages", () => {
    const store = createCaptureStore();
    const ports = fakeCapturePorts();
    installCaptureIntake(ports.port, store);

    ports.fireMessage({ foo: 1 }, 5);
    ports.fireMessage("just a string", 5);
    expect(store.readConsole(5, FULL).entries).toEqual([]);
  });

  it("drops a valid envelope that arrives without a sender tab id", () => {
    const store = createCaptureStore();
    const ports = fakeCapturePorts();
    installCaptureIntake(ports.port, store);

    ports.fireMessage(consoleEnvelope("hello"), undefined);
    expect(store.readConsole(0, FULL).entries).toEqual([]);
  });

  it("drops a valid envelope from chrome.tabs.TAB_ID_NONE (-1)", () => {
    const store = createCaptureStore();
    const ports = fakeCapturePorts();
    installCaptureIntake(ports.port, store);

    ports.fireMessage(consoleEnvelope("hello"), -1);
    expect(store.readConsole(-1, FULL).entries).toEqual([]);
  });

  it("evicts a tab's buffers when the tab-removed listener fires", () => {
    const store = createCaptureStore();
    const ports = fakeCapturePorts();
    installCaptureIntake(ports.port, store);

    ports.fireMessage(consoleEnvelope("hello"), 8);
    expect(store.readConsole(8, FULL).entries).toHaveLength(1);

    ports.fireTabRemoved(8);
    expect(store.readConsole(8, FULL).entries).toEqual([]);
  });
});
