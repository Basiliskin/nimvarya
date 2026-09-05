/**
 * Extension-side bridge client — one reconnecting WebSocket to the relay.
 *
 * Ported from boky's infrastructure bridge client with the entire
 * dashboard-request / dashboard-response / broadcast half removed (that
 * half was the only thing pulling in boky's messaging layer). Behaviour kept:
 *
 *  - dials eagerly at construction (the standalone worker has nothing else to
 *    trigger a lazy dial);
 *  - sends `{ kind: "hello", role: "extension" }` as the first frame on open;
 *  - buffers outbound frames in a bounded outbox until the socket is open;
 *  - for every inbound `command` frame, calls `onCommand` and writes back the
 *    resulting `command-response` (always exactly one, even on failure);
 *  - after any close, reconnects once after a fixed delay, re-sending hello.
 */

import { isCommand } from "../protocol/guards.js";
import type { BridgeMessage, CommandResponse } from "../protocol/types.js";

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8766";
const DEFAULT_RECONNECT_DELAY_MS = 2000;
const READY_STATE_OPEN = 1;

/** Max frames held in the pre-open outbox; the oldest is dropped past this. */
export const OUTBOX_LIMIT = 100;

export type BridgeCommandHandler = (
  command: Extract<BridgeMessage, { kind: "command" }>,
) => Promise<CommandResponse> | CommandResponse;

/** The subset of the WebSocket API the bridge client depends on. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "error",
    listener: () => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

export type BridgeSocketFactory = (url: string) => BridgeSocket;

export interface BridgeClientOptions {
  readonly url: string;
  readonly socketFactory: BridgeSocketFactory;
  readonly onCommand: BridgeCommandHandler;
  readonly reconnectDelayMs?: number;
}

export interface BridgeClient {
  /** Enqueue a frame, buffering it (bounded) until the socket is open. */
  send(message: BridgeMessage): void;
  /** Stop for good: cancel any pending reconnect and close the socket. */
  stop(): void;
}

export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const reconnectDelayMs =
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let socket: BridgeSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const outbox: BridgeMessage[] = [];

  const writeNow = (message: BridgeMessage): void => {
    if (socket && socket.readyState === READY_STATE_OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const enqueue = (message: BridgeMessage): void => {
    if (socket && socket.readyState === READY_STATE_OPEN) {
      writeNow(message);
      return;
    }
    outbox.push(message);
    while (outbox.length > OUTBOX_LIMIT) outbox.shift();
  };

  const flushOutbox = (): void => {
    while (outbox.length > 0) {
      const message = outbox.shift();
      if (message) writeNow(message);
    }
  };

  const handleIncoming = async (event: { data: unknown }): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return; // malformed JSON — ignore, socket stays usable
    }
    if (!isCommand(parsed)) return; // hello / observation / response / junk

    let response: CommandResponse;
    try {
      response = await options.onCommand(parsed);
    } catch (error) {
      response = {
        kind: "command-response",
        id: parsed.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    enqueue(response);
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  function connect(): void {
    if (stopped || socket) return;
    const ws = options.socketFactory(options.url);
    socket = ws;

    ws.addEventListener("open", () => {
      writeNow({ kind: "hello", role: "extension" });
      flushOutbox();
    });
    ws.addEventListener("message", (event) => {
      void handleIncoming(event);
    });
    ws.addEventListener("close", () => {
      socket = null;
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  connect();

  return {
    send: enqueue,
    stop: (): void => {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
