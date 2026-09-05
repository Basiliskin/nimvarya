/**
 * The generic page-action handlers.
 *
 * Every handler resolves its target through the dedicated sandbox tab's
 * `sandboxTab.resolveTabId()`, so commands always act on one auto-created,
 * reused tab by tabId — not whatever the human happens to have focused
 * (`ports.queryActiveTab()` is gone from the resolve path). `captureTab` uses
 * the CDP debugger port (`captureDebugger.captureScreenshot`) so it can capture
 * the deliberately unfocused sandbox tab, which the window-scoped
 * `captureVisibleTab` could not. Each handler validates its own params by hand
 * and returns an `{ error }` sentinel — without calling any chrome port — on bad
 * input, rather than throwing.
 *
 * `readPage` / `getPageText` apply a `maxChars` cap (default 200 000) and
 * report `truncated` + `totalChars`. `captureTab` is left uncapped here — how
 * to present a large PNG is the MCP server's decision (a later phase).
 *
 * The DOM-side `func` bodies passed to `ports.executeScript` are copied
 * verbatim in behaviour from boky's background command handler.
 */

import type { PageAction } from "../protocol/actions.js";
import type {
  CaptureTabFailureResult,
  CaptureTabMode,
  CaptureTabResult,
  FindElementMatch,
} from "../protocol/types.js";
import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT } from "./capture-buffer.js";
import type { CaptureStore } from "./capture-store.js";
import type { Handler, HandlerOutcome } from "./command-dispatch.js";
import type {
  CaptureScreenshotOptions,
  DebuggerPorts,
  ScrollIntent,
  ScrollOutcome,
} from "./debugger-ports.js";
import type { ChromePorts } from "./ports.js";
import type { SandboxTabPorts } from "./sandbox-ports.js";
import { waitForCondition } from "./wait-condition.js";
import type { WaitCondition } from "./wait-condition.js";
import { buildOversizeResult, checkSizeLimit } from "./size-limits.js";

export const DEFAULT_MAX_CHARS = 200_000;

/**
 * Cap on the JSON length of an `executeScript` result. A larger result resolves
 * to a structured too-large result (see size-limits.ts) rather than being sent
 * raw across the wire or thrown.
 */
export const MAX_EXECUTE_SCRIPT_RESULT_CHARS = 1_000_000;

/**
 * The `captureTab` screenshot **size policy** — the constants that govern how an
 * oversized screenshot is handled. A capture whose encoded base64 length exceeds
 * the ceiling is automatically re-taken smaller down the ladder until a rung fits
 * (reporting the applied scale + attempt count) or the give-up floor is still
 * over the ceiling (a defined non-throwing `too-large` outcome carrying the
 * measured size, the ceiling, the floor, and the attempt count). The ladder is
 * scale-only PNG — a JPEG/quality rung is deliberately out of scope (see the
 * deferred list; a scale-only ladder is a complete delivery).
 *
 *  1. `MAX_SCREENSHOT_BASE64_CHARS` — the base64 ceiling.
 *  2. `SCREENSHOT_DOWNSCALE_LADDER_SCALES` — the ordered, strictly-decreasing
 *     render scales a too-large capture is re-tried at.
 *  3. `SCREENSHOT_DOWNSCALE_FLOOR_SCALE` — the give-up floor (the smallest scale
 *     the ladder ever applies, derived from the ladder's last rung).
 *
 * Measured live 2026-09-04 on the dedicated unfocused sandbox tab
 * (en.wikipedia.org/wiki/Chromium_(web_browser), dpr 2) a default viewport
 * capture returns ~845KB of base64 (844960 chars); the ceiling value sat above
 * that with headroom and is kept. Sibling to `MAX_EXECUTE_SCRIPT_RESULT_CHARS`,
 * scoped to the screenshot result (a cross-tool cap is a separate open question).
 */
export const MAX_SCREENSHOT_BASE64_CHARS = 1_200_000;

/**
 * The ordered render scales the `captureTab` downscale ladder applies to an
 * over-large screenshot, strictly decreasing in (0,1]. A viewport capture at
 * these scales is produced by the debugger port's whole-viewport scaled-clip
 * option; an element capture lowers its clip's `scale` field. The values are
 * chosen so a few rungs reliably bring a dense dpr-2 page under the ceiling.
 */
export const SCREENSHOT_DOWNSCALE_LADDER_SCALES = [0.75, 0.5, 0.33] as const;

/**
 * The give-up floor — the smallest render scale the downscale ladder ever
 * applies, and the last rung. A capture still over the ceiling here yields the
 * `too-large` give-up outcome (`captured: false` carrying size, ceiling, this
 * floor, and the attempt count). Asserted equal to the ladder's last element by
 * the unit tests so it can never drift out of sync with a re-tuned ladder.
 */
export const SCREENSHOT_DOWNSCALE_FLOOR_SCALE = 0.33;

/**
 * Maximum number of matched elements `findElement` returns. Applied IN-PAGE
 * before the structured-clone boundary, so a 5 000-match selector still only
 * serializes `MAX_FIND_ELEMENT_MATCHES` descriptors across the wire. The
 * `total` field reports the pre-slice count so a caller can tell the cap fired.
 */
export const MAX_FIND_ELEMENT_MATCHES = 50;

/**
 * Maximum visible `innerText` length per matched element returned by
 * `findElement`. Applied IN-PAGE per element; `truncated` is set on the result
 * when any element's text was clipped at this length.
 */
export const MAX_ELEMENT_TEXT_CHARS = 500;

/**
 * Cap on the JSON length of a `readConsoleMessages` result — the WHOLE
 * serialised `CaptureRead` (the `entries` array plus the `nextSince` /
 * `dropped` / `truncated` metadata), not any single console entry. A larger
 * read resolves to a structured too-large result (see size-limits.ts) rather
 * than sending an unbounded body across the wire. Measured live 2026-09-04 on
 * a heavy page (en.wikipedia.org) a 500-entry console read — the
 * `MAX_READ_LIMIT` window — serialised to ~76 671 chars under the
 * `MAX_CONSOLE_TEXT_BYTES=8192` per-entry cap; the ceiling sits well above
 * that with headroom while still bounding a genuinely huge console dump.
 * Sibling to `MAX_EXECUTE_SCRIPT_RESULT_CHARS`, scoped to the console-read
 * result (a cross-tool cap is a separate open question).
 */
export const MAX_CONSOLE_READ_RESULT_CHARS = 1_000_000;

/**
 * Cap on the JSON length of a `readNetworkRequests` result — the WHOLE
 * serialised `CaptureRead` (the `entries` array plus the `nextSince` /
 * `dropped` / `truncated` metadata), not any single network entry. Network
 * entries are far larger than console ones (each body preview is already
 * capped at `MAX_BODY_PREVIEW_BYTES=4096`), so this ceiling is higher than the
 * console one. Measured live 2026-09-04 on a heavy page (en.wikipedia.org) a
 * 500-entry network read — the `MAX_READ_LIMIT` window — serialised to ~2 331
 * 618 chars, which shows the count-based `limit` alone does NOT bound a network
 * read to a small payload. The ceiling sits just above that measured
 * worst-case so a legitimate heavy read still passes while an anomalous larger
 * one is caught. Sibling to `MAX_CONSOLE_READ_RESULT_CHARS`, scoped to the
 * network-read result (a cross-tool cap is a separate open question).
 */
export const MAX_NETWORK_READ_RESULT_CHARS = 3_000_000;

/**
 * The plain `{ error }` sentinel the `scrollPage` handler returns when its params
 * are malformed. `amountPx` must be a non-negative finite number and `toBottom` a
 * boolean when present; this is the message a caller sees, matching the two-field
 * param model with no `direction` / repeat fields.
 */
const SCROLL_PARAM_ERROR =
  "scrollPage accepts an optional numeric amountPx and an optional boolean toBottom";

/**
 * `chrome.tabs.goBack` / `goForward` reject when the tab has no history entry in
 * that direction. The handler maps that rejection to a dedicated sentinel rather
 * than letting `guard()` surface the raw Chrome message, so a caller can tell
 * "there was nowhere to go" apart from a genuine failure.
 */
function noHistoryOutcome(direction: "back" | "forward"): HandlerOutcome {
  return {
    error: `the sandbox tab has no ${direction} history entry to navigate to`,
  };
}

/**
 * Validate one caller-supplied pointer coordinate. `x` and `y` must each be a
 * non-negative integer; a negative, fractional, `NaN`/`Infinity`, or non-numeric
 * value is rejected with an `{ error }` sentinel rather than coerced, and the
 * rejection happens before any in-page dispatch runs.
 */
function resolveCoordinate(
  action: "clickAt" | "hover",
  axis: "x" | "y",
  raw: unknown,
): number | { error: string } {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return {
    error: `${action} requires \`${axis}\` to be a non-negative integer`,
  };
}

/**
 * Turn the page-controlled pointer-dispatch return value into a JSON-safe
 * `HandlerOutcome`. A missing / malformed envelope (script injection blocked)
 * resolves to an `{ error }` sentinel; otherwise the result is rebuilt from
 * primitives so no DOM node / function / circular value can reach the wire.
 */
function coercePointerOutcome(
  action: "clickAt" | "hover",
  raw: unknown,
): HandlerOutcome {
  if (!isRecord(raw)) {
    return {
      error: `${action} returned no result — the page may block script injection via its Content-Security-Policy`,
    };
  }
  return {
    result: {
      found: raw["found"] === true,
      dispatched: asCount(raw["dispatched"]),
    },
  };
}

/**
 * Coerce an unknown page value to a string-or-null. Empty strings are also
 * `null` (the in-page `attr` helper returns `null` for absent or empty
 * attributes, and the wire convention is `null` for absent — never `""`).
 */
function asStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value === "" ? null : value;
}

/**
 * Turn the page-controlled `findElement` return value into a JSON-safe
 * `HandlerOutcome`. A missing / malformed envelope (the page blocked `eval` via
 * CSP, or the world returned nothing) resolves to an `{ error }` sentinel;
 * otherwise every descriptor is rebuilt field-by-field from primitives (no
 * pass-through of the raw page object) and every key-attribute slot is
 * normalised to `string | null`. An empty match list is a real
 * `{ matches: [], total: 0, truncated: false }` — not an error — so callers can
 * tell a no-match selector from a CSP-blocked injection.
 */
function coerceFindElementOutcome(raw: unknown): HandlerOutcome {
  if (!isRecord(raw)) {
    return {
      error:
        "findElement returned no result — the page may block script injection via its Content-Security-Policy",
    };
  }
  const rawMatches = raw["matches"];
  if (!Array.isArray(rawMatches)) {
    return { error: "findElement returned a malformed match list" };
  }
  const matches: FindElementMatch[] = [];
  for (const entry of rawMatches) {
    if (!isRecord(entry)) {
      return { error: "findElement returned a malformed match entry" };
    }
    const attrs = entry["attributes"];
    if (!isRecord(attrs)) {
      return { error: "findElement returned a malformed attribute map" };
    }
    matches.push({
      ref: asString(entry["ref"]),
      text: asString(entry["text"]),
      attributes: {
        tagName: asStringOrNull(attrs["tagName"]),
        id: asStringOrNull(attrs["id"]),
        class: asStringOrNull(attrs["class"]),
        role: asStringOrNull(attrs["role"]),
        ariaLabel: asStringOrNull(attrs["ariaLabel"]),
        href: asStringOrNull(attrs["href"]),
        name: asStringOrNull(attrs["name"]),
        type: asStringOrNull(attrs["type"]),
        dataTestid: asStringOrNull(attrs["dataTestid"]),
      },
    });
  }
  return {
    result: {
      matches,
      total: asCount(raw["total"]),
      truncated: asBool(raw["truncated"]),
    },
  };
}

/**
 * Turn the CDP-backed `DebuggerPorts.scroll` outcome into a JSON-safe
 * `HandlerOutcome`. The port returns a fully-typed `ScrollOutcome` — a status
 * object (which mechanism moved the page, before/after `scrollY`, `reachedEnd`),
 * not an evaluated JSON value — so this explicitly selects the four fields and
 * passes `method` through unchanged. It deliberately does NOT reuse
 * `coerceExecuteScriptOutcome` / the `InPageScriptOutcome` JSON-value path.
 */
export function coerceScrollOutcome(outcome: ScrollOutcome): HandlerOutcome {
  return {
    result: {
      method: outcome.method,
      scrollYBefore: outcome.scrollYBefore,
      scrollYAfter: outcome.scrollYAfter,
      reachedEnd: outcome.reachedEnd,
    },
  };
}

/** Validated `captureTab` params, narrowed by `mode`. */
type ParsedCaptureParams =
  | { readonly mode: CaptureTabMode & "viewport" }
  | { readonly mode: CaptureTabMode & "element"; readonly elementRef: string }
  | { readonly mode: CaptureTabMode & "full-page" };

/** A `captureTab` param error, returned as an `{ error }` sentinel without touching a tab. */
type CaptureParamError = { readonly error: string };

/**
 * Validate caller-supplied `captureTab` params. `mode` defaults to `viewport`;
 * `element` mode additionally requires a non-empty `elementRef`. Anything else
 * (a bad mode, a missing elementRef) is rejected with an `{ error }` sentinel
 * before any tab is resolved — never coerced, never a throw.
 */
function resolveCaptureParams(
  params: unknown,
): ParsedCaptureParams | CaptureParamError {
  if (!isRecord(params)) return { mode: "viewport" };
  const mode = params["mode"];
  if (mode === undefined) return { mode: "viewport" };
  if (mode === "viewport") return { mode: "viewport" };
  if (mode === "element") {
    const elementRef = params["elementRef"];
    if (!nonEmptyString(elementRef)) {
      return {
        error: "captureTab element mode requires a non-empty elementRef string",
      };
    }
    return { mode: "element", elementRef };
  }
  if (mode === "full-page") return { mode: "full-page" };
  return {
    error:
      'captureTab accepts a mode of "viewport" | "element" | "full-page"; element mode requires an elementRef',
  };
}

/** The rect/geometry an element-mode capture reads back from the page. */
type ElementRect =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly scrollX: number;
      readonly scrollY: number;
      readonly innerWidth: number;
      readonly innerHeight: number;
    };

/**
 * The `Runtime.evaluate` expression that resolves a findElement CSS-locator ref
 * to its bounding rect (plus the document scroll offset and viewport geometry).
 * The ref is embedded as a JSON string literal — never interpolated into code,
 * never `eval`'d as caller JS — so a hostile ref cannot escape the string
 * context. A missing element or a malformed selector resolves to
 * `{ found: false }`, not a throw.
 */
function buildElementRectExpression(elementRef: string): string {
  return `(() => {
  let el;
  try {
    el = document.querySelector(${JSON.stringify(elementRef)});
  } catch {
    return { found: false };
  }
  if (el === null) return { found: false };
  const r = el.getBoundingClientRect();
  return {
    found: true,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  };
})()`;
}

/**
 * Coerce the `InPageScriptOutcome` of an element-rect read into an `ElementRect`.
 * A missing / malformed envelope resolves to an `{ error }` so the caller can
 * surface it as a structured `tab-unavailable` outcome rather than throwing.
 */
function coerceElementRect(
  outcome: InPageScriptOutcome,
): ElementRect | CaptureParamError {
  if (!outcome.ok) return { error: outcome.error };
  let raw: unknown;
  try {
    raw = JSON.parse(outcome.json);
  } catch {
    return { error: "element rect read returned malformed JSON" };
  }
  if (!isRecord(raw))
    return { error: "element rect read returned a non-object" };
  if (raw["found"] !== true) return { found: false };
  const num = (key: string): number => {
    const v = raw[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return {
    found: true,
    x: num("x"),
    y: num("y"),
    width: num("width"),
    height: num("height"),
    scrollX: num("scrollX"),
    scrollY: num("scrollY"),
    innerWidth: num("innerWidth"),
    innerHeight: num("innerHeight"),
  };
}

/**
 * Read the pixel width/height of a PNG from its base64 data-URL by parsing the
 * PNG IHDR width/height fields (bytes 16–23). Returns `undefined` for anything
 * that is not a parseable PNG, so a healthy capture that happens to return an
 * odd image still reports width/height 0 rather than crashing.
 */
function readPngDimensions(
  dataUrl: string,
): { readonly width: number; readonly height: number } | undefined {
  const payload = dataUrl.replace(/^data:image\/png;base64,/, "");
  let bin: string;
  try {
    bin = atob(payload);
  } catch {
    return undefined;
  }
  if (bin.length < 24) return undefined;
  const byte = (i: number): number => bin.charCodeAt(i);
  if (
    byte(0) !== 0x89 ||
    byte(1) !== 0x50 ||
    byte(2) !== 0x4e ||
    byte(3) !== 0x47
  ) {
    return undefined;
  }
  return {
    width:
      ((byte(16) << 24) | (byte(17) << 16) | (byte(18) << 8) | byte(19)) >>> 0,
    height:
      ((byte(20) << 24) | (byte(21) << 16) | (byte(22) << 8) | byte(23)) >>> 0,
  };
}

/**
 * A relay/tab problem — a rejected CDP attach, a resolver throw, or a malformed
 * page read — surfaced as a structured non-image `tab-unavailable` outcome.
 */
function captureUnavailableOutcome(error: unknown): CaptureTabFailureResult {
  return {
    captured: false,
    reason: "tab-unavailable",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Apply the `captureTab` size policy to one captured screenshot. A payload at or
 * under the base64 ceiling is returned as a `captured: true` image recording
 * `appliedScale: 1, attempts: 1` (no downscale run). A payload over the ceiling
 * is driven down the downscale ladder via `recapture` until a rung fits
 * (reporting the applied scale and cumulative attempts) or the give-up floor is
 * reached — a `captured: false` too-large outcome carrying size/limit/floor/
 * attempts.
 */
async function captureResultWithLadder(
  initialDataUrl: string,
  recapture: (scale: number) => Promise<string>,
  clipped: boolean,
): Promise<CaptureTabResult> {
  const initialSize = initialDataUrl.replace(
    /^data:image\/png;base64,/,
    "",
  ).length;
  if (initialSize <= MAX_SCREENSHOT_BASE64_CHARS) {
    const dims = readPngDimensions(initialDataUrl);
    return {
      captured: true,
      dataUrl: initialDataUrl,
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
      clipped,
      appliedScale: 1,
      attempts: 1,
    };
  }
  return captureDownscaleLadder(recapture, clipped);
}

/**
 * Walk the downscale ladder for a capture whose initial full-size payload
 * already exceeded the ceiling. `recapture(scale)` returns the data-URL for a
 * capture at that render scale; the helper measures each rung's base64 length
 * and returns `captured: true` on the first rung that fits, or a `too-large`
 * give-up outcome once the floor is still over the ceiling. It never attaches
 * or detaches a debugger session — `recapture` owns that (each call is the
 * port's own attach → command → detach session, whose `finally` detaches).
 */
async function captureDownscaleLadder(
  recapture: (scale: number) => Promise<string>,
  clipped: boolean,
): Promise<CaptureTabResult> {
  // `attempts` counts the initial full-size capture (1) plus every rung tried.
  let attempts = 1;
  let lastSize = 0;
  for (const scale of SCREENSHOT_DOWNSCALE_LADDER_SCALES) {
    attempts += 1;
    let dataUrl: string;
    try {
      dataUrl = await recapture(scale);
    } catch (error) {
      // A transient CDP/relay failure mid-ladder is a tab problem, not a size
      // problem — surface it as the same structured outcome as any capture
      // rejection and stop walking rungs (the failed session already detached).
      return captureUnavailableOutcome(error);
    }
    lastSize = dataUrl.replace(/^data:image\/png;base64,/, "").length;
    if (lastSize <= MAX_SCREENSHOT_BASE64_CHARS) {
      const dims = readPngDimensions(dataUrl);
      return {
        captured: true,
        dataUrl,
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
        clipped,
        appliedScale: scale,
        attempts,
      };
    }
  }
  // Every rung, including the give-up floor, was still over the ceiling.
  return {
    captured: false,
    reason: "too-large",
    size: lastSize,
    limit: MAX_SCREENSHOT_BASE64_CHARS,
    floor: SCREENSHOT_DOWNSCALE_FLOOR_SCALE,
    attempts,
  };
}

/**
 * Capture the sandbox tab's current viewport via the CDP debugger port. A
 * capture rejection (attach / CDP failure) resolves to a structured
 * `tab-unavailable` outcome rather than rejecting.
 */
async function captureViewport(
  captureDebugger: DebuggerPorts,
  tabId: number,
): Promise<HandlerOutcome> {
  let dataUrl: string;
  try {
    dataUrl = await captureDebugger.captureScreenshot(tabId);
  } catch (error) {
    return { result: captureUnavailableOutcome(error) };
  }
  // `recapture` re-takes the whole viewport at a reduced render scale via the
  // debugger port's no-clip `scale` option (a full-viewport scaled clip built
  // from the tab's layout-viewport geometry).
  const recapture = (scale: number): Promise<string> =>
    captureDebugger.captureScreenshot(tabId, { scale });
  return { result: await captureResultWithLadder(dataUrl, recapture, false) };
}

/**
 * Capture the sandbox tab's whole scrollable document via the CDP debugger
 * port's full-page capability (`captureBeyondViewport: true`, focus-emulated).
 * This is the one consumer of the render-the-tab primitive this horizon ships.
 * A capture rejection (attach / CDP failure) resolves to a structured
 * `tab-unavailable` outcome rather than rejecting. Oversized results are driven
 * down the same scale-only ladder as `captureViewport`, via a recapture closure
 * that re-takes the full page at a reduced render scale.
 */
async function captureFullPage(
  captureDebugger: DebuggerPorts,
  tabId: number,
): Promise<HandlerOutcome> {
  let dataUrl: string;
  try {
    dataUrl = await captureDebugger.captureFullPageScreenshot(tabId);
  } catch (error) {
    return { result: captureUnavailableOutcome(error) };
  }
  // `recapture` re-takes the whole document at a reduced render scale via the
  // full-page port. CDP has no top-level `scale` for a beyond-viewport capture
  // (see that port's doc comment), so a scaled full-page capture is not yet
  // composited at the requested scale; the argument is forwarded so the ladder
  // contract is identical to `captureViewport`'s, and a dense page bottoms out
  // at the floor rather than re-serving the scale-1 image forever.
  const recapture = (scale: number): Promise<string> =>
    captureDebugger.captureFullPageScreenshot(tabId, { scale });
  return { result: await captureResultWithLadder(dataUrl, recapture, false) };
}

/**
 * Capture one element of the sandbox tab by a findElement CSS-locator ref. The
 * ref is resolved to a clip rect via `Runtime.evaluate` (the post-h9 CDP read
 * path), then captured. No-match, zero-area, and relay/tab failures each return
 * a structured non-image outcome; the clip is measured in document coordinates
 * (rect + scroll offset) and `clipped` reports whether the element rect
 * exceeded the composited viewport.
 */
async function captureElement(
  captureDebugger: DebuggerPorts,
  tabId: number,
  elementRef: string,
): Promise<HandlerOutcome> {
  let outcome: InPageScriptOutcome;
  try {
    outcome = await captureDebugger.evaluate(
      tabId,
      buildElementRectExpression(elementRef),
    );
  } catch (error) {
    return { result: captureUnavailableOutcome(error) };
  }
  const rect = coerceElementRect(outcome);
  if ("error" in rect) {
    return { result: captureUnavailableOutcome(rect.error) };
  }
  if (!rect.found) {
    return { result: { captured: false, reason: "element-not-found" } };
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return { result: { captured: false, reason: "zero-area" } };
  }
  const clip: CaptureScreenshotOptions["clip"] = {
    x: rect.x + rect.scrollX,
    y: rect.y + rect.scrollY,
    width: rect.width,
    height: rect.height,
    scale: 1,
  };
  const clipped =
    rect.width > rect.innerWidth || rect.height > rect.innerHeight;
  let dataUrl: string;
  try {
    dataUrl = await captureDebugger.captureScreenshot(tabId, { clip });
  } catch (error) {
    return { result: captureUnavailableOutcome(error) };
  }
  // `recapture` re-takes the element's clip at a reduced scale, preserving the
  // clip's x/y/width/height and lowering only `scale`.
  const recapture = (scale: number): Promise<string> =>
    captureDebugger.captureScreenshot(tabId, { clip: { ...clip, scale } });
  return { result: await captureResultWithLadder(dataUrl, recapture, clipped) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Coerce a page-controlled (`unknown`) executeScript result to a safe shape. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function asBool(value: unknown): boolean {
  return value === true;
}

/**
 * The shape the in-page `executeScript` closure returns: either a JSON string of
 * the evaluated value, or a reason it could not be serialised / it threw. The
 * CDP-backed `DebuggerPorts.evaluate` produces the same shape so the two eval
 * paths share one coercion.
 */
export type InPageScriptOutcome =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: string };

/**
 * Turn the page-controlled `executeScript` return value into a `HandlerOutcome`.
 * A missing / malformed envelope (the page blocked `eval` via CSP, or the world
 * returned nothing), or a serialisation failure, resolve to an `{ error }`
 * sentinel — never a throw, never a raw page value. An over-large result resolves
 * to a structured non-throwing too-large result (size-limits.ts) instead of an
 * error, so a caller can distinguish "too large" from a genuine failure.
 */
function coerceExecuteScriptOutcome(raw: unknown): HandlerOutcome {
  if (!isRecord(raw)) {
    return {
      error:
        "executeScript returned no result — the page may block eval via its Content-Security-Policy",
    };
  }
  if (raw["ok"] === false) {
    return {
      error: nonEmptyString(raw["error"])
        ? raw["error"]
        : "executeScript expression failed",
    };
  }
  if (raw["ok"] === true && typeof raw["json"] === "string") {
    const json = raw["json"];
    const ceiling = checkSizeLimit(
      json.length,
      MAX_EXECUTE_SCRIPT_RESULT_CHARS,
    );
    if (!ceiling.withinLimit) {
      return { result: buildOversizeResult(ceiling) };
    }
    const value: unknown = JSON.parse(json);
    return { result: { value } };
  }
  return { error: "executeScript returned an unrecognised result shape" };
}

/** Clamp a caller-supplied `maxChars` to a sane positive integer, else default. */
export function resolveMaxChars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_MAX_CHARS;
  }
  return raw;
}

function truncate(
  text: string,
  maxChars: number,
): {
  readonly text: string;
  readonly totalChars: number;
  readonly truncated: boolean;
} {
  const totalChars = text.length;
  if (totalChars > maxChars) {
    return { text: text.slice(0, maxChars), totalChars, truncated: true };
  }
  return { text, totalChars, truncated: false };
}

/**
 * Validate a caller-supplied capture `since` cursor. Optional; defaults to 0
 * (read from the start of the buffer). Anything that is not a non-negative
 * integer — a string, `1.5`, `NaN`, `-1` — is rejected rather than coerced.
 */
export function resolveSince(raw: unknown): number | { error: string } {
  if (raw === undefined) return 0;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return { error: "`since` must be a non-negative integer when provided" };
}

/**
 * Validate a caller-supplied capture `limit`. Optional; defaults to
 * `DEFAULT_READ_LIMIT`. A non-positive or non-integer value is rejected; a
 * value above `MAX_READ_LIMIT` is silently clamped down to it.
 */
export function resolveReadLimit(raw: unknown): number | { error: string } {
  if (raw === undefined) return DEFAULT_READ_LIMIT;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return Math.min(raw, MAX_READ_LIMIT);
  }
  return { error: "`limit` must be a positive integer when provided" };
}

/** Error a caller sees when `waitFor` params are malformed, matching the three-mode model. */
const WAIT_PARAM_ERROR =
  'waitFor requires a mode of "selector-present" | "network-idle" | "fixed-delay"; selector-present also needs a selector, fixed-delay a delayMs';

/**
 * A `waitFor` mode's validated params, narrowed by the `mode` discriminator.
 * `timeoutMs` is clamped by the poll module, so a caller-supplied value may be
 * any finite number here; an invalid *type* is rejected, an out-of-range value
 * is clamped (never silently disabling the wait).
 */
type ParsedWaitForParams =
  | {
      readonly mode: "selector-present";
      readonly selector: string;
      readonly timeoutMs: number | undefined;
    }
  | {
      readonly mode: "network-idle";
      readonly timeoutMs: number | undefined;
    }
  | {
      readonly mode: "fixed-delay";
      readonly delayMs: number;
      readonly timeoutMs: number | undefined;
    };

/**
 * Validate caller-supplied `waitFor` params before any tab is resolved. Returns
 * the narrowed mode-specific params, or an `{ error }` sentinel. A malformed
 * `mode`, a missing / wrongly-typed mode-specific field, or a non-finite
 * `timeoutMs` are rejected; a numeric-out-of-range `timeoutMs` is passed through
 * to the poll module's clamp.
 */
export function resolveWaitForParams(
  params: unknown,
): ParsedWaitForParams | { readonly error: string } {
  if (!isRecord(params)) return { error: WAIT_PARAM_ERROR };
  const mode = params["mode"];
  const timeoutMs = params["timeoutMs"];
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))
  ) {
    return {
      error: "waitFor `timeoutMs` must be a finite number when provided",
    };
  }
  if (mode === "selector-present") {
    const selector = params["selector"];
    if (!nonEmptyString(selector)) {
      return {
        error:
          "waitFor selector-present mode requires a non-empty selector string",
      };
    }
    return { mode: "selector-present", selector, timeoutMs };
  }
  if (mode === "network-idle") {
    return { mode: "network-idle", timeoutMs };
  }
  if (mode === "fixed-delay") {
    const delayMs = params["delayMs"];
    if (
      typeof delayMs !== "number" ||
      !Number.isFinite(delayMs) ||
      delayMs < 0
    ) {
      return {
        error:
          "waitFor fixed-delay mode requires a non-negative finite delayMs",
      };
    }
    return { mode: "fixed-delay", delayMs, timeoutMs };
  }
  return { error: WAIT_PARAM_ERROR };
}

/**
 * Wrap a handler so a thrown error or a rejected chrome-port promise becomes an
 * `{ error }` outcome rather than propagating — the dispatcher would also catch
 * a throw, but a handler that resolves its own failures keeps the contract
 * ("returns `{ error }` on a handled failure") honest and testable in isolation.
 */
function guard(fn: Handler): Handler {
  return async (params) => {
    try {
      return await fn(params);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function pageActionHandlers(
  ports: ChromePorts,
  sandboxTab: SandboxTabPorts,
  captureDebugger: DebuggerPorts,
  captureStore: CaptureStore,
): Record<PageAction, Handler> {
  const readCapture =
    (channel: "console" | "network"): Handler =>
    async (params) => {
      const rawParams = isRecord(params) ? params : {};
      const since = resolveSince(rawParams["since"]);
      if (typeof since !== "number") return since;
      const limit = resolveReadLimit(rawParams["limit"]);
      if (typeof limit !== "number") return limit;
      const tabId = await sandboxTab.resolveTabId();
      const query = { since, limit };
      const result =
        channel === "console"
          ? captureStore.readConsole(tabId, query)
          : captureStore.readNetwork(tabId, query);
      // Byte-size guard, mirroring `coerceExecuteScriptOutcome`: measure the
      // whole serialised CaptureRead the count clamp already produced and, when
      // it exceeds the channel's ceiling, replace it with the shared non-throwing
      // oversize outcome instead of sending an unbounded body across the wire.
      // The count-based since/limit/nextSince/dropped/truncated clamp above is
      // untouched — this adds a byte bound alongside it, never instead of it.
      const ceiling =
        channel === "console"
          ? MAX_CONSOLE_READ_RESULT_CHARS
          : MAX_NETWORK_READ_RESULT_CHARS;
      const sizeCheck = checkSizeLimit(JSON.stringify(result).length, ceiling);
      if (!sizeCheck.withinLimit) {
        return { result: buildOversizeResult(sizeCheck) };
      }
      return { result };
    };

  const raw: Record<PageAction, Handler> = {
    ping: () => ({ result: { ok: true, ts: Date.now() } }),

    navigateTo: async (params) => {
      if (!isRecord(params) || !nonEmptyString(params["url"])) {
        return { error: "navigateTo requires a non-empty url string" };
      }
      const tabId = await sandboxTab.resolveTabId();
      await ports.updateTab(tabId, { url: params["url"] });
      return { result: { navigated: true } };
    },

    getPageText: async (params) => {
      const maxChars = resolveMaxChars(
        isRecord(params) ? params["maxChars"] : undefined,
      );
      const tabId = await sandboxTab.resolveTabId();
      const raw = await ports.executeScript(
        tabId,
        () => document.body.innerText,
        [],
      );
      const { text, totalChars, truncated } = truncate(asString(raw), maxChars);
      return { result: { text, totalChars, truncated } };
    },

    readPage: async (params) => {
      const maxChars = resolveMaxChars(
        isRecord(params) ? params["maxChars"] : undefined,
      );
      const tabId = await sandboxTab.resolveTabId();
      const raw = await ports.executeScript(
        tabId,
        () => document.documentElement.outerHTML,
        [],
      );
      const { text, totalChars, truncated } = truncate(asString(raw), maxChars);
      return { result: { content: text, totalChars, truncated } };
    },

    findElement: async (params) => {
      if (!isRecord(params) || !nonEmptyString(params["selector"])) {
        return { error: "findElement requires a non-empty selector string" };
      }
      const tabId = await sandboxTab.resolveTabId();
      // Self-contained ISOLATED-world function. The two size limits arrive as
      // explicit args — chrome structured-clones the function ref, so module-
      // scoped captures cannot survive a structured-clone boundary, which is
      // exactly why the match/text limits are threaded instead of inlined.
      // MAX_REF_DEPTH stays inlined: it is a purely internal walk cap, not a
      // caller-tunable size limit. The selector reaches the page as a serialised
      // arg only — no template-string interpolation, no eval, no caller JS.
      const raw = await ports.executeScript(
        tabId,
        (selector: string, maxMatches: number, maxTextChars: number) => {
          const MAX_REF_DEPTH = 8;

          /**
           * Build a self-contained CSS-locator string for one DOM element by
           * walking up to its first unique-id ancestor (preferred) and recording
           * a `:nth-of-type` chain below it. Capped at MAX_REF_DEPTH levels so
           * obfuscated-class pages do not produce enormous selectors. Uses
           * `CSS.escape` so an id with non-CSS characters still parses.
           * Recursive so the parameter type stays `Element` all the way down
           * (a `let node = parent` reassignment loses narrowing through ESLint's
           * strict-type-checked unsafe-* rules).
           */
          function buildRef(el: Element, depth: number = 0): string {
            if (depth >= MAX_REF_DEPTH) return el.tagName.toLowerCase();
            const id = el.getAttribute("id");
            if (
              id !== null &&
              id !== "" &&
              document.querySelectorAll(`#${CSS.escape(id)}`).length === 1
            ) {
              return `#${CSS.escape(id)}`;
            }
            const tag = el.tagName.toLowerCase();
            const parent = el.parentElement;
            if (parent === null) return tag;
            const siblings: Element[] = [];
            for (const child of Array.from(parent.children)) {
              if (child.tagName === el.tagName) siblings.push(child);
            }
            const index = siblings.indexOf(el) + 1;
            return `${buildRef(parent, depth + 1)} > ${tag}:nth-of-type(${index})`;
          }

          /** An HTML attribute value or `null` when absent/empty. */
          function attr(el: Element, name: string): string | null {
            const v = el.getAttribute(name);
            return v === null || v === "" ? null : v;
          }

          try {
            const nodes = document.querySelectorAll(selector);
            const total = nodes.length;
            const sliced: Element[] = Array.from(nodes).slice(0, maxMatches);
            const matches: FindElementMatch[] = [];
            let anyTextTruncated = false;
            for (const el of sliced) {
              // `innerText` and `className` live on HTMLElement, not the wider
              // Element type that `querySelectorAll` yields — narrow with an
              // explicit cast so the produced `FindElementMatch` matches its
              // declared shape (every field either a string or `null`).
              const htmlEl = el as HTMLElement;
              const fullText = htmlEl.innerText;
              const text = fullText.slice(0, maxTextChars);
              if (text.length < fullText.length) anyTextTruncated = true;
              const cls =
                typeof htmlEl.className === "string" ? htmlEl.className : "";
              matches.push({
                ref: buildRef(el),
                text,
                attributes: {
                  tagName: el.tagName === "" ? null : el.tagName.toLowerCase(),
                  id: attr(el, "id"),
                  class: cls === "" ? null : cls,
                  role: attr(el, "role"),
                  ariaLabel: attr(el, "aria-label"),
                  href: attr(el, "href"),
                  name: attr(el, "name"),
                  type: attr(el, "type"),
                  dataTestid: attr(el, "data-testid"),
                },
              });
            }
            const truncated = total > maxMatches || anyTextTruncated;
            return { matches, total, truncated };
          } catch {
            // Hostile selector (syntax error, null bytes, etc) — return an
            // empty match list, not a throw. Mirrors the previous existence-
            // check semantics where a bad selector resolved to 0, not an error.
            return { matches: [], total: 0, truncated: false };
          }
        },
        [params["selector"], MAX_FIND_ELEMENT_MATCHES, MAX_ELEMENT_TEXT_CHARS],
      );
      return coerceFindElementOutcome(raw);
    },

    clickElement: async (params) => {
      if (!isRecord(params) || !nonEmptyString(params["selector"])) {
        return { error: "clickElement requires a non-empty selector string" };
      }
      const tabId = await sandboxTab.resolveTabId();
      const clicked = await ports.executeScript(
        tabId,
        (selector: string) => {
          try {
            const el = document.querySelector(selector);
            if (el instanceof HTMLElement) {
              el.click();
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },
        [params["selector"]],
      );
      return { result: { clicked: asBool(clicked) } };
    },

    typeText: async (params) => {
      if (
        !isRecord(params) ||
        !nonEmptyString(params["selector"]) ||
        typeof params["text"] !== "string"
      ) {
        return {
          error: "typeText requires a non-empty selector and a text string",
        };
      }
      const tabId = await sandboxTab.resolveTabId();
      const typed = await ports.executeScript(
        tabId,
        (selector: string, text: string) => {
          try {
            const el = document.querySelector(selector);
            if (
              el instanceof HTMLInputElement ||
              el instanceof HTMLTextAreaElement
            ) {
              el.value = text;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
            if (el instanceof HTMLElement && el.isContentEditable) {
              el.textContent = text;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },
        [params["selector"], params["text"]],
      );
      return { result: { typed: asBool(typed) } };
    },

    captureTab: async (params) => {
      const parsed = resolveCaptureParams(params);
      if ("error" in parsed) return parsed;
      // Resolve the sandbox tab AFTER validating params, so bad input never
      // touches (or creates) a tab. A resolution failure is a structured
      // `tab-unavailable` outcome, not a rejection.
      let tabId: number;
      try {
        tabId = await sandboxTab.resolveTabId();
      } catch (error) {
        return { result: captureUnavailableOutcome(error) };
      }
      if (parsed.mode === "element") {
        return await captureElement(captureDebugger, tabId, parsed.elementRef);
      }
      if (parsed.mode === "full-page") {
        return await captureFullPage(captureDebugger, tabId);
      }
      return await captureViewport(captureDebugger, tabId);
    },

    readConsoleMessages: readCapture("console"),
    readNetworkRequests: readCapture("network"),

    navigateBack: async () => {
      const tabId = await sandboxTab.resolveTabId();
      try {
        await ports.goBack(tabId);
      } catch {
        return noHistoryOutcome("back");
      }
      return { result: { moved: true } };
    },

    navigateForward: async () => {
      const tabId = await sandboxTab.resolveTabId();
      try {
        await ports.goForward(tabId);
      } catch {
        return noHistoryOutcome("forward");
      }
      return { result: { moved: true } };
    },

    reloadTab: async () => {
      const tabId = await sandboxTab.resolveTabId();
      await ports.reload(tabId);
      return { result: { reloaded: true } };
    },

    executeScript: async (params) => {
      if (!isRecord(params) || !nonEmptyString(params["code"])) {
        return { error: "executeScript requires a non-empty code string" };
      }
      const tabId = await sandboxTab.resolveTabId();
      const outcome = await ports.executeScript(
        tabId,
        (code: string): InPageScriptOutcome => {
          let value: unknown;
          try {
            // Indirect eval → runs in global (page) scope, in the MAIN world.
            value = (0, eval)(code);
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          if (value === undefined) {
            return { ok: false, error: "expression returned undefined" };
          }
          if (typeof value === "function") {
            return {
              ok: false,
              error: "expression returned a function (not serialisable)",
            };
          }
          if (typeof Node !== "undefined" && value instanceof Node) {
            return {
              ok: false,
              error: "expression returned a DOM node (not serialisable)",
            };
          }
          try {
            const json = JSON.stringify(value);
            if (typeof json !== "string") {
              return {
                ok: false,
                error: "expression result is not JSON-serialisable",
              };
            }
            return { ok: true, json };
          } catch {
            return {
              ok: false,
              error:
                "expression result is not JSON-serialisable (circular structure)",
            };
          }
        },
        [params["code"]],
        { world: "MAIN" },
      );
      return coerceExecuteScriptOutcome(outcome);
    },

    evaluatePage: async (params) => {
      if (!isRecord(params) || !nonEmptyString(params["code"])) {
        return { error: "evaluatePage requires a non-empty code string" };
      }
      const tabId = await sandboxTab.resolveTabId();
      // CDP Runtime.evaluate is exempt from the page's CSP — the one path that
      // reads values on strict-CSP sites where the executeScript eval is blocked.
      const outcome = await captureDebugger.evaluate(tabId, params["code"]);
      return coerceExecuteScriptOutcome(outcome);
    },

    clickAt: async (params) => {
      if (!isRecord(params)) {
        return { error: "clickAt requires `x` and `y` non-negative integers" };
      }
      const x = resolveCoordinate("clickAt", "x", params["x"]);
      if (typeof x !== "number") return x;
      const y = resolveCoordinate("clickAt", "y", params["y"]);
      if (typeof y !== "number") return y;
      const tabId = await sandboxTab.resolveTabId();
      const raw = await ports.executeScript(
        tabId,
        (px: number, py: number) => {
          const el = document.elementFromPoint(px, py);
          if (el === null) return { found: false, dispatched: 0 };
          const init: MouseEventInit = {
            bubbles: true,
            cancelable: true,
            clientX: px,
            clientY: py,
          };
          let dispatched = 0;
          el.dispatchEvent(new PointerEvent("pointerdown", init));
          dispatched += 1;
          el.dispatchEvent(new PointerEvent("pointerup", init));
          dispatched += 1;
          el.dispatchEvent(new MouseEvent("click", init));
          dispatched += 1;
          return { found: true, dispatched };
        },
        [x, y],
      );
      return coercePointerOutcome("clickAt", raw);
    },

    hover: async (params) => {
      if (!isRecord(params)) {
        return { error: "hover requires `x` and `y` non-negative integers" };
      }
      const x = resolveCoordinate("hover", "x", params["x"]);
      if (typeof x !== "number") return x;
      const y = resolveCoordinate("hover", "y", params["y"]);
      if (typeof y !== "number") return y;
      const tabId = await sandboxTab.resolveTabId();
      const raw = await ports.executeScript(
        tabId,
        (px: number, py: number) => {
          const el = document.elementFromPoint(px, py);
          if (el === null) return { found: false, dispatched: 0 };
          const init: MouseEventInit = {
            bubbles: true,
            cancelable: true,
            clientX: px,
            clientY: py,
          };
          let dispatched = 0;
          el.dispatchEvent(new PointerEvent("pointerover", init));
          dispatched += 1;
          el.dispatchEvent(new MouseEvent("mouseover", init));
          dispatched += 1;
          return { found: true, dispatched };
        },
        [x, y],
      );
      return coercePointerOutcome("hover", raw);
    },

    getTabState: async () => {
      const sandboxId = await sandboxTab.peekStoredSandboxTabId();
      if (sandboxId === undefined) {
        return {
          result: {
            sandboxTab: null,
            activeTab: null,
            sandboxTabActive: false,
          },
        };
      }
      const sandbox = await ports.readTab(sandboxId);
      const active = await ports.activeTabOfWindow(sandbox.windowId);
      const activeTab =
        active === undefined
          ? null
          : { id: active.id, url: active.url, title: active.title };
      return {
        result: {
          sandboxTab: {
            id: sandbox.id,
            url: sandbox.url,
            title: sandbox.title,
          },
          activeTab,
          sandboxTabActive: activeTab !== null && activeTab.id === sandbox.id,
        },
      };
    },

    closeSandboxTab: async () => {
      // Exclusively the sandbox-tab lifecycle port: resolves the stored id via
      // the existing SANDBOX_TAB_ID_KEY lookup, closes only that tab, clears the
      // persisted id, and never throws (no-op-safe on a missing/stale tab). The
      // generic onTabRemoved listener owns capture-buffer eviction — this handler
      // does not duplicate it.
      return { result: await sandboxTab.closeSandboxTab() };
    },

    scrollPage: async (params) => {
      if (!isRecord(params)) {
        return { error: SCROLL_PARAM_ERROR };
      }
      const rawAmountPx = params["amountPx"];
      const rawToBottom = params["toBottom"];
      if (rawAmountPx !== undefined) {
        if (
          typeof rawAmountPx !== "number" ||
          !Number.isFinite(rawAmountPx) ||
          rawAmountPx < 0
        ) {
          return { error: SCROLL_PARAM_ERROR };
        }
      }
      if (rawToBottom !== undefined && typeof rawToBottom !== "boolean") {
        return { error: SCROLL_PARAM_ERROR };
      }
      // Resolve the sandbox tab AFTER validating params, so bad input never
      // touches (or creates) a tab. Omit un-supplied fields from the intent —
      // the port applies its own amountPx-default (2000) and toBottom semantics.
      const tabId = await sandboxTab.resolveTabId();
      // Build the intent with only the supplied fields — the port applies its own
      // amountPx default (2000) and, when both are omitted, this is the empty
      // intent `{}`.
      const intent: ScrollIntent = {
        ...(typeof rawAmountPx === "number" ? { amountPx: rawAmountPx } : {}),
        ...(typeof rawToBottom === "boolean" ? { toBottom: rawToBottom } : {}),
      };
      const outcome = await captureDebugger.scroll(tabId, intent);
      return coerceScrollOutcome(outcome);
    },

    waitFor: async (params) => {
      const parsed = resolveWaitForParams(params);
      if ("error" in parsed) return parsed;
      const tabId = await sandboxTab.resolveTabId();
      let condition: WaitCondition;
      if (parsed.mode === "selector-present") {
        const selector = parsed.selector;
        condition = {
          kind: "selector-present",
          // ISOLATED-world injected function, the exact findElement shape: the
          // caller's selector is only ever a serialisable arg, never eval'd or
          // interpolated into a code body — so it is CSP-safe by construction.
          isPresent: () =>
            ports
              .executeScript(
                tabId,
                (sel: string) => {
                  try {
                    return document.querySelectorAll(sel).length > 0;
                  } catch {
                    return false;
                  }
                },
                [selector],
              )
              .then((raw) => asBool(raw)),
        };
      } else if (parsed.mode === "network-idle") {
        condition = {
          kind: "network-idle",
          // Newest captured network seq for this tab. Reading `since: 0` always
          // returns the full window oldest-first, so the last entry is the
          // newest — this avoids the stale-cursor reset (passing a `since` past
          // the newest seq silently resets to 0).
          latestSeq: () => {
            const read = captureStore.readNetwork(tabId, {
              since: 0,
              limit: MAX_READ_LIMIT,
            });
            const last = read.entries[read.entries.length - 1];
            return last === undefined ? 0 : last.seq;
          },
        };
      } else {
        condition = { kind: "fixed-delay", delayMs: parsed.delayMs };
      }
      const options =
        parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs };
      const outcome = await waitForCondition(condition, options);
      return { result: outcome };
    },
  };

  return {
    ping: raw.ping,
    navigateTo: guard(raw.navigateTo),
    getPageText: guard(raw.getPageText),
    readPage: guard(raw.readPage),
    findElement: guard(raw.findElement),
    clickElement: guard(raw.clickElement),
    typeText: guard(raw.typeText),
    captureTab: guard(raw.captureTab),
    readConsoleMessages: guard(raw.readConsoleMessages),
    readNetworkRequests: guard(raw.readNetworkRequests),
    executeScript: guard(raw.executeScript),
    evaluatePage: guard(raw.evaluatePage),
    clickAt: guard(raw.clickAt),
    hover: guard(raw.hover),
    navigateBack: guard(raw.navigateBack),
    navigateForward: guard(raw.navigateForward),
    reloadTab: guard(raw.reloadTab),
    getTabState: guard(raw.getTabState),
    scrollPage: guard(raw.scrollPage),
    waitFor: guard(raw.waitFor),
    closeSandboxTab: guard(raw.closeSandboxTab),
  };
}
