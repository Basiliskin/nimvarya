import { describe, expect, it } from "vitest";

import {
  isBridgeMessage,
  isCommand,
  isCommandResponse,
  isHelloMessage,
  isObservation,
} from "./guards.js";

describe("isHelloMessage", () => {
  it("accepts extension and controller hellos, rejects other roles", () => {
    expect(isHelloMessage({ kind: "hello", role: "extension" })).toBe(true);
    expect(isHelloMessage({ kind: "hello", role: "controller" })).toBe(true);
    expect(isHelloMessage({ kind: "hello", role: "operator" })).toBe(false);
    expect(isHelloMessage({ kind: "hi", role: "extension" })).toBe(false);
    expect(isHelloMessage(null)).toBe(false);
  });
});

describe("isCommand", () => {
  it("requires a string id, a known action, and an object params", () => {
    expect(
      isCommand({
        kind: "command",
        id: "a",
        action: "getPageText",
        params: {},
      }),
    ).toBe(true);
    expect(
      isCommand({ kind: "command", id: 1, action: "getPageText", params: {} }),
    ).toBe(false);
    expect(
      isCommand({ kind: "command", id: "a", action: "frobnicate", params: {} }),
    ).toBe(false);
    expect(
      isCommand({
        kind: "command",
        id: "a",
        action: "getPageText",
        params: null,
      }),
    ).toBe(false);
  });
});

describe("isCommandResponse", () => {
  it("accepts exactly-one of result / error and rejects both or neither", () => {
    expect(
      isCommandResponse({ kind: "command-response", id: "a", result: 1 }),
    ).toBe(true);
    expect(
      isCommandResponse({ kind: "command-response", id: "a", error: "boom" }),
    ).toBe(true);
    expect(isCommandResponse({ kind: "command-response", id: "a" })).toBe(
      false,
    );
    expect(
      isCommandResponse({
        kind: "command-response",
        id: "a",
        result: 1,
        error: "boom",
      }),
    ).toBe(false);
    expect(
      isCommandResponse({ kind: "command-response", id: 1, result: 1 }),
    ).toBe(false);
  });
});

describe("isObservation", () => {
  it("requires a known observationType and numeric tabId / timestamp", () => {
    expect(
      isObservation({
        kind: "observation",
        observationType: "console",
        tabId: 3,
        timestamp: 1,
        payload: {},
      }),
    ).toBe(true);
    expect(
      isObservation({
        kind: "observation",
        observationType: "sniff",
        tabId: 3,
        timestamp: 1,
        payload: {},
      }),
    ).toBe(false);
  });
});

describe("isBridgeMessage", () => {
  it("accepts any of the four frame kinds and rejects unknown / malformed", () => {
    expect(isBridgeMessage({ kind: "hello", role: "extension" })).toBe(true);
    expect(
      isBridgeMessage({ kind: "command", id: "a", action: "ping", params: {} }),
    ).toBe(true);
    expect(isBridgeMessage({ kind: "telemetry", id: "a", data: {} })).toBe(
      false,
    );
    expect(isBridgeMessage("not json")).toBe(false);
    expect(isBridgeMessage({ kind: "command" })).toBe(false);
  });
});
