import { describe, expect, it } from "vitest";

import { PAGE_ACTIONS } from "../protocol/actions.js";
import { CONSOLE_LEVEL_NAMES } from "../protocol/capture.js";

import { SEND_KEY_NAMES } from "../extension/debugger-ports.js";

import {
  SEND_KEYS_KEY_NAMES,
  TOOL_CATALOG,
  listTools,
} from "./tool-catalog.js";

describe("TOOL_CATALOG", () => {
  it("has exactly one entry per PAGE_ACTIONS name", () => {
    expect(Object.keys(TOOL_CATALOG).sort()).toEqual([...PAGE_ACTIONS].sort());
  });

  it("gives every tool an object input schema with additionalProperties:false and a description", () => {
    for (const action of PAGE_ACTIONS) {
      const entry = TOOL_CATALOG[action];
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.inputSchema.type).toBe("object");
      expect(entry.inputSchema.additionalProperties).toBe(false);
      expect(typeof entry.inputSchema.properties).toBe("object");
    }
  });
});

describe("listTools", () => {
  it("advertises exactly the PAGE_ACTIONS names, in that order, with no umbrella tool", () => {
    const names = listTools().map((t) => t.name);
    expect(names).toEqual([...PAGE_ACTIONS]);
    expect(names).not.toContain("ext_command");
    expect(names).not.toContain("getStorage");
  });

  it("declares the required arguments each action actually needs", () => {
    const required = new Map(
      listTools().map((t) => [t.name, t.inputSchema.required ?? []]),
    );
    expect(required.get("navigateTo")).toEqual(["url"]);
    expect(required.get("findElement")).toEqual(["selector"]);
    expect(required.get("clickElement")).toEqual(["selector"]);
    expect(required.get("typeText")).toEqual(["selector", "text"]);
    expect(required.get("ping")).toEqual([]);
    expect(required.get("captureTab")).toEqual([]);
    expect(required.get("readPage")).toEqual([]);
    expect(required.get("getPageText")).toEqual([]);
    expect(required.get("executeScript")).toEqual(["code"]);
    expect(required.get("evaluatePage")).toEqual(["code"]);
    expect(required.get("navigateBack")).toEqual([]);
    expect(required.get("navigateForward")).toEqual([]);
    expect(required.get("reloadTab")).toEqual([]);
    expect(required.get("clickAt")).toEqual(["x", "y"]);
    expect(required.get("hover")).toEqual(["x", "y"]);
    expect(required.get("getTabState")).toEqual([]);
    expect(required.get("scrollPage")).toEqual([]);
    expect(required.get("waitFor")).toEqual(["mode"]);
    expect(required.get("sendKeys")).toEqual([]);
    expect(required.get("saveImage")).toEqual(["selector", "path"]);
  });

  it("gives captureTab a strict schema with an optional mode enum (viewport|element|full-page) and an optional string elementRef, no required fields", () => {
    const schema = listTools().find(
      (t) => t.name === "captureTab",
    )?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required ?? []).toEqual([]);
    const props = Object.keys(schema?.properties ?? {}).sort();
    expect(props).toEqual(["elementRef", "mode"]);
    const mode = (schema?.properties as Record<string, Record<string, unknown>>)
      .mode;
    expect(mode?.type).toBe("string");
    expect(mode?.enum).toEqual(["viewport", "element", "full-page"]);
    const elementRef = (
      schema?.properties as Record<string, Record<string, unknown>>
    ).elementRef;
    expect(elementRef?.type).toBe("string");
  });

  it("advertises the full-page mode in the captureTab tool schema", () => {
    const schema = listTools().find(
      (t) => t.name === "captureTab",
    )?.inputSchema;
    const mode = (schema?.properties as Record<string, Record<string, unknown>>)
      .mode;
    expect(mode?.enum).toEqual(["viewport", "element", "full-page"]);
    expect(mode?.enum).toContain("full-page");
    expect(String(mode?.description)).toMatch(/full-page/);
  });

  it("keeps maxChars an optional property (not required) on the read actions", () => {
    for (const name of ["readPage", "getPageText"] as const) {
      const schema = listTools().find((t) => t.name === name)?.inputSchema;
      expect(schema?.properties).toHaveProperty("maxChars");
      expect(schema?.required ?? []).not.toContain("maxChars");
    }
  });

  it("gives ping and getTabState an empty properties object", () => {
    for (const name of ["ping", "getTabState"] as const) {
      const schema = listTools().find((t) => t.name === name)?.inputSchema;
      expect(schema?.properties).toEqual({});
      expect(schema?.required).toBeUndefined();
    }
  });

  it("advertises exactly twenty-three tools, ending with sendKeys then saveImage", () => {
    const names = listTools().map((t) => t.name);
    expect(names).toHaveLength(23);
    expect(names.slice(-2)).toEqual(["sendKeys", "saveImage"]);
  });

  it("gives saveImage a strict schema: selector and absolute path required, boolean overwrite optional", () => {
    const schema = listTools().find((t) => t.name === "saveImage")?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["selector", "path"]);
    const props = schema?.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual([
      "overwrite",
      "path",
      "selector",
    ]);
    expect(props.selector?.type).toBe("string");
    expect(props.path?.type).toBe("string");
    expect(String(props.path?.description)).toMatch(/absolute/i);
    expect(props.overwrite?.type).toBe("boolean");
  });

  it("describes every saveImage outcome: the result fields, the 25 MB limit, the overwrite refusal and each failure reason", () => {
    const description =
      listTools().find((t) => t.name === "saveImage")?.description ?? "";
    expect(description).toContain("{ path, bytes, width, height, mimeType }");
    expect(description).toContain("25 MB");
    expect(description).toMatch(/absolute/);
    expect(description).toMatch(/overwrite/);
    for (const reason of [
      "element-not-found",
      "not-image",
      "not-loaded",
      "tainted",
      "unreadable",
      "too-large",
    ]) {
      expect(description).toContain(reason);
    }
  });

  it("gives sendKeys a strict schema whose key enum is exactly the keys the extension can press", () => {
    const schema = listTools().find((t) => t.name === "sendKeys")?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required ?? []).toEqual([]);
    const props = schema?.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual([
      "delayMs",
      "keys",
      "selector",
      "text",
    ]);
    expect((props.keys?.items as { enum: string[] }).enum).toEqual([
      ...SEND_KEY_NAMES,
    ]);
    expect([...SEND_KEYS_KEY_NAMES]).toEqual([...SEND_KEY_NAMES]);
  });

  it("gives waitFor a three-branch oneOf schema that is mode-exclusive and timeout-bounded", () => {
    const schema = listTools().find((t) => t.name === "waitFor")?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["mode"]);
    const props = schema?.properties as Record<string, Record<string, unknown>>;
    expect(props.mode?.enum).toEqual([
      "selector-present",
      "network-idle",
      "fixed-delay",
    ]);
    expect(props.timeoutMs?.minimum).toBe(100);
    expect(props.timeoutMs?.maximum).toBe(25000);
    const oneOf = schema?.oneOf as { required?: string[] }[];
    expect(oneOf).toHaveLength(3);
    expect(oneOf[0]?.required).toEqual(["mode", "selector"]);
    expect(oneOf[1]?.required).toEqual(["mode"]);
    expect(oneOf[2]?.required).toEqual(["mode", "delayMs"]);
  });

  it("gives scrollPage a strict two-optional-property schema with an empty required array", () => {
    const schema = listTools().find(
      (t) => t.name === "scrollPage",
    )?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required ?? []).toEqual([]);
    const props = Object.keys(schema?.properties ?? {}).sort();
    expect(props).toEqual(["amountPx", "toBottom"]);
    const amountPx = (
      schema?.properties as Record<string, Record<string, unknown>>
    ).amountPx;
    expect(amountPx?.type).toBe("number");
    expect(amountPx?.minimum).toBe(0);
    const toBottom = (
      schema?.properties as Record<string, Record<string, unknown>>
    ).toBottom;
    expect(toBottom?.type).toBe("boolean");
  });

  it("gives clickAt / hover strict integer x/y coordinate properties", () => {
    for (const name of ["clickAt", "hover"] as const) {
      const schema = listTools().find((t) => t.name === name)?.inputSchema;
      expect(schema?.type).toBe("object");
      expect(schema?.additionalProperties).toBe(false);
      expect(schema?.required).toEqual(["x", "y"]);
      const props = schema?.properties as Record<
        string,
        Record<string, unknown>
      >;
      for (const axis of ["x", "y"] as const) {
        expect(props[axis]?.type).toBe("integer");
        expect(props[axis]?.minimum).toBe(0);
      }
    }
  });

  it("gives navigateBack / navigateForward / reloadTab a strict no-args schema", () => {
    for (const name of [
      "navigateBack",
      "navigateForward",
      "reloadTab",
    ] as const) {
      const schema = listTools().find((t) => t.name === name)?.inputSchema;
      expect(schema?.type).toBe("object");
      expect(schema?.properties).toEqual({});
      expect(schema?.additionalProperties).toBe(false);
      expect(schema?.required).toBeUndefined();
    }
  });

  it("gives executeScript a required string `code` and a strict schema", () => {
    const schema = listTools().find(
      (t) => t.name === "executeScript",
    )?.inputSchema;
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["code"]);
    const code = (schema?.properties as Record<string, Record<string, unknown>>)
      .code;
    expect(code?.type).toBe("string");
  });
});

describe("readConsoleMessages / readNetworkRequests schemas", () => {
  const tools = ["readConsoleMessages", "readNetworkRequests"] as const;

  it("share one strict, integer-typed since/limit schema with no required array", () => {
    for (const name of tools) {
      const schema = listTools().find((t) => t.name === name)?.inputSchema;
      expect(schema?.additionalProperties).toBe(false);
      expect(schema?.required).toBeUndefined();
      const since = (
        schema?.properties as Record<string, Record<string, unknown>>
      ).since;
      const limit = (
        schema?.properties as Record<string, Record<string, unknown>>
      ).limit;
      expect(since?.type).toBe("integer");
      expect(since?.minimum).toBe(0);
      expect(limit?.type).toBe("integer");
      expect(limit?.minimum).toBe(1);
      expect(String(limit?.description)).toMatch(/100/);
      expect(String(limit?.description)).toMatch(/500/);
    }
  });

  it("both descriptions explain the nextSince cursor and non-destructive reads", () => {
    for (const name of tools) {
      const desc = listTools().find((t) => t.name === name)?.description ?? "";
      expect(desc).toMatch(/nextSince/);
      expect(desc.toLowerCase()).toMatch(/never deletes|not delete|lost when/);
    }
  });

  it("both share the identical since/limit property block byte-for-byte", () => {
    const { levels, ...a } =
      TOOL_CATALOG.readConsoleMessages.inputSchema.properties;
    const b = TOOL_CATALOG.readNetworkRequests.inputSchema.properties;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(levels).toBeDefined();
  });

  it("lets readConsoleMessages filter by every captured console level", () => {
    const levels = (
      TOOL_CATALOG.readConsoleMessages.inputSchema.properties as Record<
        string,
        { type?: string; items?: { enum?: readonly string[] } }
      >
    ).levels;
    expect(levels?.type).toBe("array");
    expect(levels?.items?.enum).toEqual([...CONSOLE_LEVEL_NAMES]);
  });

  it("both descriptions mention the too-large/oversize behavior", () => {
    for (const name of tools) {
      const desc = listTools().find((t) => t.name === name)?.description ?? "";
      expect(desc.toLowerCase()).toMatch(/too-large|too large/);
    }
  });
});
