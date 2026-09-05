import { describe, expect, it } from "vitest";

import { DEFAULT_RELAY_PORT, main, resolveRelayPort } from "./main.js";

describe("resolveRelayPort", () => {
  it("returns the default when the env var is unset or empty", () => {
    expect(resolveRelayPort(undefined)).toBe(DEFAULT_RELAY_PORT);
    expect(resolveRelayPort("")).toBe(DEFAULT_RELAY_PORT);
    expect(DEFAULT_RELAY_PORT).toBe(8766);
  });

  it("parses a valid port override", () => {
    expect(resolveRelayPort("8799")).toBe(8799);
    expect(resolveRelayPort("1")).toBe(1);
    expect(resolveRelayPort("65535")).toBe(65535);
  });

  it("throws with a message naming the variable on a non-numeric or out-of-range value", () => {
    for (const bad of ["abc", "80.5", "0", "-1", "70000", "NaN"]) {
      expect(() => resolveRelayPort(bad)).toThrow(/CHROME_BRIDGE_PORT/);
    }
  });

  it("exposes main as an async entrypoint", () => {
    expect(typeof main).toBe("function");
  });
});
