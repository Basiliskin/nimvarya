/**
 * Process entry for the MCP server: launched by `tools/chrome-bridge/bin/mcp.mjs`
 * (registered as `chrome-bridge` in the repo-root `.mcp.json`) and by
 * `npm run mcp`.
 *
 * stdio hygiene: stdout carries only JSON-RPC frames (the SDK's
 * `StdioServerTransport` owns it) — every diagnostic goes to stderr. The relay
 * connection is started but NOT awaited, so the server answers `initialize` /
 * `tools/list` immediately even when the relay is down; the Controller client's
 * own backoff reconnects in the background and individual `tools/call`s then
 * fail with `isError: true` until it is up.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createControllerClient,
  resolveBridgeUrl,
} from "../controller/controller-client.js";
import { createMcpServer } from "./server.js";
import type { CommandSender } from "./server.js";

export interface McpMainDeps {
  /** Build the command sender the MCP server forwards calls through. */
  readonly createSender: () => {
    readonly sender: CommandSender;
    /** Begin connecting to the relay (must not reject / must not block). */
    start: () => void;
  };
  /** Attach a transport to the built server (real: stdio). */
  readonly attachTransport: (
    server: ReturnType<typeof createMcpServer>,
  ) => Promise<void>;
  /** Diagnostic sink — must never be stdout. */
  readonly logError: (message: string) => void;
}

export const defaultMcpMainDeps: McpMainDeps = {
  createSender: () => {
    const client = createControllerClient();
    // The wire params are opaque at the MCP boundary — arguments arrive as
    // untyped JSON, so the action↔params correlation `ControllerClient` enforces
    // cannot be re-established here. Forward them through untyped, once.
    const sender: CommandSender = {
      sendCommand: (action, params) => client.sendCommand(action, params),
    };
    return {
      sender,
      start: () => {
        void client.connect().catch(() => {
          /* the client's own backoff keeps retrying */
        });
      },
    };
  },
  attachTransport: async (server) => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  },
  logError: (message) => {
    process.stderr.write(`[chrome-bridge mcp] ${message}\n`);
  },
};

export async function runMcpServer(
  deps: McpMainDeps = defaultMcpMainDeps,
): Promise<void> {
  const { sender, start } = deps.createSender();
  start();
  deps.logError(`connecting to relay at ${resolveBridgeUrl()}`);
  const server = createMcpServer({ client: sender });
  await deps.attachTransport(server);
}
