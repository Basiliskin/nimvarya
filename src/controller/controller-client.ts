/**
 * Node-side Controller client — one reconnecting WebSocket to the relay that
 * sends `command` frames and correlates their `command-response` replies.
 *
 * Ported from boky's `extension/devtools/extension-mcp.mjs` `BridgeClient`
 * class, typed and generalised:
 *
 *  - command ids are `crypto.randomUUID()` strings, not a per-instance integer
 *    counter (two controllers pointed at the same relay would both start at 1
 *    and collide);
 *  - the relay URL comes from `CHROME_BRIDGE_URL` (read at construction time,
 *    not module load) and defaults to `ws://127.0.0.1:8766`, not boky's 8765;
 *  - every inbound frame is parsed as `unknown` and narrowed through the
 *    protocol type guards;
 *  - per-command timeout is 30s by default and overridable per call;
 *  - reconnect backoff doubles 1000 → 15000 ms and resets to 1000 on a
 *    successful open; `close()` disables reconnection for good.
 *
 * The next phase (the MCP server) is the real consumer of `createControllerClient`
 * and `resolveBridgeUrl`; for now the co-located unit test is the only importer.
 */

import { randomUUID } from "node:crypto";

import { WebSocket as WsWebSocket } from "ws";
import type { RawData } from "ws";

import { isCommandResponse, isObservation } from "../protocol/guards.js";
import type { PageAction } from "../protocol/actions.js";
import type {
  CommandResponse,
  Observation,
  PageActionParams,
} from "../protocol/types.js";

/** Default relay URL when `CHROME_BRIDGE_URL` is unset. */
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8766";
const DEFAULT_TIMEOUT_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const READY_STATE_OPEN = 1;

/**
 * The relay URL: `process.env.CHROME_BRIDGE_URL` when set and non-empty,
 * otherwise `ws://127.0.0.1:8766`. Read lazily (on each call) so a test can
 * override the env var and restore it without a module reload.
 */
export function resolveBridgeUrl(): string {
  const fromEnv = process.env.CHROME_BRIDGE_URL;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_BRIDGE_URL;
}

/** The subset of a WebSocket the controller client depends on. */
export interface ControllerSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(
    event: "open" | "close" | "error" | "message",
    listener: (data?: unknown) => void,
  ): void;
}

export type ControllerSocketFactory = (url: string) => ControllerSocket;

export interface ControllerClientOptions {
  /** Relay URL; defaults to `resolveBridgeUrl()`. */
  readonly url?: string;
  /** Default per-command timeout in ms; defaults to 30000. */
  readonly timeoutMs?: number;
  /** Socket factory; defaults to a real `ws` socket. Injected by tests. */
  readonly socketFactory?: ControllerSocketFactory;
}

export interface ControllerClient {
  /** Open the socket and resolve once it is connected and hello has been sent. */
  connect(): Promise<void>;
  /**
   * Send a command and resolve with its `command-response` frame (or reject
   * with the response's `error`, a timeout, or 'Bridge connection lost').
   */
  sendCommand<A extends PageAction>(
    action: A,
    params: PageActionParams[A],
    options?: { readonly timeoutMs?: number },
  ): Promise<CommandResponse>;
  /** Register an observation listener; returns an unsubscribe function. */
  onObservation(listener: (observation: Observation) => void): () => void;
  /** Stop for good: cancel reconnect, reject pending commands, close the socket. */
  close(): void;
  /** Test-visible count of in-flight commands. */
  pendingCount(): number;
}

interface PendingCommand {
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const realSocketFactory: ControllerSocketFactory = (url) => {
  const ws = new WsWebSocket(url);
  return {
    get readyState(): number {
      return ws.readyState;
    },
    send(data: string): void {
      ws.send(data);
    },
    close(): void {
      ws.close();
    },
    on(
      event: "open" | "close" | "error" | "message",
      listener: (data?: unknown) => void,
    ): void {
      if (event === "message") {
        ws.on("message", (data: RawData, isBinary: boolean) => {
          if (isBinary) return;
          listener(frameToString(data));
        });
      } else if (event === "open") {
        ws.on("open", () => {
          listener();
        });
      } else if (event === "close") {
        ws.on("close", () => {
          listener();
        });
      } else {
        ws.on("error", () => {
          listener();
        });
      }
    },
  };
};

function frameToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

export function createControllerClient(
  options: ControllerClientOptions = {},
): ControllerClient {
  const url = options.url ?? resolveBridgeUrl();
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const factory = options.socketFactory ?? realSocketFactory;

  let socket: ControllerSocket | null = null;
  let connected = false;
  let closed = false;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let awaitingOpen: (() => void) | null = null;

  const pending = new Map<string, PendingCommand>();
  const observers = new Set<(observation: Observation) => void>();

  const rejectAllPending = (message: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(message));
    }
  };

  const handleMessage = (data: unknown): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }

    if (isCommandResponse(parsed)) {
      const entry = pending.get(parsed.id);
      if (entry === undefined) return; // unknown / duplicate / already timed out
      pending.delete(parsed.id);
      clearTimeout(entry.timer);
      if (parsed.error !== undefined) {
        entry.reject(new Error(parsed.error));
      } else {
        entry.resolve(parsed);
      }
      return;
    }

    if (isObservation(parsed)) {
      for (const listener of observers) {
        try {
          listener(parsed);
        } catch {
          // one throwing subscriber must not stop delivery to the rest
        }
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  };

  function openSocket(): void {
    if (closed || socket !== null) return;
    const ws = factory(url);
    socket = ws;

    ws.on("open", () => {
      connected = true;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      ws.send(JSON.stringify({ kind: "hello", role: "controller" }));
      if (awaitingOpen !== null) {
        const resolve = awaitingOpen;
        awaitingOpen = null;
        resolve();
      }
    });

    ws.on("message", (data) => {
      handleMessage(data);
    });

    // A failed connection emits 'error' then 'close'; reconnect is driven from
    // 'close' alone so the delay is not scheduled twice.
    ws.on("error", () => {
      /* handled via 'close' */
    });

    ws.on("close", () => {
      socket = null;
      connected = false;
      rejectAllPending("Bridge connection lost");
      if (!closed) scheduleReconnect();
    });
  }

  const connect = async (): Promise<void> => {
    if (closed) throw new Error("Controller client is closed");
    if (connected) return;
    await new Promise<void>((resolve) => {
      awaitingOpen = resolve;
      openSocket();
    });
  };

  const sendCommand = <A extends PageAction>(
    action: A,
    params: PageActionParams[A],
    callOptions?: { readonly timeoutMs?: number },
  ): Promise<CommandResponse> => {
    const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs;
    return new Promise<CommandResponse>((resolve, reject) => {
      if (
        socket === null ||
        !connected ||
        socket.readyState !== READY_STATE_OPEN
      ) {
        reject(new Error("Controller is not connected to the relay"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(
            new Error(`Command "${action}" timed out after ${timeoutMs}ms`),
          );
        }
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ kind: "command", id, action, params }));
    });
  };

  const onObservation = (
    listener: (observation: Observation) => void,
  ): (() => void) => {
    observers.add(listener);
    return () => {
      observers.delete(listener);
    };
  };

  const close = (): void => {
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    awaitingOpen = null;
    rejectAllPending("Bridge connection lost");
    socket?.close();
    socket = null;
    connected = false;
  };

  return {
    connect,
    sendCommand,
    onObservation,
    close,
    pendingCount: () => pending.size,
  };
}
