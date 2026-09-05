/**
 * `DebuggerPorts` — the slice of the `chrome.*` API that drives an
 * arbitrary tab through CDP (`chrome.debugger`), plus its real implementation.
 *
 * Why a separate port beside `ChromePorts`, `CapturePorts`, and
 * `SandboxTabPorts`:
 *
 *   `ChromePorts.captureVisibleTab` is window-scoped and can only capture the
 *   focused tab of a window — the wrong tool when the target is the dedicated
 *   sandbox tab that is deliberately kept unfocused. CDP's
 *   `Page.captureScreenshot` targets a specific tab by id regardless of focus,
 *   but it is reached through `chrome.debugger`, which none of the existing
 *   ports expose. This port owns that call — and, as of horizon 09,
 *   `Runtime.evaluate` — plus the cleanup that keeps a failed or suspended
 *   command from leaking a debugger attachment.
 *
 * The CDP-vs-DOM decision is recorded in the project's decisions.md: CDP was
 * introduced for this background-tab screenshot gap; the broader CDP pivot
 * (Runtime.evaluate, Input.dispatch*, scroll) was deferred. Horizon 09 lifts
 * the CDP Runtime.evaluate ban for read-only page evaluation (see decisions.md),
 * which is why this port adds a value-read command alongside screenshot capture.
 *
 * `chromeCaptureDebuggerPorts` is covered by a co-located unit test that stubs
 * the `chrome` global. No `chrome.*` access happens at module load — every
 * reference is inside `chromeCaptureDebuggerPorts`.
 */

/// <reference types="chrome" />

import type { InPageScriptOutcome } from "./page-actions.js";

/** The CDP protocol version `chrome.debugger.attach` requires. */
const CDP_VERSION = "1.3";

/**
 * The max wall-clock for one CDP command session (attach → run → detach).
 * A hung page command — e.g. the settle-delay / read-back `Runtime.evaluate`
 * after a wheel dispatch triggers a heavy virtualized re-render that blocks the
 * page main thread — must not wedge the debugger attachment past this window.
 * On timeout the session rejects and the `finally` below still detaches, so no
 * attachment leaks. Kept well under the MCP layer's command timeout so the
 * service worker detaches first instead of the MCP having to give up.
 */
const CDP_COMMAND_TIMEOUT_MS = 15000;

/**
 * Scroll intent for `DebuggerPorts.scroll`. `amountPx` is pixels to scroll down
 * (scroll is always downward; defaults to `2000` when omitted). `toBottom` is a
 * single large downward jump toward the current bottom, targeting
 * `document.documentElement.scrollHeight` — not a loop that chases an infinite
 * list; a caller needing more scrolling calls the tool again. There is no
 * `direction` field and no repeat count.
 */
export interface ScrollIntent {
  readonly amountPx?: number;
  readonly toBottom?: boolean;
}

/**
 * Optional CDP `Page.captureScreenshot` options for `DebuggerPorts.captureScreenshot`.
 * `clip` asks for a single rect (CSS-pixel coordinates from the document origin;
 * `scale` defaults to `1` in CDP). `scale` — used only when `clip` is absent —
 * asks for the whole viewport rendered smaller: the port reads the tab's
 * layout-viewport width/height and builds a full-viewport clip at that scale.
 * `clip` takes precedence when both are supplied. `captureBeyondViewport` —
 * used by the full-page capture port — composites the document region that
 * extends past the current viewport (CDP `Page.captureScreenshot`'s
 * `captureBeyondViewport: true`), so a tall page's off-screen pixels are painted
 * into the PNG rather than coming back blank.
 */
export interface CaptureScreenshotOptions {
  readonly clip?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale?: number;
  };
  /**
   * Re-render the whole viewport at a reduced `scale` (0 < scale <= 1), used
   * only when `clip` is absent. The port reads the tab's layout-viewport
   * width/height and builds a full-viewport clip at that scale, so an
   * over-large viewport screenshot can be taken smaller (e.g. by the captureTab
   * downscale ladder). `clip` takes precedence when both are supplied.
   */
  readonly scale?: number;
  /**
   * Composite the document region beyond the current viewport into the PNG
   * (`Page.captureScreenshot` `captureBeyondViewport: true`). Used by
   * `captureFullPageScreenshot`; when true the port sends no `clip` and no
   * `scale`-built clip, so the whole scrollable document is captured. The
   * sandbox tab normally suspends its render pass, so this must be combined with
   * CDP focus emulation to yield non-blank off-screen pixels — see
   * `captureFullPageScreenshot`.
   */
  readonly captureBeyondViewport?: boolean;
}

/**
 * The observable outcome of one `DebuggerPorts.scroll` call. `method` names the
 * mechanism that actually moved the page — a CDP `Input.dispatchMouseEvent`
 * wheel (`'wheel'`), the `window.scrollBy`/`window.scrollTo` script fallback
 * (`'script'`), or neither (`'none'`). `reachedEnd` is a best-effort flag, true
 * when `scrollYAfter + innerHeight >= scrollHeight - SLACK`; on an infinite list
 * that keeps growing it may read `false` forever, which is correct.
 */
export interface ScrollOutcome {
  readonly method: "wheel" | "script" | "none";
  readonly scrollYBefore: number;
  readonly scrollYAfter: number;
  readonly reachedEnd: boolean;
}

export interface DebuggerPorts {
  /**
   * Capture the given tab's current rendered viewport as a
   * `data:image/png;base64,<b64>` URL, regardless of whether the tab is
   * focused. `options.clip` asks for a single rect (CSS-pixel coordinates from
   * the document origin, `scale` defaults to 1), e.g. to capture one element
   * addressed by a findElement CSS-locator ref resolved to its bounding box.
   * `options.scale` — without a `clip` — re-captures the whole viewport at a
   * reduced render scale (0 < scale <= 1) by building a full-viewport clip, the
   * mechanism the captureTab downscale ladder uses to shrink an over-large
   * screenshot. Full-page (beyond-viewport) capture is not handled here — that
   * is the `captureFullPageScreenshot` port's job, which needs CDP focus
   * emulation to composite off-screen pixels on the unfocused sandbox tab.
   * Rejects when the tab cannot be attached or the CDP call fails.
   */
  captureScreenshot(
    tabId: number,
    options?: CaptureScreenshotOptions,
  ): Promise<string>;

  /**
   * Capture the given tab's whole scrollable document as a
   * `data:image/png;base64,<b64>` URL (CDP `Page.captureScreenshot` with
   * `captureBeyondViewport: true`), for the deliberately-unfocused sandbox tab,
   * by enabling Chrome's CDP focus emulation for the duration of this one capture
   * and restoring it before the session detaches.
   *
   * The sandbox tab is kept unfocused, and an unfocused Chrome tab suspends its
   * compositor — which is why an ordinary beyond-viewport capture comes back with
   * blank off-screen pixels (the horizon-13 failure). `Emulation.setFocusEmulationEnabled`
   * forces Blink to treat the page as focused long enough for the compositor to
   * paint the off-screen region; it is then disabled in a `finally` that runs
   * before `withDebuggerSession`'s own detach, so the unfocused-tab invariant is
   * restored on every exit path — success, or a throw from the capture itself.
   *
   * `options.scale` is accepted (the downscale-ladder recapture contract) but is
   * not currently applied to a beyond-viewport capture: CDP
   * `Page.captureScreenshot` has no top-level `scale` parameter — the only
   * `scale` lives inside `clip`, and this capture sends no clip. A scaled
   * beyond-viewport capture would need a document-spanning clip with a lowered
   * `clip.scale`; the base full-page capture renders at scale 1.
   */
  captureFullPageScreenshot(
    tabId: number,
    options?: { readonly scale?: number },
  ): Promise<string>;

  /**
   * Evaluate a JavaScript `expression` in the given tab's page context via CDP
   * `Runtime.evaluate`, returning the value serialised as JSON in the same
   * `InPageScriptOutcome` shape the `executeScript` handler produces. Unlike
   * `chrome.scripting`, the CDP path is exempt from the page's
   * Content-Security-Policy, so this reads values on strict-CSP sites where
   * `executeScript` is blocked. A page-level throw or unserialisable value
   * resolves to `{ ok: false, error }`; an attach / detach failure rejects.
   */
  evaluate(tabId: number, expression: string): Promise<InPageScriptOutcome>;

  /**
   * Move the given tab's scroll position via CDP, materialising virtualized /
   * lazy-rendered list rows the `chrome.scripting` ISOLATED-world reads
   * (`readPage`/`getPageText`/`findElement`) cannot react to. Tries a synthetic
   * `Input.dispatchMouseEvent` wheel first, and falls back to a
   * `window.scrollBy`/`window.scrollTo` script scroll (via `Runtime.evaluate`)
   * only when the wheel did not move the page. Resolves with `method: 'none'`
   * when neither moved the page.
   */
  scroll(tabId: number, intent: ScrollIntent): Promise<ScrollOutcome>;
}

/**
 * The production `DebuggerPorts`, backed by the MV3 `chrome.debugger` API.
 */
export function chromeCaptureDebuggerPorts(): DebuggerPorts {
  // Rejection handles for in-flight commands, keyed by tab id so a
  // browser-initiated detach (service-worker suspension, or the user opening
  // DevTools on the sandbox tab) rejects only the command it interrupted
  // instead of leaving its promise hanging. The single listener is registered
  // once here, at construction, so it is never re-accumulated per command.
  const inFlight = new Map<
    number,
    { readonly label: string; readonly reject: (error: Error) => void }
  >();

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const entry = inFlight.get(tabId);
    if (entry === undefined) return;
    inFlight.delete(tabId);
    entry.reject(
      new Error(`chrome.debugger detached (${reason}) while ${entry.label}`),
    );
  });

  /**
   * Run one CDP command against a tab within a single attach / command /
   * detach session, rejecting an in-flight command when the browser detaches
   * mid-execution, and giving up after a timeout so a hung page command can
   * never wedge the debugger attachment. Shared by `captureScreenshot`,
   * `evaluate`, and `scroll` so a failed, suspended, or hung command never
   * leaks a debugger attachment. `timeoutMs` overrides the default in tests.
   */
  async function withDebuggerSession<T>(
    tabId: number,
    label: "capturing" | "capturing-full-page" | "evaluating" | "scrolling",
    run: () => Promise<T>,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);

    // A handle the onDetach listener uses to reject a command still waiting on
    // the CDP reply. Registered before the command so a detach that fires
    // mid-command fails the pending promise, no matter which settles first.
    // On the success path this promise simply never settles — it is a no-op.
    let rejectInterruption: ((error: Error) => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectInterruption = reject;
    });
    inFlight.set(tabId, {
      label,
      reject: (error) => rejectInterruption?.(error),
    });

    const command = Promise.race([run(), interrupted]);

    // Bound the whole session. `command` is the normal outcome (run resolved or
    // a browser-initiated detach rejected it); `timeoutDeath` fires when a page
    // is so busy that even the settle-delay / read-back `Runtime.evaluate`
    // never resolves. Either way the finally below detaches, so a hung command
    // releases the attachment instead of leaking it and wedging later calls.
    // (`command` is subscribed to by `Promise.race`, so a rejection it produces
    // after the race settles is handled and never surfaces as unhandled.)
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutDeath = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `chrome.debugger command timed out after ${timeoutMs}ms while ${label}`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([command, timeoutDeath]);
    } finally {
      // Cancel the pending timeout so a command that finished on time can never
      // reject `timeoutDeath` later — that would be an unhandled rejection.
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      // Clear the handle BEFORE our own detach, because detaching fires
      // onDetach — with the entry gone that firing is a no-op, not a stray
      // rejection of a command that already settled.
      inFlight.delete(tabId);
      // Detach runs on every path. If the browser already detached (or a prior
      // failure left nothing attached), detach rejects; swallow that so it
      // never masks the command outcome the caller is about to observe.
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }

  async function captureScreenshot(
    tabId: number,
    options?: CaptureScreenshotOptions,
  ): Promise<string> {
    return withDebuggerSession(tabId, "capturing", () =>
      screenshotTab(tabId, options),
    );
  }

  async function captureFullPageScreenshot(
    tabId: number,
    options?: { readonly scale?: number },
  ): Promise<string> {
    return withDebuggerSession(tabId, "capturing-full-page", async () => {
      // The sandbox tab is deliberately unfocused, which suspends its compositor
      // render pass — the horizon-13 reason captureBeyondViewport came back with
      // blank off-screen pixels. Force Blink to treat the page as focused for the
      // duration of this one capture, then restore it in the finally below so the
      // unfocused-tab invariant holds on every exit path (success or a throw).
      await chrome.debugger.sendCommand(
        { tabId },
        "Emulation.setFocusEmulationEnabled",
        { enabled: true },
      );
      try {
        return await screenshotTab(tabId, {
          captureBeyondViewport: true,
          ...(options?.scale !== undefined ? { scale: options.scale } : {}),
        });
      } finally {
        // Unconditionally disable focus emulation inside the same session. A
        // rejection here must not mask the capture outcome the caller observes,
        // so it is swallowed — `withDebuggerSession`'s own finally below still
        // detaches the debugger regardless.
        await chrome.debugger
          .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
            enabled: false,
          })
          .catch(() => {});
      }
    });
  }

  async function evaluate(
    tabId: number,
    expression: string,
  ): Promise<InPageScriptOutcome> {
    return withDebuggerSession(tabId, "evaluating", () =>
      evaluateTab(tabId, expression),
    );
  }

  async function screenshotTab(
    tabId: number,
    options?: CaptureScreenshotOptions,
  ): Promise<string> {
    const params: Record<string, unknown> = { format: "png" };
    if (options?.captureBeyondViewport === true) {
      // Full-page / beyond-viewport capture: composite the whole scrollable
      // document, sending NO clip (and no `scale`-built viewport clip). CDP has
      // no top-level `scale` parameter to apply here — a scaled beyond-viewport
      // capture would need a document-spanning clip instead; the base full-page
      // capture renders at scale 1.
      params.captureBeyondViewport = true;
    } else if (options?.clip !== undefined) {
      params.clip = options.clip;
    } else if (options?.scale !== undefined) {
      // Whole-viewport downscale: build a clip covering the whole layout
      // viewport at the requested scale. `clip` (a single element/detail rect)
      // takes precedence; `scale` only drives the no-clip (whole-page) case.
      const viewport = await readLayoutViewport(tabId);
      params.clip = {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
        scale: options.scale,
      };
    }
    const base64 = readScreenshotBase64(
      await chrome.debugger.sendCommand(
        { tabId },
        "Page.captureScreenshot",
        params,
      ),
    );
    if (base64 === undefined) {
      throw new Error("CDP Page.captureScreenshot returned no image data");
    }
    return `data:image/png;base64,${base64}`;
  }

  async function evaluateTab(
    tabId: number,
    expression: string,
  ): Promise<InPageScriptOutcome> {
    const reply = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
    );
    return cdpEvalOutcome(reply);
  }

  async function scroll(
    tabId: number,
    intent: ScrollIntent,
  ): Promise<ScrollOutcome> {
    return withDebuggerSession(tabId, "scrolling", () =>
      scrollTab(tabId, intent),
    );
  }

  async function scrollTab(
    tabId: number,
    intent: ScrollIntent,
  ): Promise<ScrollOutcome> {
    const amountPx = intent.amountPx ?? SCROLL_DEFAULT_PIXELS;
    const toBottom = intent.toBottom === true;

    const before = await readScrollMetrics(tabId);
    const scrollYBefore = before.scrollY;
    const innerHeight = before.innerHeight;
    const innerWidth = before.innerWidth;
    const scrollHeight = before.scrollHeight;

    const x = Math.round(innerWidth / 2);
    const y = Math.round(innerHeight / 2);
    const deltaY = toBottom ? scrollHeight : amountPx;

    // Try the synthetic wheel, but never let it block the reliable script
    // scroll: the sandbox tab is deliberately unfocused, where
    // Input.dispatchMouseEvent hangs, so a hung (or errored, or non-moving)
    // wheel falls through to the Runtime.evaluate scroll below.
    const wheelDispatched = await attemptWheel(tabId, x, y, deltaY);
    if (wheelDispatched) {
      await sleepTab(tabId);
      const afterWheel = await readScrollMetrics(tabId);
      if (movedBy(scrollYBefore, afterWheel.scrollY)) {
        return scrollOutcome(
          "wheel",
          scrollYBefore,
          afterWheel.scrollY,
          scrollHeight,
          innerHeight,
        );
      }
    }

    const fallbackExpression = toBottom
      ? "window.scrollTo(0, document.documentElement.scrollHeight)"
      : `window.scrollBy(0, ${amountPx})`;
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: fallbackExpression,
      returnByValue: true,
      awaitPromise: true,
    });
    await sleepTab(tabId);

    const afterScript = await readScrollMetrics(tabId);
    if (movedBy(scrollYBefore, afterScript.scrollY)) {
      return scrollOutcome(
        "script",
        scrollYBefore,
        afterScript.scrollY,
        scrollHeight,
        innerHeight,
      );
    }
    return scrollOutcome(
      "none",
      scrollYBefore,
      afterScript.scrollY,
      scrollHeight,
      innerHeight,
    );
  }

  async function sleepTab(tabId: number): Promise<void> {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: SCROLL_SETTLE_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  async function readScrollMetrics(tabId: number): Promise<ScrollMetrics> {
    const reply = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: SCROLL_METRICS_EXPRESSION,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    return parseScrollMetrics(reply);
  }

  /**
   * Read the tab's layout-viewport content size (CSS pixels) so a whole-viewport
   * scaled clip can be built at capture time. Runs inside the same
   * `withDebuggerSession` as the capture, so a single attach/detach covers both
   * the geometry read and the subsequent `Page.captureScreenshot`.
   */
  async function readLayoutViewport(
    tabId: number,
  ): Promise<{ readonly width: number; readonly height: number }> {
    const reply = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: LAYOUT_VIEWPORT_EXPRESSION,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    return parseLayoutViewport(reply);
  }

  /**
   * Dispatch a synthetic wheel and report whether the send actually completed.
   * Returns false when the command rejects, or when it has not resolved within
   * `WHEEL_ATTEMPT_TIMEOUT_MS` — an unfocused sandbox tab can hang
   * `Input.dispatchMouseEvent`, and a hang must not block the script scroll.
   * A command that loses the race leaves the underlying sendCommand pending; its
   * late rejection (on session detach) is consumed by the race's own handlers.
   */
  async function attemptWheel(
    tabId: number,
    x: number,
    y: number,
    deltaY: number,
  ): Promise<boolean> {
    const wheel = chrome.debugger.sendCommand(
      { tabId },
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x, y, deltaX: 0, deltaY },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, WHEEL_ATTEMPT_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([
        wheel.then(
          () => "wheel" as const,
          () => "error" as const,
        ),
        deadline,
      ]);
      return outcome === "wheel";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return { captureScreenshot, captureFullPageScreenshot, evaluate, scroll };
}

/**
 * Map one `Runtime.evaluate` reply to the same `InPageScriptOutcome` the
 * in-page `executeScript` closure produces, so the next phase's handler can
 * call `coerceExecuteScriptOutcome` on it with no adaptation. A page-level
 * throw comes back as `exceptionDetails`; `returnByValue` makes `result.value`
 * a JSON-safe value. An absent / `undefined` value maps to the same error
 * strings `executeScript` returns. The size ceiling is not applied here — it is
 * enforced once, in the shared `coerceExecuteScriptOutcome` coercion, so the
 * `chrome.scripting` and CDP paths stay symmetric (both surface an over-cap
 * value as `{ ok: true, json }` for that coercion to cap).
 */
function cdpEvalOutcome(reply: unknown): InPageScriptOutcome {
  if (!isRecord(reply)) {
    return { ok: false, error: "CDP Runtime.evaluate returned no result" };
  }
  const exceptionDetails = reply["exceptionDetails"];
  if (isRecord(exceptionDetails)) {
    const description = isRecord(exceptionDetails["exception"])
      ? exceptionDetails["exception"]["description"]
      : undefined;
    const text = exceptionDetails["text"];
    return {
      ok: false,
      error:
        typeof description === "string"
          ? description
          : typeof text === "string"
            ? text
            : "expression threw in page",
    };
  }
  const result = isRecord(reply["result"]) ? reply["result"] : undefined;
  if (result === undefined) {
    return {
      ok: false,
      error: "CDP Runtime.evaluate returned no result value",
    };
  }
  const value = result["value"];
  if (value === undefined) {
    return { ok: false, error: "expression returned undefined" };
  }
  let json: string;
  try {
    const serialised = JSON.stringify(value);
    if (typeof serialised !== "string") {
      return { ok: false, error: "expression result is not JSON-serialisable" };
    }
    json = serialised;
  } catch {
    return {
      ok: false,
      error: "expression result is not JSON-serialisable (circular structure)",
    };
  }
  return { ok: true, json };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Internal geometry read back from a tab before/after a scroll. */
interface ScrollMetrics {
  readonly scrollY: number;
  readonly scrollHeight: number;
  readonly innerHeight: number;
  readonly innerWidth: number;
}

/** Pixels to scroll by default when `amountPx` is omitted — roughly one viewport. */
const SCROLL_DEFAULT_PIXELS = 2000;
/** A sub-pixel wheel movement (below this) is treated as "the page did not move". */
const SCROLL_MOVE_TOLERANCE = 0.5;
/** Pixel slack allowed before deciding the page has reached the bottom. */
const SCROLL_END_SLACK = 1;
/**
 * How long to wait for a CDP `Input.dispatchMouseEvent` wheel send to resolve
 * before treating it as unusable and falling through to the `Runtime.evaluate`
 * scroll. The sandbox tab is deliberately unfocused, and CDP input dispatch to
 * an unfocused target can hang; without this bound the hanging wheel would block
 * the reliable script fallback. Far below `CDP_COMMAND_TIMEOUT_MS`.
 */
const WHEEL_ATTEMPT_TIMEOUT_MS = 750;

/** The `Runtime.evaluate` expression that reads the tab's scroll geometry. */
const SCROLL_METRICS_EXPRESSION =
  "({ scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight, innerWidth: window.innerWidth })";
/**
 * The `Runtime.evaluate` expression that reads the tab's layout-viewport
 * content size (CSS pixels). `document.documentElement.clientWidth/clientHeight`
 * is the content box of the layout viewport — the surface a CDP
 * `Page.captureScreenshot` clip is measured against — whereas
 * `window.innerWidth/innerHeight` can include the scrollbar and differ under
 * overlay-scrollbar setups, so a whole-viewport scaled clip is built from the
 * client-size family, not from `innerWidth`/`innerHeight` alone.
 */
const LAYOUT_VIEWPORT_EXPRESSION =
  "({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight })";
/** The `Runtime.evaluate` expression that yields ~150ms so lazy rows can render. */
const SCROLL_SETTLE_EXPRESSION =
  "(async () => { await new Promise(r => setTimeout(r, 150)); })()";

/** True when the page's `scrollY` moved from `from` to `to` by a real amount. */
function movedBy(from: number, to: number): boolean {
  return Math.abs(to - from) >= SCROLL_MOVE_TOLERANCE;
}

function reachedEnd(
  scrollY: number,
  innerHeight: number,
  scrollHeight: number,
): boolean {
  return scrollY + innerHeight >= scrollHeight - SCROLL_END_SLACK;
}

function scrollOutcome(
  method: ScrollOutcome["method"],
  scrollYBefore: number,
  scrollYAfter: number,
  scrollHeight: number,
  innerHeight: number,
): ScrollOutcome {
  return {
    method,
    scrollYBefore,
    scrollYAfter,
    reachedEnd: reachedEnd(scrollYAfter, innerHeight, scrollHeight),
  };
}

/**
 * Narrow one `Runtime.evaluate` reply into a `ScrollMetrics`, guarding each
 * value through `isRecord` and a finite-number check so a malformed / empty /
 * non-numeric reply degrades to zeroes (and the scroll then reports
 * `method: 'none'`) instead of yielding `NaN` or a discarded rejection.
 */
function parseScrollMetrics(reply: unknown): ScrollMetrics {
  const fallback: ScrollMetrics = {
    scrollY: 0,
    scrollHeight: 0,
    innerHeight: 0,
    innerWidth: 0,
  };
  if (!isRecord(reply)) return fallback;
  const result = isRecord(reply["result"]) ? reply["result"] : undefined;
  if (result === undefined) return fallback;
  const value = isRecord(result["value"]) ? result["value"] : undefined;
  if (value === undefined) return fallback;
  const finite = (key: string): number => {
    const n = value[key];
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  };
  return {
    scrollY: finite("scrollY"),
    scrollHeight: finite("scrollHeight"),
    innerHeight: finite("innerHeight"),
    innerWidth: finite("innerWidth"),
  };
}

/**
 * Narrow one `Runtime.evaluate` reply into the layout-viewport content size,
 * guarding each value through `isRecord` and a positive-finite-number check so
 * a malformed / empty / non-numeric reply rejects (with a clear error) rather
 * than yielding a 0x0 or NaN clip — a broken geometry read must never silently
 * produce a zero-area scaled capture.
 */
function parseLayoutViewport(reply: unknown): {
  readonly width: number;
  readonly height: number;
} {
  if (!isRecord(reply)) {
    throw new Error("CDP layout-viewport read returned no result");
  }
  const result = isRecord(reply["result"]) ? reply["result"] : undefined;
  if (result === undefined) {
    throw new Error("CDP layout-viewport read returned no result value");
  }
  const value = isRecord(result["value"]) ? result["value"] : undefined;
  if (value === undefined) {
    throw new Error("CDP layout-viewport read returned no value");
  }
  const positive = (key: string): number | undefined => {
    const n = value[key];
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const width = positive("width");
  const height = positive("height");
  if (width === undefined || height === undefined) {
    throw new Error("CDP layout-viewport read returned no usable width/height");
  }
  return { width, height };
}

/**
 * `Page.captureScreenshot` returns `{ data: <base64> }` with no data-URL prefix
 * of its own. Extract that base64, or `undefined` when the response is missing
 * it — the port then rejects rather than emitting `data:image/png;base64,undefined`.
 */
function readScreenshotBase64(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const data = (result as Record<string, unknown>)["data"];
  if (typeof data !== "string" || data === "") return undefined;
  return data;
}
