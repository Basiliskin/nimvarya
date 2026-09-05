/**
 * `ChromePorts` — the narrow slice of the `chrome.*` API the page-action
 * handlers depend on, plus its real implementation over the extension APIs.
 *
 * The interface exists so the handlers in `page-actions.ts` are unit-testable
 * with fakes: the service worker itself cannot run under vitest, so the fake
 * `ChromePorts` in the tests is the genuine second implementation (YAGNI gate 3
 * is satisfied by a real consumer, not a hypothetical one).
 *
 * `executeScript` returns `unknown` on purpose — an injected function's result
 * is page-controlled data and is validated by the caller, never trusted by
 * shape.
 *
 * Named `ports.ts` so the repo-wide coverage guard treats it as a boundary
 * definition; its only runtime export, `chromeCommandPorts`, is exercised
 * end-to-end by the manual Chrome check recorded in the phase notes.
 */

/// <reference types="chrome" />

import type { TabIdentity } from "../protocol/types.js";

export interface ActiveTab {
  readonly id: number;
  readonly windowId: number;
}

/** A tab's identity (id/url/title) plus the window that owns it. */
export type TabIdentityWithWindow = TabIdentity & { readonly windowId: number };

export interface ChromePorts {
  /** The active tab of the current window, or `undefined` if there is none. */
  queryActiveTab(): Promise<ActiveTab | undefined>;
  /**
   * Read one tab's identity (id/url/title) plus its window id by tab id. Rejects
   * for a closed or restricted tab, so a caller's `guard()` can surface it; the
   * url/title fall back to `""` but never to `undefined`.
   */
  readTab(tabId: number): Promise<TabIdentityWithWindow>;
  /**
   * The active tab of the given window, or `undefined` when that window has no
   * active tab. Scoped strictly to the passed `windowId` — never the current
   * window and never the OS-focused window.
   */
  activeTabOfWindow(
    windowId: number,
  ): Promise<TabIdentityWithWindow | undefined>;
  /**
   * Serialise `func`, run it in the page with `args`, return its result.
   *
   * `options.world` selects the execution world: omitted (or `"ISOLATED"`) runs
   * in the extension's isolated content-script world, as every existing handler
   * needs; `"MAIN"` runs in the page's own JS world so a caller-supplied
   * expression can see page globals and libraries (used by `executeScript`).
   */
  executeScript(
    tabId: number,
    func: (...args: never[]) => unknown,
    args: readonly unknown[],
    options?: { readonly world?: "ISOLATED" | "MAIN" },
  ): Promise<unknown>;
  /** Point the tab at `url`. */
  updateTab(tabId: number, props: { readonly url: string }): Promise<void>;
  /**
   * Move the tab to its previous history entry. Rejects when the tab has no
   * earlier entry (Chrome throws "Cannot find a previous page in history.").
   */
  goBack(tabId: number): Promise<void>;
  /**
   * Move the tab to its next history entry. Rejects when the tab has no later
   * entry (Chrome throws "Cannot find a next page in history.").
   */
  goForward(tabId: number): Promise<void>;
  /** Reload the tab (equivalent to the browser's reload button). */
  reload(tabId: number): Promise<void>;
  /** Capture the visible area of the given window as a `data:image/png` URL. */
  captureVisibleTab(windowId: number): Promise<string>;
}

/**
 * Map a resolved `chrome.tabs.Tab` to its identity triple. `url`/`title` are
 * optional on the raw tab (and absent on a restricted or still-loading tab), so
 * they fall back to `""` to keep the identity always-string. `id` is guarded
 * because the raw type marks it optional; a resolved tab always carries one,
 * so this throw is unreachable in practice and exists only to keep the return
 * type `number` without a non-null assertion.
 */
function tabIdentity(tab: chrome.tabs.Tab): TabIdentityWithWindow {
  const id = tab.id;
  if (id === undefined) {
    throw new Error("chrome tab resolved without an id");
  }
  return {
    id,
    windowId: tab.windowId,
    url: tab.url ?? "",
    title: tab.title ?? "",
  };
}

/** The production `ChromePorts`, backed by the MV3 extension APIs. */
export function chromeCommandPorts(): ChromePorts {
  return {
    queryActiveTab: async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) return undefined;
      return { id: tab.id, windowId: tab.windowId };
    },
    readTab: async (tabId) => tabIdentity(await chrome.tabs.get(tabId)),
    activeTabOfWindow: async (windowId) => {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab?.id === undefined) return undefined;
      return tabIdentity(tab);
    },
    executeScript: async (tabId, func, args, options) => {
      const injected = await chrome.scripting.executeScript<unknown[], unknown>(
        {
          target: { tabId },
          func: func as (...a: unknown[]) => unknown,
          args: [...args],
          ...(options?.world === undefined ? {} : { world: options.world }),
        },
      );
      return injected[0]?.result;
    },
    updateTab: async (tabId, props) => {
      await chrome.tabs.update(tabId, { url: props.url });
    },
    goBack: (tabId) => chrome.tabs.goBack(tabId),
    goForward: (tabId) => chrome.tabs.goForward(tabId),
    reload: (tabId) => chrome.tabs.reload(tabId),
    captureVisibleTab: (windowId) =>
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
  };
}
