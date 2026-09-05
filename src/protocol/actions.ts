/**
 * The single source of truth for the generic page actions the bridge supports.
 *
 * Every other list in the package (the extension's handler map, the MCP tool
 * catalog) is derived from this tuple by typing itself `Record<PageAction, ...>`,
 * so adding an action here without updating a consumer is a `tsc` error — this
 * replaces boky's runtime regex parity check.
 */

export const PAGE_ACTIONS = [
  "ping",
  "navigateTo",
  "getPageText",
  "readPage",
  "findElement",
  "clickElement",
  "typeText",
  "captureTab",
  "readConsoleMessages",
  "readNetworkRequests",
  "executeScript",
  "evaluatePage",
  "navigateBack",
  "navigateForward",
  "reloadTab",
  "clickAt",
  "hover",
  "getTabState",
  "scrollPage",
  "waitFor",
  "closeSandboxTab",
] as const;

export type PageAction = (typeof PAGE_ACTIONS)[number];

/** Narrows an arbitrary value to a known page action. */
export function isPageAction(value: unknown): value is PageAction {
  return (
    typeof value === "string" && PAGE_ACTIONS.some((action) => action === value)
  );
}
