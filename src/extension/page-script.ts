/**
 * MAIN-world capture wrapper — the only script in this package that runs inside
 * the inspected page's own JavaScript world.
 *
 * Why it exists:
 *
 *   A Chrome extension cannot observe a page's `console` output or its
 *   `fetch` / `XMLHttpRequest` traffic from the outside. The only way is to
 *   run code in the page's own world and replace those APIs before the page
 *   uses them. This module installs those wrappers, serialises each event into
 *   a bounded `ConsoleEntry` / `NetworkEntry` from the capture contract, and
 *   hands it to the page via `window.postMessage` wrapped in a
 *   {@link CaptureEnvelope}. The ISOLATED-world forwarder (a later phase)
 *   picks those envelopes up and relays them to the service worker.
 *
 * Why an installer that takes its targets as an argument:
 *
 *   This package has no jsdom; tests run in plain Node. `installPageCapture`
 *   receives every global it touches through `env`, so the whole wrapper can
 *   be exercised with fakes — a `vi.fn` console, a fake `fetch` returning a
 *   `Response`-like object with a `ReadableStream` body, a minimal fake XHR
 *   class. The bottom-of-file bootstrap builds the real `env` from `window`
 *   and is guarded by `typeof window !== "undefined"`, so importing this
 *   module under vitest performs no wrapping and touches no globals — the same
 *   "no side effect on import" convention `service-worker.ts` uses.
 *
 * Byte bounding happens here, in the page world, before anything crosses
 * `postMessage`: every text-bearing field goes through `boundText` from the
 * capture contract, so an oversized payload is cut at the source instead of
 * being shipped across two message boundaries and trimmed later.
 */

/// <reference lib="dom" />

import {
  boundText,
  CAPTURE_NAMESPACE,
  MAX_BODY_PREVIEW_BYTES,
  MAX_CONSOLE_TEXT_BYTES,
} from "../protocol/capture.js";
import type {
  CaptureEnvelope,
  ConsoleEntry,
  NetworkEntry,
} from "../protocol/capture.js";

/** The `fetch` shape the wrapper reads and replaces. */
type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** The console levels this wrapper replaces (plus the synthetic `uncaught`). */
type CapturedLevel = "log" | "info" | "warn" | "error" | "debug" | "uncaught";

const WRAPPED_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * Every global the wrapper needs, injected so the installer is testable in
 * Node. Production supplies these from `window`; tests supply fakes.
 */
export interface PageCaptureEnv {
  /** The page's console; its five methods are replaced in place. */
  readonly console: Record<
    (typeof WRAPPED_LEVELS)[number],
    (...args: unknown[]) => void
  >;
  /** Read the current `fetch` (already bound to its receiver). */
  getFetch(): FetchFn;
  /** Install the wrapped `fetch` back onto the page. */
  setFetch(fn: FetchFn): void;
  /** The page's `XMLHttpRequest` constructor; its prototype is patched in place. */
  readonly XMLHttpRequest: typeof XMLHttpRequest;
  /** Deliver one capture envelope to the page (production: `postMessage(env, "*")`). */
  postMessage(envelope: CaptureEnvelope): void;
  /** Subscribe to uncaught errors / rejections. */
  addEventListener(
    type: "error" | "unhandledrejection",
    listener: (event: {
      readonly error?: unknown;
      readonly message?: string;
      readonly reason?: unknown;
    }) => void,
  ): void;
  /** Monotonic clock in milliseconds (production: `performance.now`). */
  now(): number;
  /** Read the shared "already installed" flag (keyed by {@link PAGE_CAPTURE_INSTALLED_FLAG}). */
  readInstalledFlag(): boolean;
  /** Set the shared flag so a second injected copy of this script is a no-op. */
  setInstalledFlag(): void;
}

/**
 * The property name the wrapper stamps on the shared global (production:
 * `window`) so two separate injections of this script do not wrap the same
 * API twice. Exported so a host that injects the script imperatively can
 * check it.
 */
export const PAGE_CAPTURE_INSTALLED_FLAG =
  "__chrome_bridge_page_capture_installed_v1__";

/** Pre-slice a single arg's string form so a multi-MB value is never joined whole. */
const WORK_SLICE = MAX_CONSOLE_TEXT_BYTES * 4 + 64;

function launder(value: unknown): unknown {
  return value;
}

function tryJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function describeValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return tryJson(value) ?? Object.prototype.toString.call(value);
}

/**
 * Serialise console args to one string, capping each arg's string form first
 * so a giant argument bounds the work, not just the output. The joined result
 * is bounded again by the caller via `boundText`.
 */
export function serializeArgs(args: readonly unknown[]): string {
  return args
    .map((arg) => {
      const text = describeValue(arg);
      return text.length > WORK_SLICE ? text.slice(0, WORK_SLICE) : text;
    })
    .join(" ");
}

function safePost(env: PageCaptureEnv, envelope: CaptureEnvelope): void {
  try {
    env.postMessage(envelope);
  } catch {
    // A throwing postMessage (e.g. a DataCloneError) must never surface in the
    // page's own console.log / fetch call.
  }
}

function postConsole(
  env: PageCaptureEnv,
  level: CapturedLevel,
  rawText: string,
): void {
  try {
    const bounded = boundText(rawText, MAX_CONSOLE_TEXT_BYTES);
    const entry: ConsoleEntry = {
      level,
      text: bounded.text,
      timestamp: env.now(),
      truncated: bounded.truncated,
    };
    safePost(env, { ns: CAPTURE_NAMESPACE, channel: "console", entry });
  } catch {
    // Never let capture bookkeeping break the wrapped call.
  }
}

function installConsole(env: PageCaptureEnv): void {
  for (const level of WRAPPED_LEVELS) {
    const original = env.console[level].bind(env.console);
    env.console[level] = (...args: unknown[]): void => {
      original(...args);
      postConsole(env, level, serializeArgs(args));
    };
  }
}

function installUncaught(env: PageCaptureEnv): void {
  env.addEventListener("error", (event) => {
    const source = event.error === undefined ? event.message : event.error;
    postConsole(env, "uncaught", describeValue(launder(source)));
  });
  env.addEventListener("unhandledrejection", (event) => {
    postConsole(env, "uncaught", describeValue(launder(event.reason)));
  });
}

const TEXT_LIKE = /^text\/|^application\/(json|javascript|ecmascript)$|\+json$/;

function isTextLike(contentType: string | null): boolean {
  if (contentType === null) return false;
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return TEXT_LIKE.test(base);
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter)}`;
}

interface NetworkDraft {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly durationMs: number;
  readonly contentType: string | null;
  readonly bodyPreview: string | null;
  readonly failed: boolean;
  readonly timestamp: number;
  readonly previewTruncated: boolean;
}

function finalizeNetworkEntry(draft: NetworkDraft): NetworkEntry {
  const url = boundText(draft.url, MAX_BODY_PREVIEW_BYTES);
  const contentType =
    draft.contentType === null
      ? null
      : boundText(draft.contentType, MAX_BODY_PREVIEW_BYTES);
  const bodyPreview =
    draft.bodyPreview === null
      ? null
      : boundText(draft.bodyPreview, MAX_BODY_PREVIEW_BYTES);
  const truncated =
    draft.previewTruncated ||
    url.truncated ||
    (contentType?.truncated ?? false) ||
    (bodyPreview?.truncated ?? false);
  return {
    requestId: draft.requestId,
    method: draft.method,
    url: url.text,
    status: draft.status,
    durationMs: draft.durationMs,
    contentType: contentType === null ? null : contentType.text,
    bodyPreview: bodyPreview === null ? null : bodyPreview.text,
    truncated,
    failed: draft.failed,
    timestamp: draft.timestamp,
  };
}

function postNetwork(env: PageCaptureEnv, draft: NetworkDraft): void {
  try {
    const entry = finalizeNetworkEntry(draft);
    safePost(env, { ns: CAPTURE_NAMESPACE, channel: "network", entry });
  } catch {
    // ignore
  }
}

async function readBodyPreview(
  body: ReadableStream<Uint8Array>,
): Promise<{ text: string; truncated: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
      if (bytes >= MAX_BODY_PREVIEW_BYTES) {
        truncated = true;
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return { text, truncated };
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (input instanceof Request) return input.method;
  return init?.method ?? "GET";
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function makeWrappedFetch(env: PageCaptureEnv, original: FetchFn): FetchFn {
  return async (input, init) => {
    const requestId = nextRequestId();
    const method = resolveMethod(input, init);
    const url = resolveUrl(input);
    const start = env.now();
    let response: Response;
    try {
      response = await original(input, init);
    } catch (err) {
      postNetwork(env, {
        requestId,
        method,
        url,
        status: null,
        durationMs: env.now() - start,
        contentType: null,
        bodyPreview: null,
        failed: true,
        timestamp: env.now(),
        previewTruncated: false,
      });
      throw err;
    }

    const contentType = response.headers.get("content-type");
    let bodyPreview: string | null = null;
    let previewTruncated = false;
    if (response.body !== null && isTextLike(contentType)) {
      try {
        const clonedBody = response.clone().body;
        if (clonedBody !== null) {
          const preview = await readBodyPreview(clonedBody);
          bodyPreview = preview.text;
          previewTruncated = preview.truncated;
        }
      } catch {
        bodyPreview = null;
      }
    }

    postNetwork(env, {
      requestId,
      method,
      url,
      status: response.status,
      durationMs: env.now() - start,
      contentType,
      bodyPreview,
      failed: !response.ok,
      timestamp: env.now(),
      previewTruncated,
    });
    return response;
  };
}

function installFetch(env: PageCaptureEnv): void {
  env.setFetch(makeWrappedFetch(env, env.getFetch()));
}

interface XhrMeta {
  method: string;
  url: string;
  start: number;
}

function readXhrBody(xhr: XMLHttpRequest): string | null {
  if (xhr.responseType !== "" && xhr.responseType !== "text") return null;
  try {
    const value: unknown = xhr.responseText;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function installXhr(env: PageCaptureEnv): void {
  const proto = env.XMLHttpRequest.prototype;
  /* eslint-disable @typescript-eslint/unbound-method --
     capturing the prototype methods to re-dispatch them with the caller's
     dynamic `this` via `.call`; they are never invoked unbound. */
  const originalOpen = proto.open;
  const originalSend = proto.send;
  /* eslint-enable @typescript-eslint/unbound-method */
  const meta = new WeakMap<XMLHttpRequest, XhrMeta>();

  proto.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    xhrUrl: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    meta.set(this, {
      method: method || "GET",
      url: typeof xhrUrl === "string" ? xhrUrl : xhrUrl.toString(),
      start: 0,
    });
    originalOpen.call(
      this,
      method,
      xhrUrl,
      async ?? true,
      username ?? null,
      password ?? null,
    );
  };

  proto.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const entry = meta.get(this);
    if (entry !== undefined) {
      entry.start = env.now();
      this.addEventListener("loadend", () => {
        const status = this.status;
        let contentType: string | null;
        try {
          contentType = this.getResponseHeader("content-type");
        } catch {
          contentType = null;
        }
        postNetwork(env, {
          requestId: nextRequestId(),
          method: entry.method,
          url: entry.url,
          status: status === 0 ? null : status,
          durationMs: env.now() - entry.start,
          contentType,
          bodyPreview: readXhrBody(this),
          failed: status === 0 || status >= 400,
          timestamp: env.now(),
          previewTruncated: false,
        });
      });
    }
    if (body === undefined) {
      originalSend.call(this);
      return;
    }
    originalSend.call(this, body);
  };
}

/**
 * Replace `console` (five levels), uncaught-error / unhandled-rejection
 * reporting, `fetch`, and `XMLHttpRequest` with capture-emitting wrappers.
 * Idempotent: a second call (same or a fresh injection sharing the global
 * flag) is a no-op.
 */
export function installPageCapture(env: PageCaptureEnv): void {
  if (env.readInstalledFlag()) return;
  env.setInstalledFlag();
  installConsole(env);
  installUncaught(env);
  installFetch(env);
  installXhr(env);
}

function bootstrapFromWindow(): void {
  if (typeof window === "undefined") return;
  installPageCapture({
    console: window.console,
    getFetch: () => window.fetch.bind(window),
    setFetch: (fn) => {
      window.fetch = fn;
    },
    XMLHttpRequest: window.XMLHttpRequest,
    postMessage: (envelope) => {
      window.postMessage(envelope, "*");
    },
    addEventListener: (type, listener) => {
      if (type === "error") {
        window.addEventListener("error", (event) => {
          listener({ error: launder(event.error), message: event.message });
        });
      } else {
        window.addEventListener("unhandledrejection", (event) => {
          listener({ reason: launder(event.reason) });
        });
      }
    },
    now: () => window.performance.now(),
    readInstalledFlag: () =>
      Reflect.get(window, PAGE_CAPTURE_INSTALLED_FLAG) === true,
    setInstalledFlag: () => {
      Reflect.set(window, PAGE_CAPTURE_INSTALLED_FLAG, true);
    },
  });
}

bootstrapFromWindow();
