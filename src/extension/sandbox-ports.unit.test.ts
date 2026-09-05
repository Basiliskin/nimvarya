import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxTabPorts } from "./sandbox-ports.js";
import { chromeSandboxTabPorts } from "./sandbox-ports.js";

/**
 * `chromeSandboxTabPorts` is the production `SandboxTabPorts`; it only touches
 * `chrome.*` inside its returned closures, so a stub `chrome` global is enough
 * to prove it resolves a live stored id, creates a fresh tab on empty storage,
 * recreates on a stale id, and shares one create across overlapping calls.
 */

const SANDBOX_TAB_ID_KEY = "sandboxTabId";

interface StubChrome {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
  tabs: {
    get: (tabId: number) => Promise<{ id?: number }>;
    create: (props: { active?: boolean }) => Promise<{ id?: number }>;
    remove: (tabId: number) => Promise<void>;
  };
}

interface StubControls {
  storage: Map<string, unknown>;
  setSpy: ReturnType<typeof vi.fn>;
  removeSpy: ReturnType<typeof vi.fn>;
  tabsGetSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  tabsRemoveSpy: ReturnType<typeof vi.fn>;
}

function installStubChrome(): StubControls {
  const storage = new Map<string, unknown>();
  const setSpy = vi.fn((items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) storage.set(key, value);
    return Promise.resolve();
  });
  const getSpy = vi.fn((key: string) => {
    return Promise.resolve({ [key]: storage.get(key) });
  });
  const removeSpy = vi.fn((key: string) => {
    storage.delete(key);
    return Promise.resolve();
  });
  // Default: any stored id is live, and a create yields a fresh unused id.
  const tabsGetSpy = vi.fn((tabId: number) => Promise.resolve({ id: tabId }));
  let nextId = 1000;
  const createSpy = vi.fn(() => Promise.resolve({ id: nextId++ }));
  // Default: remove resolves, so a stored id is a live tab that closes cleanly.
  const tabsRemoveSpy = vi.fn((_tabId: number) => Promise.resolve());
  const stub: StubChrome = {
    storage: { local: { get: getSpy, set: setSpy, remove: removeSpy } },
    tabs: { get: tabsGetSpy, create: createSpy, remove: tabsRemoveSpy },
  };
  vi.stubGlobal("chrome", stub);
  return {
    storage,
    setSpy,
    removeSpy,
    tabsGetSpy,
    createSpy,
    tabsRemoveSpy,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chromeSandboxTabPorts", () => {
  it("reuses a stored live tab id without creating a new tab", async () => {
    const { storage, createSpy, tabsGetSpy } = installStubChrome();
    storage.set(SANDBOX_TAB_ID_KEY, 7);
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const first = await ports.resolveTabId();
    const second = await ports.resolveTabId();

    expect(first).toBe(7);
    expect(second).toBe(7);
    expect(typeof first).toBe("number");
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(createSpy).not.toHaveBeenCalled();
    // The id handed back is exactly the one validated via chrome.tabs.get.
    expect(tabsGetSpy).toHaveBeenCalledWith(7);
  });

  it("creates one background tab and persists its id when storage is empty", async () => {
    const { storage, createSpy, setSpy } = installStubChrome();
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const id = await ports.resolveTabId();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({ active: false });
    // The persisted value is a bare number under the same key the resolver reads.
    expect(storage.get(SANDBOX_TAB_ID_KEY)).toBe(id);
    expect(setSpy).toHaveBeenCalledWith({ [SANDBOX_TAB_ID_KEY]: id });
    expect(typeof id).toBe("number");
  });

  it("recreates a background tab and persists its id when the stored id is dead", async () => {
    const { storage, createSpy, setSpy, tabsGetSpy } = installStubChrome();
    storage.set(SANDBOX_TAB_ID_KEY, 99);
    tabsGetSpy.mockRejectedValue(new Error("No tab with id: 99."));
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const id = await ports.resolveTabId();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({ active: false });
    expect(id).not.toBe(99);
    expect(storage.get(SANDBOX_TAB_ID_KEY)).toBe(id);
    expect(setSpy).toHaveBeenCalledWith({ [SANDBOX_TAB_ID_KEY]: id });
    expect(typeof id).toBe("number");
  });

  it("recreates when chrome.tabs.get resolves a different tab than the stored id", async () => {
    const { storage, createSpy, setSpy, tabsGetSpy } = installStubChrome();
    storage.set(SANDBOX_TAB_ID_KEY, 99);
    // get resolves, but to a tab whose id was reused, so 99 is no longer live.
    tabsGetSpy.mockResolvedValue({ id: 100 });
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const id = await ports.resolveTabId();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({ active: false });
    expect(id).not.toBe(99);
    expect(storage.get(SANDBOX_TAB_ID_KEY)).toBe(id);
    expect(setSpy).toHaveBeenCalledWith({ [SANDBOX_TAB_ID_KEY]: id });
  });

  it("treats a non-number stored id as absent and creates a fresh tab", async () => {
    const { storage, createSpy, setSpy } = installStubChrome();
    storage.set(SANDBOX_TAB_ID_KEY, "not-a-number");
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const id = await ports.resolveTabId();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({ active: false });
    expect(storage.get(SANDBOX_TAB_ID_KEY)).toBe(id);
    expect(setSpy).toHaveBeenCalled();
    expect(typeof id).toBe("number");
  });

  it("shares one create across overlapping calls, spawning a single tab", async () => {
    const { storage, createSpy } = installStubChrome();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    createSpy.mockReturnValue(gate.then(() => ({ id: 42 })));
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const first = ports.resolveTabId();
    const second = ports.resolveTabId();
    release?.();
    const [id1, id2] = await Promise.all([first, second]);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(id1).toBe(42);
    expect(id2).toBe(42);
    expect(storage.get(SANDBOX_TAB_ID_KEY)).toBe(42);
  });

  it("closes the stored tab, clears its persisted id, and reports closed+hadTab", async () => {
    const { storage, removeSpy, tabsRemoveSpy } = installStubChrome();
    storage.set(SANDBOX_TAB_ID_KEY, 7);
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const result = await ports.closeSandboxTab();

    expect(result).toEqual({ closed: true, hadTab: true });
    expect(tabsRemoveSpy).toHaveBeenCalledTimes(1);
    expect(tabsRemoveSpy).toHaveBeenCalledWith(7);
    expect(removeSpy).toHaveBeenCalledWith(SANDBOX_TAB_ID_KEY);
    // The persisted id is gone, so the next resolveTabId lazily recreates.
    expect(storage.get(SANDBOX_TAB_ID_KEY)).toBeUndefined();
  });

  it("is a no-op when no tab is stored, never calling chrome.tabs.remove", async () => {
    const { tabsRemoveSpy, removeSpy } = installStubChrome();
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const result = await ports.closeSandboxTab();

    // A non-number / absent stored id is treated as absent by readStoredTabId,
    // so an empty storage map exercises the no-op branch directly.
    expect(result).toEqual({ closed: false, hadTab: false });
    expect(tabsRemoveSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("treats a stale/already-closed tab id as a no-op rather than throwing", async () => {
    const { storage, tabsRemoveSpy, removeSpy } = installStubChrome();
    storage.set(SANDBOX_TAB_ID_KEY, 99);
    // A manually-closed tab rejects on remove; the port catches it and clears.
    tabsRemoveSpy.mockRejectedValue(new Error("No tab with id: 99."));
    const ports: SandboxTabPorts = chromeSandboxTabPorts();

    const result = await ports.closeSandboxTab();

    expect(result).toEqual({ closed: false, hadTab: false });
    expect(tabsRemoveSpy).toHaveBeenCalledWith(99);
    expect(removeSpy).toHaveBeenCalledWith(SANDBOX_TAB_ID_KEY);
    expect(storage.get(SANDBOX_TAB_ID_KEY)).toBeUndefined();
  });
});
