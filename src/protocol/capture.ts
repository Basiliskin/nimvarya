/**
 * The capture contract — the single source of truth for the shape of a
 * console message / network request as it travels from the page's own JS
 * world, through the content-script forwarder, into the service worker's
 * per-tab ring buffers, and back out through the read tools.
 *
 * Why a dedicated module:
 *
 *   - Three separate scripts (the MAIN-world wrapper, the ISOLATED
 *     content-script forwarder, and the service worker) exchange the same
 *     records across two untrusted message boundaries. If each defined its
 *     own shape they would drift; putting the shape, the byte caps, and the
 *     validator in one module means every consumer imports one contract
 *     instead of inventing one.
 *   - The trust boundary lives at the content-script `message` listener and
 *     again at the service worker `runtime.onMessage` listener. Both MUST
 *     validate every inbound envelope before touching it; `isCaptureEnvelope`
 *     is the one predicate that gates those boundaries. A page that guesses
 *     the namespace string and posts a forged envelope would otherwise reach
 *     the buffers, so the namespace is a non-guessable constant (not
 *     "nimvarya" or "capture") and is enforced on every envelope.
 *
 * This module imports nothing from the rest of the package and references no
 * browser API. The only ambient globals it relies on (`TextEncoder` /
 * `TextDecoder`) are part of the platform in every target (browser MAIN world,
 * content script, and Node for the tests).
 */

/**
 * The single namespace string the page script stamps on every outbound
 * `window.postMessage` capture envelope, and the forwarder + service worker
 * require on every inbound envelope. Generated once, kept stable forever.
 */
export const CAPTURE_NAMESPACE = "__chrome_bridge_capture_v1__" as const;

/** The discriminant that separates console capture from network capture. */
export type CaptureChannel = "console" | "network";

/** Hard cap on the serialized console text of a single entry, in UTF-8 bytes. */
export const MAX_CONSOLE_TEXT_BYTES = 8192;

/** Hard cap on the response body preview of a single network entry, in UTF-8 bytes. */
export const MAX_BODY_PREVIEW_BYTES = 4096;

/** The console levels the page script captures, including uncaught errors. */
type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug" | "uncaught";

/** One bounded console message as captured at capture time. */
export interface ConsoleEntry {
  readonly level: ConsoleLevel;
  /** The console args, already serialized to a single bounded string. */
  readonly text: string;
  /** Epoch milliseconds. */
  readonly timestamp: number;
  /** True when `text` was cut to `MAX_CONSOLE_TEXT_BYTES`. */
  readonly truncated: boolean;
}

/**
 * One network request as captured at capture time. Metadata is always present;
 * `status` / `contentType` / `bodyPreview` are nullable because a request can
 * fail (status `null`) or the response can carry no textual body (preview
 * `null`) — they are declared `| null`, never optional, so a missing property
 * is a wire-format violation rather than a legitimate "absent" value.
 */
export interface NetworkEntry {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  /** HTTP status, or null when the request failed before a response arrived. */
  readonly status: number | null;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  readonly contentType: string | null;
  /** Bounded text-only preview of the response body, or null when none recorded. */
  readonly bodyPreview: string | null;
  /** True when `bodyPreview` was cut to `MAX_BODY_PREVIEW_BYTES`. */
  readonly truncated: boolean;
  /** True when the request failed (network error or non-2xx final). */
  readonly failed: boolean;
  /** Epoch milliseconds. */
  readonly timestamp: number;
}

/**
 * The tamper-resistant envelope exchanged over both message boundaries. A
 * discriminated union on `channel`: narrowing to one channel narrows `entry`
 * to the matching shape, so a consumer that checks `channel` never re-guards
 * `entry`.
 */
export type CaptureEnvelope =
  | {
      readonly ns: typeof CAPTURE_NAMESPACE;
      readonly channel: "console";
      readonly entry: ConsoleEntry;
    }
  | {
      readonly ns: typeof CAPTURE_NAMESPACE;
      readonly channel: "network";
      readonly entry: NetworkEntry;
    };

const CONSOLE_LEVELS: ReadonlySet<string> = new Set([
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "uncaught",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConsoleLevel(value: unknown): value is ConsoleLevel {
  return typeof value === "string" && CONSOLE_LEVELS.has(value);
}

function isConsoleEntry(value: unknown): value is ConsoleEntry {
  if (!isRecord(value)) return false;
  return (
    isConsoleLevel(value["level"]) &&
    typeof value["text"] === "string" &&
    typeof value["timestamp"] === "number" &&
    typeof value["truncated"] === "boolean"
  );
}

function isNetworkEntry(value: unknown): value is NetworkEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value["requestId"] === "string" &&
    typeof value["method"] === "string" &&
    typeof value["url"] === "string" &&
    (value["status"] === null || typeof value["status"] === "number") &&
    typeof value["durationMs"] === "number" &&
    (value["contentType"] === null ||
      typeof value["contentType"] === "string") &&
    (value["bodyPreview"] === null ||
      typeof value["bodyPreview"] === "string") &&
    typeof value["truncated"] === "boolean" &&
    typeof value["failed"] === "boolean" &&
    typeof value["timestamp"] === "number"
  );
}

/**
 * Type-narrowing predicate: returns true only when `value` is a fully shaped,
 * correctly-paired `CaptureEnvelope`. It never throws, checks `ns` and
 * `channel` first, and enforces the channel/entry pairing — a console-shaped
 * entry under `channel: "network"` is rejected, and vice versa.
 */
export function isCaptureEnvelope(value: unknown): value is CaptureEnvelope {
  if (!isRecord(value)) return false;
  if (value["ns"] !== CAPTURE_NAMESPACE) return false;
  if (value["channel"] === "console") {
    return isConsoleEntry(value["entry"]);
  }
  if (value["channel"] === "network") {
    return isNetworkEntry(value["entry"]);
  }
  return false;
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a code
 * point. Uses code-point iteration so surrogate pairs stay whole; the result
 * of a truncation always ends on a complete character and its encoded byte
 * length is always <= `maxBytes`. Pure: no module state, same input yields
 * same output.
 */
export function boundText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();

  if (maxBytes <= 0) {
    return { text: "", truncated: text.length > 0 };
  }

  const whole = encoder.encode(text);
  if (whole.length <= maxBytes) {
    return { text, truncated: false };
  }

  // whole.length > maxBytes: accumulate complete code points (for...of keeps
  // surrogate pairs together) until the next one would exceed maxBytes.
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const len = encoder.encode(ch).length;
    if (bytes + len > maxBytes) {
      return { text: out, truncated: true };
    }
    bytes += len;
    out += ch;
  }

  // Unreachable when whole.length > maxBytes and maxBytes > 0, but the guard
  // keeps the return type total.
  return { text: out, truncated: false };
}
