import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultMcpMainDeps, runMcpServer } from "./main.js";
import type { McpMainDeps } from "./main.js";

describe("runMcpServer", () => {
  it("starts the relay connection, logs to the diagnostic sink, and attaches the transport once", async () => {
    const start = vi.fn();
    const attachTransport = vi.fn((_server: unknown) => Promise.resolve());
    const logError = vi.fn();
    const deps: McpMainDeps = {
      createSender: () => ({
        sender: {
          sendCommand: vi.fn(() => Promise.reject(new Error("unused"))),
        },
        start,
      }),
      attachTransport,
      logError,
    };

    await runMcpServer(deps);

    expect(start).toHaveBeenCalledTimes(1);
    expect(attachTransport).toHaveBeenCalledTimes(1);
    const server = attachTransport.mock.calls[0]?.[0] as { connect: unknown };
    expect(typeof server.connect).toBe("function");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("relay"));
  });
});

describe("defaultMcpMainDeps.logError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes to stderr and never to stdout", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    defaultMcpMainDeps.logError("something happened");

    expect(err).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveBeenCalled();
  });
});

describe("bin/mcp.mjs launcher", () => {
  it("emits nothing on stdout when started with no relay running", async () => {
    const launcher = fileURLToPath(
      new URL("../../bin/mcp.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [launcher], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NIMVARYA_URL: "ws://127.0.0.1:59999" },
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));

    await new Promise((resolve) => setTimeout(resolve, 2500));
    child.kill("SIGKILL");

    for (const line of stdout.split("\n").filter(Boolean)) {
      const parseLine = (): unknown => JSON.parse(line);
      expect(parseLine).not.toThrow();
    }
  }, 20_000);
});
