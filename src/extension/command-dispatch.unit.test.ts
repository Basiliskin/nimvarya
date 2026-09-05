import { describe, expect, it } from "vitest";

import { PAGE_ACTIONS } from "../protocol/actions.js";
import type { PageAction } from "../protocol/actions.js";
import { createCommandDispatcher } from "./command-dispatch.js";
import type { Handler } from "./command-dispatch.js";

function handlerMap(overrides: Partial<Record<PageAction, Handler>>): Record<
  PageAction,
  Handler
> {
  const base = {} as Record<PageAction, Handler>;
  for (const action of PAGE_ACTIONS) {
    base[action] = () => ({ result: { action } });
  }
  return { ...base, ...overrides };
}

describe("createCommandDispatcher", () => {
  it("answers a known action with a result response carrying the same id", async () => {
    const dispatch = createCommandDispatcher(handlerMap({}));
    const res = await dispatch({ id: "abc", action: "ping", params: {} });
    expect(res).toEqual({
      kind: "command-response",
      id: "abc",
      result: { action: "ping" },
    });
  });

  it("rejects an unknown action with an error naming it and no result key", async () => {
    const dispatch = createCommandDispatcher(handlerMap({}));
    const res = await dispatch({ id: "x", action: "notAnAction", params: {} });
    expect(res).toEqual({
      kind: "command-response",
      id: "x",
      error: "unknown action notAnAction",
    });
    expect("result" in res).toBe(false);
  });

  it("turns a thrown Error into an error response with its message", async () => {
    const dispatch = createCommandDispatcher(
      handlerMap({
        navigateTo: () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await dispatch({
      id: "1",
      action: "navigateTo",
      params: { url: "https://x" },
    });
    expect(res).toEqual({ kind: "command-response", id: "1", error: "boom" });
  });

  it("turns a thrown non-Error value into a string error", async () => {
    const dispatch = createCommandDispatcher(
      handlerMap({
        readPage: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "plain string";
        },
      }),
    );
    const res = await dispatch({ id: "2", action: "readPage", params: {} });
    expect(res.kind).toBe("command-response");
    expect(res.id).toBe("2");
    expect(typeof res.error).toBe("string");
    expect(res.error).toContain("plain string");
  });

  it("passes an { error } sentinel through as an error response", async () => {
    const dispatch = createCommandDispatcher(
      handlerMap({
        findElement: () => ({ error: "bad selector" }),
      }),
    );
    const res = await dispatch({ id: "3", action: "findElement", params: {} });
    expect(res).toEqual({
      kind: "command-response",
      id: "3",
      error: "bad selector",
    });
  });

  it("awaits an async handler's result", async () => {
    const dispatch = createCommandDispatcher(
      handlerMap({
        getPageText: () =>
          Promise.resolve({ result: { text: "hi", totalChars: 2, truncated: false } }),
      }),
    );
    const res = await dispatch({ id: "4", action: "getPageText", params: {} });
    expect(res).toEqual({
      kind: "command-response",
      id: "4",
      result: { text: "hi", totalChars: 2, truncated: false },
    });
  });
});
