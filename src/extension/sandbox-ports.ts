/**
 * `SandboxTabPorts` — the slice of the `chrome.*` API that owns the one
 * dedicated sandbox tab the MCP drives, plus its real implementation.
 *
 * Why a third port interface next to `ChromePorts` and `CapturePorts`:
 *
 *   `ChromePorts` (ports.ts) models the tab/scripting calls the handlers make
 *   outward and `CapturePorts` (capture-ports.ts) models the intake direction.
 *   Sandbox-tab lifecycle is a third concern: the MCP wants every page action
 *   to target ONE auto-created, reused tab — not whatever is focused. Owning
 *   that tab (create it once, remember its id, recreate it when it dies) calls
 *   `chrome.tabs.create`/`chrome.tabs.get`/`chrome.tabs.remove` and
 *   `chrome.storage.local`, none of which the other two ports expose.
 *
 * `chromeSandboxTabPorts` is covered by a co-located unit test that stubs the
 * `chrome` global, and it is wired into `startServiceWorker` in a later phase.
 * No `chrome.*` access happens at module load — every reference is inside
 * `chromeSandboxTabPorts`.
 */

/// <reference types="chrome" />

import type { CloseSandboxTabResult } from "../protocol/types.js";

/** The key under which the sandbox tab's id is persisted in `chrome.storage.local`. */
const SANDBOX_TAB_ID_KEY = "sandboxTabId";

/**
 * The page the sandbox tab opens on. A dedicated extension page rather than a
 * blank New Tab, so a user glancing at the tab strip can tell the bridge's tab
 * apart from a tab they opened themselves.
 */
export const SANDBOX_PAGE = "sandbox.html";

/**
 * Thrown by `requireTabId` when no live sandbox tab exists. Page actions that
 * only read or act on an existing page must NOT silently spawn a tab: a user
 * who closed the bridge's tab (or restarted Chrome) would otherwise see tabs
 * reappear "by themselves" on the next action from any connected session.
 */
export class SandboxTabClosedError extends Error {
  constructor() {
    super(
      "sandbox tab is not open — call navigateTo(url) first to open the bridge's tab",
    );
    this.name = "SandboxTabClosedError";
  }
}

export interface SandboxTabPorts {
  /**
   * The id of the one dedicated sandbox tab, creating (or recreating) it when
   * it is missing or stale. Resolves to a positive tab id; throws when the tab
   * cannot be created (e.g. the extension lacks the `tabs` permission).
   * Only `navigateTo` may use this — it is the single action allowed to open
   * the tab. Every other action goes through `requireTabId`.
   */
  resolveTabId(): Promise<number>;

  /**
   * The id of the live sandbox tab, or a `SandboxTabClosedError` rejection when
   * none exists. Never creates a tab.
   */
  requireTabId(): Promise<number>;

  /**
   * The id of the already-persisted sandbox tab, or `undefined` when none has
   * been stored yet. Purely a read of `chrome.storage.local`: it never creates,
   * focuses, reloads, moves, or otherwise mutates a tab, so a report can tell
   * whether a sandbox tab exists without side effects.
   */
  peekStoredSandboxTabId(): Promise<number | undefined>;

  /**
   * Close the current sandbox tab (if one exists) and clear its persisted id,
   * so the next `resolveTabId` lazily recreates a fresh tab via its existing
   * fallback path. Never throws, and is no-op-safe: `{ closed: false,
   * hadTab: false }` when there is no stored tab, when the stored id points to
   * an already-closed tab (`chrome.tabs.remove` rejects), and on a second call
   * after a successful close. Returns `{ closed: true, hadTab: true }` when a
   * live tab was closed. Capture-buffer eviction for the closed tab is not this
   * method's job — the generic `onTabRemoved` listener handles that.
   */
  closeSandboxTab(): Promise<CloseSandboxTabResult>;
}

/** The production `SandboxTabPorts`, backed by the MV3 extension APIs. */
export function chromeSandboxTabPorts(): SandboxTabPorts {
  // A single promise for any in-flight create, shared by concurrent callers so
  // two near-simultaneous `resolveTabId` calls never both spawn a tab. Cleared
  // when it settles so a later, separate call can create again if it must.
  let inflightCreate: Promise<number> | undefined;

  async function resolveTabId(): Promise<number> {
    const storedId = await readStoredTabId();
    if (storedId !== undefined && (await isLiveTab(storedId))) {
      return storedId;
    }
    if (inflightCreate === undefined) {
      inflightCreate = createSandboxTab();
      // Reset the slot when this create settles, leaving no dangling promise.
      // Attach a rejection handler so the reset itself never becomes an
      // unhandled rejection; the caller still observes the real outcome.
      void inflightCreate.then(
        () => {
          inflightCreate = undefined;
        },
        () => {
          inflightCreate = undefined;
        },
      );
    }
    return inflightCreate;
  }

  async function requireTabId(): Promise<number> {
    const storedId = await readStoredTabId();
    if (storedId !== undefined && (await isLiveTab(storedId))) {
      return storedId;
    }
    throw new SandboxTabClosedError();
  }

  async function peekStoredSandboxTabId(): Promise<number | undefined> {
    return readStoredTabId();
  }

  async function closeSandboxTab(): Promise<CloseSandboxTabResult> {
    const storedId = await readStoredTabId();
    if (storedId === undefined) {
      return { closed: false, hadTab: false };
    }
    try {
      await chrome.tabs.remove(storedId);
    } catch {
      // A stale/manually-closed id rejects; the tab is gone either way. Clear
      // the stale id and report a no-op rather than surfacing a throw.
      await clearStoredTabId();
      return { closed: false, hadTab: false };
    }
    await clearStoredTabId();
    return { closed: true, hadTab: true };
  }

  return {
    resolveTabId,
    requireTabId,
    peekStoredSandboxTabId,
    closeSandboxTab,
  };
}

async function readStoredTabId(): Promise<number | undefined> {
  const stored: Record<string, unknown> =
    await chrome.storage.local.get(SANDBOX_TAB_ID_KEY);
  const value: unknown = stored[SANDBOX_TAB_ID_KEY];
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

async function isLiveTab(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    // A get that resolves to a different id than we asked for is a stale id
    // that has been reused; treat it as not-live so we recreate.
    return tab.id === tabId;
  } catch {
    return false;
  }
}

async function clearStoredTabId(): Promise<void> {
  try {
    await chrome.storage.local.remove(SANDBOX_TAB_ID_KEY);
  } catch {
    // Best-effort: a storage failure never turns a close into a throw. The next
    // `resolveTabId` re-checks liveness and lazily recreates if the id persists.
  }
}

async function createSandboxTab(): Promise<number> {
  // `active: false` is explicit and load-bearing: the sandbox tab must never
  // steal the user's focus, and the default for `active` is true.
  const tab = await chrome.tabs.create({
    active: false,
    url: chrome.runtime.getURL(SANDBOX_PAGE),
  });
  const id = tab.id;
  if (id === undefined) {
    throw new Error("chrome.tabs.create returned a tab with no id");
  }
  await chrome.storage.local.set({ [SANDBOX_TAB_ID_KEY]: id });
  return id;
}
