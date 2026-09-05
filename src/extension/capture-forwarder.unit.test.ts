import { describe, expect, it, vi } from "vitest";

import { CAPTURE_NAMESPACE } from "../protocol/capture.js";
import type { CaptureEnvelope } from "../protocol/capture.js";
import { installCaptureForwarder } from "./capture-forwarder.js";
import type { ForwarderDeps } from "./capture-forwarder.js";

type SendFn = (envelope: CaptureEnvelope) => void;
type Handler = (event: { source: unknown; data: unknown }) => void;

function consoleEnvelope(): CaptureEnvelope {
  return {
    ns: CAPTURE_NAMESPACE,
    channel: "console",
    entry: { level: "log", text: "hello", timestamp: 1, truncated: false },
  };
}

/**
 * Build a forwarder with an `addMessageListener` that stores every registered
 * handler in an array, plus a `dispatch` that feeds an event to all of them —
 * so a test drives the listener directly with a plain object, no
 * `window.dispatchEvent` / `new MessageEvent(...)` (neither exists in the Node
 * vitest environment).
 */
function harness(send?: ReturnType<typeof vi.fn<SendFn>>): {
  dispatch: Handler;
  sendToWorker: ReturnType<typeof vi.fn<SendFn>>;
  self: object;
} {
  const self = {};
  const sendToWorker = send ?? vi.fn<SendFn>();
  const handlers: Handler[] = [];
  const deps: ForwarderDeps = {
    addMessageListener: (h) => handlers.push(h),
    sendToWorker,
    self,
  };
  installCaptureForwarder(deps);
  expect(handlers).toHaveLength(1);
  const dispatch: Handler = (event) => {
    for (const h of handlers) h(event);
  };
  return { dispatch, sendToWorker, self };
}

describe("installCaptureForwarder", () => {
  it("forwards a valid envelope from the page's own window unchanged", () => {
    const { dispatch, sendToWorker, self } = harness();
    const envelope = consoleEnvelope();

    dispatch({ source: self, data: envelope });

    expect(sendToWorker).toHaveBeenCalledTimes(1);
    // Same reference — relayed, not re-wrapped or cloned with fields dropped.
    expect(sendToWorker.mock.calls[0]?.[0]).toBe(envelope);
  });

  it("drops a well-formed envelope that came from a different source", () => {
    const { dispatch, sendToWorker } = harness();
    const otherWindow = { name: "an-iframe" };

    dispatch({ source: otherWindow, data: consoleEnvelope() });

    expect(sendToWorker).not.toHaveBeenCalled();
  });

  it("drops a same-source message whose data is not a capture envelope", () => {
    const { dispatch, sendToWorker, self } = harness();

    dispatch({ source: self, data: { ns: "nimvarya" } });
    dispatch({ source: self, data: "not-an-object" });

    expect(sendToWorker).not.toHaveBeenCalled();
  });

  it("never throws when sendToWorker throws, and keeps forwarding after", () => {
    let shouldThrow = true;
    const send = vi.fn<SendFn>(() => {
      if (shouldThrow) throw new Error("worker suspended");
    });
    const { dispatch, self } = harness(send);

    expect(() => {
      dispatch({ source: self, data: consoleEnvelope() });
    }).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);

    shouldThrow = false;
    const second = consoleEnvelope();
    dispatch({ source: self, data: second });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe(second);
  });
});
