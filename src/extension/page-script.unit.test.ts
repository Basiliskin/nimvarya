import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isCaptureEnvelope,
  MAX_BODY_PREVIEW_BYTES,
  MAX_CONSOLE_TEXT_BYTES,
} from "../protocol/capture.js";
import type { CaptureEnvelope } from "../protocol/capture.js";
import {
  installPageCapture,
  PAGE_CAPTURE_INSTALLED_FLAG,
  serializeArgs,
} from "./page-script.js";
import type { PageCaptureEnv } from "./page-script.js";

type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type ErrListener = (event: {
  error?: unknown;
  message?: string;
  reason?: unknown;
}) => void;

const enc = new TextEncoder();

/** Every envelope posted anywhere in the suite — replayed in afterEach. */
let allPosted: unknown[] = [];

interface Harness {
  env: PageCaptureEnv;
  posted: CaptureEnvelope[];
  console: Record<
    "log" | "info" | "warn" | "error" | "debug",
    ReturnType<typeof vi.fn>
  >;
  clock: { t: number };
  fireError: ErrListener;
  fireRejection: ErrListener;
  currentFetch: () => FetchFn;
  postThrows: (on: boolean) => void;
}

function makeHarness(originalFetch: FetchFn, xhrCtor?: unknown): Harness {
  const posted: CaptureEnvelope[] = [];
  const clock = { t: 0 };
  let installed = false;
  let fetchImpl = originalFetch;
  let throwOnPost = false;
  const errorListeners: ErrListener[] = [];
  const rejectionListeners: ErrListener[] = [];
  const consoleFns = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const env: PageCaptureEnv = {
    console: { ...consoleFns },
    getFetch: () => fetchImpl,
    setFetch: (fn) => {
      fetchImpl = fn;
    },
    XMLHttpRequest: (xhrCtor ?? function noop() {}) as unknown as typeof XMLHttpRequest,
    postMessage: (envelope) => {
      if (throwOnPost) throw new Error("DataCloneError");
      posted.push(envelope);
      allPosted.push(envelope);
    },
    addEventListener: (type, listener) => {
      if (type === "error") errorListeners.push(listener);
      else rejectionListeners.push(listener);
    },
    now: () => clock.t,
    readInstalledFlag: () => installed,
    setInstalledFlag: () => {
      installed = true;
    },
  };

  return {
    env,
    posted,
    console: consoleFns,
    clock,
    fireError: (e) => {
      for (const l of errorListeners) l(e);
    },
    fireRejection: (e) => {
      for (const l of rejectionListeners) l(e);
    },
    currentFetch: () => fetchImpl,
    postThrows: (on) => {
      throwOnPost = on;
    },
  };
}

function noFetch(): FetchFn {
  return () => Promise.reject(new Error("fetch not used in this test"));
}

interface FakeStream {
  getReader(): {
    read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

function streamOf(chunks: Uint8Array[], endless = false): FakeStream {
  let i = 0;
  const cancel = vi.fn(() => Promise.resolve());
  return {
    getReader() {
      return {
        read: () => {
          if (endless) {
            return Promise.resolve({
              done: false,
              value: enc.encode("x".repeat(1024)),
            });
          }
          if (i < chunks.length) {
            const value = chunks[i];
            i += 1;
            return Promise.resolve({ done: false, value });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
        cancel,
      };
    },
  };
}

function fakeResponse(opts: {
  status?: number;
  contentType?: string | null;
  body?: FakeStream | null;
}): { response: Response; clone: ReturnType<typeof vi.fn> } {
  const status = opts.status ?? 200;
  const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
  const body = opts.body === undefined ? streamOf([enc.encode("{}")]) : opts.body;
  const clone = vi.fn(() => ({ body }));
  const response = {
    status,
    ok: status >= 200 && status < 300,
    body,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "content-type" ? contentType : null,
    },
    clone,
  };
  return { response: response as unknown as Response, clone };
}

function lastNetwork(posted: CaptureEnvelope[]): CaptureEnvelope & {
  channel: "network";
} {
  const found = [...posted].reverse().find((e) => e.channel === "network");
  if (found === undefined) {
    throw new Error("no network envelope posted");
  }
  return found;
}

afterEach(() => {
  for (const envelope of allPosted) {
    expect(isCaptureEnvelope(envelope)).toBe(true);
  }
  allPosted = [];
  vi.restoreAllMocks();
});

describe("installPageCapture — console wrapping", () => {
  it("each level calls the original once and posts one valid envelope", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      h.posted.length = 0;
      h.env.console[level]("hello", 42);
      expect(h.console[level]).toHaveBeenCalledTimes(1);
      expect(h.console[level]).toHaveBeenCalledWith("hello", 42);
      expect(h.posted).toHaveLength(1);
      const envelope = h.posted[0];
      expect(isCaptureEnvelope(envelope)).toBe(true);
      expect(envelope?.channel).toBe("console");
      if (envelope?.channel === "console") {
        expect(envelope.entry.level).toBe(level);
        expect(envelope.entry.text).toContain("hello");
      }
    }
  });

  it("window error and unhandledrejection post an uncaught entry with name + message", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);

    h.fireError({ error: new TypeError("boom") });
    h.fireRejection({ reason: new RangeError("nope") });

    const consoleEnvelopes = h.posted.filter((e) => e.channel === "console");
    const texts = consoleEnvelopes.map((e) => e.entry.text);
    expect(
      consoleEnvelopes.every((e) => e.entry.level === "uncaught"),
    ).toBe(true);
    expect(texts).toContain("TypeError: boom");
    expect(texts).toContain("RangeError: nope");
  });

  it("a throwing postMessage never escapes the wrapped console call", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);
    h.postThrows(true);
    expect(() => {
      h.env.console.log("still logged");
    }).not.toThrow();
    expect(h.console.log).toHaveBeenCalledTimes(1);
  });

  it("a circular object arg is still posted and the original still runs", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => {
      h.env.console.log(a);
    }).not.toThrow();
    expect(h.console.log).toHaveBeenCalledTimes(1);
    expect(h.posted).toHaveLength(1);
    expect(isCaptureEnvelope(h.posted[0])).toBe(true);
  });

  it("double install leaves the original called exactly once per call", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);
    installPageCapture(h.env);
    h.env.console.log("once");
    expect(h.console.log).toHaveBeenCalledTimes(1);
    expect(h.posted).toHaveLength(1);
    expect(h.env.readInstalledFlag()).toBe(true);
  });
});

describe("serializeArgs / page-world byte bounding", () => {
  it("bounds a 1 MB console arg and marks truncated", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);
    h.env.console.log("x".repeat(1_000_000));
    const envelope = h.posted[0];
    expect(envelope?.channel).toBe("console");
    if (envelope?.channel === "console") {
      expect(enc.encode(envelope.entry.text).length).toBeLessThanOrEqual(
        MAX_CONSOLE_TEXT_BYTES,
      );
      expect(envelope.entry.truncated).toBe(true);
    }
  });

  it("a short console arg is not truncated", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);
    h.env.console.log("tiny");
    const envelope = h.posted[0];
    if (envelope?.channel === "console") {
      expect(envelope.entry.truncated).toBe(false);
    }
  });

  it("worst-case multi-arg console call stays under a per-entry ceiling", () => {
    const h = makeHarness(noFetch());
    installPageCapture(h.env);
    h.env.console.log(...Array.from({ length: 20 }, () => "y".repeat(100_000)));
    const envelope = h.posted[0];
    expect(JSON.stringify(envelope).length).toBeLessThan(12_000);
    if (envelope?.channel === "console") {
      expect(envelope.entry.truncated).toBe(true);
    }
  });

  it("serializeArgs renders errors as name + message and joins with spaces", () => {
    expect(serializeArgs([new Error("x"), "y"])).toBe("Error: x y");
  });

  it("a too-long request url is bounded with truncated=true", async () => {
    const longUrl = `https://h/${"p".repeat(10_000)}`;
    const { response } = fakeResponse({ contentType: "text/plain", body: streamOf([enc.encode("ok")]) });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    await h.currentFetch()(longUrl);
    const envelope = lastNetwork(h.posted);
    expect(enc.encode(envelope.entry.url).length).toBeLessThanOrEqual(
      MAX_BODY_PREVIEW_BYTES,
    );
    expect(envelope.entry.truncated).toBe(true);
  });
});

describe("fetch wrapping — bounded streaming preview", () => {
  it("reads a small text body fully with truncated=false", async () => {
    const { response } = fakeResponse({
      contentType: "application/json",
      body: streamOf([enc.encode('{"ok":true}')]),
    });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    await h.currentFetch()("https://h/data");
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.bodyPreview).toBe('{"ok":true}');
    expect(envelope.entry.truncated).toBe(false);
    expect(envelope.entry.status).toBe(200);
  });

  it("stops a never-ending stream at the cap, marks truncated, cancels the reader", async () => {
    const body = streamOf([], true);
    const reader = body.getReader();
    const cancelSpy = reader.cancel;
    // re-wrap so the wrapper's getReader() returns the same cancel spy
    const trackedBody: FakeStream = {
      getReader: () => ({
        read: reader.read.bind(reader),
        cancel: cancelSpy,
      }),
    };
    const tracked = fakeResponse({ contentType: "application/json", body: trackedBody });
    const h = makeHarness(() => Promise.resolve(tracked.response));
    installPageCapture(h.env);
    await h.currentFetch()("https://h/stream");
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.truncated).toBe(true);
    expect(enc.encode(envelope.entry.bodyPreview ?? "").length).toBeLessThanOrEqual(
      MAX_BODY_PREVIEW_BYTES,
    );
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("decodes a multi-byte char split across two chunks without mangling", async () => {
    const euro = enc.encode("€"); // 3 bytes: E2 82 AC
    const body = streamOf([
      new Uint8Array([...enc.encode("a"), euro[0] ?? 0]),
      new Uint8Array([euro[1] ?? 0, euro[2] ?? 0, ...enc.encode("b")]),
    ]);
    const { response } = fakeResponse({ contentType: "text/plain", body });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    await h.currentFetch()("https://h/utf8");
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.bodyPreview).toBe("a€b");
    expect(envelope.entry.bodyPreview).not.toContain("�");
  });

  it("a binary content-type yields bodyPreview null and never reads the body", async () => {
    const { response, clone } = fakeResponse({
      contentType: "image/png",
      body: streamOf([enc.encode("PNGDATA")]),
    });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    await h.currentFetch()("https://h/img");
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.bodyPreview).toBeNull();
    expect(isCaptureEnvelope(envelope)).toBe(true);
    expect(clone).not.toHaveBeenCalled();
  });

  it("a null body (204) posts bodyPreview null without rejecting", async () => {
    const { response } = fakeResponse({ status: 204, contentType: "application/json", body: null });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    await expect(h.currentFetch()("https://h/empty")).resolves.toBeDefined();
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.bodyPreview).toBeNull();
  });

  it("returns the identical Response object to the caller", async () => {
    const { response } = fakeResponse({ contentType: "text/plain", body: streamOf([enc.encode("hi")]) });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    const result = await h.currentFetch()("https://h/x");
    expect(Object.is(result, response)).toBe(true);
  });

  it("a rejected fetch re-throws the same error and posts failed/status=null", async () => {
    const boom = new Error("network down");
    const h = makeHarness(() => Promise.reject(boom));
    installPageCapture(h.env);
    await expect(h.currentFetch()("https://h/down", { method: "PUT" })).rejects.toBe(
      boom,
    );
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.failed).toBe(true);
    expect(envelope.entry.status).toBeNull();
    expect(envelope.entry.method).toBe("PUT");
    expect(envelope.entry.url).toBe("https://h/down");
  });

  it("normalizes method and url from a Request object", async () => {
    const { response } = fakeResponse({ contentType: "text/plain", body: streamOf([enc.encode("ok")]) });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    await h.currentFetch()(new Request("https://h/api", { method: "DELETE" }));
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.method).toBe("DELETE");
    expect(envelope.entry.url).toBe("https://h/api");
  });

  it("defaults method to GET for a bare string url", async () => {
    const { response } = fakeResponse({ contentType: "text/plain", body: streamOf([enc.encode("ok")]) });
    const h = makeHarness(() => Promise.resolve(response));
    installPageCapture(h.env);
    await h.currentFetch()("https://h/plain");
    expect(lastNetwork(h.posted).entry.method).toBe("GET");
  });
});

describe("XHR wrapping", () => {
  class FakeXHR {
    public status = 200;
    public responseType: XMLHttpRequestResponseType = "";
    private readonly listeners = new Map<string, Array<() => void>>();
    public static text = "response-body";
    public static header: string | null = "text/plain";

    open(_method: string, _url: string | URL): void {}
    send(_body?: unknown): void {}
    addEventListener(type: string, cb: () => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(cb);
      this.listeners.set(type, list);
    }
    getResponseHeader(_name: string): string | null {
      return FakeXHR.header;
    }
    get responseText(): string {
      if (this.responseType !== "" && this.responseType !== "text") {
        throw new Error("InvalidStateError");
      }
      return FakeXHR.text;
    }
    fire(type: string): void {
      for (const cb of this.listeners.get(type) ?? []) cb();
    }
  }

  it("posts a NetworkEntry on loadend for a text response, timed by env.now()", () => {
    const h = makeHarness(noFetch(), FakeXHR);
    installPageCapture(h.env);
    const xhr = new FakeXHR();
    xhr.open("POST", "https://h/submit");
    h.clock.t = 10;
    xhr.send();
    h.clock.t = 35;
    xhr.fire("loadend");
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.method).toBe("POST");
    expect(envelope.entry.url).toBe("https://h/submit");
    expect(envelope.entry.status).toBe(200);
    expect(envelope.entry.contentType).toBe("text/plain");
    expect(envelope.entry.bodyPreview).toBe("response-body");
    expect(envelope.entry.durationMs).toBe(25);
  });

  it("does not read responseText when responseType is json", () => {
    const h = makeHarness(noFetch(), FakeXHR);
    installPageCapture(h.env);
    const xhr = new FakeXHR();
    xhr.responseType = "json";
    xhr.open("GET", "https://h/j");
    xhr.send();
    expect(() => {
      xhr.fire("loadend");
    }).not.toThrow();
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.bodyPreview).toBeNull();
    expect(isCaptureEnvelope(envelope)).toBe(true);
  });

  it("reports status 0 as failed with status null", () => {
    const h = makeHarness(noFetch(), FakeXHR);
    installPageCapture(h.env);
    const xhr = new FakeXHR();
    xhr.status = 0;
    xhr.open("GET", "https://h/aborted");
    xhr.send();
    xhr.fire("loadend");
    const envelope = lastNetwork(h.posted);
    expect(envelope.entry.failed).toBe(true);
    expect(envelope.entry.status).toBeNull();
  });

  it("keeps concurrent XHR urls independent (per-instance meta)", () => {
    const h = makeHarness(noFetch(), FakeXHR);
    installPageCapture(h.env);
    const a = new FakeXHR();
    const b = new FakeXHR();
    a.open("GET", "https://h/a");
    b.open("GET", "https://h/b");
    a.send();
    b.send();
    a.fire("loadend");
    b.fire("loadend");
    const urls = h.posted
      .filter((e) => e.channel === "network")
      .map((e) => e.entry.url);
    expect(urls).toEqual(["https://h/a", "https://h/b"]);
  });
});

describe("node-safe bootstrap", () => {
  it("importing the module touches no node globals and sets no flag", async () => {
    const fetchBefore = globalThis.fetch;
    const logBefore = console.log;
    const flagBefore: unknown = Reflect.get(
      globalThis,
      PAGE_CAPTURE_INSTALLED_FLAG,
    );
    await import("./page-script.js");
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(console.log).toBe(logBefore);
    expect(flagBefore).toBeUndefined();
    expect(
      Reflect.get(globalThis, PAGE_CAPTURE_INSTALLED_FLAG),
    ).toBeUndefined();
  });

  it("the exported env type is usable to build a fake (compile-time)", () => {
    const built: PageCaptureEnv = makeHarness(noFetch()).env;
    expect(typeof built.now()).toBe("number");
  });
});
