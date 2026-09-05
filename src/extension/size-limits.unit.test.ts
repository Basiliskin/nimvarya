import { describe, expect, it } from "vitest";

import { buildOversizeResult, checkSizeLimit } from "./size-limits.js";
import type { OversizeResult, SizeCeilingOutcome } from "./size-limits.js";

describe("checkSizeLimit", () => {
  it("reports withinLimit true for a value under the ceiling, echoing both sizes", () => {
    const outcome = checkSizeLimit(10, 100);
    expect(outcome).toEqual({
      withinLimit: true,
      actualBytes: 10,
      limitBytes: 100,
    });
  });

  it("reports withinLimit true for a value exactly at the ceiling (inclusive boundary)", () => {
    const outcome = checkSizeLimit(100, 100);
    expect(outcome).toEqual({
      withinLimit: true,
      actualBytes: 100,
      limitBytes: 100,
    });
    expect(outcome.withinLimit).toBe(true);
  });

  it("reports withinLimit false for a value over the ceiling", () => {
    const outcome = checkSizeLimit(101, 100);
    expect(outcome).toEqual({
      withinLimit: false,
      actualBytes: 101,
      limitBytes: 100,
    });
  });

  it("does not mutate or round either argument", () => {
    const outcome = checkSizeLimit(1_000_001, 1_000_000);
    expect(outcome.actualBytes).toBe(1_000_001);
    expect(outcome.limitBytes).toBe(1_000_000);
  });
});

describe("buildOversizeResult", () => {
  it("shapes an over-cap outcome into a plain result carrying tooLarge and both sizes", () => {
    const outcome: SizeCeilingOutcome = checkSizeLimit(101, 100);
    const result: OversizeResult = buildOversizeResult(outcome);
    expect(result).toEqual({
      tooLarge: true,
      actualBytes: 101,
      limitBytes: 100,
    });
  });

  it("surfaces a within-limit outcome as tooLarge false, without discarding the sizes", () => {
    const result = buildOversizeResult(checkSizeLimit(100, 100));
    expect(result).toEqual({
      tooLarge: false,
      actualBytes: 100,
      limitBytes: 100,
    });
  });

  it("returns exactly-at-cap as tooLarge false (inclusive boundary propagates to the builder)", () => {
    const result = buildOversizeResult(checkSizeLimit(100, 100));
    expect(result.tooLarge).toBe(false);
  });

  it("returns a plain serialisable object with no tool-specific or action-name field", () => {
    const result = buildOversizeResult(checkSizeLimit(200, 100));
    expect(Object.keys(result).sort()).toEqual([
      "actualBytes",
      "limitBytes",
      "tooLarge",
    ]);
    expect(result).not.toHaveProperty("actionName");
    expect(result).not.toHaveProperty("error");
  });
});
