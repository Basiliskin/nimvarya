import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeSocket } from "./bridge-client.js";
import type { CapturePorts } from "./capture-ports.js";
import type { DebuggerPorts } from "./debugger-ports.js";
import { resetBridgeKeepaliveForTests } from "./keepalive.js";
import type { AlarmsPort } from "./keepalive.js";
import type { ChromePorts } from "./ports.js";
import type { SandboxTabPorts } from "./sandbox-ports.js";
import { startServiceWorker } from "./service-worker.js";

const parseJson = (raw: string): unknown => JSON.parse(raw);
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket implements BridgeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    ((event: { data: unknown }) => void)[]
  >();
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: { data: unknown }) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: { data: unknown } = { data: undefined }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  frames(): unknown[] {
    return this.sent.map(parseJson);
  }
}

function fakeAlarms(): { port: AlarmsPort; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn();
  return { create, port: { create, onAlarm: { addListener: vi.fn() } } };
}

function fakePorts(): ChromePorts {
  return {
    queryActiveTab: () => Promise.resolve({ id: 1, windowId: 1 }),
    executeScript: () => Promise.resolve("PAGE TEXT"),
    updateTab: () => Promise.resolve(),
    captureVisibleTab: () => Promise.resolve("data:image/png;base64,AA"),
    goBack: () => Promise.resolve(),
    goForward: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    readTab: () =>
      Promise.resolve({
        id: 1,
        windowId: 1,
        url: "https://example.com",
        title: "Example",
      }),
    activeTabOfWindow: () =>
      Promise.resolve({
        id: 1,
        windowId: 1,
        url: "https://example.com",
        title: "Example",
      }),
  };
}

function fakeSandboxTabPorts(): SandboxTabPorts {
  return {
    resolveTabId: () => Promise.resolve(1),
    peekStoredSandboxTabId: () => Promise.resolve(1),
    closeSandboxTab: () => Promise.resolve({ closed: true, hadTab: true }),
  };
}

function fakeDebuggerPorts(): DebuggerPorts {
  return {
    captureScreenshot: () => Promise.resolve("data:image/png;base64,AA"),
    captureFullPageScreenshot: () =>
      Promise.resolve("data:image/png;base64,AA"),
    evaluate: () => Promise.resolve({ ok: true, json: "null" }),
    scroll: () =>
      Promise.resolve({
        method: "none" as const,
        scrollYBefore: 0,
        scrollYAfter: 0,
        reachedEnd: false,
      }),
  };
}

/** A fake `CapturePorts` that records the two listeners `installCaptureIntake` registers. */
function fakeCapturePorts(): {
  port: CapturePorts;
  runtimeListeners: ((
    message: unknown,
    senderTabId: number | undefined,
  ) => void)[];
  tabRemovedListeners: ((tabId: number) => void)[];
} {
  const runtimeListeners: ((
    message: unknown,
    senderTabId: number | undefined,
  ) => void)[] = [];
  const tabRemovedListeners: ((tabId: number) => void)[] = [];
  return {
    runtimeListeners,
    tabRemovedListeners,
    port: {
      onRuntimeMessage: (listener) => runtimeListeners.push(listener),
      onTabRemoved: (listener) => tabRemovedListeners.push(listener),
    },
  };
}

describe("startServiceWorker", () => {
  beforeEach(() => {
    resetBridgeKeepaliveForTests();
  });

  it("installs the keepalive alarm once with the standard period", () => {
    const alarms = fakeAlarms();
    startServiceWorker({
      alarms: alarms.port,
      ports: fakePorts(),
      sandboxTabPorts: fakeSandboxTabPorts(),
      debuggerPorts: fakeDebuggerPorts(),
      capturePorts: fakeCapturePorts().port,
      socketFactory: () => new FakeSocket(),
    }).client.stop();
    expect(alarms.create).toHaveBeenCalledTimes(1);
    expect(alarms.create).toHaveBeenCalledWith("bridge-keepalive", {
      periodInMinutes: 0.5,
    });
  });

  it("dials the default relay URL when none is supplied", () => {
    const factory = vi.fn((_url: string) => new FakeSocket());
    startServiceWorker({
      alarms: fakeAlarms().port,
      ports: fakePorts(),
      sandboxTabPorts: fakeSandboxTabPorts(),
      debuggerPorts: fakeDebuggerPorts(),
      capturePorts: fakeCapturePorts().port,
      socketFactory: factory,
    }).client.stop();
    expect(factory).toHaveBeenCalledWith("ws://127.0.0.1:8766");
  });

  it("routes an inbound command through the real page-action handlers", async () => {
    const socket = new FakeSocket();
    startServiceWorker({
      alarms: fakeAlarms().port,
      ports: fakePorts(),
      sandboxTabPorts: fakeSandboxTabPorts(),
      debuggerPorts: fakeDebuggerPorts(),
      capturePorts: fakeCapturePorts().port,
      socketFactory: () => socket,
      url: "ws://127.0.0.1:1",
    });
    socket.open();
    socket.emit("message", {
      data: JSON.stringify({
        kind: "command",
        id: "gp-1",
        action: "getPageText",
        params: {},
      }),
    });
    await tick();
    expect(socket.frames()).toContainEqual({
      kind: "command-response",
      id: "gp-1",
      result: { text: "PAGE TEXT", totalChars: 9, truncated: false },
    });
  });

  it("wires the dispatcher so a bad-params command yields an { error } response", async () => {
    const socket = new FakeSocket();
    startServiceWorker({
      alarms: fakeAlarms().port,
      ports: fakePorts(),
      sandboxTabPorts: fakeSandboxTabPorts(),
      debuggerPorts: fakeDebuggerPorts(),
      capturePorts: fakeCapturePorts().port,
      socketFactory: () => socket,
      url: "ws://127.0.0.1:1",
    });
    socket.open();
    socket.emit("message", {
      data: JSON.stringify({
        kind: "command",
        id: "n-1",
        action: "navigateTo",
        params: {},
      }),
    });
    await tick();
    const response = socket
      .frames()
      .find(
        (f) =>
          typeof f === "object" && f !== null && "id" in f && f.id === "n-1",
      );
    expect(response).toMatchObject({
      kind: "command-response",
      id: "n-1",
      error: expect.any(String),
    });
  });

  it("registers exactly one runtime-message and one tab-removed listener for capture intake", () => {
    const capture = fakeCapturePorts();
    startServiceWorker({
      alarms: fakeAlarms().port,
      ports: fakePorts(),
      sandboxTabPorts: fakeSandboxTabPorts(),
      debuggerPorts: fakeDebuggerPorts(),
      capturePorts: capture.port,
      socketFactory: () => new FakeSocket(),
    }).client.stop();
    expect(capture.runtimeListeners).toHaveLength(1);
    expect(capture.tabRemovedListeners).toHaveLength(1);
  });

  it("exposes the capture store, and a read on a fresh tab is the empty-but-valid shape", () => {
    const started = startServiceWorker({
      alarms: fakeAlarms().port,
      ports: fakePorts(),
      sandboxTabPorts: fakeSandboxTabPorts(),
      debuggerPorts: fakeDebuggerPorts(),
      capturePorts: fakeCapturePorts().port,
      socketFactory: () => new FakeSocket(),
    });
    started.client.stop();
    expect(
      started.captureStore.readConsole(42, { since: 0, limit: 10 }),
    ).toEqual({
      entries: [],
      nextSince: 0,
      dropped: false,
      truncated: false,
    });
    expect(
      started.captureStore.readNetwork(42, { since: 0, limit: 10 }),
    ).toEqual({
      entries: [],
      nextSince: 0,
      dropped: false,
      truncated: false,
    });
  });
});
