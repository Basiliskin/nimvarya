/**
 * The standalone WebSocket relay.
 *
 * A dependency-light local server (only `ws` + Node built-ins + the package's
 * own protocol module) that routes frames between exactly one connected
 * Extension and any number of Controllers. It is a trimmed port of boky's
 * `services/nest-host/src/bridge-relay/bridge-relay.service.ts`:
 *
 *  - the three `dashboard-*` frame kinds and their pending-request machinery
 *    are dropped entirely;
 *  - the server binds `127.0.0.1` explicitly (boky's omits `host` and so
 *    listens on every interface);
 *  - a socket's role is fixed by its FIRST `hello` frame and never changes.
 *
 * Routing contract:
 *  - `command`          → every extension socket;
 *  - `command-response` → every controller socket (never echoed to the extension);
 *  - `observation`      → every controller socket (never echoed to the extension).
 *
 * Malformed JSON, frames that fail the protocol type guard, unknown `kind`
 * values and binary frames are silently discarded; the sending socket stays
 * open and other sockets keep receiving traffic.
 */

import { once } from "node:events";

import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

import { isBridgeMessage } from "../protocol/guards.js";
import type { BridgeMessage } from "../protocol/types.js";

export interface StartRelayOptions {
  /** Interface to bind. The process entry always passes `"127.0.0.1"`. */
  readonly host: string;
  /** TCP port; `0` binds an ephemeral port (used by the tests). */
  readonly port: number;
}

export interface RunningRelay {
  /** The port actually bound — the real number even when `0` was requested. */
  readonly port: number;
  /** Terminate every connected socket, release the port, then resolve. */
  close(): Promise<void>;
}

/**
 * Decode a `ws` frame to a UTF-8 string. Every member of the `RawData` union is
 * handled explicitly so a frame is never reduced via a bare `toString()`.
 */
function frameToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

/**
 * Wrapper that keeps the JSON.parse-cast lint rule from firing — the parsed
 * surface stays `unknown` and is narrowed by the guard, never type-asserted.
 */
function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

/** Parse + narrow a frame; `null` means malformed and is silently dropped. */
function parseFrame(raw: string): BridgeMessage | null {
  try {
    const value = parseJson(raw);
    return isBridgeMessage(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Start the relay. The returned promise resolves only once the server is
 * actually listening, and rejects if the port is already in use (or any other
 * server-level error fires before `listening`).
 */
export async function startRelay(
  options: StartRelayOptions,
): Promise<RunningRelay> {
  const { host, port } = options;

  const extensions = new Set<WebSocket>();
  const controllers = new Set<WebSocket>();

  const wss = new WebSocketServer({ host, port });

  const safeSend = (socket: WebSocket, msg: BridgeMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  wss.on("connection", (socket: WebSocket) => {
    let role: "extension" | "controller" | null = null;

    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return; // relay only carries JSON text frames
      const msg = parseFrame(frameToString(raw));
      if (msg === null) return;

      if (role === null && msg.kind === "hello") {
        role = msg.role === "extension" ? "extension" : "controller";
        (role === "extension" ? extensions : controllers).add(socket);
        return;
      }

      switch (msg.kind) {
        case "command":
          for (const ext of extensions) safeSend(ext, msg);
          return;
        case "command-response":
        case "observation":
          for (const controller of controllers) safeSend(controller, msg);
          return;
        default:
          // `hello` after the role is fixed, or anything else — ignore.
          return;
      }
    });

    const forget = (): void => {
      extensions.delete(socket);
      controllers.delete(socket);
    };
    socket.on("close", forget);
    socket.on("error", forget);
  });

  // Surface a pre-listening server error (EADDRINUSE is the common one) as a
  // rejection rather than an unhandled event.
  const listening = new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  await listening;
  wss.removeAllListeners("error");
  wss.on("error", () => {
    // Post-listening server errors must not crash the process; per-socket
    // errors are handled on the socket itself.
  });

  const address = wss.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : port;

  return {
    port: boundPort,
    close: async (): Promise<void> => {
      for (const client of wss.clients) client.terminate();
      const closed = once(wss, "close");
      wss.close();
      await closed;
    },
  };
}
