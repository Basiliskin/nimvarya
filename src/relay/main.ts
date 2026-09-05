/**
 * Process entry for the relay: `npm run relay` from `tools/chrome-bridge`.
 *
 * Binds `127.0.0.1` only. The port defaults to 8766 (distinct from boky's 8765
 * so both relays can run at once) and is overridden by `CHROME_BRIDGE_PORT`; a
 * non-numeric or out-of-range value fails loudly instead of silently falling
 * back.
 */

import { pathToFileURL } from "node:url";

import { startRelay } from "./relay.js";

export const DEFAULT_RELAY_PORT = 8766;
const HOST = "127.0.0.1";

/**
 * Resolve the listen port from a raw `CHROME_BRIDGE_PORT` value. Throws (rather
 * than falling back to the default) on a non-integer or out-of-range value so a
 * typo fails loudly instead of starting on the wrong port.
 */
export function resolveRelayPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RELAY_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `CHROME_BRIDGE_PORT must be an integer between 1 and 65535, got "${raw}"`,
    );
  }
  return parsed;
}

export async function main(): Promise<void> {
  const port = resolveRelayPort(process.env["CHROME_BRIDGE_PORT"]);
  const relay = await startRelay({ host: HOST, port });
  process.stdout.write(
    `chrome-bridge relay listening on ws://${HOST}:${relay.port}\n`,
  );

  const shutdown = (): void => {
    void relay.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
