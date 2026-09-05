/**
 * The stdio MCP server: it advertises the page actions as discrete tools
 * (`listTools`) and forwards each `tools/call` through a Controller client to
 * the extension, shaping the reply into MCP content blocks.
 *
 * Result mapping:
 *  - a text/JSON result → a single `text` content block;
 *  - `captureTab` is mode-discriminated — `viewport` (the default, the current
 *    rendered viewport), `element` (a single-element clip via `elementRef`), or
 *    `full-page` (the whole scrollable document, via `captureBeyondViewport`);
 *  - `captureTab` with a real image → an `image` block (`mimeType: image/png`,
 *    pure base64 with any `data:...;base64,` prefix stripped) PLUS a sibling
 *    `text` block carrying `{ captured, width, height, clipped }` and, when the
 *    downscale ladder produced the capture, `appliedScale` / `attempts` so a
 *    client can cross-check the returned image's pixel dimensions and know how
 *    a downscaled capture was made;
 *  - `captureTab` with a structured non-image outcome (too-large /
 *    element-not-found / zero-area / tab-unavailable) → a `text` block with
 *    `isError: true`;
 *  - an over-large `executeScript` / `evaluatePage` /
 *    `readConsoleMessages` / `readNetworkRequests` value → a `text` block with
 *    `isError: true` carrying the size-ceiling info, so a caller can tell "too
 *    large to return" from a genuine error (which surfaces via `response.error`);
 *  - an `{ error }` reply or a transport failure (relay down, timeout) →
 *    `isError: true` with a readable message naming the action;
 *  - an unknown tool name → `isError: true` WITHOUT touching the client.
 *
 * The SDK's low-level `Server` is used (not the high-level `McpServer`) to match
 * boky's `extension-mcp.mjs` wiring.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import { isPageAction } from "../protocol/actions.js";
import type { PageAction } from "../protocol/actions.js";
import type {
  CaptureTabImageResult,
  CommandResponse,
} from "../protocol/types.js";

import type { OversizeResult } from "../extension/size-limits.js";

import { listTools } from "./tool-catalog.js";

/** The MCP server identity advertised to clients. */
export const MCP_SERVER_NAME = "chrome-bridge";
const MCP_SERVER_VERSION = "0.0.0";

/**
 * The tool names whose serialised result is byte-capped: a value that exceeds
 * its ceiling is replaced with the shared `OversizeResult` sentinel
 * (`{ tooLarge, actualBytes, limitBytes }`) rather than sent in full. The
 * `isOversizeResult` check in `handleToolCall` is gated on membership in this
 * set so a caller sees that sentinel as an `isError: true` JSON text block, not
 * a silent success payload. Adding a new size-capped tool means adding its name
 * here AND to the size-ceiling check that produces `OversizeResult`.
 */
const OVERSIZE_RESULT_TOOL_NAMES = new Set<string>([
  "executeScript",
  "evaluatePage",
  "readConsoleMessages",
  "readNetworkRequests",
]);

/**
 * The single method the server needs from a Controller client. `ControllerClient`
 * from `../controller/controller-client.ts` satisfies this once adapted in
 * `main.ts` — the wire params are opaque here, so this signature is intentionally
 * loose (correlation of action↔params is enforced at the typed call sites, not
 * at the MCP boundary where arguments arrive as untyped JSON).
 */
export interface CommandSender {
  sendCommand(
    action: PageAction,
    params: Readonly<Record<string, unknown>>,
  ): Promise<CommandResponse>;
}

export interface McpServerDeps {
  readonly client: CommandSender;
}

function textResult(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

/**
 * Render a real `captureTab` image result as an MCP image content block plus a
 * sibling text block carrying the returned image's pixel metadata (`captured`,
 * `width`, `height`, `clipped`) and, when the downscale ladder produced it, the
 * applied render scale and attempt count (`appliedScale`, `attempts`) so an MCP
 * client can cross-check the picture against a measured element rect and know
 * how a downscaled capture was produced. A structured non-image outcome never
 * reaches this helper — those route to a single text/`isError` block (see
 * below).
 */
function captureImageResult(image: CaptureTabImageResult): CallToolResult {
  const metadata = JSON.stringify(
    {
      captured: image.captured,
      width: image.width,
      height: image.height,
      clipped: image.clipped,
      // Both are optional on the type so a hand-built result from before the
      // downscale ladder still serialises; every real capture carries them.
      ...(image.appliedScale !== undefined
        ? { appliedScale: image.appliedScale }
        : {}),
      ...(image.attempts !== undefined ? { attempts: image.attempts } : {}),
    },
    null,
    2,
  );
  return {
    content: [
      {
        type: "image",
        data: stripDataUrlPrefix(image.dataUrl),
        mimeType: "image/png",
      },
      { type: "text", text: metadata },
    ],
  };
}

function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.replace(/^data:[^;,]+;base64,/, "");
}

/**
 * Narrow a `captureTab` result to its image variant. A real capture has
 * `captured: true` plus a string `dataUrl`; every structured non-image outcome
 * (`too-large` / `element-not-found` / `zero-area` / `tab-unavailable`) is
 * `captured: false` and must NOT take the image path.
 */
function isCaptureTabImage(result: unknown): result is CaptureTabImageResult {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { captured?: unknown }).captured === true &&
    typeof (result as { dataUrl?: unknown }).dataUrl === "string"
  );
}

/**
 * Narrow a non-captureTab tool result to its oversize variant. `executeScript`,
 * `evaluatePage`, `readConsoleMessages` and `readNetworkRequests` return an
 * `OversizeResult` (size-limits.ts) — `{ tooLarge: true, actualBytes,
 * limitBytes }` — as a plain result field when the serialised value exceeded the
 * size ceiling, instead of throwing. A normal value is `{ value: ... }` (or a
 * read tool's `CaptureReadResult`), so checking the top-level `tooLarge` flag is
 * the discriminated test. Genuine failures never reach here: they surface as
 * `response.error` above and are handled before this check.
 */
function isOversizeResult(result: unknown): result is OversizeResult {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { tooLarge?: unknown }).tooLarge === true &&
    typeof (result as { actualBytes?: unknown }).actualBytes === "number" &&
    typeof (result as { limitBytes?: unknown }).limitBytes === "number"
  );
}

/**
 * Handle one `tools/call`. Exported so the mapping can be unit-tested directly
 * with a fake `CommandSender`, without spinning up a transport.
 */
export async function handleToolCall(
  deps: McpServerDeps,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  if (!isPageAction(toolName)) {
    return textResult(`Unknown tool: ${toolName}`, true);
  }
  try {
    const response = await deps.client.sendCommand(toolName, args);
    if (response.error !== undefined) {
      return textResult(
        `chrome-bridge "${toolName}" failed: ${response.error}`,
        true,
      );
    }
    if (toolName === "captureTab") {
      if (isCaptureTabImage(response.result)) {
        return captureImageResult(response.result);
      }
      // A structured non-image captureTab outcome (too-large / element-not-found
      // / zero-area / tab-unavailable) is a result-level failure — surface it as
      // a JSON text block with isError set, never as an (empty) image block.
      return textResult(JSON.stringify(response.result, null, 2), true);
    }
    if (OVERSIZE_RESULT_TOOL_NAMES.has(toolName)) {
      if (isOversizeResult(response.result)) {
        // A too-large value is a result-level failure mirroring captureTab's
        // structured non-image outcome: a JSON text block with isError set, so
        // an MCP caller can distinguish "too large to return" from a genuine
        // error (which surfaces via response.error above). Covers the tools
        // whose serialised result is byte-capped — executeScript, evaluatePage,
        // and (since horizon 17) the readConsoleMessages / readNetworkRequests
        // readers. The check never runs for captureTab/findElement or other
        // tools, whose results are not capped this way.
        return textResult(JSON.stringify(response.result, null, 2), true);
      }
    }
    return textResult(JSON.stringify(response.result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`chrome-bridge "${toolName}" failed: ${message}`, true);
  }
}

/** Build the MCP `Server` with the tool list and call handlers wired in. */
export function createMcpServer(deps: McpServerDeps): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: listTools(),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    (request): Promise<CallToolResult> =>
      handleToolCall(deps, request.params.name, request.params.arguments ?? {}),
  );

  return server;
}
