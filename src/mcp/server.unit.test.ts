import { describe, expect, it, vi } from "vitest";

import type { CommandResponse } from "../protocol/types.js";

import { MCP_SERVER_NAME, createMcpServer, handleToolCall } from "./server.js";
import type { CommandSender, McpServerDeps } from "./server.js";
import type { ImageWriteOutcome, ImageWriter } from "./image-writer.js";

function ok(result: unknown): CommandResponse {
  return { kind: "command-response", id: "test-id", result };
}

function fail(error: string): CommandResponse {
  return { kind: "command-response", id: "test-id", error };
}

function fakeDeps(
  sendCommand: CommandSender["sendCommand"],
  writeOutcome?: ImageWriteOutcome,
): {
  deps: McpServerDeps;
  spy: ReturnType<typeof vi.fn>;
  writer: ReturnType<typeof vi.fn<ImageWriter>>;
} {
  const spy = vi.fn(sendCommand);
  const client: CommandSender = { sendCommand: spy };
  const writer = vi.fn<ImageWriter>((_path, bytes) =>
    Promise.resolve(writeOutcome ?? { written: true, bytes: bytes.length }),
  );
  return { deps: { client, imageWriter: writer }, spy, writer };
}

function textOf(res: { content: unknown[] }): string {
  return (res.content[0] as { text: string }).text;
}

describe("handleToolCall", () => {
  it("maps a text/JSON result to a single text content block with no error flag", async () => {
    const { deps, spy } = fakeDeps(() =>
      Promise.resolve(
        ok({ text: "hello world", totalChars: 11, truncated: false }),
      ),
    );

    const res = await handleToolCall(deps, "getPageText", {});

    expect(spy).toHaveBeenCalledWith("getPageText", {});
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect((res.content[0] as { text: string }).text).toContain("hello world");
  });

  it("maps a captured:true captureTab result to an image block PLUS a width/height/clipped/appliedScale/attempts metadata text block", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({
          captured: true,
          dataUrl: "data:image/png;base64,AAAA",
          width: 1,
          height: 1,
          clipped: false,
          appliedScale: 1,
          attempts: 1,
        }),
      ),
    );

    const res = await handleToolCall(deps, "captureTab", {});

    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(2);
    expect(res.content[0]).toEqual({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
    });
    expect(res.content[1]).toMatchObject({ type: "text" });
    expect(JSON.parse((res.content[1] as { text: string }).text)).toEqual({
      captured: true,
      width: 1,
      height: 1,
      clipped: false,
      appliedScale: 1,
      attempts: 1,
    });
  });

  it("omits appliedScale/attempts from the metadata when a hand-built result lacks them", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({
          captured: true,
          dataUrl: "data:image/png;base64,AAAA",
          width: 1,
          height: 1,
          clipped: false,
        }),
      ),
    );

    const res = await handleToolCall(deps, "captureTab", {});

    expect(res.content[1]).toMatchObject({ type: "text" });
    expect(JSON.parse((res.content[1] as { text: string }).text)).toEqual({
      captured: true,
      width: 1,
      height: 1,
      clipped: false,
    });
  });

  it("leaves an already-bare base64 screenshot untouched (not double-decoded)", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({
          captured: true,
          dataUrl: "BBBB",
          width: 1,
          height: 1,
          clipped: false,
        }),
      ),
    );
    const res = await handleToolCall(deps, "captureTab", {});
    expect(res.content).toHaveLength(2);
    expect(res.content[0]).toEqual({
      type: "image",
      data: "BBBB",
      mimeType: "image/png",
    });
    expect(res.content[1]).toMatchObject({ type: "text" });
  });

  it("routes a give-up too-large captureTab outcome to a text block with isError set, carrying size/limit/floor/attempts", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({
          captured: false,
          reason: "too-large",
          size: 1_240_000,
          limit: 1_200_000,
          floor: 0.33,
          attempts: 4,
        }),
      ),
    );

    const res = await handleToolCall(deps, "captureTab", {});

    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("too-large");
    expect(text).toContain("1240000");
    expect(text).toContain("1200000");
    expect(text).toContain("0.33");
    expect(text).toContain("4");
  });

  it("routes element-not-found and zero-area captureTab outcomes to text/error blocks, never the image path", async () => {
    for (const reason of ["element-not-found", "zero-area"] as const) {
      const { deps } = fakeDeps(() =>
        Promise.resolve(ok({ captured: false, reason })),
      );
      const res = await handleToolCall(deps, "captureTab", {});
      expect(res.isError).toBe(true);
      expect(res.content[0]).toMatchObject({ type: "text" });
      expect((res.content[0] as { text: string }).text).toContain(reason);
    }
  });

  it("routes a tab-unavailable captureTab outcome to a text/error block", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({
          captured: false,
          reason: "tab-unavailable",
          detail: "sandbox tab missing and could not be created",
        }),
      ),
    );
    const res = await handleToolCall(deps, "captureTab", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect((res.content[0] as { text: string }).text).toContain(
      "tab-unavailable",
    );
  });

  it("maps an { error } reply to isError:true with the message text", async () => {
    const { deps } = fakeDeps(() => Promise.resolve(fail("no active tab")));

    const res = await handleToolCall(deps, "clickElement", { selector: "#x" });

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain(
      "no active tab",
    );
  });

  it("maps a rejected sendCommand (relay down / timeout) to isError:true, not an unhandled rejection", async () => {
    const { deps } = fakeDeps(() =>
      Promise.reject(
        new Error('Command "getPageText" timed out after 30000ms'),
      ),
    );

    const res = await handleToolCall(deps, "getPageText", {});

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("timed out");
    expect((res.content[0] as { text: string }).text).toContain("getPageText");
  });

  it("rejects an unknown tool name without ever calling the client", async () => {
    const { deps, spy } = fakeDeps(() => Promise.resolve(ok({})));

    const res = await handleToolCall(deps, "getStorage", {});

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("Unknown tool");
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces an over-large executeScript value as isError:true with the size-ceiling payload", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({ tooLarge: true, actualBytes: 1_100_000, limitBytes: 1_000_000 }),
      ),
    );

    const res = await handleToolCall(deps, "executeScript", {
      code: "'x'.repeat(1100000)",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("tooLarge");
    expect(text).toContain("1100000");
    expect(text).toContain("1000000");
    expect(text).not.toContain("failed");
  });

  it("surfaces an over-large evaluatePage value as isError:true the same way", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({ tooLarge: true, actualBytes: 2_400_000, limitBytes: 1_000_000 }),
      ),
    );

    const res = await handleToolCall(deps, "evaluatePage", { code: "x" });

    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("tooLarge");
    expect(text).toContain("2400000");
  });

  it("surfaces an over-large readConsoleMessages result as isError:true with the size-ceiling payload", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({ tooLarge: true, actualBytes: 1_100_000, limitBytes: 1_000_000 }),
      ),
    );

    const res = await handleToolCall(deps, "readConsoleMessages", {
      since: 0,
      limit: 100,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("tooLarge");
    expect(text).toContain("1100000");
    expect(text).toContain("1000000");
    expect(text).not.toContain("failed");
  });

  it("surfaces an over-large readNetworkRequests result as isError:true the same way", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(
        ok({ tooLarge: true, actualBytes: 2_400_000, limitBytes: 3_000_000 }),
      ),
    );

    const res = await handleToolCall(deps, "readNetworkRequests", {
      since: 0,
      limit: 100,
    });

    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("tooLarge");
    expect(text).toContain("2400000");
    expect(text).toContain("3000000");
  });

  it("keeps a normal (non-oversize) executeScript value as a plain text block, not isError", async () => {
    const { deps } = fakeDeps(() => Promise.resolve(ok({ value: "hello" })));

    const res = await handleToolCall(deps, "executeScript", { code: "1 + 1" });

    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain("hello");
  });

  it("does not flag a tooLarge-shaped result on a tool outside executeScript/evaluatePage", async () => {
    // Prove the oversize branch is scoped by tool name: an unrelated tool whose
    // result happens to carry a top-level `tooLarge` field must NOT be flagged.
    const { deps } = fakeDeps(() =>
      Promise.resolve(ok({ tooLarge: true, actualBytes: 9, limitBytes: 9 })),
    );

    const res = await handleToolCall(deps, "getPageText", {});

    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain("tooLarge");
  });
});

describe("handleToolCall saveImage", () => {
  const PNG_BASE64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7,
  ]).toString("base64");
  const WEBP_BASE64 = Buffer.from(
    "RIFF\x10\x00\x00\x00WEBPVP8 ",
    "latin1",
  ).toString("base64");

  function readOk(base64: string, mimeType?: string): CommandResponse {
    return ok({
      read: true,
      base64,
      ...(mimeType !== undefined ? { mimeType } : {}),
      width: 640,
      height: 480,
      byteLength: Buffer.from(base64, "base64").length,
    });
  }

  it.each([
    ["a relative path", "out.png"],
    ["an empty path", ""],
    ["a home-relative path", "~/x.png"],
    ["a non-string path", 42],
    ["a missing path", undefined],
  ])(
    "rejects %s with isError before calling the client",
    async (_label, path) => {
      const { deps, spy, writer } = fakeDeps(() =>
        Promise.resolve(readOk(PNG_BASE64)),
      );

      const res = await handleToolCall(deps, "saveImage", {
        selector: "#img",
        path,
      });

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("path-not-absolute");
      expect(spy).toHaveBeenCalledTimes(0);
      expect(writer).toHaveBeenCalledTimes(0);
    },
  );

  it("forwards only the selector to the extension and passes overwrite to the writer", async () => {
    const { deps, spy, writer } = fakeDeps(() =>
      Promise.resolve(readOk(PNG_BASE64)),
    );

    await handleToolCall(deps, "saveImage", {
      selector: "#img",
      path: "/tmp/x.png",
      overwrite: true,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["saveImage", { selector: "#img" }]);
    expect(writer).toHaveBeenCalledWith("/tmp/x.png", expect.any(Buffer), true);
  });

  it("defaults overwrite to false", async () => {
    const { deps, writer } = fakeDeps(() =>
      Promise.resolve(readOk(PNG_BASE64)),
    );

    await handleToolCall(deps, "saveImage", {
      selector: "#img",
      path: "/tmp/x.png",
    });

    expect(writer).toHaveBeenCalledWith(
      "/tmp/x.png",
      expect.any(Buffer),
      false,
    );
  });

  it("returns exactly { path, bytes, width, height, mimeType } as one text block, with no base64", async () => {
    const { deps, writer } = fakeDeps(() =>
      Promise.resolve(readOk(PNG_BASE64, "image/png")),
    );

    const res = await handleToolCall(deps, "saveImage", {
      selector: "#img",
      path: "/tmp/x.png",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(res.content[0]).toMatchObject({ type: "text" });
    const body: unknown = JSON.parse(textOf(res));
    expect(Object.keys(body as object).sort()).toEqual([
      "bytes",
      "height",
      "mimeType",
      "path",
      "width",
    ]);
    expect(body).toEqual({
      path: "/tmp/x.png",
      bytes: Buffer.from(PNG_BASE64, "base64").length,
      width: 640,
      height: 480,
      mimeType: "image/png",
    });
    expect(textOf(res)).not.toContain(PNG_BASE64);
    const written = writer.mock.calls[0]?.[1];
    expect(
      written && Buffer.from(written).equals(Buffer.from(PNG_BASE64, "base64")),
    ).toBe(true);
  });

  it("lets the sniffed type win over the page-reported type", async () => {
    const { deps } = fakeDeps(() =>
      Promise.resolve(readOk(PNG_BASE64, "image/jpeg")),
    );

    const res = await handleToolCall(deps, "saveImage", {
      selector: "#img",
      path: "/tmp/x.png",
    });

    expect(JSON.parse(textOf(res))).toMatchObject({ mimeType: "image/png" });
  });

  it("takes an <img>'s type from its sniffed WebP bytes when the page reports none", async () => {
    const { deps } = fakeDeps(() => Promise.resolve(readOk(WEBP_BASE64)));

    const res = await handleToolCall(deps, "saveImage", {
      selector: "#img",
      path: "/tmp/x.webp",
    });

    expect(JSON.parse(textOf(res))).toMatchObject({ mimeType: "image/webp" });
  });

  it("falls back to the page type, then application/octet-stream, for unknown bytes", async () => {
    const unknown = Buffer.from("not an image").toString("base64");
    const withType = fakeDeps(() =>
      Promise.resolve(readOk(unknown, "image/avif")),
    );
    const withoutType = fakeDeps(() => Promise.resolve(readOk(unknown)));

    const a = await handleToolCall(withType.deps, "saveImage", {
      selector: "#i",
      path: "/tmp/a",
    });
    const b = await handleToolCall(withoutType.deps, "saveImage", {
      selector: "#i",
      path: "/tmp/b",
    });

    expect(JSON.parse(textOf(a))).toMatchObject({ mimeType: "image/avif" });
    expect(JSON.parse(textOf(b))).toMatchObject({
      mimeType: "application/octet-stream",
    });
  });

  it.each([
    "element-not-found",
    "not-image",
    "not-loaded",
    "tainted",
    "unreadable",
  ])(
    "maps the %s read failure to isError naming the reason, writing nothing",
    async (reason) => {
      const { deps, writer } = fakeDeps(() =>
        Promise.resolve(ok({ read: false, reason })),
      );

      const res = await handleToolCall(deps, "saveImage", {
        selector: "#img",
        path: "/tmp/x.png",
      });

      expect(res.isError).toBe(true);
      expect(JSON.parse(textOf(res))).toMatchObject({ saved: false, reason });
      expect(writer).toHaveBeenCalledTimes(0);
    },
  );

  it("maps too-large to isError carrying size and limit, writing nothing", async () => {
    const { deps, writer } = fakeDeps(() =>
      Promise.resolve(
        ok({
          read: false,
          reason: "too-large",
          size: 30000000,
          limit: 26214400,
        }),
      ),
    );

    const res = await handleToolCall(deps, "saveImage", {
      selector: "#img",
      path: "/tmp/x.png",
    });

    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res))).toEqual({
      saved: false,
      reason: "too-large",
      size: 30000000,
      limit: 26214400,
    });
    expect(writer).toHaveBeenCalledTimes(0);
  });

  it.each(["exists", "parent-missing", "io-error"] as const)(
    "maps a %s writer refusal to isError naming the reason",
    async (reason) => {
      const { deps } = fakeDeps(() => Promise.resolve(readOk(PNG_BASE64)), {
        written: false,
        reason,
        message: "refused",
      });

      const res = await handleToolCall(deps, "saveImage", {
        selector: "#img",
        path: "/tmp/x.png",
      });

      expect(res.isError).toBe(true);
      expect(JSON.parse(textOf(res))).toMatchObject({
        saved: false,
        reason,
        path: "/tmp/x.png",
      });
    },
  );

  it("maps an unexpected payload, an { error } reply and a rejected send to isError without throwing", async () => {
    const odd = fakeDeps(() => Promise.resolve(ok({ read: "maybe" })));
    const errored = fakeDeps(() => Promise.resolve(fail("no sandbox tab")));
    const rejected = fakeDeps(() => Promise.reject(new Error("relay down")));
    const args = { selector: "#img", path: "/tmp/x.png" };

    const [oddRes, errRes, rejRes] = await Promise.all([
      handleToolCall(odd.deps, "saveImage", args),
      handleToolCall(errored.deps, "saveImage", args),
      handleToolCall(rejected.deps, "saveImage", args),
    ]);

    expect([oddRes.isError, errRes.isError, rejRes.isError]).toEqual([
      true,
      true,
      true,
    ]);
    expect(textOf(errRes)).toContain("no sandbox tab");
    expect(textOf(rejRes)).toContain("relay down");
    expect(odd.writer).toHaveBeenCalledTimes(0);
  });
});

describe("createMcpServer", () => {
  it("builds a server identified as nimvarya that can be connected to a transport", () => {
    const { deps } = fakeDeps(() => Promise.resolve(ok({})));
    const server = createMcpServer(deps);
    expect(MCP_SERVER_NAME).toBe("nimvarya");
    expect(typeof server.connect).toBe("function");
  });
});
