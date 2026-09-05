import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandResponse } from "../protocol/types.js";
import {
  createBridgeClient,
  DEFAULT_BRIDGE_URL,
  OUTBOX_LIMIT,
} from "./bridge-client.js";
import type { BridgeCommandHandler, BridgeSocket } from "./bridge-client.js";

const parseJson = (raw: string): unknown => JSON.parse(raw);
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
    this.emit("close");
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

const noopHandler: BridgeCommandHandler = (cmd) => ({
  kind: "command-response",
  id: cmd.id,
  result: null,
});

function setup(onCommand: BridgeCommandHandler = noopHandler): {
  sockets: FakeSocket[];
  factory: ReturnType<typeof vi.fn>;
  client: ReturnType<typeof createBridgeClient>;
} {
  const sockets: FakeSocket[] = [];
  const factory = vi.fn((_url: string) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const client = createBridgeClient({
    url: "ws://127.0.0.1:9999",
    socketFactory: factory,
    onCommand,
    reconnectDelayMs: 2000,
  });
  return { sockets, factory, client };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createBridgeClient — constants", () => {
  it("exposes a numeric outbox cap and the default relay URL", () => {
    expect(typeof OUTBOX_LIMIT).toBe("number");
    expect(OUTBOX_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_BRIDGE_URL).toBe("ws://127.0.0.1:8766");
  });
});

describe("createBridgeClient — connection loop", () => {
  it("dials eagerly at construction, before any send", () => {
    const { factory } = setup();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("sends hello role=extension as the first frame on open", () => {
    const { sockets } = setup();
    sockets[0]?.open();
    expect(sockets[0]?.frames()[0]).toEqual({ kind: "hello", role: "extension" });
  });

  it("buffers a pre-open frame and flushes it after hello", () => {
    const { sockets, client } = setup();
    client.send({
      kind: "observation",
      observationType: "console",
      tabId: 1,
      timestamp: 0,
      payload: "x",
    });
    expect(sockets[0]?.sent).toHaveLength(0);
    sockets[0]?.open();
    expect(sockets[0]?.frames()[0]).toEqual({ kind: "hello", role: "extension" });
    expect(sockets[0]?.frames()[1]).toMatchObject({
      kind: "observation",
      tabId: 1,
    });
  });

  it("drops the oldest buffered frame past the cap", () => {
    const { sockets, client } = setup();
    for (let i = 0; i < OUTBOX_LIMIT + 5; i++) {
      client.send({
        kind: "observation",
        observationType: "console",
        tabId: i,
        timestamp: 0,
        payload: null,
      });
    }
    sockets[0]?.open();
    const observations = (sockets[0]?.frames() ?? []).filter(
      (f): f is { kind: string; tabId: number } =>
        typeof f === "object" &&
        f !== null &&
        "kind" in f &&
        (f).kind === "observation",
    );
    expect(observations).toHaveLength(OUTBOX_LIMIT);
    expect(observations[0]?.tabId).toBe(5);
  });

  it("reconnects exactly once after the delay and re-sends hello", () => {
    vi.useFakeTimers();
    const { sockets, factory } = setup();
    sockets[0]?.open();
    sockets[0]?.emit("close");
    vi.advanceTimersByTime(1999);
    expect(factory).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(factory).toHaveBeenCalledTimes(2);
    sockets[1]?.open();
    expect(sockets[1]?.frames()[0]).toEqual({ kind: "hello", role: "extension" });
  });

  it("schedules only one reconnect when error and close both fire", () => {
    vi.useFakeTimers();
    const { sockets, factory } = setup();
    sockets[0]?.open();
    sockets[0]?.emit("error"); // handler calls socket.close() -> emits close
    sockets[0]?.emit("close");
    vi.advanceTimersByTime(2000);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels a pending reconnect", () => {
    vi.useFakeTimers();
    const { sockets, factory, client } = setup();
    sockets[0]?.emit("close");
    client.stop();
    vi.advanceTimersByTime(10_000);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe("createBridgeClient — command handling", () => {
  it("answers a command frame with a command-response carrying the same id", async () => {
    const { sockets } = setup((cmd) => ({
      kind: "command-response",
      id: cmd.id,
      result: { ok: true },
    }));
    sockets[0]?.open();
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        kind: "command",
        id: "cmd-1",
        action: "ping",
        params: {},
      }),
    });
    await tick();
    expect(sockets[0]?.frames()).toContainEqual({
      kind: "command-response",
      id: "cmd-1",
      result: { ok: true },
    });
  });

  it("ignores invalid JSON and non-command frames but stays usable", async () => {
    const handler = vi.fn(noopHandler);
    const { sockets } = setup(handler);
    sockets[0]?.open();
    sockets[0]?.emit("message", { data: "not json{" });
    sockets[0]?.emit("message", {
      data: JSON.stringify({ kind: "hello", role: "controller" }),
    });
    await tick();
    expect(handler).not.toHaveBeenCalled();

    sockets[0]?.emit("message", {
      data: JSON.stringify({
        kind: "command",
        id: "z",
        action: "ping",
        params: {},
      }),
    });
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      (sockets[0]?.frames() ?? []).some(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          "id" in f &&
          (f).id === "z",
      ),
    ).toBe(true);
  });

  it("writes an error command-response when onCommand throws", async () => {
    const { sockets } = setup((): CommandResponse => {
      throw new Error("handler boom");
    });
    sockets[0]?.open();
    sockets[0]?.emit("message", {
      data: JSON.stringify({
        kind: "command",
        id: "e1",
        action: "ping",
        params: {},
      }),
    });
    await tick();
    expect(sockets[0]?.frames()).toContainEqual({
      kind: "command-response",
      id: "e1",
      error: "handler boom",
    });
  });
});
