/**
 * The size-limit policy for the bridge's page-value tools (`executeScript`,
 * `evaluatePage`, and any future tool that returns a serialised value to an MCP
 * caller).
 *
 * This is a FLAT ceiling: a value either fits within its cap or it does not,
 * and there is no re-render-and-retry. The helpers here do exactly that one
 * comparison, and it is deliberately distinct from `captureTab`'s downscale
 * ladder, which re-renders a screenshot at a smaller scale and retries down a
 * bounded set of rungs. The two size policies are unrelated, so nothing in this
 * module should be used to reason about the capture ladder.
 *
 * Why a standalone module:
 *
 *   Two independent tools currently re-implement the exact same oversize check
 *   — `coerceExecuteScriptOutcome` (page-actions.ts, the `chrome.scripting`
 *   transport) and the CDP `evaluatePage` path (debugger-ports.ts) — each
 *   importing the same `MAX_EXECUTE_SCRIPT_RESULT_CHARS` constant and each
 *   branching to a near-identical throw/sentinel branch instead of returning a
 *   structured result. Both are rewired onto the helpers below so that an
 *   over-cap result is a non-throwing condition a caller can branch on, not a
 *   thrown error. The comparison is small but it is policy, and policy is worth
 *   doing once, so this module is built and unit-tested in isolation before
 *   anything depends on it.
 */

/**
 * The result of comparing a serialised value's size against the ceiling — a
 * FLAT ceiling result, distinct from `captureTab`'s downscale-ladder sizing,
 * which re-renders a screenshot smaller and retries down a bounded set of rungs.
 * This type has nothing to do with that ladder: a value either fits within
 * `limitBytes` or it does not, and there is no retry. `withinLimit` is true when
 * `actualBytes <= limitBytes` — a value exactly at the cap still fits, so the
 * boundary is inclusive.
 */
export interface SizeCeilingOutcome {
  /** True when `actualBytes <= limitBytes` — exactly at the cap still fits. */
  readonly withinLimit: boolean;
  /** The measured size of the value. For the bridge this is the serialised string's `.length`. */
  readonly actualBytes: number;
  /** The ceiling this value was measured against. */
  readonly limitBytes: number;
}

/** A generic, tool-agnostic "this value was too large to return" payload. */
export interface OversizeResult {
  readonly tooLarge: boolean;
  readonly actualBytes: number;
  readonly limitBytes: number;
}

/**
 * Compare a measured size against the ceiling. Pure and synchronous — no I/O,
 * no `chrome.*`/DOM access, no async. The boundary is inclusive: a value exactly
 * at `limitBytes` is `withinLimit: true`.
 */
export function checkSizeLimit(
  actualBytes: number,
  limitBytes: number,
): SizeCeilingOutcome {
  return {
    withinLimit: actualBytes <= limitBytes,
    actualBytes,
    limitBytes,
  };
}

/**
 * Shape a `SizeCeilingOutcome` into a plain, serialisable non-throwing result a
 * tool handler can return. Generic by construction — it carries no action name
 * and no tool-specific field, so `executeScript`, `evaluatePage`, or a future
 * tool can surface "the value was too large to return" the same way. It keeps
 * `actualBytes` and `limitBytes` so a caller can report the size gap.
 */
export function buildOversizeResult(
  outcome: SizeCeilingOutcome,
): OversizeResult {
  return {
    tooLarge: !outcome.withinLimit,
    actualBytes: outcome.actualBytes,
    limitBytes: outcome.limitBytes,
  };
}
