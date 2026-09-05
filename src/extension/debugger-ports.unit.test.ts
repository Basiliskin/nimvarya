import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DebuggerPorts,
  ScrollIntent,
  ScrollOutcome,
} from "./debugger-ports.js";
import { chromeCaptureDebuggerPorts } from "./debugger-ports.js";
import { MAX_EXECUTE_SCRIPT_RESULT_CHARS } from "./page-actions.js";

/**
 * `chromeCaptureDebuggerPorts` is the production `DebuggerPorts`; it only
 * touches `chrome.*` inside the returned closures, so a stub `chrome.debugger`
 * global is enough to prove it builds a data-URL from the CDP base64, detaches
 * on every path, re-attaches cleanly after a failure, and rejects an in-flight
 * capture when the browser detaches mid-command.
 */

/** A realistic base64 PNG payload — just needs to round-trip through the prefix. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";

/**
 * The `Runtime.evaluate` expression `screenshotTab` uses to read the layout
 * viewport for a scaled whole-viewport clip (mirrors the scroll-metrics
 * expression pattern; asserted verbatim so a regression that switches the port
 * to `innerWidth`/`innerHeight` fails loudly).
 */
const LAYOUT_VIEWPORT_EXPR =
  "({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight })";

interface StubChrome {
  debugger: {
    attach: (target: { tabId?: number }, version: string) => Promise<void>;
    detach: (target: { tabId?: number }) => Promise<void>;
    sendCommand: (
      target: { tabId?: number },
      method: string,
      params?: unknown,
    ) => Promise<unknown>;
    onDetach: {
      addListener: (
        cb: (source: { tabId?: number | undefined }, reason: string) => void,
      ) => void;
    };
  };
}

interface StubControls {
  attachSpy: ReturnType<typeof vi.fn>;
  detachSpy: ReturnType<typeof vi.fn>;
  sendCommandSpy: ReturnType<typeof vi.fn>;
  addListenerSpy: ReturnType<typeof vi.fn>;
  fireDetach: (tabId: number | undefined, reason?: string) => void;
}

function installStubDebugger(
  sendCommand?: (
    target: { tabId?: number },
    method: string,
    params?: unknown,
  ) => Promise<unknown>,
): StubControls {
  let detachCb:
    | ((source: { tabId?: number | undefined }, reason: string) => void)
    | undefined;
  const attachSpy = vi.fn((_target: { tabId?: number }, _version: string) =>
    Promise.resolve(),
  );
  const detachSpy = vi.fn((_target: { tabId?: number }) => Promise.resolve());
  const sendCommandSpy = vi.fn(
    sendCommand ??
      ((_target: { tabId?: number }, _method: string, _params?: unknown) =>
        Promise.resolve({ data: PNG_B64 })),
  );
  const addListenerSpy = vi.fn(
    (cb: (source: { tabId?: number | undefined }, reason: string) => void) => {
      detachCb = cb;
    },
  );
  const stub: StubChrome = {
    debugger: {
      attach: attachSpy,
      detach: detachSpy,
      sendCommand: sendCommandSpy,
      onDetach: { addListener: addListenerSpy },
    },
  };
  vi.stubGlobal("chrome", stub);
  return {
    attachSpy,
    detachSpy,
    sendCommandSpy,
    addListenerSpy,
    fireDetach: (tabId, reason = "target closed") => {
      if (detachCb === undefined) throw new Error("no detach listener");
      detachCb({ tabId }, reason);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chromeCaptureDebuggerPorts", () => {
  it("builds a single-prefixed data-URL from the CDP base64 payload", async () => {
    const { attachSpy, detachSpy, sendCommandSpy } = installStubDebugger();
    const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

    const url = await ports.captureScreenshot(7);

    expect(url).toBe(`data:image/png;base64,${PNG_B64}`);
    // Passed through unmodified: the substring after the prefix is the stub bytes.
    expect(url.slice(url.indexOf(",") + 1)).toBe(PNG_B64);
    // Exactly one prefix — the double-prefix bug would fail this count.
    expect(url.match(/data:image\/png;base64,/g)).toHaveLength(1);
    // The CDP call is made with the tabId and the screenshot method.
    expect(attachSpy).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
    expect(sendCommandSpy).toHaveBeenCalledWith(
      { tabId: 7 },
      "Page.captureScreenshot",
      { format: "png" },
    );
    expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("passes a clip rect through to Page.captureScreenshot when requested", async () => {
    const { sendCommandSpy } = installStubDebugger();
    const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

    await ports.captureScreenshot(7, {
      clip: { x: 8859, y: 0, width: 546, height: 1811, scale: 1 },
    });

    expect(sendCommandSpy).toHaveBeenCalledWith(
      { tabId: 7 },
      "Page.captureScreenshot",
      {
        format: "png",
        clip: { x: 8859, y: 0, width: 546, height: 1811, scale: 1 },
      },
    );
  });

  it("builds a whole-viewport scaled clip from a layout-viewport read when scale is supplied without a clip", async () => {
    const { attachSpy, detachSpy, sendCommandSpy } = installStubDebugger(
      (_target, method) =>
        method === "Runtime.evaluate"
          ? Promise.resolve({
              result: { type: "object", value: { width: 1280, height: 800 } },
            })
          : Promise.resolve({ data: PNG_B64 }),
    );
    const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

    const url = await ports.captureScreenshot(7, { scale: 0.5 });

    expect(url).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(attachSpy).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
    expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
    // The layout-viewport geometry is read first, via a CDP Runtime.evaluate
    // (one attach/detach session covers both the read and the capture).
    expect(sendCommandSpy).toHaveBeenCalledWith(
      { tabId: 7 },
      "Runtime.evaluate",
      {
        expression: LAYOUT_VIEWPORT_EXPR,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    // The capture clip is the whole viewport at origin 0,0 at the requested
    // scale, sized from that read (not from innerWidth/innerHeight).
    expect(sendCommandSpy).toHaveBeenCalledWith(
      { tabId: 7 },
      "Page.captureScreenshot",
      {
        format: "png",
        clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 },
      },
    );
  });

  it("passes a lowered clip.scale through for element mode, preserving x/y/width/height", async () => {
    const { sendCommandSpy } = installStubDebugger();
    const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

    await ports.captureScreenshot(7, {
      clip: { x: 8859, y: 0, width: 546, height: 1811, scale: 0.5 },
    });

    // Element-mode downscale lowers clip.scale but leaves the rect geometry
    // untouched — the port forwards the clip verbatim, no geometry read.
    expect(sendCommandSpy).toHaveBeenCalledWith(
      { tabId: 7 },
      "Page.captureScreenshot",
      {
        format: "png",
        clip: { x: 8859, y: 0, width: 546, height: 1811, scale: 0.5 },
      },
    );
  });

  it("prefers a supplied clip over a top-level scale, so no geometry read happens when both are present", async () => {
    const { sendCommandSpy } = installStubDebugger();
    const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

    await ports.captureScreenshot(7, {
      clip: { x: 100, y: 50, width: 640, height: 480, scale: 0.75 },
      scale: 0.5,
    });

    // The clip wins; the top-level scale is ignored. Only the capture call is
    // made — the sendCommandSpy is hit exactly once (no geometry read).
    expect(sendCommandSpy).toHaveBeenCalledTimes(1);
    expect(sendCommandSpy).toHaveBeenCalledWith(
      { tabId: 7 },
      "Page.captureScreenshot",
      {
        format: "png",
        clip: { x: 100, y: 50, width: 640, height: 480, scale: 0.75 },
      },
    );
  });

  it("rejects with a clear error when the layout-viewport read is unusable", async () => {
    const { detachSpy } = installStubDebugger((_target, method) =>
      method === "Runtime.evaluate"
        ? Promise.resolve({
            result: { type: "object", value: { width: "nope" } },
          })
        : Promise.resolve({ data: PNG_B64 }),
    );
    const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

    await expect(ports.captureScreenshot(7, { scale: 0.5 })).rejects.toThrow(
      "no usable width/height",
    );
    // The rejection still detaches — nothing left attached.
    expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("rejects with a clear error when the CDP response has no image data", async () => {
    const { detachSpy, sendCommandSpy } = installStubDebugger();
    sendCommandSpy.mockResolvedValue({});
    const ports = chromeCaptureDebuggerPorts();

    await expect(ports.captureScreenshot(7)).rejects.toThrow("no image data");
    // The rejection path still detaches — nothing left attached.
    expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("detaches and surfaces the CDP error when sendCommand rejects", async () => {
    const { detachSpy, sendCommandSpy } = installStubDebugger();
    sendCommandSpy.mockRejectedValue(new Error("Cannot attach to target"));
    const ports = chromeCaptureDebuggerPorts();

    await expect(ports.captureScreenshot(7)).rejects.toThrow(
      "Cannot attach to target",
    );
    expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("swallows a detach error so it cannot mask the capture outcome", async () => {
    const { detachSpy } = installStubDebugger();
    detachSpy.mockRejectedValue(new Error("No debugger attached"));
    const ports = chromeCaptureDebuggerPorts();

    await expect(ports.captureScreenshot(7)).resolves.toBe(
      `data:image/png;base64,${PNG_B64}`,
    );
  });

  it("re-attaches cleanly after a failed capture", async () => {
    const { attachSpy, detachSpy, sendCommandSpy } = installStubDebugger();
    sendCommandSpy.mockRejectedValueOnce(new Error("boom"));
    const ports = chromeCaptureDebuggerPorts();

    await expect(ports.captureScreenshot(7)).rejects.toThrow("boom");
    // Second call succeeds — the first failure detached, so re-attach works.
    sendCommandSpy.mockResolvedValue({ data: PNG_B64 });
    const url = await ports.captureScreenshot(7);

    expect(url).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(attachSpy).toHaveBeenCalledTimes(2);
    expect(detachSpy).toHaveBeenCalledTimes(2);
  });

  it("registers the onDetach listener exactly once across captures", async () => {
    const { addListenerSpy } = installStubDebugger();
    const ports = chromeCaptureDebuggerPorts();

    await ports.captureScreenshot(7);
    await ports.captureScreenshot(7);

    expect(addListenerSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an in-flight capture when the browser detaches mid-command", async () => {
    const { sendCommandSpy, fireDetach } = installStubDebugger();
    let release: (() => void) | undefined;
    const gate = new Promise<unknown>((resolve) => {
      release = () => {
        resolve({ data: PNG_B64 });
      };
    });
    sendCommandSpy.mockReturnValue(gate);
    const ports = chromeCaptureDebuggerPorts();

    const pending = ports.captureScreenshot(9);
    // Let the async capture reach its in-flight race before firing a detach —
    // in real Chrome onDetach is async, so flush the microtask queue here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireDetach(9);

    await expect(pending).rejects.toThrow("chrome.debugger detached");
    // Resolve the abandoned screenshot so nothing lingers across tests.
    release?.();
  });

  it("treats a second detach event for the same tab as a no-op", () => {
    const { fireDetach } = installStubDebugger();
    chromeCaptureDebuggerPorts();

    expect(() => {
      fireDetach(5);
      fireDetach(5);
    }).not.toThrow();
  });

  describe("captureFullPageScreenshot", () => {
    it("enables focus emulation, captures beyond-viewport, then disables focus emulation, in one session", async () => {
      const { attachSpy, detachSpy, sendCommandSpy } = installStubDebugger();
      const ports = chromeCaptureDebuggerPorts();

      const url = await ports.captureFullPageScreenshot(7);

      expect(url).toBe(`data:image/png;base64,${PNG_B64}`);
      expect(attachSpy).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
      // The three CDP commands, in order, all over the one attachment.
      const commands = sendCommandSpy.mock.calls.map(
        ([_target, method, params]) => ({ method, params }),
      );
      expect(commands).toEqual([
        {
          method: "Emulation.setFocusEmulationEnabled",
          params: { enabled: true },
        },
        {
          method: "Page.captureScreenshot",
          params: { format: "png", captureBeyondViewport: true },
        },
        {
          method: "Emulation.setFocusEmulationEnabled",
          params: { enabled: false },
        },
      ]);
      expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
    });

    it("still sends the disable inside the session when the capture step throws", async () => {
      const calls: { method: string; params: unknown }[] = [];
      installStubDebugger((_target, method, params) => {
        calls.push({ method, params });
        if (method === "Page.captureScreenshot") {
          return Promise.reject(new Error("capture failed"));
        }
        return Promise.resolve({ data: PNG_B64 });
      });
      const ports = chromeCaptureDebuggerPorts();

      await expect(ports.captureFullPageScreenshot(7)).rejects.toThrow(
        "capture failed",
      );

      // enable -> capture -> disable, even though capture threw; the capture
      // error is what the caller observes.
      expect(calls.map((c) => c.method)).toEqual([
        "Emulation.setFocusEmulationEnabled",
        "Page.captureScreenshot",
        "Emulation.setFocusEmulationEnabled",
      ]);
    });

    it("propagates the capture error even when the disable command rejects", async () => {
      const calls: { method: string; params: unknown }[] = [];
      installStubDebugger((_target, method, params) => {
        calls.push({ method, params });
        if (method === "Page.captureScreenshot") {
          return Promise.reject(new Error("capture failed"));
        }
        if (
          method === "Emulation.setFocusEmulationEnabled" &&
          (params as { enabled?: boolean } | undefined)?.enabled === false
        ) {
          return Promise.reject(new Error("disable failed"));
        }
        return Promise.resolve({ data: PNG_B64 });
      });
      const ports = chromeCaptureDebuggerPorts();

      await expect(ports.captureFullPageScreenshot(7)).rejects.toThrow(
        "capture failed",
      );
      // The disable is attempted (and rejects), but it must not mask the
      // capture error — that error is what the caller observes.
      expect(calls.map((c) => c.method)).toEqual([
        "Emulation.setFocusEmulationEnabled",
        "Page.captureScreenshot",
        "Emulation.setFocusEmulationEnabled",
      ]);
    });

    it("does not send a compensating disable when the enable command itself fails", async () => {
      const calls: { method: string; params: unknown }[] = [];
      installStubDebugger((_target, method, params) => {
        calls.push({ method, params });
        if (method === "Emulation.setFocusEmulationEnabled") {
          return Promise.reject(new Error("enable failed"));
        }
        return Promise.resolve({ data: PNG_B64 });
      });
      const ports = chromeCaptureDebuggerPorts();

      await expect(ports.captureFullPageScreenshot(7)).rejects.toThrow(
        "enable failed",
      );
      // Nothing was enabled, so no compensating disable is sent.
      expect(calls.map((c) => c.method)).toEqual([
        "Emulation.setFocusEmulationEnabled",
      ]);
    });

    it("re-attaches cleanly after a failed full-page capture", async () => {
      const { attachSpy, detachSpy, sendCommandSpy } = installStubDebugger();
      sendCommandSpy.mockRejectedValueOnce(new Error("boom"));
      const ports = chromeCaptureDebuggerPorts();

      await expect(ports.captureFullPageScreenshot(7)).rejects.toThrow("boom");
      sendCommandSpy.mockResolvedValue({ data: PNG_B64 });
      const url = await ports.captureFullPageScreenshot(7);

      expect(url).toBe(`data:image/png;base64,${PNG_B64}`);
      expect(attachSpy).toHaveBeenCalledTimes(2);
      expect(detachSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("evaluate", () => {
    it("returns a JSON-serialised value from the CDP result", async () => {
      const { attachSpy, detachSpy, sendCommandSpy } = installStubDebugger();
      sendCommandSpy.mockResolvedValue({
        result: { type: "string", value: "hi" },
      });
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.evaluate(7, "document.title");

      expect(outcome).toEqual({ ok: true, json: '"hi"' });
      expect(attachSpy).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
      expect(sendCommandSpy).toHaveBeenCalledWith(
        { tabId: 7 },
        "Runtime.evaluate",
        {
          expression: "document.title",
          returnByValue: true,
          awaitPromise: true,
        },
      );
      expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
    });

    it("maps exceptionDetails to the exception description as an error", async () => {
      const { detachSpy, sendCommandSpy } = installStubDebugger();
      sendCommandSpy.mockResolvedValue({
        result: { type: "object", subtype: "error" },
        exceptionDetails: {
          text: "Uncaught TypeError",
          exception: {
            description: "TypeError: x is not a function at <anonymous>",
          },
        },
      });
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.evaluate(7, "x()");

      expect(outcome).toEqual({
        ok: false,
        error: "TypeError: x is not a function at <anonymous>",
      });
      // The error path still detaches — nothing left attached.
      expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
    });

    it("falls back to exceptionDetails.text when the exception has no description", async () => {
      const { sendCommandSpy } = installStubDebugger();
      sendCommandSpy.mockResolvedValue({
        exceptionDetails: { text: "Uncaught ReferenceError: y is not defined" },
      });
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.evaluate(7, "y");

      expect(outcome).toEqual({
        ok: false,
        error: "Uncaught ReferenceError: y is not defined",
      });
    });

    it("reports an undefined value with the same error executeScript returns", async () => {
      const { sendCommandSpy } = installStubDebugger();
      sendCommandSpy.mockResolvedValue({ result: { type: "undefined" } });
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.evaluate(7, "const u = undefined; u");

      expect(outcome).toEqual({
        ok: false,
        error: "expression returned undefined",
      });
    });

    it("passes an over-large value through uncapped for the shared coercion to cap", async () => {
      const { sendCommandSpy } = installStubDebugger();
      const big = "x".repeat(MAX_EXECUTE_SCRIPT_RESULT_CHARS + 1);
      sendCommandSpy.mockResolvedValue({
        result: { type: "string", value: big },
      });
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.evaluate(7, "big");

      expect(outcome).toEqual({ ok: true, json: JSON.stringify(big) });
    });

    it("returns an error when the CDP reply carries no result value", async () => {
      const { sendCommandSpy } = installStubDebugger();
      sendCommandSpy.mockResolvedValue({});
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.evaluate(7, "x");

      expect(outcome).toEqual({
        ok: false,
        error: "CDP Runtime.evaluate returned no result value",
      });
    });

    it("re-attaches cleanly after an evaluating failure", async () => {
      const { attachSpy, detachSpy, sendCommandSpy } = installStubDebugger();
      sendCommandSpy.mockRejectedValueOnce(
        new Error("Cannot attach to target"),
      );
      const ports = chromeCaptureDebuggerPorts();

      await expect(ports.evaluate(7, "x")).rejects.toThrow(
        "Cannot attach to target",
      );
      sendCommandSpy.mockResolvedValue({
        result: { type: "string", value: "ok" },
      });
      const outcome = await ports.evaluate(7, "x");

      expect(outcome).toEqual({ ok: true, json: '"ok"' });
      expect(attachSpy).toHaveBeenCalledTimes(2);
      expect(detachSpy).toHaveBeenCalledTimes(2);
    });

    it("rejects an in-flight evaluate with the evaluating label when the browser detaches", async () => {
      const { sendCommandSpy, fireDetach } = installStubDebugger();
      let release: (() => void) | undefined;
      const gate = new Promise<unknown>((resolve) => {
        release = () => {
          resolve({ result: { type: "string", value: "hi" } });
        };
      });
      sendCommandSpy.mockReturnValue(gate);
      const ports = chromeCaptureDebuggerPorts();

      const pending = ports.evaluate(9, "document.title");
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireDetach(9);

      await expect(pending).rejects.toThrow(
        "chrome.debugger detached (target closed) while evaluating",
      );
      release?.();
    });
  });

  describe("scroll", () => {
    const METRICS_EXPR =
      "({ scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight, innerWidth: window.innerWidth })";
    const SETTLE_EXPR =
      "(async () => { await new Promise(r => setTimeout(r, 150)); })()";

    const metricsReply = (scrollY: number): unknown => ({
      result: {
        type: "object",
        value: {
          scrollY,
          scrollHeight: 5000,
          innerHeight: 800,
          innerWidth: 1280,
        },
      },
    });

    const scrollEvalExpressions = (
      sendCommandSpy: ReturnType<typeof vi.fn>,
    ): string[] =>
      sendCommandSpy.mock.calls
        .filter(([, method]) => method === "Runtime.evaluate")
        .map(([, , params]) => (params as { expression?: string }).expression)
        .filter(
          (expression): expression is string => typeof expression === "string",
        );

    /**
     * Drive the scan stub as a scripted page: the metrics reads #1/#2/#3 return
     * `before` / `afterWheel` / `afterScript` scrollY (geometry fixed at
     * 5000 × 800 × 1280); the wheel dispatch, settlement, and script fallback
     * all acknowledge with a void result so only the read-backs drive movement.
     */
    function scriptedScroll(
      before: number,
      afterWheel: number,
      afterScript: number,
    ): ReturnType<typeof installStubDebugger> {
      let metricsReads = 0;
      return installStubDebugger((_target, method, params) => {
        if (method === "Input.dispatchMouseEvent") return Promise.resolve({});
        if (
          method === "Runtime.evaluate" &&
          (params as { expression?: string } | undefined)?.expression ===
            METRICS_EXPR
        ) {
          metricsReads += 1;
          return Promise.resolve(
            metricsReply(
              metricsReads === 1
                ? before
                : metricsReads === 2
                  ? afterWheel
                  : afterScript,
            ),
          );
        }
        return Promise.resolve({});
      });
    }

    it("wheel-only-success: dispatches the wheel, never sends the script fallback, method === 'wheel'", async () => {
      const { attachSpy, detachSpy, sendCommandSpy } = scriptedScroll(
        0,
        2000,
        0,
      );
      const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

      const outcome = await ports.scroll(7, {});

      expect(outcome).toEqual({
        method: "wheel",
        scrollYBefore: 0,
        scrollYAfter: 2000,
        reachedEnd: false,
      });
      expect(attachSpy).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
      expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
      // The wheel command + params are pinned: x/y are the viewport centre
      // (1280/2, 800/2) derived from the first read-back, deltaY is the default
      // amountPx of 2000.
      expect(sendCommandSpy).toHaveBeenCalledWith(
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 2000 },
      );
      // Both read-backs and the settle-delay evaluate are pinned with both flags.
      expect(sendCommandSpy).toHaveBeenCalledWith(
        { tabId: 7 },
        "Runtime.evaluate",
        { expression: METRICS_EXPR, returnByValue: true, awaitPromise: true },
      );
      expect(sendCommandSpy).toHaveBeenCalledWith(
        { tabId: 7 },
        "Runtime.evaluate",
        { expression: SETTLE_EXPR, returnByValue: true, awaitPromise: true },
      );
      // The wheel moved the page, so the script fallback is never sent.
      const expressions = scrollEvalExpressions(sendCommandSpy);
      expect(expressions).toContain(METRICS_EXPR);
      expect(expressions).toContain(SETTLE_EXPR);
      expect(expressions).not.toContain("window.scrollBy(0, 2000)");
    });

    it("wheel-then-script-fallback: the script scroll IS sent when the wheel did not move the page", async () => {
      const { sendCommandSpy } = scriptedScroll(0, 0, 2000);
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.scroll(7, {});

      expect(outcome).toEqual({
        method: "script",
        scrollYBefore: 0,
        scrollYAfter: 2000,
        reachedEnd: false,
      });
      const expressions = scrollEvalExpressions(sendCommandSpy);
      expect(expressions).toContain("window.scrollBy(0, 2000)");
      expect(expressions).toContain(METRICS_EXPR);
      expect(expressions).toContain(SETTLE_EXPR);
    });

    it("falls back to the script scroll when the wheel dispatch errors, so a stubborn Input.dispatchMouseEvent never blocks it", async () => {
      let metricsReads = 0;
      const stub = installStubDebugger((_target, method, params) => {
        if (method === "Input.dispatchMouseEvent") {
          return Promise.reject(new Error("Input.dispatch unsupported"));
        }
        if (
          method === "Runtime.evaluate" &&
          (params as { expression?: string } | undefined)?.expression ===
            METRICS_EXPR
        ) {
          metricsReads += 1;
          return Promise.resolve(metricsReply(metricsReads === 1 ? 0 : 2000));
        }
        return Promise.resolve({});
      });
      const ports: DebuggerPorts = chromeCaptureDebuggerPorts();

      const outcome = await ports.scroll(7, {});

      expect(outcome).toEqual({
        method: "script",
        scrollYBefore: 0,
        scrollYAfter: 2000,
        reachedEnd: false,
      });
      expect(scrollEvalExpressions(stub.sendCommandSpy)).toContain(
        "window.scrollBy(0, 2000)",
      );
    });

    it("neither mechanism moves the page: method === 'none'", async () => {
      const { sendCommandSpy } = scriptedScroll(0, 0, 0);
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.scroll(7, { amountPx: 500 });

      expect(outcome).toEqual({
        method: "none",
        scrollYBefore: 0,
        scrollYAfter: 0,
        reachedEnd: false,
      });
      // The script fallback is still attempted with the resolved amountPx.
      expect(scrollEvalExpressions(sendCommandSpy)).toContain(
        "window.scrollBy(0, 500)",
      );
    });

    it("toBottom: a scrollHeight-covering deltaY and a scrollTo fallback, reachedEnd true at the bottom", async () => {
      const { sendCommandSpy } = scriptedScroll(0, 0, 4200);
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.scroll(7, { toBottom: true });

      // scrollHeight - innerHeight = 5000 - 800 = 4200 is the true bottom.
      expect(outcome).toEqual({
        method: "script",
        scrollYBefore: 0,
        scrollYAfter: 4200,
        reachedEnd: true,
      });
      expect(sendCommandSpy).toHaveBeenCalledWith(
        { tabId: 7 },
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 5000 },
      );
      expect(scrollEvalExpressions(sendCommandSpy)).toContain(
        "window.scrollTo(0, document.documentElement.scrollHeight)",
      );
    });

    it("degenerate reply resolves to method 'none' rather than rejecting or yielding NaN", async () => {
      const { detachSpy } = installStubDebugger((_target, method) => {
        // Metrics replies carry a non-numeric scrollY; the geometry keys are absent.
        if (method === "Input.dispatchMouseEvent") return Promise.resolve({});
        if (method === "Runtime.evaluate") {
          return Promise.resolve({
            result: { type: "object", value: { scrollY: "oops" } },
          });
        }
        return Promise.resolve({});
      });
      const ports = chromeCaptureDebuggerPorts();

      const outcome = await ports.scroll(7, {});

      expect(outcome.method).toBe("none");
      expect(Number.isFinite(outcome.scrollYBefore)).toBe(true);
      expect(Number.isFinite(outcome.scrollYAfter)).toBe(true);
      expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
    });

    it("detaches on the error path and re-attaches cleanly after a rejected command", async () => {
      let calls = 0;
      let metricsReads = 0;
      const { attachSpy, detachSpy } = installStubDebugger(
        (_target, method, params) => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(new Error("Cannot attach to target"));
          }
          if (method === "Input.dispatchMouseEvent") return Promise.resolve({});
          if (
            method === "Runtime.evaluate" &&
            (params as { expression?: string } | undefined)?.expression ===
              METRICS_EXPR
          ) {
            metricsReads += 1;
            return Promise.resolve(metricsReply(metricsReads === 1 ? 0 : 2000));
          }
          return Promise.resolve({});
        },
      );
      const ports = chromeCaptureDebuggerPorts();

      await expect(ports.scroll(7, {})).rejects.toThrow(
        "Cannot attach to target",
      );
      expect(detachSpy).toHaveBeenCalled();

      const outcome = await ports.scroll(7, {});
      expect(outcome.method).toBe("wheel");
      expect(attachSpy).toHaveBeenCalledTimes(2);
      expect(detachSpy).toHaveBeenCalledTimes(2);
    });

    it("rejects an in-flight scroll with the scrolling label when the browser detaches", async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<unknown>((resolve) => {
        release = () => {
          resolve(metricsReply(0));
        };
      });
      const { fireDetach } = installStubDebugger((_target, method) => {
        if (method === "Runtime.evaluate") return gate;
        return Promise.resolve({});
      });
      const ports = chromeCaptureDebuggerPorts();

      const pending = ports.scroll(9, {});
      // Flush the microtask queue so the scroll reaches its in-flight CDP read.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireDetach(9);

      await expect(pending).rejects.toThrow(
        "chrome.debugger detached (target closed) while scrolling",
      );
      release?.();
    });

    it("gives up after the session timeout and still detaches, so a hung page command cannot wedge the debugger", async () => {
      vi.useFakeTimers();
      try {
        const hang = new Promise<unknown>(() => undefined);
        const { detachSpy, sendCommandSpy } = installStubDebugger(() => hang);
        const ports = chromeCaptureDebuggerPorts();

        const pending = ports.scroll(7, {});
        // Let the async scroll attach and reach its first (hung) metrics read.
        for (let i = 0; i < 10 && sendCommandSpy.mock.calls.length === 0; i++) {
          await Promise.resolve();
        }
        expect(sendCommandSpy).toHaveBeenCalled();

        const assertion = expect(pending).rejects.toThrow(
          /timed out after \d+ms while scrolling/,
        );
        // Well past CDP_COMMAND_TIMEOUT_MS (15000) so the session timeout fires.
        vi.advanceTimersByTime(20000);
        await assertion;

        // The timeout still detaches — no orphaned attachment is left behind.
        expect(detachSpy).toHaveBeenCalledWith({ tabId: 7 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("the exported scroll param/outcome types shape a ScrollIntent / ScrollOutcome", () => {
      const intent: ScrollIntent = { amountPx: 100 };
      const outcome: ScrollOutcome = {
        method: "script",
        scrollYBefore: 0,
        scrollYAfter: 100,
        reachedEnd: false,
      };
      expect(intent.amountPx).toBe(100);
      expect(outcome.method).toBe("script");
    });
  });
});
