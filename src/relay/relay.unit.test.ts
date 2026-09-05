import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRelay } from "./relay.js";
import type { RunningRelay, StartRelayOptions } from "./relay.js";

const LOOPBACK = "127.0.0.1";
const EPHEMERAL: StartRelayOptions = { host: LOOPBACK, port: 0 };

interface Collector {
  readonly socket: WebSocket;
  readonly messages: unknown[];
  waitFor(
    predicate: (msg: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  received(predicate: (msg: Record<string, unknown>) => boolean): boolean;
}

let relay: RunningRelay;
const openSockets: WebSocket[] = [];

function connect(role: "extension" | "controller" | null): Promise<Collector> {
  const socket = new WebSocket(`ws://${LOOPBACK}:${relay.port}`);
  openSockets.push(socket);
  const messages: unknown[] = [];
  const waiters: {
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];

  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      messages.push({ __binary: true });
      return;
    }
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    messages.push(parsed);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter && waiter.predicate(record)) {
          waiters.splice(i, 1);
          waiter.resolve(record);
        }
      }
    }
  });

  const collector: Collector = {
    socket,
    messages,
    waitFor: (predicate) =>
      new Promise((resolve) => {
        const existing = messages.find(
          (m): m is Record<string, unknown> =>
            m !== null &&
            typeof m === "object" &&
            predicate(m as Record<string, unknown>),
        );
        if (existing) {
          resolve(existing);
          return;
        }
        waiters.push({ predicate, resolve });
      }),
    received: (predicate) =>
      messages.some(
        (m) =>
          m !== null &&
          typeof m === "object" &&
          predicate(m as Record<string, unknown>),
      ),
  };

  return once(socket, "open").then(() => {
    if (role === null) return collector;
    socket.send(JSON.stringify({ kind: "hello", role }));
    // Give the relay a turn to register the role before the caller sends more.
    return new Promise<Collector>((resolve) => {
      setImmediate(() => {
        resolve(collector);
      });
    });
  });
}

beforeEach(async () => {
  relay = await startRelay(EPHEMERAL);
});

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await relay.close();
});

describe("startRelay — role-based fan-out", () => {
  it("routes a command only to the extension, never to another controller", async () => {
    const ext = await connect("extension");
    const controllerA = await connect("controller");
    const controllerB = await connect("controller");

    const command = {
      kind: "command",
      id: "cmd-1",
      action: "getPageText",
      params: {},
    };
    controllerA.socket.send(JSON.stringify(command));

    const seen = await ext.waitFor((m) => m["kind"] === "command");
    expect(seen["id"]).toBe("cmd-1");

    // Round-trip a response so ordering guarantees controllerB has had its turn.
    ext.socket.send(
      JSON.stringify({
        kind: "command-response",
        id: "cmd-1",
        result: { text: "hi" },
      }),
    );
    await controllerA.waitFor((m) => m["kind"] === "command-response");
    await controllerB.waitFor((m) => m["kind"] === "command-response");

    expect(controllerB.received((m) => m["kind"] === "command")).toBe(false);
    expect(controllerA.received((m) => m["kind"] === "command")).toBe(false);
  });

  it("broadcasts command-response and observation to every controller and never echoes to the extension", async () => {
    const ext = await connect("extension");
    const controllerA = await connect("controller");
    const controllerB = await connect("controller");

    ext.socket.send(
      JSON.stringify({
        kind: "command-response",
        id: "r1",
        result: { ok: true },
      }),
    );
    ext.socket.send(
      JSON.stringify({
        kind: "observation",
        observationType: "console",
        tabId: 7,
        timestamp: 1,
        payload: { level: "log", args: ["hello"] },
      }),
    );

    for (const controller of [controllerA, controllerB]) {
      const response = await controller.waitFor(
        (m) => m["kind"] === "command-response",
      );
      expect(response["id"]).toBe("r1");
      const observation = await controller.waitFor(
        (m) => m["kind"] === "observation",
      );
      expect(observation["tabId"]).toBe(7);
    }

    expect(ext.received((m) => m["kind"] === "command-response")).toBe(false);
    expect(ext.received((m) => m["kind"] === "observation")).toBe(false);
  });

  it("delivers observations to a controller that joins after the extension has already sent frames", async () => {
    const ext = await connect("extension");
    ext.socket.send(
      JSON.stringify({
        kind: "observation",
        observationType: "network",
        tabId: 1,
        timestamp: 1,
        payload: {},
      }),
    );

    const lateController = await connect("controller");
    ext.socket.send(
      JSON.stringify({
        kind: "observation",
        observationType: "network",
        tabId: 2,
        timestamp: 2,
        payload: {},
      }),
    );

    const observation = await lateController.waitFor(
      (m) => m["kind"] === "observation",
    );
    expect(observation["tabId"]).toBe(2);
    // The pre-join observation must not have been buffered for it.
    expect(lateController.received((m) => m["tabId"] === 1)).toBe(false);
  });

  it("fixes a socket's role on its FIRST hello and ignores a later contradicting hello", async () => {
    const ext = await connect("extension");
    const controller = await connect("controller");

    // Controller now claims to be an extension — must be ignored.
    controller.socket.send(
      JSON.stringify({ kind: "hello", role: "extension" }),
    );
    await new Promise<void>((r) => {
      setImmediate(r);
    });

    controller.socket.send(
      JSON.stringify({ kind: "command", id: "c9", action: "ping", params: {} }),
    );
    const seen = await ext.waitFor((m) => m["kind"] === "command");
    expect(seen["id"]).toBe("c9");
    // If the contradicting hello had taken effect, the controller would now be an
    // extension and would have received its own command.
    expect(controller.received((m) => m["kind"] === "command")).toBe(false);
  });
});

describe("startRelay — malformed and unknown frames", () => {
  it("drops non-JSON text without closing the socket and still routes a following valid frame", async () => {
    const ext = await connect("extension");
    const controller = await connect("controller");

    controller.socket.send("not json{");
    expect(controller.socket.readyState).toBe(WebSocket.OPEN);

    controller.socket.send(
      JSON.stringify({
        kind: "command",
        id: "after-garbage",
        action: "ping",
        params: {},
      }),
    );
    const seen = await ext.waitFor((m) => m["kind"] === "command");
    expect(seen["id"]).toBe("after-garbage");
  });

  it("drops unknown kinds and structurally-invalid frames with no process-level error", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);

    const ext = await connect("extension");
    const controller = await connect("controller");

    controller.socket.send(
      JSON.stringify({ kind: "dashboard-state", data: {} }),
    );
    controller.socket.send(JSON.stringify({ kind: "command" })); // missing id/action/params
    controller.socket.send(
      JSON.stringify({ kind: "command-response", id: "x" }),
    ); // neither result nor error

    controller.socket.send(
      JSON.stringify({ kind: "command", id: "ok", action: "ping", params: {} }),
    );
    await ext.waitFor((m) => m["id"] === "ok");

    expect(ext.received((m) => m["kind"] === "dashboard-state")).toBe(false);
    expect(onUnhandled).not.toHaveBeenCalled();

    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUnhandled);
  });

  it("does not throw or close the socket on a binary frame", async () => {
    const ext = await connect("extension");
    const controller = await connect("controller");

    controller.socket.send(Buffer.from([0x00, 0x01, 0x02]));
    expect(controller.socket.readyState).toBe(WebSocket.OPEN);

    controller.socket.send(
      JSON.stringify({
        kind: "command",
        id: "post-binary",
        action: "ping",
        params: {},
      }),
    );
    await ext.waitFor((m) => m["id"] === "post-binary");
    expect(ext.received((m) => m["__binary"] === true)).toBe(false);
  });

  it("narrows parsed frames through the protocol guard with no `as` cast in relay.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./relay.ts", import.meta.url), "utf8");
    expect(/\bas\s+[A-Z]/.test(source)).toBe(false);
  });
});

describe("startRelay — bind address and port", () => {
  it("binds the loopback interface only", async () => {
    // relay is already started on 127.0.0.1 in beforeEach; a fresh instance
    // proves the option is honoured and the reported port is the bound one.
    const instance = await startRelay({ host: LOOPBACK, port: 0 });
    try {
      expect(instance.port).toBeGreaterThan(0);
      // A client on the loopback address connects.
      const client = new WebSocket(`ws://127.0.0.1:${instance.port}`);
      await once(client, "open");
      client.close();
    } finally {
      await instance.close();
    }
  });

  it("reports the ephemeral port actually bound, not the requested 0", () => {
    expect(relay.port).toBeGreaterThan(0);
    expect(relay.port).toBeLessThan(65536);
  });
});

describe("startRelay — lifecycle", () => {
  it("resolves only once listening and releases the port so a restart on it succeeds", async () => {
    const first = await startRelay({ host: LOOPBACK, port: 0 });
    const port = first.port;
    await first.close();

    const second = await startRelay({ host: LOOPBACK, port });
    try {
      expect(second.port).toBe(port);
    } finally {
      await second.close();
    }
  });

  it("rejects when the port is already in use", async () => {
    const first = await startRelay({ host: LOOPBACK, port: 0 });
    try {
      await expect(
        startRelay({ host: LOOPBACK, port: first.port }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });

  it("does not send on a socket that has disconnected", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    const ext = await connect("extension");
    const controller = await connect("controller");
    controller.socket.close();
    await once(controller.socket, "close");

    ext.socket.send(
      JSON.stringify({
        kind: "observation",
        observationType: "console",
        tabId: 3,
        timestamp: 9,
        payload: {},
      }),
    );
    // Round-trip a fresh controller to flush the relay's message handling.
    const fresh = await connect("controller");
    ext.socket.send(
      JSON.stringify({
        kind: "observation",
        observationType: "console",
        tabId: 4,
        timestamp: 10,
        payload: {},
      }),
    );
    await fresh.waitFor((m) => m["tabId"] === 4);

    expect(onUnhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", onUnhandled);
  });

  it("close() terminates connected sockets and resolves", async () => {
    const instance = await startRelay({ host: LOOPBACK, port: 0 });
    const client = new WebSocket(`ws://${LOOPBACK}:${instance.port}`);
    await once(client, "open");
    const clientClosed = once(client, "close");

    await instance.close();
    await clientClosed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});
