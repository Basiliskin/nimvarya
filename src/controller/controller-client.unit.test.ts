import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRelay } from "../relay/relay.js";
import type { RunningRelay } from "../relay/relay.js";
import {
  DEFAULT_BRIDGE_URL,
  createControllerClient,
  resolveBridgeUrl,
} from "./controller-client.js";
import type {
  ControllerClient,
  ControllerClientOptions,
  ControllerSocket,
  ControllerSocketFactory,
} from "./controller-client.js";

const LOOPBACK = "127.0.0.1";

/** Narrow `T | undefined` to `T` in tests without a non-null assertion. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

function parseRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object") {
    throw new Error(`not an object: ${raw}`);
  }
  return value as Record<string, unknown>;
}

// --- resolveBridgeUrl --------------------------------------------------------

describe("resolveBridgeUrl", () => {
  const original = process.env.CHROME_BRIDGE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.CHROME_BRIDGE_URL;
    else process.env.CHROME_BRIDGE_URL = original;
  });

  it("returns CHROME_BRIDGE_URL when set", () => {
    process.env.CHROME_BRIDGE_URL = "ws://example.test:9999";
    expect(resolveBridgeUrl()).toBe("ws://example.test:9999");
  });

  it("falls back to ws://127.0.0.1:8766 (not boky's 8765) when unset", () => {
    delete process.env.CHROME_BRIDGE_URL;
    expect(resolveBridgeUrl()).toBe("ws://127.0.0.1:8766");
    expect(DEFAULT_BRIDGE_URL).toBe("ws://127.0.0.1:8766");
    expect(resolveBridgeUrl()).not.toContain("8765");
  });

  it("treats an empty CHROME_BRIDGE_URL as unset", () => {
    process.env.CHROME_BRIDGE_URL = "";
    expect(resolveBridgeUrl()).toBe("ws://127.0.0.1:8766");
  });
});

// --- Round-trip against the real relay + a fake extension socket ------------

/**
 * A plain `ws` client that plays the Extension role: it says
 * `hello role=extension` and lets the test drive the `command-response`
 * replies. Frames are flat (`{ kind, id, result }`) — the shape the relay's
 * protocol guard accepts; boky's nested `data` shape was dropped in the
 * protocol phase.
 */
class FakeExtension {
  readonly socket: WebSocket;
  readonly commands: { id: string; action: string }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const record = parseRecord(raw.toString("utf8"));
      if (record.kind !== "command") return;
      this.commands.push({ id: String(record.id), action: String(record.action) });
    });
  }

  static async connect(port: number): Promise<FakeExtension> {
    const socket = new WebSocket(`ws://${LOOPBACK}:${port}`);
    await once(socket, "open");
    socket.send(JSON.stringify({ kind: "hello", role: "extension" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return new FakeExtension(socket);
  }

  reply(id: string, result: unknown): void {
    this.socket.send(JSON.stringify({ kind: "command-response", id, result }));
  }

  replyError(id: string, error: string): void {
    this.socket.send(JSON.stringify({ kind: "command-response", id, error }));
  }

  observe(payload: unknown): void {
    this.socket.send(
      JSON.stringify({
        kind: "observation",
        observationType: "console",
        tabId: 1,
        timestamp: Date.now(),
        payload,
      }),
    );
  }

  close(): void {
    this.socket.close();
  }

  firstCommandId(): string {
    return must(this.commands.at(0), "first command").id;
  }
}

describe("createControllerClient — against the real relay", () => {
  let relay: RunningRelay;
  let ext: FakeExtension;
  let client: ControllerClient;

  beforeEach(async () => {
    relay = await startRelay({ host: LOOPBACK, port: 0 });
    ext = await FakeExtension.connect(relay.port);
    client = createControllerClient({
      url: `ws://${LOOPBACK}:${relay.port}`,
      timeoutMs: 30_000,
    });
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    ext.close();
    await relay.close();
  });

  it("resolves a command with the response carrying its own id", async () => {
    const pending = client.sendCommand("getPageText", {});
    await vi.waitFor(() => {
      expect(ext.commands).toHaveLength(1);
    });
    const id = ext.firstCommandId();
    ext.reply(id, { text: "hello" });
    const response = await pending;
    expect(response.kind).toBe("command-response");
    expect(response.id).toBe(id);
    expect(response.result).toEqual({ text: "hello" });
    expect(client.pendingCount()).toBe(0);
  });

  it("correlates two concurrent commands even when replies arrive in reverse order", async () => {
    const first = client.sendCommand("findElement", { selector: "a" });
    const second = client.sendCommand("findElement", { selector: "b" });
    await vi.waitFor(() => {
      expect(ext.commands).toHaveLength(2);
    });
    const id1 = must(ext.commands.at(0), "command 1").id;
    const id2 = must(ext.commands.at(1), "command 2").id;
    expect(id1).not.toBe(id2);
    // Reply to the SECOND command first.
    ext.reply(id2, { found: true, matches: 2 });
    ext.reply(id1, { found: false, matches: 0 });
    expect((await first).result).toEqual({ found: false, matches: 0 });
    expect((await second).result).toEqual({ found: true, matches: 2 });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects the matching promise on an error response and clears the pending entry", async () => {
    const pending = client.sendCommand("clickElement", { selector: "#x" });
    await vi.waitFor(() => {
      expect(ext.commands).toHaveLength(1);
    });
    const id = ext.firstCommandId();
    ext.replyError(id, "no such element");
    await expect(pending).rejects.toThrow("no such element");
    expect(client.pendingCount()).toBe(0);
    // A stray second reply with the same id is ignored, not a double-settle.
    expect(() => {
      ext.reply(id, { late: true });
    }).not.toThrow();
  });

  it("ignores an unknown-id response and malformed input without an unhandled error", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    ext.reply("id-nobody-sent", { whatever: true });
    ext.socket.send("not json{");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const pending = client.sendCommand("ping", {});
    await vi.waitFor(() => {
      expect(ext.commands).toHaveLength(1);
    });
    ext.reply(ext.firstCommandId(), { ok: true, ts: 1 });
    await pending;
    expect(onUnhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", onUnhandled);
  });

  it("times out a command with no reply after the per-call timeoutMs (default unchanged)", async () => {
    const started = Date.now();
    await expect(
      client.sendCommand("readPage", {}, { timeoutMs: 60 }),
    ).rejects.toThrow(/timed out after 60ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(client.pendingCount()).toBe(0);
  });

  it("does not double-settle when a reply arrives after the timeout fired", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    const pending = client.sendCommand("getPageText", {}, { timeoutMs: 40 });
    await expect(pending).rejects.toThrow(/timed out/);
    await vi.waitFor(() => {
      expect(ext.commands).toHaveLength(1);
    });
    expect(() => {
      ext.reply(ext.firstCommandId(), { text: "late" });
    }).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(onUnhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", onUnhandled);
  });

  it("rejects every pending command with 'Bridge connection lost' when the relay drops", async () => {
    const a = client.sendCommand("getPageText", {});
    const b = client.sendCommand("readPage", {});
    await vi.waitFor(() => {
      expect(ext.commands.length).toBeGreaterThanOrEqual(2);
    });
    await relay.close();
    await expect(a).rejects.toThrow("Bridge connection lost");
    await expect(b).rejects.toThrow("Bridge connection lost");
    expect(client.pendingCount()).toBe(0);
  });

  it("delivers observations to every subscriber and honours unsubscribe", async () => {
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const unsubA = client.onObservation((o) => seenA.push(o.payload));
    client.onObservation((o) => seenB.push(o.payload));

    ext.observe({ n: 1 });
    await vi.waitFor(() => {
      expect(seenA).toHaveLength(1);
      expect(seenB).toHaveLength(1);
    });
    expect(seenA.at(0)).toEqual({ n: 1 });

    unsubA();
    ext.observe({ n: 2 });
    await vi.waitFor(() => {
      expect(seenB).toHaveLength(2);
    });
    expect(seenA).toHaveLength(1);
  });

  it("rejects a command sent while disconnected with a clear 'not connected' error", async () => {
    client.close();
    await expect(client.sendCommand("ping", {})).rejects.toThrow(
      /not connected/i,
    );
  });
});

// --- Reconnect backoff, driven by a fake socket + fake timers --------------

interface FakeSocket extends ControllerSocket {
  readyState: number;
  readonly sent: string[];
  emitOpen(): void;
  emitClose(): void;
}

function makeFakeFactory(): {
  factory: ControllerSocketFactory;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const factory: ControllerSocketFactory = () => {
    const listeners = new Map<string, ((data?: unknown) => void)[]>();
    const sent: string[] = [];
    const fake: FakeSocket = {
      readyState: 0,
      sent,
      send: (data) => {
        sent.push(data);
      },
      close: () => {
        fake.readyState = 3;
      },
      on: (event, listener) => {
        const arr = listeners.get(event) ?? [];
        arr.push(listener);
        listeners.set(event, arr);
      },
      emitOpen: () => {
        fake.readyState = 1;
        for (const listener of listeners.get("open") ?? []) listener();
      },
      emitClose: () => {
        fake.readyState = 3;
        for (const listener of listeners.get("close") ?? []) listener();
      },
    };
    sockets.push(fake);
    return fake;
  };
  return { factory, sockets };
}

describe("createControllerClient — reconnect backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const options = (
    factory: ControllerSocketFactory,
  ): ControllerClientOptions => ({
    url: "ws://unused.test:1",
    socketFactory: factory,
  });

  async function connectFirst(): Promise<{
    client: ControllerClient;
    sockets: FakeSocket[];
  }> {
    const { factory, sockets } = makeFakeFactory();
    const client = createControllerClient(options(factory));
    const connected = client.connect();
    must(sockets.at(0), "socket 0").emitOpen();
    await connected;
    return { client, sockets };
  }

  it("reconnects with delays 1000, 2000, 4000, 8000, 15000, 15000 while the relay stays down", async () => {
    const { client, sockets } = await connectFirst();

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000];
    for (let i = 0; i < expectedDelays.length; i += 1) {
      const delay = must(expectedDelays.at(i), "delay");
      // The reconnect attempts themselves fail: the socket closes, never opens.
      must(sockets.at(i), "socket").emitClose();
      vi.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(i + 1); // not yet
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(i + 2); // dialled at exactly `delay`
    }
    client.close();
  });

  it("re-sends hello on a reconnected socket and resets the delay to 1000 after a successful open", async () => {
    const { client, sockets } = await connectFirst();
    expect(parseRecord(must(sockets.at(0), "socket 0").sent[0] ?? "")).toEqual({
      kind: "hello",
      role: "controller",
    });

    // Two failures take the delay up to 4000...
    must(sockets.at(0), "s0").emitClose();
    vi.advanceTimersByTime(1_000);
    must(sockets.at(1), "s1").emitClose();
    vi.advanceTimersByTime(2_000);

    // ...then the reconnect succeeds: hello is re-sent and the delay resets.
    const reconnected = must(sockets.at(2), "s2");
    reconnected.emitOpen();
    expect(parseRecord(reconnected.sent[0] ?? "")).toEqual({
      kind: "hello",
      role: "controller",
    });

    reconnected.emitClose();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
    client.close();
  });

  it("close() cancels a scheduled reconnect", async () => {
    const { client, sockets } = await connectFirst();
    must(sockets.at(0), "s0").emitClose();
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
