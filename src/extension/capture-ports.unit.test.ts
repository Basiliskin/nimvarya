import { afterEach, describe, expect, it, vi } from "vitest";

import { chromeCapturePorts, type CapturePorts } from "./capture-ports.js";

/**
 * `chromeCapturePorts` is the production `CapturePorts`; it only touches
 * `chrome.*` inside its returned closures, so a stub `chrome` global is enough
 * to prove it forwards to the right listener surfaces and reads `sender.tab?.id`.
 */

interface StubChrome {
  runtime: {
    onMessage: {
      addListener: (
        cb: (message: unknown, sender: { tab?: { id?: number } }) => void,
      ) => void;
    };
  };
  tabs: { onRemoved: { addListener: (cb: (tabId: number) => void) => void } };
}

function installStubChrome(): {
  fireMessage: (message: unknown, sender: { tab?: { id?: number } }) => void;
  fireRemoved: (tabId: number) => void;
} {
  let messageCb:
    | ((message: unknown, sender: { tab?: { id?: number } }) => void)
    | undefined;
  let removedCb: ((tabId: number) => void) | undefined;
  const stub: StubChrome = {
    runtime: {
      onMessage: {
        addListener: (cb) => {
          messageCb = cb;
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener: (cb) => {
          removedCb = cb;
        },
      },
    },
  };
  vi.stubGlobal("chrome", stub);
  return {
    fireMessage: (message, sender) => {
      if (messageCb === undefined) throw new Error("no message listener");
      messageCb(message, sender);
    },
    fireRemoved: (tabId) => {
      if (removedCb === undefined) throw new Error("no removed listener");
      removedCb(tabId);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chromeCapturePorts", () => {
  it("forwards a runtime message with the sender's tab id", () => {
    const stub = installStubChrome();
    const ports: CapturePorts = chromeCapturePorts();
    const seen: { message: unknown; tabId: number | undefined }[] = [];
    ports.onRuntimeMessage((message, senderTabId) => {
      seen.push({ message, tabId: senderTabId });
    });

    stub.fireMessage({ hello: 1 }, { tab: { id: 7 } });
    expect(seen).toEqual([{ message: { hello: 1 }, tabId: 7 }]);
  });

  it("reports an undefined tab id for a sender with no tab", () => {
    const stub = installStubChrome();
    const ports = chromeCapturePorts();
    const tabIds: (number | undefined)[] = [];
    ports.onRuntimeMessage((_message, senderTabId) => {
      tabIds.push(senderTabId);
    });

    stub.fireMessage({}, {});
    expect(tabIds).toEqual([undefined]);
  });

  it("forwards tab-removed events", () => {
    const stub = installStubChrome();
    const ports = chromeCapturePorts();
    const removed: number[] = [];
    ports.onTabRemoved((tabId) => removed.push(tabId));

    stub.fireRemoved(42);
    expect(removed).toEqual([42]);
  });
});
