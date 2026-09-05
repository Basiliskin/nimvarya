/**
 * `waitFor`'s polling engine — a time-bounded loop that waits for one of three
 * page conditions (a CSS selector is present, captured network traffic has gone
 * quiet, or a fixed delay elapsed) and reports a met / not-met outcome.
 *
 * Why a separate standalone module:
 *
 *   Every existing page-action handler is a single one-shot check (validate →
 *   resolve tab → one call → coerce → return). `waitFor` is the first handler
 *   that has to wait over time, so its loop is built and unit-tested in
 *   isolation — with injected check callbacks, a clampable timeout budget, and
 *   no `chrome.*` / DOM / peer-module dependency — before anything wires it into
 *   a page action. The one genuinely new logic in this feature lives here.
 *
 * Contract:
 *
 *   - A mode descriptor resolves to exactly one of three shapes; the result is
 *     always `{ mode, met, elapsedMs }`.
 *   - A timeout is a normal `{ met: false }` RESULT, never a thrown error and
 *     never a hang. The budget is `clamp(timeoutMs ?? DEFAULT, MIN, HARD_CAP)`,
 *     kept a safe margin below the 30s end-to-end MCP command timeout.
 *   - The injected callbacks are the only external interface: a `now()` clock
 *     (default `Date.now`, which vitest fake timers patch) plus the mode-specific
 *     probes. A probe that throws/rejects is swallowed — it means "condition not
 *     verifiable this tick", which is never enough to declare success.
 *   - Selector mode: `isPresent()` reports true when the node is in the DOM
 *     (an existence count > 0, the `findElement` injected-function shape).
 *   - Network-idle mode: `latestSeq()` returns a monotonic activity marker (the
 *     newest captured network seq; 0 when nothing has been captured). The loop
 *     re-arms its quiet window whenever the marker advances and reports met only
 *     after `quietMs` with no advance.
 *   - Fixed-delay mode waits `delayMs`, bounded by the budget; the delay
 *     completing counts as met, the budget elapsing first is not-met.
 */

export type WaitModeKind = "selector-present" | "network-idle" | "fixed-delay";

/** Constant gap between condition checks — a fixed value, never derived from `timeoutMs`. */
export const POLL_INTERVAL_MS = 100;
/** Budget used when the caller passes no `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Floor: a typo'd 0 / negative / NaN `timeoutMs` is floored, not allowed to disable the wait. */
export const MIN_TIMEOUT_MS = 100;
/** Ceiling: keeps the wait safely below the 30s end-to-end MCP command timeout. */
export const HARD_CAP_MS = 25_000;
/** Default quiet window for network-idle mode. */
export const DEFAULT_QUIET_MS = 500;

/** One wait condition, discriminated by `kind`, carrying its injected probes. */
export type WaitCondition =
  | {
      readonly kind: "selector-present";
      /** True when the target node is in the DOM (an injected existence check). */
      readonly isPresent: () => boolean | Promise<boolean>;
    }
  | {
      readonly kind: "network-idle";
      /** Monotonic activity marker (newest captured network seq); 0 if none captured. */
      readonly latestSeq: () => number | Promise<number>;
      /** Quiet window before the page counts as idle; defaults to {@link DEFAULT_QUIET_MS}. */
      readonly quietMs?: number;
    }
  | {
      readonly kind: "fixed-delay";
      /** Milliseconds to wait; met when the delay completes within the budget. */
      readonly delayMs: number;
    };

export interface WaitForOptions {
  /** Overall budget for the wait; clamped to `[MIN_TIMEOUT_MS, HARD_CAP_MS]`. */
  readonly timeoutMs?: number;
  /** Clock override, default `Date.now` (vi fake timers patch it). */
  readonly now?: () => number;
}

export interface WaitOutcome {
  readonly mode: WaitModeKind;
  readonly met: boolean;
  readonly elapsedMs: number;
}

/**
 * Clamp a caller-supplied `timeoutMs` to the effective budget: a missing /
 * non-finite value falls back to the default, and the result never dips below
 * the floor or above the hard cap. This is the single source of truth for the
 * clamp, reused by the handler-layer validator and the unit tests.
 */
export function resolveTimeoutBudget(timeoutMs: number | undefined): number {
  const raw = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, MIN_TIMEOUT_MS), HARD_CAP_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Swallow a selector-probe error: an unverifiable condition is simply not met this tick. */
async function safePresent(
  fn: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await fn();
  } catch {
    return false;
  }
}

/**
 * Swallow a network-probe error: an unverifiable marker re-arms the quiet window
 * so the loop never reports idle on a probe that errored.
 */
async function safeSeq(
  fn: () => number | Promise<number>,
): Promise<number | "error"> {
  try {
    return await fn();
  } catch {
    return "error";
  }
}

export async function waitForCondition(
  condition: WaitCondition,
  options: WaitForOptions = {},
): Promise<WaitOutcome> {
  const now = options.now ?? (() => Date.now());
  const budget = resolveTimeoutBudget(options.timeoutMs);
  const start = now();
  const deadline = start + budget;
  const elapsed = (): number => Math.min(now() - start, budget);
  const mode = condition.kind;

  if (condition.kind === "fixed-delay") {
    const delayMs = Math.max(0, condition.delayMs);
    await sleep(Math.min(delayMs, budget));
    return { mode, met: delayMs <= budget, elapsedMs: elapsed() };
  }

  if (condition.kind === "selector-present") {
    let present = await safePresent(condition.isPresent);
    while (!present && now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      present = await safePresent(condition.isPresent);
    }
    return { mode, met: present, elapsedMs: elapsed() };
  }

  // network-idle
  const quietMs = condition.quietMs ?? DEFAULT_QUIET_MS;
  let lastSeq = await safeSeq(condition.latestSeq);
  let quietSince = start;
  while (now() < deadline) {
    const cur = await safeSeq(condition.latestSeq);
    if (cur === "error") {
      quietSince = now(); // unverifiable marker ⇒ cannot confirm idle, re-arm.
    } else if (cur !== lastSeq) {
      lastSeq = cur;
      quietSince = now();
    }
    if (now() - quietSince >= quietMs) {
      return { mode, met: true, elapsedMs: elapsed() };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { mode, met: false, elapsedMs: elapsed() };
}
