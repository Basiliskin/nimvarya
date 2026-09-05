/**
 * Wire protocol shared by the relay, the extension, the controller client and
 * the MCP server. Copied and trimmed from boky's `extension/devtools/domain/types.ts`:
 *
 *  - only four frame kinds survive: `hello`, `command`, `command-response`,
 *    `observation` (boky's extra frame kinds are dropped);
 *  - command / command-response ids are `string` only ( allowed
 *    `string | number`, which collides at the relay when two controllers each
 *    start counting from 1);
 *  - the actions are the generic page actions in `PAGE_ACTIONS`
 *    (`./actions.ts`) — none of boky's extension-specific commands.
 *
 * This module imports nothing outside `tools/nimvarya/src/` and references
 * no browser API.
 */

import type { PageAction } from "./actions.js";
import type { ConsoleEntry, NetworkEntry } from "./capture.js";

// --- Shared tab identity ------------------------------------------------------

/**
 * A tab's `{ id, url, title }` triple, shared by the read-only `getTabState`
 * action and the `ChromePorts` tab-identity reads. `url` / `title` are always
 * strings (not optional) — `""` when the tab is still loading or its URL is
 * restricted — so a caller can treat the identity as a complete record.
 */
export interface TabIdentity {
  readonly id: number;
  readonly url: string;
  readonly title: string;
}

// --- Per-action parameter types -------------------------------------------------

export interface PingParams {
  readonly _?: never;
}

export interface NavigateToParams {
  readonly url: string;
}

/** Optional cap on the returned character count; defaults are applied by the handler. */
export interface GetPageTextParams {
  readonly maxChars?: number;
}

/** Optional cap on the returned character count; defaults are applied by the handler. */
export interface ReadPageParams {
  readonly maxChars?: number;
}

export interface FindElementParams {
  readonly selector: string;
}

export interface ClickElementParams {
  readonly selector: string;
}

export interface TypeTextParams {
  readonly selector: string;
  readonly text: string;
}

/**
 * The three capture modes `captureTab` supports, mutually exclusive. `viewport`
 * (the default) captures the current rendered viewport; `element` captures one
 * element addressed by a CSS-locator ref; `full-page` captures the whole
 * scrollable document beyond the viewport (CDP `captureBeyondViewport`), which
 * the render-the-tab primitive made possible on the deliberately-unfocused
 * sandbox tab.
 */
export type CaptureTabMode = "viewport" | "element" | "full-page";

/**
 * Params for the `captureTab` action. `mode` is an optional three-value field —
 * `"viewport"` (the default, behaviour unchanged) captures the current rendered
 * viewport; `"element"` captures one element addressed by the `elementRef`
 * string, which is read only when `mode` is `"element"`; `"full-page"` captures
 * the whole scrollable document beyond the viewport. `elementRef` is the
 * self-contained CSS-locator string `findElement` returns (a generated selector
 * the same selector-string surface already accepts — never a CDP node id, opaque
 * handle, XPath, or index into a prior result set).
 */
export interface CaptureTabParams {
  readonly mode?: CaptureTabMode;
  readonly elementRef?: string;
}

/**
 * Shared query for the two capture-read actions. Both fields are optional: the
 * handler defaults `since` to 0 (from the start of the buffer) and `limit` to
 * `DEFAULT_READ_LIMIT`, and silently clamps `limit` to `MAX_READ_LIMIT`.
 */
export interface ReadCaptureParams {
  readonly since?: number;
  readonly limit?: number;
}

export type ReadConsoleMessagesParams = ReadCaptureParams;
export type ReadNetworkRequestsParams = ReadCaptureParams;

/** A JavaScript expression to evaluate in the active tab's MAIN world. */
export interface ExecuteScriptParams {
  readonly code: string;
}

/**
 * A JavaScript expression to evaluate in the active tab's page via CDP
 * `Runtime.evaluate` — exempt from the page's Content-Security-Policy, so it
 * reads values on strict-CSP sites (github.com, reddit.com, LinkedIn) where
 * `executeScript`'s `chrome.scripting` eval is blocked.
 */
export interface EvaluatePageParams {
  readonly code: string;
}

/** `navigateBack` takes no arguments — it acts on the active tab. */
export interface NavigateBackParams {
  readonly _?: never;
}

/** `navigateForward` takes no arguments — it acts on the active tab. */
export interface NavigateForwardParams {
  readonly _?: never;
}

/** `reloadTab` takes no arguments — it reloads the active tab. */
export interface ReloadTabParams {
  readonly _?: never;
}

/**
 * `clickAt` targets the element sitting under an x/y page coordinate (CSS pixels
 * from the top-left of the viewport). Both are required non-negative integers.
 */
export interface ClickAtParams {
  readonly x: number;
  readonly y: number;
}

/**
 * `hover` targets the element sitting under an x/y page coordinate (CSS pixels
 * from the top-left of the viewport). Both are required non-negative integers.
 */
export interface HoverParams {
  readonly x: number;
  readonly y: number;
}

/** `getTabState` takes no arguments — it reports two tab identities, targeting neither. */
export interface GetTabStateParams {
  readonly _?: never;
}

/**
 * `closeSandboxTab` takes no arguments — it closes the current sandbox tab (if
 * one exists) and clears its persisted id, so the next page action lazily
 * recreates a fresh tab. A no-op-safe, non-throwing action.
 */
export interface CloseSandboxTabParams {
  readonly _?: never;
}

/**
 * `scrollPage` scrolls the sandbox tab's page down. `amountPx` is pixels to
 * scroll down (defaults to 2000 when omitted — the port applies the default);
 * `toBottom` is a single large downward jump toward the current bottom, not a
 * loop. Scroll is always downward: there is no `direction` field and no repeat
 * count, so a caller needing more scrolling calls the tool again. Both are
 * optional; the port applies defaults and the handler never does.
 */
export interface ScrollPageParams {
  readonly amountPx?: number;
  readonly toBottom?: boolean;
}

/** The three conditions `waitFor` can block on. Modes are mutually exclusive. */
export type WaitForMode = "selector-present" | "network-idle" | "fixed-delay";

/** `waitFor` in selector-present mode: block until a CSS selector appears in the sandbox tab's DOM. */
export interface SelectorWaitParams {
  readonly mode: "selector-present";
  readonly selector: string;
  readonly timeoutMs?: number;
}

/** `waitFor` in network-idle mode: block until captured fetch/XHR traffic goes quiet. */
export interface NetworkIdleWaitParams {
  readonly mode: "network-idle";
  readonly timeoutMs?: number;
}

/** `waitFor` in fixed-delay mode: block until `delayMs` elapses, bounded by `timeoutMs`. */
export interface FixedDelayWaitParams {
  readonly mode: "fixed-delay";
  readonly delayMs: number;
  readonly timeoutMs?: number;
}

/**
 * Params for the `waitFor` action. The three wait modes are mutually exclusive —
 * exactly one shape is valid per call, discriminated by `mode`. `timeoutMs`
 * (optional) bounds the whole wait and is clamped to
 * `[MIN_TIMEOUT_MS, HARD_CAP_MS]` by the poll module, so a timeout is a normal
 * `{ met: false }` result — never a thrown error.
 */
export type WaitForParams =
  | SelectorWaitParams
  | NetworkIdleWaitParams
  | FixedDelayWaitParams;

/** Params carried by a `command` frame, keyed by its `action`. */
export interface PageActionParams {
  readonly ping: PingParams;
  readonly navigateTo: NavigateToParams;
  readonly getPageText: GetPageTextParams;
  readonly readPage: ReadPageParams;
  readonly findElement: FindElementParams;
  readonly clickElement: ClickElementParams;
  readonly typeText: TypeTextParams;
  readonly captureTab: CaptureTabParams;
  readonly readConsoleMessages: ReadConsoleMessagesParams;
  readonly readNetworkRequests: ReadNetworkRequestsParams;
  readonly executeScript: ExecuteScriptParams;
  readonly evaluatePage: EvaluatePageParams;
  readonly navigateBack: NavigateBackParams;
  readonly navigateForward: NavigateForwardParams;
  readonly reloadTab: ReloadTabParams;
  readonly clickAt: ClickAtParams;
  readonly hover: HoverParams;
  readonly getTabState: GetTabStateParams;
  readonly scrollPage: ScrollPageParams;
  readonly waitFor: WaitForParams;
  readonly closeSandboxTab: CloseSandboxTabParams;
}

// --- Per-action result types --------------------------------------------------

export interface PingResult {
  readonly ok: true;
  readonly ts: number;
}

export interface NavigateToResult {
  readonly navigated: true;
}

export interface GetPageTextResult {
  readonly text: string;
  readonly totalChars: number;
  readonly truncated: boolean;
}

export interface ReadPageResult {
  readonly content: string;
  readonly totalChars: number;
  readonly truncated: boolean;
}

/**
 * The fixed identifying attributes `findElement` reads per matched element:
 * `tagName` plus the eight HTML-attribute hooks the action covers
 * (`id`, `class`, `role`, `aria-label`, `href`, `name`, `type`, `data-testid`).
 * Every field is `string | null` — absent attributes are `null`, never omitted,
 * never `undefined`, so a caller can rely on every key being present in every
 * descriptor. `class` is the full `className` string (truncated only by the
 * result-size cap); `dataTestid` maps to `data-testid` on the element.
 */
export interface FindElementKeyAttributes {
  readonly tagName: string | null;
  readonly id: string | null;
  readonly class: string | null;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly href: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly dataTestid: string | null;
}

/**
 * One element matched by `findElement`. `ref` is a self-contained CSS-locator
 * string that re-fed to `findElement` / `clickElement` resolves to the same
 * element (a generated selector the same selector-string surface already
 * accepts — never a CDP backend id, opaque handle, XPath, or index into a prior
 * result set). `text` is the element's visible `innerText`, truncated per
 * element to the documented cap; `attributes` carries the fixed key-attribute
 * map with absent fields set to `null`.
 */
export interface FindElementMatch {
  readonly ref: string;
  readonly text: string;
  readonly attributes: FindElementKeyAttributes;
}

/**
 * The new `findElement` extraction result. `matches` is the ordered matched
 * elements (at most `MAX_FIND_ELEMENT_MATCHES`), each truncated to
 * `MAX_ELEMENT_TEXT_CHARS` of visible text. `total` is the full match count
 * before the element-count cap (so a caller can tell whether the cap fired).
 * `truncated` is `true` when either the element-count cap or the per-element
 * text cap fired; an empty match list is `{ matches: [], total: 0, truncated:
 * false }`, NOT an error.
 */
export interface FindElementResult {
  readonly matches: readonly FindElementMatch[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface ClickElementResult {
  readonly clicked: boolean;
}

export interface TypeTextResult {
  readonly typed: boolean;
}

/**
 * A real `captureTab` image capture. `dataUrl` is the
 * `data:image/png;base64,...` URL; `width`/`height` are the returned image's
 * pixel dimensions (decoded from the PNG header); `clipped` is `true` only in
 * element mode when the captured element's bounding rect exceeded the composited
 * viewport, so the returned image is cropped to the viewport.
 */
export interface CaptureTabImageResult {
  readonly captured: true;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
  /**
   * The render scale applied to this capture: `1` for a full-size capture, or a
   * downscale-ladder rung (`< 1`) when an over-large screenshot was re-taken
   * smaller. Optional so a hand-built image result from before the downscale
   * ladder still type-checks.
   */
  readonly appliedScale?: number;
  /**
   * The number of captures (initial full-size plus downscale-ladder rungs) that
   * produced this result: `1` for a capture that fit on the first try.
   * Optional for the same backward-compatibility reason as `appliedScale`.
   */
  readonly attempts?: number;
}

/** A one-line reason for a structured non-image `captureTab` outcome. */
export type CaptureTabFailureReason =
  | "element-not-found"
  | "zero-area"
  | "too-large"
  | "tab-unavailable";

/** A structured non-image `captureTab` outcome, discriminated by `captured: false`. */
export interface CaptureTabFailureResult {
  readonly captured: false;
  readonly reason: CaptureTabFailureReason;
  /** For `reason: "too-large"` — the measured base64 payload length at the give-up floor. */
  readonly size?: number;
  /** For `reason: "too-large"` — the ceiling constant every ladder rung crossed. */
  readonly limit?: number;
  /** For `reason: "too-large"` — the give-up floor scale still over the ceiling. */
  readonly floor?: number;
  /** For `reason: "too-large"` — how many captures (initial + ladder rungs) were attempted. */
  readonly attempts?: number;
  /** Optional detail, e.g. the underlying message for `reason: "tab-unavailable"`. */
  readonly detail?: string;
}

/**
 * The outcome of one `captureTab` call. A real capture is `captured: true` and
 * carries the data-URL plus width/height/clipped metadata; when the downscale
 * ladder produced it the result also records the applied scale and attempt count.
 * An over-large result is `captured: false` with `reason: "too-large"`, meaning
 * the automatic downscale ladder ran and the give-up floor was still over the
 * ceiling, carrying size/limit/floor/attempts. Every handled failure — element
 * not found, zero-area element, over-large result, or a relay/tab problem — is
 * `captured: false` with a discriminating `reason`, never a throw and never an
 * unhandled hang.
 */
export type CaptureTabResult = CaptureTabImageResult | CaptureTabFailureResult;

/**
 * The non-destructive window read returned by a capture-read action. Mirrors
 * the extension-side `CaptureRead<T>` structurally so `src/protocol` stays free
 * of an inward dependency on `src/extension`.
 */
export interface CaptureReadResult<T> {
  /** Matching entries, ascending by `seq`, at most `limit` of them. */
  readonly entries: readonly (T & { readonly seq: number })[];
  /** Pass this back as `since` on the next call to get only newer entries. */
  readonly nextSince: number;
  /** True when the ring overwrote entries the caller's `since` never covered. */
  readonly dropped: boolean;
  /** True when strictly more entries matched than were returned. */
  readonly truncated: boolean;
}

export type ReadConsoleMessagesResult = CaptureReadResult<ConsoleEntry>;
export type ReadNetworkRequestsResult = CaptureReadResult<NetworkEntry>;

/**
 * The evaluated expression's value, round-tripped through JSON so it is always
 * serialisable. A non-serialisable result (`undefined`, a function, a DOM node,
 * a circular structure), an over-large result, or a thrown error is reported as
 * a `command-response` error rather than in this shape; `error` is retained on
 * the interface for callers that model a partial result.
 */
export interface ExecuteScriptResult {
  readonly value: unknown;
  readonly error?: string;
}

/**
 * The value read by a CDP runtime evaluation, round-tripped through JSON as the
 * `executeScript` result shape (mirrors `ExecuteScriptResult` structurally). An
 * `error` is present when the CDP eval threw, returned a non-serialisable value,
 * or exceeded the size cap — modeled on the wire so a caller can distinguish a
 * genuine read from a handled failure.
 */
export interface EvaluatePageResult {
  readonly value?: unknown;
  readonly error?: string;
}

/** A successful `navigateBack` — the active tab moved to its previous history entry. */
export interface NavigateBackResult {
  readonly moved: true;
}

/** A successful `navigateForward` — the active tab moved to its next history entry. */
export interface NavigateForwardResult {
  readonly moved: true;
}

/** A successful `reloadTab` — the active tab was reloaded. */
export interface ReloadTabResult {
  readonly reloaded: true;
}

/**
 * A `clickAt` result. `found` is whether an element sat under the coordinate;
 * `dispatched` is how many synthesized pointer/mouse events were fired on it
 * (`0` when `found` is `false`). Synthetic events are untrusted, so a non-zero
 * `dispatched` does not guarantee a framework handler reacted.
 */
export interface ClickAtResult {
  readonly found: boolean;
  readonly dispatched: number;
}

/**
 * A `hover` result. `found` is whether an element sat under the coordinate;
 * `dispatched` is how many synthesized pointer/mouse events (`pointerover`,
 * `mouseover`) were fired on it (`0` when `found` is `false`). Synthetic events
 * are untrusted, so a non-zero `dispatched` does not guarantee a framework
 * handler reacted.
 */
export interface HoverResult {
  readonly found: boolean;
  readonly dispatched: number;
}

/**
 * The read-only report returned by `getTabState`: the dedicated sandbox tab and
 * the currently-focused tab of the sandbox tab's window, each as a `TabIdentity`,
 * plus a flag for whether the sandbox tab is itself that focused tab. `null` (not
 * `undefined`) means "there is no such tab" — both are `null` when no sandbox tab
 * has been created yet. `sandboxTabActive` is `true` exactly when `activeTab`
 * resolves to the same tab as `sandboxTab`.
 */
export interface GetTabStateResult {
  readonly sandboxTab: TabIdentity | null;
  readonly activeTab: TabIdentity | null;
  readonly sandboxTabActive: boolean;
}

/**
 * The outcome of one `closeSandboxTab` call. `hadTab` is `true` when a persisted
 * sandbox tab id existed and a close was attempted; `closed` is `true` when that
 * close actually succeeded. A no-op call (no stored tab, an already-closed tab,
 * or a second call after a successful close) resolves to
 * `{ closed: false, hadTab: false }` — never a throw and never an `{ error }`.
 */
export interface CloseSandboxTabResult {
  readonly closed: boolean;
  readonly hadTab: boolean;
}

/**
 * The observable outcome of one `scrollPage` call. `method` names the mechanism
 * that actually moved the page — a CDP `Input.dispatchMouseEvent` wheel
 * (`'wheel'`), the `window.scrollBy`/`window.scrollTo` script fallback
 * (`'script'`), or neither (`'none'`). `scrollYBefore`/`scrollYAfter` are the
 * page's scroll position before and after the call, and `reachedEnd` is a
 * best-effort flag (`scrollYAfter + innerHeight >= scrollHeight - SLACK`) that on
 * an infinite list may read `false` forever, which is correct.
 */
export interface ScrollPageResult {
  readonly method: "wheel" | "script" | "none";
  readonly scrollYBefore: number;
  readonly scrollYAfter: number;
  readonly reachedEnd: boolean;
}

/**
 * The outcome of one `waitFor` call. `mode` echoes which condition was checked,
 * `met` is whether it held before the timeout budget was spent, and `elapsedMs`
 * is how long the wait actually took. A timeout is a normal `{ met: false }`
 * result — never an error — with `elapsedMs` clamped to the effective budget.
 */
export interface WaitForResult {
  readonly mode: WaitForMode;
  readonly met: boolean;
  readonly elapsedMs: number;
}

/** Result carried by a successful `command-response` frame, keyed by the action. */
export interface PageActionResults {
  readonly ping: PingResult;
  readonly navigateTo: NavigateToResult;
  readonly getPageText: GetPageTextResult;
  readonly readPage: ReadPageResult;
  readonly findElement: FindElementResult;
  readonly clickElement: ClickElementResult;
  readonly typeText: TypeTextResult;
  readonly captureTab: CaptureTabResult;
  readonly readConsoleMessages: ReadConsoleMessagesResult;
  readonly readNetworkRequests: ReadNetworkRequestsResult;
  readonly executeScript: ExecuteScriptResult;
  readonly evaluatePage: EvaluatePageResult;
  readonly navigateBack: NavigateBackResult;
  readonly navigateForward: NavigateForwardResult;
  readonly reloadTab: ReloadTabResult;
  readonly clickAt: ClickAtResult;
  readonly hover: HoverResult;
  readonly getTabState: GetTabStateResult;
  readonly scrollPage: ScrollPageResult;
  readonly waitFor: WaitForResult;
  readonly closeSandboxTab: CloseSandboxTabResult;
}

// --- Frames ------------------------------------------------------------------

export type Role = "extension" | "controller";

export interface HelloMessage {
  readonly kind: "hello";
  readonly role: Role;
}

/**
 * A request frame. `action` and `params` are correlated at compile time: a
 * `{ action: "navigateTo" }` frame must carry `NavigateToParams`, never
 * `FindElementParams`.
 */
export type Command = {
  readonly [A in PageAction]: {
    readonly kind: "command";
    readonly id: string;
    readonly action: A;
    readonly params: PageActionParams[A];
  };
}[PageAction];

/**
 * The reply frame, keyed by the same `id`. Exactly one of `result` / `error` is
 * present — the "both absent" and "both present" states are not expressible.
 */
export type CommandResponse =
  | {
      readonly kind: "command-response";
      readonly id: string;
      readonly result: unknown;
      readonly error?: undefined;
    }
  | {
      readonly kind: "command-response";
      readonly id: string;
      readonly error: string;
      readonly result?: undefined;
    };

export type ObservationType = "console" | "network" | "page-error";

/** A fire-and-forget event frame from the extension to every controller. */
export interface Observation {
  readonly kind: "observation";
  readonly observationType: ObservationType;
  readonly tabId: number;
  readonly timestamp: number;
  readonly payload: unknown;
}

export type BridgeMessage =
  | HelloMessage
  | Command
  | CommandResponse
  | Observation;
