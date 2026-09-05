import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChromePorts, TabIdentityWithWindow } from "./ports.js";
import { chromeCommandPorts } from "./ports.js";

/**
 * `chromeCommandPorts` is the production `ChromePorts`; it only touches
 * `chrome.*` inside its returned closures, so a stub `chrome` global is enough
 * to prove the tab-identity reads: `readTab` maps a resolved tab to its id/url/
 * title triple (with empty-string fallbacks), rejects out of `chrome.tabs.get`,
 * and `activeTabOfWindow` scopes strictly to the passed `windowId` and returns
 * `undefined` when that window has no active tab.
 */

interface StubTab {
  id?: number;
  windowId: number;
  url?: string;
  title?: string;
}

type TabsGet = (tabId: number) => Promise<StubTab>;
type TabsQuery = (info: {
  active: boolean;
  windowId: number;
}) => Promise<StubTab[]>;

interface StubChrome {
  tabs: {
    get: TabsGet;
    query: TabsQuery;
  };
}

interface StubControls {
  tabsGetSpy: ReturnType<typeof vi.fn>;
  tabsQuerySpy: ReturnType<typeof vi.fn>;
}

function installStubChrome(): StubControls {
  const tabsGetSpy = vi.fn((tabId: number) =>
    Promise.resolve({ id: tabId, windowId: 1 }),
  );
  const tabsQuerySpy = vi.fn((_info: { active: boolean; windowId: number }) =>
    Promise.resolve([]),
  );
  const stub: StubChrome = {
    tabs: { get: tabsGetSpy, query: tabsQuerySpy },
  };
  vi.stubGlobal("chrome", stub);
  return { tabsGetSpy, tabsQuerySpy };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chromeCommandPorts", () => {
  it("maps a resolved tab to its identity triple with the id it was queried for", async () => {
    const { tabsGetSpy } = installStubChrome();
    tabsGetSpy.mockResolvedValue({
      id: 5,
      windowId: 7,
      url: "https://example.com",
      title: "Example",
    });
    const ports: ChromePorts = chromeCommandPorts();

    const identity = await ports.readTab(5);

    expect(identity).toEqual({
      id: 5,
      windowId: 7,
      url: "https://example.com",
      title: "Example",
    });
    expect(tabsGetSpy).toHaveBeenCalledWith(5);
  });

  it("defaults url and title to empty strings when the tab has none", async () => {
    const { tabsGetSpy } = installStubChrome();
    // A still-loading or restricted tab has no url/title set.
    tabsGetSpy.mockResolvedValue({ id: 3, windowId: 9 });
    const ports: ChromePorts = chromeCommandPorts();

    const identity: TabIdentityWithWindow = await ports.readTab(3);

    expect(identity).toEqual({ id: 3, windowId: 9, url: "", title: "" });
  });

  it("propagates a rejection from chrome.tabs.get for a closed or restricted tab", async () => {
    const { tabsGetSpy } = installStubChrome();
    tabsGetSpy.mockRejectedValue(new Error("No tab with id: 99."));
    const ports: ChromePorts = chromeCommandPorts();

    await expect(ports.readTab(99)).rejects.toThrow("No tab with id: 99.");
  });

  it("queries the passed window and returns the active tab's identity", async () => {
    const { tabsQuerySpy } = installStubChrome();
    tabsQuerySpy.mockResolvedValue([
      { id: 4, windowId: 11, url: "https://example.com", title: "Example" },
    ]);
    const ports: ChromePorts = chromeCommandPorts();

    const identity = await ports.activeTabOfWindow(11);

    expect(identity).toEqual({
      id: 4,
      windowId: 11,
      url: "https://example.com",
      title: "Example",
    });
    expect(tabsQuerySpy).toHaveBeenCalledWith({ active: true, windowId: 11 });
  });

  it("returns undefined when the given window has no active tab", async () => {
    const { tabsQuerySpy } = installStubChrome();
    tabsQuerySpy.mockResolvedValue([]);
    const ports: ChromePorts = chromeCommandPorts();

    await expect(ports.activeTabOfWindow(11)).resolves.toBeUndefined();
    expect(tabsQuerySpy).toHaveBeenCalledWith({ active: true, windowId: 11 });
  });
});
