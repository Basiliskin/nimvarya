import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_QUIET_MS,
  DEFAULT_TIMEOUT_MS,
  HARD_CAP_MS,
  MIN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  resolveTimeoutBudget,
  waitForCondition,
} from "./wait-condition.js";
import type { WaitCondition, WaitModeKind } from "./wait-condition.js";

/**
 * Let the initial condition probe (and its continuation) run so the poll loop's
 * first `setTimeout` is scheduled before the clock is advanced.
 */
async function scheduleNextPoll(): Promise<void> {
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForCondition — selector-present", () => {
  it("resolves met once the node appears mid-poll", async () => {
    let present = false;
    const p = waitForCondition(
      { kind: "selector-present", isPresent: () => present },
      { timeoutMs: 1000 },
    );
    present = true;
    await scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    const outcome = await p;
    expect(outcome).toEqual({
      mode: "selector-present",
      met: true,
      elapsedMs: POLL_INTERVAL_MS,
    });
  });

  it("resolves met immediately when the node is already present", async () => {
    const p = waitForCondition(
      { kind: "selector-present", isPresent: () => true },
      { timeoutMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(0);

    const outcome = await p;
    expect(outcome.met).toBe(true);
    expect(outcome.elapsedMs).toBe(0);
  });

  it("resolves met:false when the node never appears, bounded by the timeout budget", async () => {
    const p = waitForCondition(
      { kind: "selector-present", isPresent: () => false },
      { timeoutMs: 300 },
    );
    await scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(400);

    const outcome = await p;
    expect(outcome).toEqual({
      mode: "selector-present",
      met: false,
      elapsedMs: 300,
    });
  });

  it("swallows a throwing selector check and still resolves met:false", async () => {
    const p = waitForCondition(
      {
        kind: "selector-present",
        isPresent: () => {
          throw new Error("boom");
        },
      },
      { timeoutMs: 200 },
    );
    await scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(300);

    const outcome = await p;
    expect(outcome.met).toBe(false);
    expect(outcome.elapsedMs).toBe(200);
  });
});

describe("waitForCondition — network-idle", () => {
  it("resolves met after a quiet window with no new activity", async () => {
    const latestSeq = vi.fn((): number => 0);
    const p = waitForCondition(
      { kind: "network-idle", latestSeq, quietMs: 200 },
      { timeoutMs: 1000 },
    );
    await scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(300);

    const outcome = await p;
    expect(outcome).toEqual({
      mode: "network-idle",
      met: true,
      elapsedMs: 200,
    });
  });

  it("re-arms the quiet window when a new network entry arrives mid-wait", async () => {
    const latestSeq = vi
      .fn()
      .mockReturnValueOnce(0) // initial baseline
      .mockReturnValueOnce(0) // first poll: still quiet, no advance
      .mockReturnValueOnce(5) // second poll: new activity, re-arm
      .mockReturnValueOnce(5) // third poll: quiet again
      .mockReturnValue(5); // remainder
    const p = waitForCondition(
      { kind: "network-idle", latestSeq, quietMs: 200 },
      { timeoutMs: 1000 },
    );
    await scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(400);

    const outcome = await p;
    // The re-arm pushed met from the naive 200ms to ~300ms; prove it waited past
    // a single quiet window rather than trusting a frozen baseline.
    expect(outcome.met).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(250);
  });

  it("resolves met:false when traffic keeps arriving past the timeout budget", async () => {
    let seq = 0;
    const latestSeq = vi.fn((): number => {
      seq += 1;
      return seq; // activity every poll; never quiet
    });
    const p = waitForCondition(
      { kind: "network-idle", latestSeq, quietMs: 200 },
      { timeoutMs: 300 },
    );
    await scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(400);

    const outcome = await p;
    expect(outcome.met).toBe(false);
    expect(outcome.elapsedMs).toBe(300);
  });

  it("never reports idle on a throwing network probe; resolves met:false at the budget", async () => {
    const latestSeq = vi.fn((): number => {
      throw new Error("boom");
    });
    const p = waitForCondition(
      { kind: "network-idle", latestSeq, quietMs: 200 },
      { timeoutMs: 300 },
    );
    await scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(400);

    const outcome = await p;
    expect(outcome.met).toBe(false);
    expect(outcome.elapsedMs).toBe(300);
  });
});

describe("waitForCondition — fixed-delay", () => {
  it("resolves met after the delay elapses within the budget", async () => {
    const p = waitForCondition(
      { kind: "fixed-delay", delayMs: 150 },
      { timeoutMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(200);

    const outcome = await p;
    expect(outcome.met).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(150);
  });

  it("resolves met:false when the delay exceeds the timeout budget", async () => {
    const p = waitForCondition(
      { kind: "fixed-delay", delayMs: 1000 },
      { timeoutMs: 200 },
    );
    await vi.advanceTimersByTimeAsync(300);

    const outcome = await p;
    expect(outcome.met).toBe(false);
    expect(outcome.elapsedMs).toBe(200);
  });
});

describe("resolveTimeoutBudget — clamp", () => {
  it("floors a 0 / negative / NaN timeoutMs to the minimum budget", () => {
    expect(resolveTimeoutBudget(0)).toBe(MIN_TIMEOUT_MS);
    expect(resolveTimeoutBudget(-5)).toBe(MIN_TIMEOUT_MS);
    expect(resolveTimeoutBudget(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("caps a huge timeoutMs at the hard cap", () => {
    expect(resolveTimeoutBudget(1_000_000)).toBe(HARD_CAP_MS);
  });

  it("defaults a missing timeoutMs to the default budget", () => {
    expect(resolveTimeoutBudget(undefined)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("passes an in-range timeoutMs through unchanged", () => {
    expect(resolveTimeoutBudget(1500)).toBe(1500);
  });
});

describe("waitForCondition — contract", () => {
  it("reports the exact mode it was given on every verdict", async () => {
    const modes: WaitModeKind[] = [
      "selector-present",
      "network-idle",
      "fixed-delay",
    ];
    for (const mode of modes) {
      const condition: WaitCondition =
        mode === "selector-present"
          ? { kind: "selector-present", isPresent: () => true }
          : mode === "network-idle"
            ? { kind: "network-idle", latestSeq: () => 0 }
            : { kind: "fixed-delay", delayMs: 1 };
      const p = waitForCondition(condition, { timeoutMs: 200 });
      await vi.advanceTimersByTimeAsync(300);
      const outcome = await p;
      expect(outcome.mode).toBe(mode);
    }
  });

  it("exposes the exported constants as the documented clamps", () => {
    expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(50);
    expect(DEFAULT_QUIET_MS).toBeGreaterThan(0);
    expect(HARD_CAP_MS).toBeLessThanOrEqual(25_000);
  });
});
