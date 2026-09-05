import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT } from "./capture-buffer.js";
import type { CaptureQuery, CaptureStore } from "./capture-store.js";
import type {
  CaptureScreenshotOptions,
  DebuggerPorts,
  ScrollOutcome,
} from "./debugger-ports.js";
import {
  DEFAULT_MAX_CHARS,
  MAX_CONSOLE_READ_RESULT_CHARS,
  MAX_ELEMENT_TEXT_CHARS,
  MAX_EXECUTE_SCRIPT_RESULT_CHARS,
  MAX_FIND_ELEMENT_MATCHES,
  MAX_NETWORK_READ_RESULT_CHARS,
  MAX_SCREENSHOT_BASE64_CHARS,
  SCREENSHOT_DOWNSCALE_FLOOR_SCALE,
  SCREENSHOT_DOWNSCALE_LADDER_SCALES,
  coerceScrollOutcome,
  pageActionHandlers,
  resolveMaxChars,
  resolveReadLimit,
  resolveSince,
  resolveWaitForParams,
} from "./page-actions.js";
import type { InPageScriptOutcome } from "./page-actions.js";
import type { ActiveTab, ChromePorts, TabIdentityWithWindow } from "./ports.js";
import type { SandboxTabPorts } from "./sandbox-ports.js";

const TAB: ActiveTab = { id: 7, windowId: 42 };

/** A fake CaptureStore recording the last query each read received. */
function fakeStore(overrides: Partial<CaptureStore> = {}): CaptureStore {
  const base: CaptureStore = {
    ingest: vi.fn(),
    readConsole: vi.fn((_tabId: number, query: CaptureQuery) => ({
      entries: [
        {
          level: "log" as const,
          text: "hi",
          timestamp: 0,
          truncated: false,
          seq: 1,
        },
      ],
      nextSince: query.since,
      dropped: false,
      truncated: false,
    })),
    readNetwork: vi.fn((_tabId: number, query: CaptureQuery) => ({
      entries: [],
      nextSince: query.since,
      dropped: false,
      truncated: false,
    })),
    evict: vi.fn(),
  };
  for (const [key, impl] of Object.entries(overrides)) {
    Reflect.set(base, key, impl);
  }
  return base;
}

function fakePorts(overrides: Partial<ChromePorts> = {}): ChromePorts {
  const base: ChromePorts = {
    queryActiveTab: vi.fn((): Promise<ActiveTab | undefined> =>
      Promise.resolve(TAB),
    ),
    executeScript: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    updateTab: vi.fn((): Promise<void> => Promise.resolve()),
    captureVisibleTab: vi.fn((): Promise<string> =>
      Promise.resolve("data:image/png;base64,AAAA"),
    ),
    goBack: vi.fn((): Promise<void> => Promise.resolve()),
    goForward: vi.fn((): Promise<void> => Promise.resolve()),
    reload: vi.fn((): Promise<void> => Promise.resolve()),
    readTab: vi.fn((): Promise<TabIdentityWithWindow> =>
      Promise.resolve({
        id: TAB.id,
        windowId: TAB.windowId,
        url: "https://example.com",
        title: "Example",
      }),
    ),
    activeTabOfWindow: vi.fn((): Promise<TabIdentityWithWindow | undefined> =>
      Promise.resolve({
        id: TAB.id,
        windowId: TAB.windowId,
        url: "https://example.com",
        title: "Example",
      }),
    ),
  };
  // Re-spy every override so `vi.mocked(ports.x)` assertions still work.
  for (const [key, impl] of Object.entries(overrides)) {
    Reflect.set(base, key, vi.fn(impl));
  }
  return base;
}

/**
 * A fake `SandboxTabPorts` resolving to the sandbox tab id `7` (matching the
 * `TAB.id` fake above, so most "forwards the resolved id" assertions read
 * naturally). Override `resolveTabId` to throw to exercise the resolver-failure
 * path, or to resolve to a different id.
 */
function fakeSandbox(
  overrides: Partial<SandboxTabPorts> = {},
): SandboxTabPorts {
  const base: SandboxTabPorts = {
    resolveTabId: vi.fn((): Promise<number> => Promise.resolve(7)),
    peekStoredSandboxTabId: vi.fn((): Promise<number | undefined> =>
      Promise.resolve(7),
    ),
    closeSandboxTab: vi.fn((): Promise<{ closed: boolean; hadTab: boolean }> =>
      Promise.resolve({ closed: true, hadTab: true }),
    ),
  };
  for (const [key, impl] of Object.entries(overrides)) {
    Reflect.set(base, key, vi.fn(impl));
  }
  return base;
}

/**
 * A fake `DebuggerPorts` resolving `captureScreenshot` to a
 * `data:image/png;base64,<b64>` URL and `evaluate` to a trivial value read.
 * Override `captureScreenshot` to reject (or return a different URL) to
 * exercise the CDP path and its error contract; override `evaluate` to feed a
 * page value or an `{ ok: false, error }` outcome to the handler.
 */
function fakeDebugger(overrides: Partial<DebuggerPorts> = {}): DebuggerPorts {
  const base: DebuggerPorts = {
    captureScreenshot: vi.fn((): Promise<string> =>
      Promise.resolve("data:image/png;base64,QUJD"),
    ),
    captureFullPageScreenshot: vi.fn((): Promise<string> =>
      Promise.resolve("data:image/png;base64,QUJD"),
    ),
    evaluate: vi.fn((): Promise<InPageScriptOutcome> =>
      Promise.resolve({ ok: true, json: "null" }),
    ),
    scroll: vi.fn((): Promise<ScrollOutcome> =>
      Promise.resolve({
        method: "none" as const,
        scrollYBefore: 0,
        scrollYAfter: 0,
        reachedEnd: false,
      }),
    ),
  };
  for (const [key, impl] of Object.entries(overrides)) {
    Reflect.set(base, key, vi.fn(impl));
  }
  return base;
}

describe("resolveMaxChars", () => {
  it("defaults on non-number, zero, negative, and non-integer input", () => {
    expect(resolveMaxChars(undefined)).toBe(DEFAULT_MAX_CHARS);
    expect(resolveMaxChars("100")).toBe(DEFAULT_MAX_CHARS);
    expect(resolveMaxChars(0)).toBe(DEFAULT_MAX_CHARS);
    expect(resolveMaxChars(-5)).toBe(DEFAULT_MAX_CHARS);
    expect(resolveMaxChars(1.5)).toBe(DEFAULT_MAX_CHARS);
    expect(resolveMaxChars(Number.NaN)).toBe(DEFAULT_MAX_CHARS);
  });
  it("passes a valid positive integer through", () => {
    expect(resolveMaxChars(10)).toBe(10);
  });
});

describe("pageActionHandlers — ping", () => {
  it("returns ok + a timestamp without touching a tab", async () => {
    const ports = fakePorts();
    const res = await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).ping({});
    expect(res).toEqual({ result: { ok: true, ts: expect.any(Number) } });
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
  });
});

describe("pageActionHandlers — navigateTo", () => {
  it("resolves the sandbox tab id and points it at the url", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).navigateTo({
      url: "https://e.com",
    });
    expect(res).toEqual({ result: { navigated: true } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.updateTab)).toHaveBeenCalledWith(7, {
      url: "https://e.com",
    });
  });
  it("rejects a missing/empty url without calling updateTab", async () => {
    const ports = fakePorts();
    for (const bad of [{}, { url: "" }, { url: 5 }]) {
      expect(
        await pageActionHandlers(
          ports,
          fakeSandbox(),
          fakeDebugger(),
          fakeStore(),
        ).navigateTo(bad),
      ).toHaveProperty("error");
    }
    expect(vi.mocked(ports.updateTab)).not.toHaveBeenCalled();
  });
  it("returns an error when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).navigateTo({
        url: "https://e.com",
      }),
    ).toHaveProperty("error");
    expect(vi.mocked(ports.updateTab)).not.toHaveBeenCalled();
  });
});

describe("pageActionHandlers — getPageText / readPage truncation", () => {
  it("does not truncate a string of exactly maxChars", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve("a".repeat(10)),
    });
    const sandbox = fakeSandbox();
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).getPageText({
        maxChars: 10,
      }),
    ).toEqual({
      result: { text: "a".repeat(10), totalChars: 10, truncated: false },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      [],
    );
  });
  it("truncates a string of maxChars + 1 and reports the original length", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve("a".repeat(11)),
    });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).getPageText({
        maxChars: 10,
      }),
    ).toEqual({
      result: { text: "a".repeat(10), totalChars: 11, truncated: true },
    });
  });
  it("readPage applies the default cap when maxChars is omitted", async () => {
    const big = "b".repeat(DEFAULT_MAX_CHARS + 1);
    const ports = fakePorts({ executeScript: () => Promise.resolve(big) });
    const sandbox = fakeSandbox();
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).readPage({}),
    ).toEqual({
      result: {
        content: "b".repeat(DEFAULT_MAX_CHARS),
        totalChars: DEFAULT_MAX_CHARS + 1,
        truncated: true,
      },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      [],
    );
  });
  it("coerces a non-string page result to an empty string", async () => {
    const ports = fakePorts({ executeScript: () => Promise.resolve(null) });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).getPageText({}),
    ).toEqual({
      result: { text: "", totalChars: 0, truncated: false },
    });
  });
});

describe("pageActionHandlers — findElement", () => {
  it("reports an empty match list (NOT an error) for a zero-match page result", async () => {
    const ports = fakePorts({
      executeScript: () =>
        Promise.resolve({ matches: [], total: 0, truncated: false }),
    });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).findElement({
        selector: ".x",
      }),
    ).toEqual({
      result: { matches: [], total: 0, truncated: false },
    });
  });
  it("passes the tab id + selector through to executeScript and rebuilds a positive match into the new result shape", async () => {
    const ports = fakePorts({
      executeScript: () =>
        Promise.resolve({
          matches: [
            {
              ref: "#x",
              text: "hi",
              attributes: {
                tagName: "div",
                id: "x",
                class: "y",
                role: null,
                ariaLabel: null,
                href: null,
                name: null,
                type: null,
                dataTestid: null,
              },
            },
          ],
          total: 1,
          truncated: false,
        }),
    });
    const sandbox = fakeSandbox();
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).findElement({
        selector: ".x",
      }),
    ).toEqual({
      result: {
        matches: [
          {
            ref: "#x",
            text: "hi",
            attributes: {
              tagName: "div",
              id: "x",
              class: "y",
              role: null,
              ariaLabel: null,
              href: null,
              name: null,
              type: null,
              dataTestid: null,
            },
          },
        ],
        total: 1,
        truncated: false,
      },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      [".x", MAX_FIND_ELEMENT_MATCHES, MAX_ELEMENT_TEXT_CHARS],
    );
  });
  it("rejects an empty/missing selector without calling executeScript", async () => {
    const ports = fakePorts();
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).findElement({}),
    ).toHaveProperty("error");
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).findElement({
        selector: "",
      }),
    ).toHaveProperty("error");
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
  });
  it("coerces a malformed / CSP-blocked page envelope to an { error } outcome", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve(undefined),
    });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).findElement({
        selector: ".x",
      }),
    ).toHaveProperty("error");
  });
  it("normalises non-string key-attribute values to null in the rebuilt descriptor", async () => {
    const ports = fakePorts({
      executeScript: () =>
        Promise.resolve({
          matches: [
            {
              ref: 7, // not a string
              text: { not: "a string" }, // not a string
              attributes: {
                tagName: "div",
                id: 42, // not a string
                class: null,
                role: undefined,
                ariaLabel: "",
                href: null,
                name: null,
                type: null,
                dataTestid: null,
              },
            },
          ],
          total: 1,
          truncated: false,
        }),
    });
    const outcome = (await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).findElement({
      selector: ".x",
    })) as { result: { matches: Array<unknown> } };
    expect(outcome["result"]["matches"][0]).toEqual({
      ref: "",
      text: "",
      attributes: {
        tagName: "div",
        id: null,
        class: null,
        role: null,
        ariaLabel: null,
        href: null,
        name: null,
        type: null,
        dataTestid: null,
      },
    });
  });

  describe("the injected in-page function", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Pull the injected ISOLATED-world function out of the executeScript mock. */
    async function injectedFn(): Promise<
      (selector: string, maxMatches: number, maxTextChars: number) => unknown
    > {
      const ports = fakePorts({
        executeScript: () =>
          Promise.resolve({ matches: [], total: 0, truncated: false }),
      });
      // The handler itself is async — await it so the executeScript mock
      // call (and therefore the captured function ref) is recorded.
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).findElement({
        selector: ".x",
      });
      const call = vi.mocked(ports.executeScript).mock.calls[0];
      return call?.[1] as (selector: string) => unknown;
    }

    function installDom(opts: { nodes?: Element[]; throwOnQuery?: boolean }): {
      querySelectorAll: ReturnType<typeof vi.fn>;
    } {
      const querySelectorAll = opts.throwOnQuery
        ? vi.fn(() => {
            throw new Error("SyntaxError: hostile selector");
          })
        : vi.fn(() => opts.nodes ?? []);
      const doc = { querySelectorAll };
      vi.stubGlobal("document", doc);
      // buildRef calls `CSS.escape` when an id is present; stub a passthrough.
      vi.stubGlobal("CSS", { escape: (s: string) => s });
      return doc;
    }

    it("builds a ref from a unique-id ancestor and copies the fixed key-attribute map", async () => {
      const target = {
        tagName: "BUTTON",
        innerText: "Sign in",
        className: "btn primary",
        getAttribute: (name: string): string | null => {
          if (name === "id") return "submit";
          if (name === "role") return "button";
          if (name === "aria-label") return null;
          return null;
        },
        parentElement: null,
      } as unknown as Element;
      const doc = installDom({ nodes: [target] });
      // `#submit` resolves to exactly one — the unique-id short-circuit.
      // The user selector `.x` also resolves to the target.
      doc.querySelectorAll = vi.fn((sel: string) =>
        sel === ".x" || sel === "#submit" ? [target] : [],
      );
      const fn = await injectedFn();
      const result = fn(
        ".x",
        MAX_FIND_ELEMENT_MATCHES,
        MAX_ELEMENT_TEXT_CHARS,
      ) as {
        matches: Array<{
          ref: string;
          text: string;
          attributes: Record<string, string | null>;
        }>;
        total: number;
        truncated: boolean;
      };
      expect(result).toEqual({
        matches: [
          {
            ref: "#submit",
            text: "Sign in",
            attributes: {
              tagName: "button",
              id: "submit",
              class: "btn primary",
              role: "button",
              ariaLabel: null,
              href: null,
              name: null,
              type: null,
              dataTestid: null,
            },
          },
        ],
        total: 1,
        truncated: false,
      });
    });

    it("falls back to an :nth-of-type chain when the element has no unique id", async () => {
      // Build a small DOM where the target's parent is a real <ul> with the
      // target as its FIRST child of its tagName. All elements share the
      // element identity so the in-page `indexOf` resolves correctly.
      const li1: Element = {
        tagName: "LI",
        innerText: "first",
        className: "",
        getAttribute: (): string | null => null,
      } as unknown as Element;
      const li2: Element = {
        tagName: "LI",
        getAttribute: (): string | null => null,
      } as unknown as Element;
      const ul: Element = {
        tagName: "UL",
        children: [li1, li2],
        parentElement: null,
        getAttribute: (): string | null => null,
      } as unknown as Element;
      // Attach the parent. Assigning on the underlying object literal must
      // stick — the `Element` type only marks the property `readonly` in the
      // type system, the runtime object is a plain `{ }`.
      (li1 as unknown as { parentElement: Element | null }).parentElement = ul;
      (li2 as unknown as { parentElement: Element | null }).parentElement = ul;
      const doc = installDom({ nodes: [li1] });
      // `.x` returns the target; every `#…` id lookup returns [] so the
      // unique-id short-circuit never fires and we walk the :nth-of-type path.
      doc.querySelectorAll = vi.fn((sel: string) =>
        sel === ".x" ? [li1] : [],
      );
      const fn = await injectedFn();
      const result = fn(
        ".x",
        MAX_FIND_ELEMENT_MATCHES,
        MAX_ELEMENT_TEXT_CHARS,
      ) as {
        matches: Array<{ ref: string }>;
      };
      const matches = result.matches;
      expect(matches).toHaveLength(1);
      // The ref must end in an nth-of-type chain rooted at a <ul>.
      expect(matches[0]?.ref).toMatch(/ul > li:nth-of-type\(1\)$/);
    });

    it("caps the result at MAX_FIND_ELEMENT_MATCHES elements and reports total + truncated", async () => {
      // Build 60 stub elements; the in-page cap is 50, so total stays 60
      // and truncated:true must be set.
      const nodes: Element[] = [];
      for (let i = 0; i < 60; i += 1) {
        nodes.push({
          tagName: "P",
          innerText: `n ${i}`.repeat(100),
          className: "",
          getAttribute: (): string | null => null,
          parentElement: null,
        } as unknown as Element);
      }
      installDom({ nodes });
      const fn = await injectedFn();
      const result = fn(
        ".x",
        MAX_FIND_ELEMENT_MATCHES,
        MAX_ELEMENT_TEXT_CHARS,
      ) as {
        matches: unknown[];
        total: number;
        truncated: boolean;
      };
      expect(result.total).toBe(60);
      expect(result.matches).toHaveLength(MAX_FIND_ELEMENT_MATCHES);
      expect(result.truncated).toBe(true);
    });

    it("truncates each element's innerText to MAX_ELEMENT_TEXT_CHARS and sets truncated:true", async () => {
      const longText = "x".repeat(2000);
      const nodes = [
        {
          tagName: "P",
          innerText: longText,
          className: "",
          getAttribute: (): string | null => null,
          parentElement: null,
        } as unknown as Element,
      ];
      installDom({ nodes });
      const fn = await injectedFn();
      const result = fn(
        ".x",
        MAX_FIND_ELEMENT_MATCHES,
        MAX_ELEMENT_TEXT_CHARS,
      ) as {
        matches: Array<{ text: string }>;
        total: number;
        truncated: boolean;
      };
      expect(result.matches[0]?.text).toHaveLength(MAX_ELEMENT_TEXT_CHARS);
      expect(result.truncated).toBe(true);
      expect(result.total).toBe(1);
    });

    it("emits null for missing key-attribute values rather than undefined or empty-string defaults", async () => {
      const target = {
        tagName: "A",
        innerText: "x",
        className: "",
        getAttribute: (name: string): string | null => {
          return name === "href" ? "/about" : null;
        },
        parentElement: null,
      } as unknown as Element;
      installDom({ nodes: [target] });
      // No override — the default querySelectorAll returns the [target] node
      // for the user selector `.x`. The id lookups `#...` happen to also
      // return [target] (length 1) which would make the unique-id short-
      // circuit fire; that's irrelevant because the target has no `id`
      // attribute so `buildRef` never tries.
      const fn = await injectedFn();
      const result = fn(
        ".x",
        MAX_FIND_ELEMENT_MATCHES,
        MAX_ELEMENT_TEXT_CHARS,
      ) as {
        matches: Array<{ attributes: Record<string, string | null> }>;
      };
      const attrs = result.matches[0]?.attributes ?? {};
      // Every key must be present (never omitted) and every absent attr
      // must be the literal null (not an empty string, not undefined).
      for (const key of [
        "tagName",
        "id",
        "class",
        "role",
        "ariaLabel",
        "href",
        "name",
        "type",
        "dataTestid",
      ]) {
        expect(key in attrs).toBe(true);
        if (key !== "tagName" && key !== "href") {
          expect(attrs[key]).toBeNull();
        }
      }
      expect(attrs["href"]).toBe("/about");
      expect(attrs["tagName"]).toBe("a");
    });

    it("treats a hostile selector as an empty match list, NOT a throw (in-page try/catch swallows)", async () => {
      const doc = installDom({ throwOnQuery: true });
      // querySelectorAll must have been called with the hostile selector (as a
      // serialised arg, never interpolated into the function body).
      const fn = await injectedFn();
      const result = fn(
        ">>>not a selector<<<",
        MAX_FIND_ELEMENT_MATCHES,
        MAX_ELEMENT_TEXT_CHARS,
      ) as {
        matches: unknown[];
        total: number;
        truncated: boolean;
      };
      expect(doc.querySelectorAll).toHaveBeenCalledWith(">>>not a selector<<<");
      expect(result).toEqual({
        matches: [],
        total: 0,
        truncated: false,
      });
    });
  });
});

describe("pageActionHandlers — clickElement / typeText", () => {
  it("clickElement returns the coerced boolean", async () => {
    const ports = fakePorts({ executeScript: () => Promise.resolve(true) });
    const sandbox = fakeSandbox();
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).clickElement({
        selector: "#b",
      }),
    ).toEqual({
      result: { clicked: true },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      ["#b"],
    );
  });
  it("clickElement rejects a bad selector without calling executeScript", async () => {
    const ports = fakePorts();
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).clickElement({}),
    ).toHaveProperty("error");
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
  });
  it("typeText needs both a non-empty selector and a text string", async () => {
    const ports = fakePorts({ executeScript: () => Promise.resolve(true) });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).typeText({
        selector: "#i",
      }),
    ).toHaveProperty("error");
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).typeText({
        selector: "#i",
        text: 3,
      }),
    ).toHaveProperty("error");
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
    const sandbox = fakeSandbox();
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).typeText({
        selector: "#i",
        text: "hi",
      }),
    ).toEqual({ result: { typed: true } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      ["#i", "hi"],
    );
  });
});

describe("pageActionHandlers — captureTab", () => {
  /** Build a PNG base64 payload whose IHDR carries the given pixel dimensions. */
  function pngB64(width: number, height: number): string {
    const bytes = [
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR chunk length (13)
      0x49,
      0x48,
      0x44,
      0x52, // 'IHDR'
      (width >> 24) & 0xff,
      (width >> 16) & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      (height >> 24) & 0xff,
      (height >> 16) & 0xff,
      (height >> 8) & 0xff,
      height & 0xff,
    ];
    return btoa(String.fromCharCode(...bytes));
  }

  const VIEWPORT_PNG = pngB64(3024, 1544);
  const ELEMENT_PNG = pngB64(512, 1740);
  const FULL_PAGE_PNG = pngB64(1512, 6000);

  it("captures the sandbox tab viewport by default via the CDP debugger port (no options) and decodes the image dimensions", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const debuggerPorts = fakeDebugger({
      captureScreenshot: () => Promise.resolve(VIEWPORT_PNG),
    });
    const res = await pageActionHandlers(
      ports,
      sandbox,
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: VIEWPORT_PNG,
        width: 3024,
        height: 1544,
        clipped: false,
        appliedScale: 1,
        attempts: 1,
      },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.captureVisibleTab)).not.toHaveBeenCalled();
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenCalledWith(7);
  });

  it("explicit viewport mode is identical to the default", async () => {
    const debuggerPorts = fakeDebugger({
      captureScreenshot: () => Promise.resolve(VIEWPORT_PNG),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "viewport" });
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: VIEWPORT_PNG,
        width: 3024,
        height: 1544,
        clipped: false,
        appliedScale: 1,
        attempts: 1,
      },
    });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenCalledWith(7);
  });

  it("element mode resolves the ref to a clip rect (document coords + scale 1) and reports clipped:false when the rect fits the viewport", async () => {
    const ports = fakePorts();
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({
          ok: true,
          json: JSON.stringify({
            found: true,
            x: 264,
            y: 4459.77,
            width: 546.67,
            height: 201.34,
            scrollX: 0,
            scrollY: 0,
            innerWidth: 1512,
            innerHeight: 772,
          }),
        }),
      captureScreenshot: () => Promise.resolve(ELEMENT_PNG),
    });
    const res = await pageActionHandlers(
      ports,
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#mwArk" });
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: ELEMENT_PNG,
        width: 512,
        height: 1740,
        clipped: false,
        appliedScale: 1,
        attempts: 1,
      },
    });
    const expression = vi.mocked(debuggerPorts.evaluate).mock.calls[0]?.[1];
    expect(typeof expression).toBe("string");
    expect(expression).toContain("getBoundingClientRect");
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenCalledWith(7, {
      clip: { x: 264, y: 4459.77, width: 546.67, height: 201.34, scale: 1 },
    });
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
  });

  it("adds the document scroll offset to the rect so a scrolled page still clips at the right document position", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({
          ok: true,
          json: JSON.stringify({
            found: true,
            x: 100,
            y: 200,
            width: 50,
            height: 60,
            scrollX: 10,
            scrollY: 1200,
            innerWidth: 800,
            innerHeight: 600,
          }),
        }),
      captureScreenshot: () => Promise.resolve(ELEMENT_PNG),
    });
    await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#x" });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenCalledWith(7, {
      clip: { x: 110, y: 1400, width: 50, height: 60, scale: 1 },
    });
  });

  it("reports clipped:true when the element rect exceeds the composited viewport in an axis", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({
          ok: true,
          json: JSON.stringify({
            found: true,
            x: 0,
            y: 0,
            width: 5000,
            height: 2000,
            scrollX: 0,
            scrollY: 0,
            innerWidth: 1512,
            innerHeight: 772,
          }),
        }),
      captureScreenshot: () => Promise.resolve(ELEMENT_PNG),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#big" });
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: ELEMENT_PNG,
        width: 512,
        height: 1740,
        clipped: true,
        appliedScale: 1,
        attempts: 1,
      },
    });
  });

  it("element mode with a missing element returns a structured element-not-found outcome, not a throw", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({ ok: true, json: JSON.stringify({ found: false }) }),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#nope" });
    expect(res).toEqual({
      result: { captured: false, reason: "element-not-found" },
    });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).not.toHaveBeenCalled();
  });

  it("element mode with a zero-area element returns a zero-area outcome, never a degenerate clip capture", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({
          ok: true,
          json: JSON.stringify({
            found: true,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            scrollX: 0,
            scrollY: 0,
            innerWidth: 800,
            innerHeight: 600,
          }),
        }),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#hidden" });
    expect(res).toEqual({
      result: { captured: false, reason: "zero-area" },
    });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).not.toHaveBeenCalled();
  });

  it("returns a defined too-large outcome carrying measured size + ceiling when an image crosses MAX_SCREENSHOT_BASE64_CHARS", async () => {
    const big = `data:image/png;base64,${"A".repeat(MAX_SCREENSHOT_BASE64_CHARS + 1)}`;
    const debuggerPorts = fakeDebugger({
      captureScreenshot: () => Promise.resolve(big),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    expect(res).toEqual({
      result: {
        captured: false,
        reason: "too-large",
        size: MAX_SCREENSHOT_BASE64_CHARS + 1,
        limit: MAX_SCREENSHOT_BASE64_CHARS,
        floor: SCREENSHOT_DOWNSCALE_FLOOR_SCALE,
        attempts: 1 + SCREENSHOT_DOWNSCALE_LADDER_SCALES.length,
      },
    });
  });

  it("does NOT trip the too-large guard on a payload just under the ceiling", async () => {
    const okPng = `data:image/png;base64,${"A".repeat(MAX_SCREENSHOT_BASE64_CHARS - 1)}`;
    const debuggerPorts = fakeDebugger({
      captureScreenshot: () => Promise.resolve(okPng),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    expect(res).toMatchObject({
      result: { captured: true, appliedScale: 1, attempts: 1 },
    });
  });

  it("applies the too-large guard in element mode too, not only viewport", async () => {
    const big = `data:image/png;base64,${"B".repeat(MAX_SCREENSHOT_BASE64_CHARS + 1)}`;
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({
          ok: true,
          json: JSON.stringify({
            found: true,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            scrollX: 0,
            scrollY: 0,
            innerWidth: 800,
            innerHeight: 600,
          }),
        }),
      captureScreenshot: () => Promise.resolve(big),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#x" });
    expect(res).toEqual({
      result: {
        captured: false,
        reason: "too-large",
        size: MAX_SCREENSHOT_BASE64_CHARS + 1,
        limit: MAX_SCREENSHOT_BASE64_CHARS,
        floor: SCREENSHOT_DOWNSCALE_FLOOR_SCALE,
        attempts: 1 + SCREENSHOT_DOWNSCALE_LADDER_SCALES.length,
      },
    });
  });

  it("drives an over-ceiling viewport capture down the ladder until a rung fits, reporting the applied scale and attempts", async () => {
    const big = `data:image/png;base64,${"A".repeat(
      MAX_SCREENSHOT_BASE64_CHARS + 1,
    )}`;
    const debuggerPorts = fakeDebugger({
      captureScreenshot: vi.fn(
        (_tabId: number, options?: CaptureScreenshotOptions) =>
          Promise.resolve(options?.scale === 0.75 ? VIEWPORT_PNG : big),
      ),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    // The initial full-size capture is over the ceiling; the first ladder rung
    // (0.75) fits, so the ladder stops there: 2 captures, appliedScale < 1.
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: VIEWPORT_PNG,
        width: 3024,
        height: 1544,
        clipped: false,
        appliedScale: 0.75,
        attempts: 2,
      },
    });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenCalledTimes(2);
  });

  it("drives an over-ceiling element capture down the ladder, preserving the clip geometry and lowering only scale", async () => {
    const big = `data:image/png;base64,${"B".repeat(
      MAX_SCREENSHOT_BASE64_CHARS + 1,
    )}`;
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({
          ok: true,
          json: JSON.stringify({
            found: true,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            scrollX: 0,
            scrollY: 0,
            innerWidth: 800,
            innerHeight: 600,
          }),
        }),
      captureScreenshot: vi.fn(
        (_tabId: number, options?: CaptureScreenshotOptions) =>
          Promise.resolve(options?.clip?.scale === 0.5 ? ELEMENT_PNG : big),
      ),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#x" });
    // Initial + rung 0.75 are over the ceiling; rung 0.5 fits: 3 captures.
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: ELEMENT_PNG,
        width: 512,
        height: 1740,
        clipped: false,
        appliedScale: 0.5,
        attempts: 3,
      },
    });
    // The downscaled clip keeps the element's x/y/width/height and lowers only scale.
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenLastCalledWith(
      7,
      {
        clip: { x: 0, y: 0, width: 100, height: 100, scale: 0.5 },
      },
    );
  });

  it("returns captured:true at the give-up floor when only the floor fits", async () => {
    const big = `data:image/png;base64,${"C".repeat(
      MAX_SCREENSHOT_BASE64_CHARS + 1,
    )}`;
    const debuggerPorts = fakeDebugger({
      captureScreenshot: vi.fn(
        (_tabId: number, options?: CaptureScreenshotOptions) =>
          Promise.resolve(
            options?.scale === SCREENSHOT_DOWNSCALE_FLOOR_SCALE
              ? VIEWPORT_PNG
              : big,
          ),
      ),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    // Every rung up to the floor was over; the floor scale fits: 4 captures.
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: VIEWPORT_PNG,
        width: 3024,
        height: 1544,
        clipped: false,
        appliedScale: SCREENSHOT_DOWNSCALE_FLOOR_SCALE,
        attempts: 4,
      },
    });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenCalledTimes(4);
  });

  it("surfaces a mid-ladder capture rejection as a structured tab-unavailable outcome and stops walking rungs", async () => {
    const big = `data:image/png;base64,${"D".repeat(
      MAX_SCREENSHOT_BASE64_CHARS + 1,
    )}`;
    const debuggerPorts = fakeDebugger({
      captureScreenshot: vi.fn(
        (
          _tabId: number,
          options?: CaptureScreenshotOptions,
        ): Promise<string> => {
          if (options?.scale === 0.5) {
            return Promise.reject(
              new Error("chrome.debugger detached (target closed)"),
            );
          }
          return Promise.resolve(big);
        },
      ),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    // Initial + rung 0.75 succeed (over the ceiling); rung 0.5 rejects -> stop.
    // The failed capture's own session detaches in the port's finally; the
    // handler surfaces a structured tab-unavailable and attempts no further rung.
    expect(res).toEqual({
      result: {
        captured: false,
        reason: "tab-unavailable",
        detail: "chrome.debugger detached (target closed)",
      },
    });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).toHaveBeenCalledTimes(3);
  });

  it("accepts mode:'full-page' and captures the whole document via the full-page port (not the viewport path)", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const debuggerPorts = fakeDebugger({
      captureFullPageScreenshot: () => Promise.resolve(FULL_PAGE_PNG),
    });
    const res = await pageActionHandlers(
      ports,
      sandbox,
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "full-page" });
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: FULL_PAGE_PNG,
        width: 1512,
        height: 6000,
        clipped: false,
        appliedScale: 1,
        attempts: 1,
      },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.captureVisibleTab)).not.toHaveBeenCalled();
    expect(
      vi.mocked(debuggerPorts.captureFullPageScreenshot),
    ).toHaveBeenCalledWith(7);
    expect(vi.mocked(debuggerPorts.captureScreenshot)).not.toHaveBeenCalled();
  });

  it("drives an over-ceiling full-page capture down the ladder until a rung fits, reporting the applied scale and attempts", async () => {
    const big = `data:image/png;base64,${"A".repeat(
      MAX_SCREENSHOT_BASE64_CHARS + 1,
    )}`;
    const debuggerPorts = fakeDebugger({
      captureFullPageScreenshot: vi.fn(
        (_tabId: number, options?: { scale?: number }) =>
          Promise.resolve(options?.scale === 0.75 ? FULL_PAGE_PNG : big),
      ),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "full-page" });
    // Initial full-size capture is over the ceiling; the first ladder rung
    // (0.75) fits, so the ladder stops there: 2 captures, appliedScale < 1.
    expect(res).toEqual({
      result: {
        captured: true,
        dataUrl: FULL_PAGE_PNG,
        width: 1512,
        height: 6000,
        clipped: false,
        appliedScale: 0.75,
        attempts: 2,
      },
    });
    // The full-page port, not captureScreenshot, is the recapture target; the
    // scale is forwarded so the ladder contract mirrors captureViewport's.
    expect(
      vi.mocked(debuggerPorts.captureFullPageScreenshot),
    ).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(debuggerPorts.captureFullPageScreenshot),
    ).toHaveBeenCalledWith(7, { scale: 0.75 });
    expect(vi.mocked(debuggerPorts.captureScreenshot)).not.toHaveBeenCalled();
  });

  it("returns a defined too-large outcome at the give-up floor for an always-over-ceiling full-page capture", async () => {
    const big = `data:image/png;base64,${"A".repeat(
      MAX_SCREENSHOT_BASE64_CHARS + 1,
    )}`;
    const debuggerPorts = fakeDebugger({
      captureFullPageScreenshot: vi.fn(() => Promise.resolve(big)),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "full-page" });
    expect(res).toEqual({
      result: {
        captured: false,
        reason: "too-large",
        size: MAX_SCREENSHOT_BASE64_CHARS + 1,
        limit: MAX_SCREENSHOT_BASE64_CHARS,
        floor: SCREENSHOT_DOWNSCALE_FLOOR_SCALE,
        attempts: 1 + SCREENSHOT_DOWNSCALE_LADDER_SCALES.length,
      },
    });
    expect(
      vi.mocked(debuggerPorts.captureFullPageScreenshot),
    ).toHaveBeenCalledTimes(1 + SCREENSHOT_DOWNSCALE_LADDER_SCALES.length);
    expect(vi.mocked(debuggerPorts.captureScreenshot)).not.toHaveBeenCalled();
  });

  it("rejects a bad mode / missing elementRef before resolving a tab", async () => {
    const sandbox = fakeSandbox();
    const debuggerPorts = fakeDebugger();
    for (const bad of [
      { mode: "bogus" },
      { mode: "element" },
      { mode: "element", elementRef: "" },
    ]) {
      const res = await pageActionHandlers(
        fakePorts(),
        sandbox,
        debuggerPorts,
        fakeStore(),
      ).captureTab(bad);
      expect(res).toHaveProperty("error");
    }
    expect(vi.mocked(sandbox.resolveTabId)).not.toHaveBeenCalled();
    expect(vi.mocked(debuggerPorts.captureScreenshot)).not.toHaveBeenCalled();
  });

  it("surfaces a rejecting debugger capture as a structured tab-unavailable outcome, not a rejection", async () => {
    const debuggerPorts = fakeDebugger({
      captureScreenshot: () =>
        Promise.reject(new Error("chrome.debugger detached (target closed)")),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    expect(res).toEqual({
      result: {
        captured: false,
        reason: "tab-unavailable",
        detail: "chrome.debugger detached (target closed)",
      },
    });
  });

  it("surfaces a rejecting element-rect read as a structured tab-unavailable outcome", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () => Promise.reject(new Error("Cannot attach to target")),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({ mode: "element", elementRef: "#x" });
    expect(res).toEqual({
      result: {
        captured: false,
        reason: "tab-unavailable",
        detail: "Cannot attach to target",
      },
    });
  });

  it("surfaces a resolver failure as a structured tab-unavailable outcome", async () => {
    const debuggerPorts = fakeDebugger();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      sandbox,
      debuggerPorts,
      fakeStore(),
    ).captureTab({});
    expect(res).toEqual({
      result: {
        captured: false,
        reason: "tab-unavailable",
        detail: "sandbox tab missing and could not be created",
      },
    });
  });

  it("treats a hostile element ref as an element-not-found outcome (in-page try/catch, never a throw)", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({ ok: true, json: JSON.stringify({ found: false }) }),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).captureTab({
      mode: "element",
      elementRef: ">>>not a selector<<<",
    });
    expect(res).toEqual({
      result: { captured: false, reason: "element-not-found" },
    });
  });
});

describe("pageActionHandlers — chrome port rejections become { error } outcomes", () => {
  const rejecting = (): Promise<never> =>
    Promise.reject(new Error("Cannot access a chrome:// URL"));

  it("every non-ping action returns an { error } outcome, never rejects", async () => {
    const ports = fakePorts({
      executeScript: rejecting,
      updateTab: rejecting,
      reload: rejecting,
    });
    const debuggerPorts = fakeDebugger({
      captureScreenshot: rejecting,
      scroll: rejecting,
    });
    const h = pageActionHandlers(
      ports,
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    );
    const outcomes = await Promise.all([
      h.navigateTo({ url: "https://e.com" }),
      h.getPageText({}),
      h.readPage({}),
      h.findElement({ selector: ".x" }),
      h.clickElement({ selector: ".x" }),
      h.typeText({ selector: ".x", text: "y" }),
      h.reloadTab({}),
      h.clickAt({ x: 1, y: 2 }),
      h.hover({ x: 1, y: 2 }),
      h.scrollPage({}),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toHaveProperty("error");
      expect(String((outcome as { error?: string }).error)).toContain(
        "Cannot access a chrome:// URL",
      );
    }
    // captureTab swallows a debugger rejection into a structured
    // tab-unavailable outcome rather than a top-level { error }.
    const captureRes = await h.captureTab({});
    expect(captureRes).toEqual({
      result: {
        captured: false,
        reason: "tab-unavailable",
        detail: "Cannot access a chrome:// URL",
      },
    });
  });
});

describe("pageActionHandlers — clickAt", () => {
  /** Pull the injected in-page function out of the executeScript mock call. */
  async function injectedFn(): Promise<
    (x: number, y: number) => { found: boolean; dispatched: number }
  > {
    const ports = fakePorts({
      executeScript: () => Promise.resolve({ found: true, dispatched: 3 }),
    });
    await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).clickAt({
      x: 10,
      y: 20,
    });
    const call = vi.mocked(ports.executeScript).mock.calls[0];
    return call?.[1] as (
      x: number,
      y: number,
    ) => { found: boolean; dispatched: number };
  }

  it("resolves the sandbox tab id and passes explicit x/y to executeScript", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve({ found: true, dispatched: 3 }),
    });
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).clickAt({
      x: 10,
      y: 20,
    });
    expect(res).toEqual({ result: { found: true, dispatched: 3 } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      [10, 20],
    );
  });

  it("rejects missing / negative / fractional / non-numeric coordinates before any port call", async () => {
    const ports = fakePorts();
    for (const bad of [
      {},
      { x: 1 },
      { x: 1, y: -2 },
      { x: 1.5, y: 2 },
      { x: "1", y: 2 },
      { x: Number.NaN, y: 0 },
      { x: 1, y: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        await pageActionHandlers(
          ports,
          fakeSandbox(),
          fakeDebugger(),
          fakeStore(),
        ).clickAt(bad),
      ).toHaveProperty("error");
    }
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
  });

  it("coerces a malformed page envelope to an { error } outcome", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve(undefined),
    });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).clickAt({
        x: 1,
        y: 2,
      }),
    ).toHaveProperty("error");
  });

  describe("the injected in-page function", () => {
    class FakePointerEvent {
      readonly type: string;
      readonly clientX: number;
      readonly clientY: number;
      constructor(
        type: string,
        init: { clientX?: number; clientY?: number } = {},
      ) {
        this.type = type;
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
      }
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function installDom(elementAt: unknown): {
      elementFromPoint: ReturnType<typeof vi.fn>;
    } {
      const doc = { elementFromPoint: vi.fn(() => elementAt) };
      vi.stubGlobal("document", doc);
      vi.stubGlobal("PointerEvent", FakePointerEvent);
      vi.stubGlobal("MouseEvent", FakePointerEvent);
      return doc;
    }

    it("dispatches pointerdown, pointerup, click in order on the element under the coordinate", async () => {
      const events: Array<{ type: string; clientX: number; clientY: number }> =
        [];
      const node = {
        dispatchEvent: vi.fn(
          (e: { type: string; clientX: number; clientY: number }) => {
            events.push(e);
            return true;
          },
        ),
      };
      const doc = installDom(node);
      const fn = await injectedFn();

      expect(fn(10, 20)).toEqual({ found: true, dispatched: 3 });
      expect(doc.elementFromPoint).toHaveBeenCalledWith(10, 20);
      expect(events.map((e) => e.type)).toEqual([
        "pointerdown",
        "pointerup",
        "click",
      ]);
      for (const e of events) {
        expect(e.clientX).toBe(10);
        expect(e.clientY).toBe(20);
      }
    });

    it("returns the not-found sentinel with 0 dispatched when elementFromPoint is null", async () => {
      installDom(null);
      const fn = await injectedFn();
      expect(fn(1, 2)).toEqual({ found: false, dispatched: 0 });
    });
  });
});

describe("pageActionHandlers — hover", () => {
  /** Pull the injected in-page function out of the executeScript mock call. */
  async function injectedFn(): Promise<
    (x: number, y: number) => { found: boolean; dispatched: number }
  > {
    const ports = fakePorts({
      executeScript: () => Promise.resolve({ found: true, dispatched: 2 }),
    });
    await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).hover({
      x: 10,
      y: 20,
    });
    const call = vi.mocked(ports.executeScript).mock.calls[0];
    return call?.[1] as (
      x: number,
      y: number,
    ) => { found: boolean; dispatched: number };
  }

  it("resolves the sandbox tab id and passes explicit x/y to executeScript", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve({ found: true, dispatched: 2 }),
    });
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).hover({
      x: 10,
      y: 20,
    });
    expect(res).toEqual({ result: { found: true, dispatched: 2 } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      [10, 20],
    );
  });

  it("rejects missing / negative / fractional / non-numeric coordinates before any port call", async () => {
    const ports = fakePorts();
    for (const bad of [
      {},
      { x: 1 },
      { x: 1, y: -2 },
      { x: 1.5, y: 2 },
      { x: "1", y: 2 },
      { x: Number.NaN, y: 0 },
      { x: 1, y: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        await pageActionHandlers(
          ports,
          fakeSandbox(),
          fakeDebugger(),
          fakeStore(),
        ).hover(bad),
      ).toHaveProperty("error");
    }
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
  });

  it("coerces a malformed page envelope to an { error } outcome", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve(undefined),
    });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).hover({
        x: 1,
        y: 2,
      }),
    ).toHaveProperty("error");
  });

  describe("the injected in-page function", () => {
    class FakePointerEvent {
      readonly type: string;
      readonly clientX: number;
      readonly clientY: number;
      constructor(
        type: string,
        init: { clientX?: number; clientY?: number } = {},
      ) {
        this.type = type;
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
      }
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function installDom(elementAt: unknown): {
      elementFromPoint: ReturnType<typeof vi.fn>;
    } {
      const doc = { elementFromPoint: vi.fn(() => elementAt) };
      vi.stubGlobal("document", doc);
      vi.stubGlobal("PointerEvent", FakePointerEvent);
      vi.stubGlobal("MouseEvent", FakePointerEvent);
      return doc;
    }

    it("dispatches pointerover, then mouseover in order on the element under the coordinate — no click events", async () => {
      const events: Array<{ type: string; clientX: number; clientY: number }> =
        [];
      const node = {
        dispatchEvent: vi.fn(
          (e: { type: string; clientX: number; clientY: number }) => {
            events.push(e);
            return true;
          },
        ),
      };
      const doc = installDom(node);
      const fn = await injectedFn();

      expect(fn(10, 20)).toEqual({ found: true, dispatched: 2 });
      expect(doc.elementFromPoint).toHaveBeenCalledWith(10, 20);
      expect(events.map((e) => e.type)).toEqual(["pointerover", "mouseover"]);
      for (const e of events) {
        expect(e.clientX).toBe(10);
        expect(e.clientY).toBe(20);
      }
    });

    it("returns the not-found sentinel with 0 dispatched when elementFromPoint is null", async () => {
      installDom(null);
      const fn = await injectedFn();
      expect(fn(1, 2)).toEqual({ found: false, dispatched: 0 });
    });
  });
});

describe("pageActionHandlers — reloadTab", () => {
  it("resolves the sandbox tab id and reloads it exclusively through ports.reload", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).reloadTab({});
    expect(res).toEqual({ result: { reloaded: true } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.reload)).toHaveBeenCalledWith(7);
    expect(vi.mocked(ports.updateTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.captureVisibleTab)).not.toHaveBeenCalled();
  });

  it("returns an error when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).reloadTab({}),
    ).toHaveProperty("error");
    expect(vi.mocked(ports.reload)).not.toHaveBeenCalled();
  });

  it("surfaces a rejected reload port as an { error } outcome", async () => {
    const ports = fakePorts({
      reload: () => Promise.reject(new Error("Cannot access a chrome:// URL")),
    });
    const res = await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).reloadTab({});
    expect(res).toHaveProperty("error");
    expect(res).not.toEqual({ result: { reloaded: true } });
  });
});

describe("pageActionHandlers — executeScript", () => {
  it("resolves the sandbox tab id and injects the caller's code into the MAIN world", async () => {
    const ports = fakePorts({
      executeScript: () =>
        Promise.resolve({ ok: true, json: JSON.stringify({ title: "hi" }) }),
    });
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).executeScript({
      code: "document.title",
    });
    expect(res).toEqual({ result: { value: { title: "hi" } } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      ["document.title"],
      { world: "MAIN" },
    );
  });

  it("rejects a missing/empty code string without calling executeScript", async () => {
    const ports = fakePorts();
    for (const bad of [{}, { code: "" }, { code: 5 }]) {
      expect(
        await pageActionHandlers(
          ports,
          fakeSandbox(),
          fakeDebugger(),
          fakeStore(),
        ).executeScript(bad),
      ).toHaveProperty("error");
    }
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
  });

  it("returns an { error } when the page returned no envelope (CSP blocked eval)", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve(undefined),
    });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).executeScript({ code: "1" }),
    ).toHaveProperty("error");
  });

  it("surfaces the in-page failure reason as an { error }", async () => {
    const ports = fakePorts({
      executeScript: () =>
        Promise.resolve({ ok: false, error: "expression returned undefined" }),
    });
    expect(
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).executeScript({
        code: "undefined",
      }),
    ).toEqual({ error: "expression returned undefined" });
  });

  it("returns a structured too-large result rather than sending it raw", async () => {
    const ports = fakePorts({
      executeScript: () =>
        Promise.resolve({
          ok: true,
          json: `"${"x".repeat(MAX_EXECUTE_SCRIPT_RESULT_CHARS)}"`,
        }),
    });
    const res = await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).executeScript({ code: "x" });
    expect(res).toEqual({
      result: {
        tooLarge: true,
        actualBytes: MAX_EXECUTE_SCRIPT_RESULT_CHARS + 2,
        limitBytes: MAX_EXECUTE_SCRIPT_RESULT_CHARS,
      },
    });
  });

  it("returns the normal value shape for an under-cap executeScript result", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve({ ok: true, json: `"ok"` }),
    });
    const res = await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).executeScript({ code: "x" });
    expect(res).toEqual({ result: { value: "ok" } });
  });

  it("yields an error when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve({ ok: true, json: "1" }),
    });
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).executeScript({
        code: "1",
      }),
    ).toHaveProperty("error");
  });

  describe("the injected MAIN-world function", () => {
    async function injectedFn(): Promise<
      (code: string) => { ok: boolean; json?: string; error?: string }
    > {
      const ports = fakePorts({
        executeScript: () => Promise.resolve({ ok: true, json: "0" }),
      });
      await pageActionHandlers(
        ports,
        fakeSandbox(),
        fakeDebugger(),
        fakeStore(),
      ).executeScript({ code: "0" });
      const call = vi.mocked(ports.executeScript).mock.calls[0];
      return call?.[1] as (code: string) => {
        ok: boolean;
        json?: string;
        error?: string;
      };
    }

    it("serialises a plain value", async () => {
      expect((await injectedFn())("1 + 1")).toEqual({ ok: true, json: "2" });
    });
    it("reports undefined, a thrown error, and a circular structure", async () => {
      const fn = await injectedFn();
      expect(fn("undefined")).toMatchObject({ ok: false });
      expect(fn("(() => { throw new Error('boom'); })()")).toMatchObject({
        ok: false,
        error: "boom",
      });
      expect(
        fn("(() => { const o = {}; o.self = o; return o; })()"),
      ).toMatchObject({ ok: false });
    });
  });
});

describe("pageActionHandlers — evaluatePage", () => {
  it("resolves the sandbox tab id and reads the page value through the CDP port", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const debuggerPorts = fakeDebugger({
      evaluate: () => Promise.resolve({ ok: true, json: JSON.stringify("h1") }),
    });
    const res = await pageActionHandlers(
      ports,
      sandbox,
      debuggerPorts,
      fakeStore(),
    ).evaluatePage({ code: "document.querySelector('h1')?.innerText" });
    expect(res).toEqual({ result: { value: "h1" } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(debuggerPorts.evaluate)).toHaveBeenCalledWith(
      7,
      "document.querySelector('h1')?.innerText",
    );
  });

  it("rejects a missing/empty code string before any CDP port call", async () => {
    const ports = fakePorts();
    const debuggerPorts = fakeDebugger();
    for (const bad of [{}, { code: "" }, { code: 5 }]) {
      expect(
        await pageActionHandlers(
          ports,
          fakeSandbox(),
          debuggerPorts,
          fakeStore(),
        ).evaluatePage(bad),
      ).toHaveProperty("error");
    }
    expect(vi.mocked(debuggerPorts.evaluate)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
  });

  it("passes a port-returned { ok: false, error } straight through", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({ ok: false, error: "expression returned undefined" }),
    });
    expect(
      await pageActionHandlers(
        fakePorts(),
        fakeSandbox(),
        debuggerPorts,
        fakeStore(),
      ).evaluatePage({ code: "undefined" }),
    ).toEqual({ error: "expression returned undefined" });
  });

  it("returns a structured too-large result for an over-large CDP result", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () =>
        Promise.resolve({
          ok: true,
          json: `"${"x".repeat(MAX_EXECUTE_SCRIPT_RESULT_CHARS)}"`,
        }),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).evaluatePage({ code: "x" });
    expect(res).toEqual({
      result: {
        tooLarge: true,
        actualBytes: MAX_EXECUTE_SCRIPT_RESULT_CHARS + 2,
        limitBytes: MAX_EXECUTE_SCRIPT_RESULT_CHARS,
      },
    });
  });

  it("returns the normal value shape for an under-cap evaluatePage result", async () => {
    const debuggerPorts = fakeDebugger({
      evaluate: () => Promise.resolve({ ok: true, json: `"ok"` }),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).evaluatePage({ code: "x" });
    expect(res).toEqual({ result: { value: "ok" } });
  });

  it("returns an error when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const debuggerPorts = fakeDebugger();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        fakePorts(),
        sandbox,
        debuggerPorts,
        fakeStore(),
      ).evaluatePage({ code: "1" }),
    ).toHaveProperty("error");
    expect(vi.mocked(debuggerPorts.evaluate)).not.toHaveBeenCalled();
  });
});

describe("pageActionHandlers — scrollPage", () => {
  it("resolves the sandbox tab id, calls the CDP scroll port with an empty intent, and coerces the outcome", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const debuggerPorts = fakeDebugger({
      scroll: () =>
        Promise.resolve({
          method: "wheel" as const,
          scrollYBefore: 0,
          scrollYAfter: 2400,
          reachedEnd: false,
        }),
    });
    const res = await pageActionHandlers(
      ports,
      sandbox,
      debuggerPorts,
      fakeStore(),
    ).scrollPage({});
    expect(res).toEqual({
      result: {
        method: "wheel",
        scrollYBefore: 0,
        scrollYAfter: 2400,
        reachedEnd: false,
      },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(debuggerPorts.scroll)).toHaveBeenCalledWith(7, {});
  });

  it("rejects malformed params before any resolveTabId or scroll call", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const debuggerPorts = fakeDebugger();
    for (const bad of [
      { amountPx: -5 },
      { amountPx: "x" },
      { amountPx: Number.NaN },
      { amountPx: Number.POSITIVE_INFINITY },
      { toBottom: 1 },
      { toBottom: "yes" },
    ]) {
      expect(
        await pageActionHandlers(
          ports,
          sandbox,
          debuggerPorts,
          fakeStore(),
        ).scrollPage(bad),
      ).toHaveProperty("error");
    }
    expect(vi.mocked(sandbox.resolveTabId)).not.toHaveBeenCalled();
    expect(vi.mocked(debuggerPorts.scroll)).not.toHaveBeenCalled();
  });

  it("forwards a supplied amountPx and toBottom into the scroll intent", async () => {
    const sandbox = fakeSandbox();
    const debuggerPorts = fakeDebugger();
    await pageActionHandlers(
      fakePorts(),
      sandbox,
      debuggerPorts,
      fakeStore(),
    ).scrollPage({ amountPx: 500, toBottom: true });
    expect(vi.mocked(debuggerPorts.scroll)).toHaveBeenCalledWith(7, {
      amountPx: 500,
      toBottom: true,
    });
  });

  it("coerces the scroll outcome into the four-field result shape across all mechanism values", async () => {
    const cases: Array<[ScrollOutcome["method"], number, boolean]> = [
      ["wheel", 2400, false],
      ["script", 1200, true],
      ["none", 0, false],
    ];
    for (const [method, after, reachedEnd] of cases) {
      const debuggerPorts = fakeDebugger({
        scroll: () =>
          Promise.resolve({
            method,
            scrollYBefore: 0,
            scrollYAfter: after,
            reachedEnd,
          }),
      });
      const res = await pageActionHandlers(
        fakePorts(),
        fakeSandbox(),
        debuggerPorts,
        fakeStore(),
      ).scrollPage({});
      expect(res).toEqual({
        result: {
          method,
          scrollYBefore: 0,
          scrollYAfter: after,
          reachedEnd,
        },
      });
      expect(vi.mocked(debuggerPorts.scroll)).toHaveBeenCalledWith(7, {});
    }
  });

  it("returns an error when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const debuggerPorts = fakeDebugger();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        fakePorts(),
        sandbox,
        debuggerPorts,
        fakeStore(),
      ).scrollPage({}),
    ).toHaveProperty("error");
    expect(vi.mocked(debuggerPorts.scroll)).not.toHaveBeenCalled();
  });

  it("surfaces a rejecting scroll port as an { error } outcome (guard wrapped)", async () => {
    const debuggerPorts = fakeDebugger({
      scroll: () =>
        Promise.reject(new Error("chrome.debugger detached (target closed)")),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      debuggerPorts,
      fakeStore(),
    ).scrollPage({});
    expect(res).toHaveProperty("error");
    expect(String((res as { error?: string }).error)).toContain(
      "chrome.debugger detached",
    );
  });
});

describe("coerceScrollOutcome", () => {
  it("selects exactly the four scroll fields and passes method through unchanged", () => {
    const outcome: ScrollOutcome = {
      method: "script",
      scrollYBefore: 10,
      scrollYAfter: 800,
      reachedEnd: true,
    };
    expect(coerceScrollOutcome(outcome)).toEqual({
      result: {
        method: "script",
        scrollYBefore: 10,
        scrollYAfter: 800,
        reachedEnd: true,
      },
    });
  });
});

describe("pageActionHandlers — navigateBack", () => {
  it("resolves the sandbox tab id and calls ports.goBack with its id", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).navigateBack({});
    expect(res).toEqual({ result: { moved: true } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.goBack)).toHaveBeenCalledWith(7);
  });

  it("returns the no-back-history sentinel (not { moved: true }) when goBack rejects", async () => {
    const ports = fakePorts({
      goBack: () =>
        Promise.reject(new Error("Cannot find a previous page in history.")),
    });
    const res = await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).navigateBack({});
    expect(res).not.toEqual({ result: { moved: true } });
    expect(res).toHaveProperty("error");
    expect(String((res as { error?: string }).error)).toMatch(/back history/);
  });

  it("returns an error when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).navigateBack({}),
    ).toHaveProperty("error");
    expect(vi.mocked(ports.goBack)).not.toHaveBeenCalled();
  });
});

describe("pageActionHandlers — navigateForward", () => {
  it("resolves the sandbox tab id and calls ports.goForward with its id", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).navigateForward({});
    expect(res).toEqual({ result: { moved: true } });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.goForward)).toHaveBeenCalledWith(7);
    expect(vi.mocked(ports.goBack)).not.toHaveBeenCalled();
  });

  it("returns the no-forward-history sentinel (not { moved: true }) when goForward rejects", async () => {
    const ports = fakePorts({
      goForward: () =>
        Promise.reject(new Error("Cannot find a next page in history.")),
    });
    const res = await pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).navigateForward({});
    expect(res).not.toEqual({ result: { moved: true } });
    expect(res).toHaveProperty("error");
    expect(String((res as { error?: string }).error)).toMatch(
      /forward history/,
    );
  });

  it("returns an error when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        fakeStore(),
      ).navigateForward({}),
    ).toHaveProperty("error");
    expect(vi.mocked(ports.goForward)).not.toHaveBeenCalled();
  });
});

describe("resolveSince / resolveReadLimit", () => {
  it("resolveSince defaults, accepts non-negative integers, rejects the rest", () => {
    expect(resolveSince(undefined)).toBe(0);
    expect(resolveSince(0)).toBe(0);
    expect(resolveSince(5)).toBe(5);
    for (const bad of [-1, 1.5, Number.NaN, "3", null, {}]) {
      expect(resolveSince(bad)).toHaveProperty("error");
    }
  });
  it("resolveReadLimit defaults, clamps to the max, rejects the rest", () => {
    expect(resolveReadLimit(undefined)).toBe(DEFAULT_READ_LIMIT);
    expect(resolveReadLimit(10)).toBe(10);
    expect(resolveReadLimit(MAX_READ_LIMIT + 1)).toBe(MAX_READ_LIMIT);
    for (const bad of [0, -1, 1.5, "3", Number.NaN]) {
      expect(resolveReadLimit(bad)).toHaveProperty("error");
    }
  });
});

describe("pageActionHandlers — readConsoleMessages / readNetworkRequests", () => {
  it("forwards a validated since/limit to the matching store read on the sandbox tab", async () => {
    const store = fakeStore();
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      store,
    ).readConsoleMessages({
      since: 2,
      limit: 9,
    });
    expect(res).toHaveProperty("result");
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(store.readConsole)).toHaveBeenCalledWith(7, {
      since: 2,
      limit: 9,
    });
    expect(vi.mocked(store.readNetwork)).not.toHaveBeenCalled();
  });

  it("readNetworkRequests hits readNetwork, not readConsole", async () => {
    const store = fakeStore();
    const sandbox = fakeSandbox();
    await pageActionHandlers(
      fakePorts(),
      sandbox,
      fakeDebugger(),
      store,
    ).readNetworkRequests({});
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(store.readNetwork)).toHaveBeenCalledWith(7, {
      since: 0,
      limit: DEFAULT_READ_LIMIT,
    });
    expect(vi.mocked(store.readConsole)).not.toHaveBeenCalled();
  });

  it("clamps an over-max limit before the store sees it", async () => {
    const store = fakeStore();
    await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).readConsoleMessages({
      limit: MAX_READ_LIMIT + 1000,
    });
    expect(vi.mocked(store.readConsole)).toHaveBeenCalledWith(7, {
      since: 0,
      limit: MAX_READ_LIMIT,
    });
  });

  it("rejects a bad since or limit without touching the store", async () => {
    const store = fakeStore();
    const h = pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    );
    for (const bad of [
      { since: -1 },
      { since: 1.5 },
      { since: Number.NaN },
      { since: "3" },
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: "3" },
    ]) {
      expect(await h.readConsoleMessages(bad)).toHaveProperty("error");
    }
    expect(vi.mocked(store.readConsole)).not.toHaveBeenCalled();
  });

  it("returns an error for both read handlers when the sandbox tab cannot be resolved (resolver throws)", async () => {
    const store = fakeStore();
    const ports = fakePorts();
    const sandbox = fakeSandbox({
      resolveTabId: () =>
        Promise.reject(
          new Error("sandbox tab missing and could not be created"),
        ),
    });
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        store,
      ).readConsoleMessages({}),
    ).toHaveProperty("error");
    expect(
      await pageActionHandlers(
        ports,
        sandbox,
        fakeDebugger(),
        store,
      ).readNetworkRequests({}),
    ).toHaveProperty("error");
  });

  it("surfaces a throwing store as an { error } outcome (guard wrapped)", async () => {
    const store = fakeStore({
      readConsole: () => {
        throw new Error("store boom");
      },
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).readConsoleMessages({});
    expect(res).toHaveProperty("error");
    expect(String((res as { error?: string }).error)).toContain("store boom");
  });

  it("an equal-to-nextSince cursor yields an empty window with the cursor unchanged", async () => {
    // fakeStore echoes `since` back as `nextSince` and readNetwork returns []
    const store = fakeStore();
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).readNetworkRequests({
      since: 4,
    });
    expect(res).toEqual({
      result: { entries: [], nextSince: 4, dropped: false, truncated: false },
    });
  });

  it("returns the console CaptureRead unchanged when the result is within the byte ceiling", async () => {
    const store = fakeStore();
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).readConsoleMessages({ since: 1, limit: 1 });
    expect(res).toEqual({
      result: {
        entries: [
          {
            level: "log",
            text: "hi",
            timestamp: 0,
            truncated: false,
            seq: 1,
          },
        ],
        nextSince: 1,
        dropped: false,
        truncated: false,
      },
    });
  });

  it("returns the network CaptureRead unchanged when the result is within the byte ceiling", async () => {
    const store = fakeStore();
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).readNetworkRequests({ since: 3, limit: 5 });
    expect(res).toEqual({
      result: { entries: [], nextSince: 3, dropped: false, truncated: false },
    });
  });

  it("replaces a console read that exceeds the byte ceiling with the oversize outcome", async () => {
    const store = fakeStore({
      readConsole: () => ({
        entries: Array.from({ length: 200 }, (_, i) => ({
          level: "log" as const,
          text: "x".repeat(8192),
          timestamp: i,
          truncated: false,
          seq: i + 1,
        })),
        nextSince: 0,
        dropped: false,
        truncated: false,
      }),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).readConsoleMessages({ since: 0, limit: MAX_READ_LIMIT });
    const oversize = (
      res as {
        result: { tooLarge: boolean; actualBytes: number; limitBytes: number };
      }
    ).result;
    expect(oversize).toMatchObject({
      tooLarge: true,
      limitBytes: MAX_CONSOLE_READ_RESULT_CHARS,
    });
    expect(oversize.actualBytes).toBeGreaterThan(MAX_CONSOLE_READ_RESULT_CHARS);
    expect(oversize).not.toHaveProperty("entries");
    expect(oversize).not.toHaveProperty("nextSince");
  });

  it("replaces a network read that exceeds the byte ceiling with the oversize outcome", async () => {
    const store = fakeStore({
      readNetwork: () => ({
        entries: Array.from({ length: 400 }, (_, i) => ({
          requestId: `r${i}`,
          method: "GET",
          url: "https://example.com/payload",
          status: 200,
          durationMs: 1,
          contentType: "application/json",
          bodyPreview: "x".repeat(9000),
          truncated: false,
          failed: false,
          timestamp: i,
          seq: i + 1,
        })),
        nextSince: 0,
        dropped: false,
        truncated: false,
      }),
    });
    const res = await pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).readNetworkRequests({ since: 0, limit: MAX_READ_LIMIT });
    const oversize = (
      res as {
        result: { tooLarge: boolean; actualBytes: number; limitBytes: number };
      }
    ).result;
    expect(oversize).toMatchObject({
      tooLarge: true,
      limitBytes: MAX_NETWORK_READ_RESULT_CHARS,
    });
    expect(oversize.actualBytes).toBeGreaterThan(MAX_NETWORK_READ_RESULT_CHARS);
    expect(oversize).not.toHaveProperty("entries");
    expect(oversize).not.toHaveProperty("nextSince");
  });
});

describe("pageActionHandlers — getTabState", () => {
  /** Assert the read-only contract: no mutating/navigating port ever fires. */
  const assertReadOnly = (ports: ChromePorts) => {
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.updateTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.captureVisibleTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.goBack)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.goForward)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.reload)).not.toHaveBeenCalled();
  };

  it("returns the null shape when no sandbox tab id is stored, and never creates or targets a tab", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox({
      peekStoredSandboxTabId: () => Promise.resolve(undefined),
    });
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).getTabState({});
    expect(res).toEqual({
      result: { sandboxTab: null, activeTab: null, sandboxTabActive: false },
    });
    expect(vi.mocked(sandbox.peekStoredSandboxTabId)).toHaveBeenCalled();
    expect(vi.mocked(sandbox.resolveTabId)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.readTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.activeTabOfWindow)).not.toHaveBeenCalled();
    assertReadOnly(ports);
  });

  it("sets sandboxTabActive true when the sandbox tab is itself the focused tab of its window", async () => {
    // fakePorts readTab resolves id 7 / windowId 42; activeTabOfWindow resolves the same id 7.
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).getTabState({});
    expect(res).toEqual({
      result: {
        sandboxTab: { id: 7, url: "https://example.com", title: "Example" },
        activeTab: { id: 7, url: "https://example.com", title: "Example" },
        sandboxTabActive: true,
      },
    });
    expect(vi.mocked(ports.readTab)).toHaveBeenCalledWith(7);
    expect(vi.mocked(ports.activeTabOfWindow)).toHaveBeenCalledWith(42);
    assertReadOnly(ports);
  });

  it("sets sandboxTabActive false when a different tab in the sandbox tab's window is focused", async () => {
    const ports = fakePorts({
      activeTabOfWindow: () =>
        Promise.resolve({
          id: 9,
          windowId: 42,
          url: "https://other.com",
          title: "Other",
        }),
    });
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).getTabState({});
    expect(res).toEqual({
      result: {
        sandboxTab: { id: 7, url: "https://example.com", title: "Example" },
        activeTab: { id: 9, url: "https://other.com", title: "Other" },
        sandboxTabActive: false,
      },
    });
    expect(vi.mocked(ports.activeTabOfWindow)).toHaveBeenCalledWith(42);
    assertReadOnly(ports);
  });

  it("surfaces a stale saved id as an { error } sentinel, not the null shape (guard wrapped)", async () => {
    const ports = fakePorts({
      readTab: () => Promise.reject(new Error("No tab with id: 99.")),
    });
    const sandbox = fakeSandbox({
      peekStoredSandboxTabId: () => Promise.resolve(99),
    });
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).getTabState({});
    expect(res).toHaveProperty("error");
    expect(String((res as { error?: string }).error)).toContain(
      "No tab with id: 99.",
    );
    expect(res).not.toEqual({
      result: { sandboxTab: null, activeTab: null, sandboxTabActive: false },
    });
    expect(vi.mocked(sandbox.resolveTabId)).not.toHaveBeenCalled();
    assertReadOnly(ports);
  });

  it("returns a value and runs no mutating port during a live read", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).getTabState({});
    expect(res).toHaveProperty("result");
    assertReadOnly(ports);
  });
});

describe("pageActionHandlers — closeSandboxTab", () => {
  /** The close action must not create, target, navigate, or otherwise touch any tab outside the sandbox port. */
  const assertNoTabTraffic = (ports: ChromePorts, sandbox: SandboxTabPorts) => {
    expect(vi.mocked(sandbox.resolveTabId)).not.toHaveBeenCalled();
    expect(vi.mocked(sandbox.peekStoredSandboxTabId)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.readTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.updateTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.captureVisibleTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.goBack)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.goForward)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.reload)).not.toHaveBeenCalled();
  };

  it("delegates to the sandbox port and returns its close result", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).closeSandboxTab({});
    expect(res).toEqual({ result: { closed: true, hadTab: true } });
    expect(vi.mocked(sandbox.closeSandboxTab)).toHaveBeenCalledTimes(1);
    assertNoTabTraffic(ports, sandbox);
  });

  it("surfaces the no-op result when the sandbox port reports no tab was closed", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox({
      closeSandboxTab: () => Promise.resolve({ closed: false, hadTab: false }),
    });
    const res = await pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).closeSandboxTab({});
    expect(res).toEqual({ result: { closed: false, hadTab: false } });
    expect(vi.mocked(sandbox.closeSandboxTab)).toHaveBeenCalledTimes(1);
    assertNoTabTraffic(ports, sandbox);
  });
});

describe("pageActionHandlers — waitFor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the handler's initial awaits settle so the poll loop's first timer is scheduled. */
  const settle = (): Promise<void> => Promise.resolve();

  it("selector-present resolves met when a JS-inserted node is already in the DOM", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve(true),
    });
    const sandbox = fakeSandbox();
    const p = pageActionHandlers(
      ports,
      sandbox,
      fakeDebugger(),
      fakeStore(),
    ).waitFor({
      mode: "selector-present",
      selector: ".x",
    });
    await vi.advanceTimersByTimeAsync(0);
    const res = await p;
    expect(res).toEqual({
      result: { mode: "selector-present", met: true, elapsedMs: 0 },
    });
    expect(vi.mocked(sandbox.resolveTabId)).toHaveBeenCalled();
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.executeScript)).toHaveBeenCalledWith(
      7,
      expect.any(Function),
      [".x"],
    );
  });

  it("selector-present resolves met:false once the timeout budget elapses", async () => {
    const ports = fakePorts({
      executeScript: () => Promise.resolve(false),
    });
    const p = pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).waitFor({
      mode: "selector-present",
      selector: ".never",
      timeoutMs: 300,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    const res = await p;
    expect(res).toEqual({
      result: { mode: "selector-present", met: false, elapsedMs: 300 },
    });
  });

  it("network-idle resolves met after a quiet window with no new traffic", async () => {
    const store = fakeStore(); // readNetwork returns empty → latestSeq is always 0
    const ports = fakePorts();
    const p = pageActionHandlers(
      ports,
      fakeSandbox(),
      fakeDebugger(),
      store,
    ).waitFor({
      mode: "network-idle",
      timeoutMs: 1000,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(700);
    const res = await p;
    expect(res).toEqual({
      result: { mode: "network-idle", met: true, elapsedMs: 500 },
    });
    expect(vi.mocked(ports.queryActiveTab)).not.toHaveBeenCalled();
    expect(vi.mocked(store.readNetwork)).toHaveBeenCalledWith(7, {
      since: 0,
      limit: MAX_READ_LIMIT,
    });
  });

  it("fixed-delay blocks for the requested delay and resolves met", async () => {
    const p = pageActionHandlers(
      fakePorts(),
      fakeSandbox(),
      fakeDebugger(),
      fakeStore(),
    ).waitFor({
      mode: "fixed-delay",
      delayMs: 150,
      timeoutMs: 1000,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    const res = await p;
    expect(res).toMatchObject({
      result: { mode: "fixed-delay", met: true },
    });
    const elapsedMs = (res as { result: { elapsedMs: number } }).result
      .elapsedMs;
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
  });

  it("rejects a malformed mode / missing mode-specific field / bad timeoutMs before resolving a tab", async () => {
    const ports = fakePorts();
    const sandbox = fakeSandbox();
    const h = pageActionHandlers(ports, sandbox, fakeDebugger(), fakeStore());
    for (const bad of [
      {},
      { mode: "bogus" },
      { mode: "selector-present" }, // missing selector
      { mode: "selector-present", selector: "" },
      { mode: "selector-present", selector: ".x", timeoutMs: "abc" },
      { mode: "fixed-delay" }, // missing delayMs
      { mode: "fixed-delay", delayMs: -1 },
      { mode: "network-idle", timeoutMs: Number.NaN },
    ]) {
      const res = await h.waitFor(bad);
      expect(res).toHaveProperty("error");
    }
    expect(vi.mocked(sandbox.resolveTabId)).not.toHaveBeenCalled();
  });
});

describe("resolveWaitForParams", () => {
  it("narrows each mode and rejects a malformed time/type", () => {
    expect(
      resolveWaitForParams({ mode: "selector-present", selector: ".x" }),
    ).toEqual({
      mode: "selector-present",
      selector: ".x",
      timeoutMs: undefined,
    });
    expect(resolveWaitForParams({ mode: "network-idle" })).toEqual({
      mode: "network-idle",
      timeoutMs: undefined,
    });
    expect(
      resolveWaitForParams({
        mode: "fixed-delay",
        delayMs: 5,
        timeoutMs: 1000,
      }),
    ).toEqual({ mode: "fixed-delay", delayMs: 5, timeoutMs: 1000 });
    expect(
      resolveWaitForParams({
        mode: "selector-present",
        selector: ".x",
        timeoutMs: "5",
      }),
    ).toHaveProperty("error");
    expect(resolveWaitForParams({ mode: "bogus" })).toHaveProperty("error");
  });
});
