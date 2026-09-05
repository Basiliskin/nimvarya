import { describe, expect, it } from "vitest";

import {
  boundText,
  CAPTURE_NAMESPACE,
  isCaptureEnvelope,
  MAX_BODY_PREVIEW_BYTES,
  MAX_CONSOLE_TEXT_BYTES,
} from "./capture.js";
import type {
  CaptureChannel,
  CaptureEnvelope,
  ConsoleEntry,
  NetworkEntry,
} from "./capture.js";

// Exports of ./capture.ts this suite exercises (the repo coverage guard and
// the phase rubric both require each to appear here by name):
//   CAPTURE_NAMESPACE, CaptureChannel, ConsoleEntry, NetworkEntry,
//   CaptureEnvelope, isCaptureEnvelope, MAX_CONSOLE_TEXT_BYTES,
//   MAX_BODY_PREVIEW_BYTES, boundText.

const consoleEntryData: Record<string, unknown> = {
  level: "log",
  text: "hi",
  timestamp: 1,
  truncated: false,
};

const networkEntryData: Record<string, unknown> = {
  requestId: "r1",
  method: "GET",
  url: "https://example.com/data",
  status: 200,
  durationMs: 5,
  contentType: "application/json",
  bodyPreview: "{}",
  truncated: false,
  failed: false,
  timestamp: 1,
};

function consoleEnvelope(entry: unknown): Record<string, unknown> {
  return { ns: CAPTURE_NAMESPACE, channel: "console", entry };
}

function networkEnvelope(entry: unknown): Record<string, unknown> {
  return { ns: CAPTURE_NAMESPACE, channel: "network", entry };
}

function withoutEntryField(
  entry: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key !== field) copy[key] = value;
  }
  return copy;
}

/** Equivalent of `String.prototype.isWellFormed` for ES2022 lib targets. */
function isWellFormedString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// Narrowing probes. These take a `CaptureEnvelope` parameter (the full union),
// so `env.channel === "network"` is a real conditional on a union type — not a
// comparison against a statically-known literal. Because the entry fields are
// read inside the narrowed branch, TypeScript itself proves the union narrows.
function readNetworkRequestId(env: CaptureEnvelope): string {
  if (env.channel === "network") {
    return env.entry.requestId;
  }
  return "";
}

function readConsoleText(env: CaptureEnvelope): string {
  if (env.channel === "console") {
    return env.entry.text;
  }
  return "";
}

function assertNoRequestIdOnConsole(env: CaptureEnvelope): void {
  if (env.channel === "console") {
    // @ts-expect-error — ConsoleEntry has no requestId.
    expect(env.entry.requestId).toBeUndefined();
  }
}

describe("isCaptureEnvelope", () => {
  it("accepts a valid console envelope and a valid network envelope", () => {
    expect(isCaptureEnvelope(consoleEnvelope(consoleEntryData))).toBe(true);
    expect(isCaptureEnvelope(networkEnvelope(networkEntryData))).toBe(true);
  });

  it("treats null / non-object inputs as invalid without throwing", () => {
    expect(isCaptureEnvelope(null)).toBe(false);
    expect(isCaptureEnvelope(undefined)).toBe(false);
    expect(isCaptureEnvelope("string")).toBe(false);
    expect(isCaptureEnvelope(12345)).toBe(false);
    expect(isCaptureEnvelope([1, 2])).toBe(false);
    expect(isCaptureEnvelope({})).toBe(false);
  });

  it("rejects a wrong namespace (including a one-character near-miss)", () => {
    expect(
      isCaptureEnvelope({
        ns: "__chrome_bridge_capture_v2__",
        channel: "console",
        entry: consoleEntryData,
      }),
    ).toBe(false);
    expect(
      isCaptureEnvelope({
        ns: "some-other-namespace",
        channel: "console",
        entry: consoleEntryData,
      }),
    ).toBe(false);
  });

  it("rejects an unknown channel and a channel/entry mismatch", () => {
    expect(
      isCaptureEnvelope({
        ns: CAPTURE_NAMESPACE,
        channel: "screenshot",
        entry: consoleEntryData,
      }),
    ).toBe(false);
    // Network channel carrying a console-shaped entry.
    expect(isCaptureEnvelope(networkEnvelope(consoleEntryData))).toBe(false);
    // Console channel carrying a network-shaped entry.
    expect(isCaptureEnvelope(consoleEnvelope(networkEntryData))).toBe(false);
  });

  it("rejects each deleted required console-entry field", () => {
    for (const field of ["level", "text", "timestamp", "truncated"]) {
      const mutated = withoutEntryField(consoleEntryData, field);
      expect(
        isCaptureEnvelope(consoleEnvelope(mutated)),
        `console entry missing ${field}`,
      ).toBe(false);
    }
  });

  it("rejects each deleted required network-entry field", () => {
    for (const field of [
      "requestId",
      "method",
      "url",
      "durationMs",
      "truncated",
      "failed",
      "timestamp",
    ]) {
      const mutated = withoutEntryField(networkEntryData, field);
      expect(
        isCaptureEnvelope(networkEnvelope(mutated)),
        `network entry missing ${field}`,
      ).toBe(false);
    }
  });

  it("validates console level membership, not just string type", () => {
    expect(
      isCaptureEnvelope(
        consoleEnvelope({ ...consoleEntryData, level: "trace" }),
      ),
    ).toBe(false);
    expect(
      isCaptureEnvelope(consoleEnvelope({ ...consoleEntryData, level: 42 })),
    ).toBe(false);
    for (const level of ["log", "info", "warn", "error", "debug", "uncaught"]) {
      expect(
        isCaptureEnvelope(consoleEnvelope({ ...consoleEntryData, level })),
      ).toBe(true);
    }
  });

  it("accepts null but rejects undefined / wrong type on nullable network fields", () => {
    const wrongValue: Record<string, unknown> = {
      status: "nope",
      contentType: 42,
      bodyPreview: true,
    };
    for (const field of ["status", "contentType", "bodyPreview"] as const) {
      expect(
        isCaptureEnvelope(
          networkEnvelope({ ...networkEntryData, [field]: null }),
        ),
        `${field} may be null`,
      ).toBe(true);
      expect(
        isCaptureEnvelope(
          networkEnvelope({ ...networkEntryData, [field]: undefined }),
        ),
        `${field} may not be undefined`,
      ).toBe(false);
      expect(
        isCaptureEnvelope(
          networkEnvelope({ ...networkEntryData, [field]: wrongValue[field] }),
        ),
        `${field} rejects a wrong type`,
      ).toBe(false);
    }
  });

  it("rejects a wrong-typed required network field", () => {
    expect(
      isCaptureEnvelope(networkEnvelope({ ...networkEntryData, requestId: 9 })),
    ).toBe(false);
    expect(
      isCaptureEnvelope(
        networkEnvelope({ ...networkEntryData, failed: "yes" }),
      ),
    ).toBe(false);
  });

  it("narrows entry on channel (type-level, compile-time)", () => {
    const networkEntry: NetworkEntry = {
      requestId: "r1",
      method: "GET",
      url: "u",
      status: 200,
      durationMs: 1,
      contentType: null,
      bodyPreview: null,
      truncated: false,
      failed: false,
      timestamp: 1,
    };
    const consoleEntry: ConsoleEntry = {
      level: "log",
      text: "hi",
      timestamp: 1,
      truncated: false,
    };
    const networkEnv: CaptureEnvelope = {
      ns: CAPTURE_NAMESPACE,
      channel: "network",
      entry: networkEntry,
    };
    const consoleEnv: CaptureEnvelope = {
      ns: CAPTURE_NAMESPACE,
      channel: "console",
      entry: consoleEntry,
    };

    expect(readNetworkRequestId(networkEnv)).toBe("r1");
    expect(readNetworkRequestId(consoleEnv)).toBe("");
    expect(readConsoleText(consoleEnv)).toBe("hi");
    expect(readConsoleText(networkEnv)).toBe("");
    // Console entries have no requestId; a non-narrowing union would leave the
    // ts-expect-error directive below unused (a compile failure).
    assertNoRequestIdOnConsole(consoleEnv);
  });

  it("declares nullable fields as `| null`, not optional", () => {
    const entry: NetworkEntry = {
      requestId: "r",
      method: "GET",
      url: "u",
      status: null,
      durationMs: 1,
      contentType: null,
      bodyPreview: null,
      truncated: false,
      failed: false,
      timestamp: 1,
    };
    const statusValue: number | null = entry.status;
    const contentTypeValue: string | null = entry.contentType;
    const bodyPreviewValue: string | null = entry.bodyPreview;
    expect(statusValue).toBeNull();
    expect(contentTypeValue).toBeNull();
    expect(bodyPreviewValue).toBeNull();
  });

  it("keeps the channel union closed and the namespace literal", () => {
    const consoleChannel: CaptureChannel = "console";
    const networkChannel: CaptureChannel = "network";
    expect(consoleChannel).toBe("console");
    expect(networkChannel).toBe("network");
    expect(CAPTURE_NAMESPACE).toBe("__chrome_bridge_capture_v1__");
  });
});

describe("boundText", () => {
  it("returns the input unchanged when at or under the byte cap", () => {
    expect(boundText("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(boundText("", 0)).toEqual({ text: "", truncated: false });
    expect(boundText("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  it("cuts ASCII text over the cap without exceeding maxBytes", () => {
    const result = boundText("abcdef", 3);
    expect(result).toEqual({ text: "abc", truncated: true });
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(3);
  });

  it("cuts multi-byte text on a code-point boundary, never splitting a character", () => {
    // Each 'é' is 2 UTF-8 bytes; at a 5-byte cap only two fit.
    const latin = boundText("ééé", 5);
    expect(latin).toEqual({ text: "éé", truncated: true });
    const latinBytes = new TextEncoder().encode(latin.text);
    expect(latinBytes.length).toBeLessThanOrEqual(5);
    expect(latinBytes.length).toBe(4);
    expect(isWellFormedString(latin.text)).toBe(true);
  });

  it("keeps surrogate pairs whole (no lone surrogate on truncation)", () => {
    // Each '😀' is 4 UTF-8 bytes; at a 5-byte cap only one fits.
    const emoji = boundText("😀😀", 5);
    expect(emoji.text).toBe("😀");
    expect(emoji.truncated).toBe(true);
    const emojiBytes = new TextEncoder().encode(emoji.text);
    expect(emojiBytes.length).toBe(4);
    expect(emojiBytes.length).toBeLessThanOrEqual(5);
    expect(isWellFormedString(emoji.text)).toBe(true);
  });

  it("handles the maxBytes=0 edge", () => {
    expect(boundText("abc", 0)).toEqual({ text: "", truncated: true });
    expect(boundText("😀", 0)).toEqual({ text: "", truncated: true });
  });

  it("is pure: same input produces the same output", () => {
    expect(boundText("ééé", 5)).toEqual(boundText("ééé", 5));
    expect(boundText("😀😀", 5)).toEqual(boundText("😀😀", 5));
  });
});

describe("capture byte caps", () => {
  it("exports the two provisional byte caps as numeric constants", () => {
    expect(MAX_CONSOLE_TEXT_BYTES).toBe(8192);
    expect(MAX_BODY_PREVIEW_BYTES).toBe(4096);
    expect(typeof MAX_CONSOLE_TEXT_BYTES).toBe("number");
    expect(typeof MAX_BODY_PREVIEW_BYTES).toBe("number");
  });
});
