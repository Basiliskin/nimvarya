import { describe, expect, it } from "vitest";

import { PAGE_ACTIONS, isPageAction } from "./actions.js";
import type { PageAction } from "./actions.js";

describe("PAGE_ACTIONS", () => {
  it("is the exact ordered tuple of the generic page actions", () => {
    expect([...PAGE_ACTIONS]).toEqual([
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
    ]);
  });

  it("has no duplicates and no extra members", () => {
    expect(new Set(PAGE_ACTIONS).size).toBe(PAGE_ACTIONS.length);
    expect(PAGE_ACTIONS.length).toBe(21);
  });
});

describe("isPageAction", () => {
  it("accepts every member of PAGE_ACTIONS", () => {
    for (const action of PAGE_ACTIONS) {
      expect(isPageAction(action)).toBe(true);
      // narrowing compiles:
      if (isPageAction(action)) {
        const narrowed: PageAction = action;
        expect(narrowed).toBe(action);
      }
    }
  });

  it("rejects near-misses, wrong types, and nullish values", () => {
    for (const reject of [
      undefined,
      null,
      42,
      "",
      "Ping",
      "navigate",
      "captureTab ",
      " ping",
      ["ping"],
      { action: "ping" },
    ]) {
      expect(isPageAction(reject)).toBe(false);
    }
  });
});
