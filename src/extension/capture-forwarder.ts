/**
 * ISOLATED-world capture forwarder — the extension's own content script.
 *
 * Why it exists:
 *
 *   The MAIN-world wrapper (`page-script.ts`) runs in the inspected page's
 *   own JavaScript world and therefore cannot touch `chrome.runtime` — the
 *   page world has no extension APIs. Something in an ISOLATED content-script
 *   world has to pick up the `window.postMessage` capture envelopes the
 *   wrapper emits and relay them to the service worker. That is this file.
 *
 * Why `chrome.runtime.sendMessage` and not a WebSocket:
 *
 *   A content script could in principle open its own `ws://` socket straight
 *   to the relay. It must not. Chromium applies the *host page's*
 *   `connect-src` Content Security Policy to any socket a content script
 *   opens, and many sites ship a strict `connect-src` that blocks
 *   `ws://localhost:*` outright — the capture path would then silently die on
 *   exactly the sites people care about. `chrome.runtime.sendMessage` is not
 *   subject to the page CSP, so the forwarder relays every validated envelope
 *   to the service worker and lets the worker (whose own context has no page
 *   CSP) do any real network work. Same reasoning, and same explanatory
 *   header, as boky's `extension/src/infrastructure/bridge/log-forwarder.ts`.
 *
 * Trust boundary: this `message` listener is one of the two points every
 * inbound envelope is validated (the other is the service worker's
 * `runtime.onMessage`). It accepts a message only when it came from the
 * page's own window (`event.source === self`) AND passes `isCaptureEnvelope`,
 * then relays it byte-for-byte — no re-wrapping, the service worker expects
 * the raw envelope.
 *
 * `installCaptureForwarder` takes its `window` / `chrome` touch points as an
 * argument so the whole relay is unit-testable in plain Node (this package
 * has no jsdom). The bottom-of-file bootstrap builds the real dependencies
 * and is guarded by `typeof window` / `typeof chrome`, so importing the
 * module under vitest wires nothing — the "no side effect on import"
 * convention `service-worker.ts` and `page-script.ts` both follow.
 */

/// <reference types="chrome" />

import { isCaptureEnvelope } from "../protocol/capture.js";
import type { CaptureEnvelope } from "../protocol/capture.js";

/**
 * The `window` / `chrome` surface the forwarder needs, injected so tests can
 * supply fakes.
 *
 * `addMessageListener`'s handler takes a structural `{ source, data }` — not a
 * DOM `MessageEvent`, which does not exist in the Node test environment — so a
 * test can invoke the captured handler with a plain object literal.
 */
export interface ForwarderDeps {
  readonly addMessageListener: (
    handler: (event: { source: unknown; data: unknown }) => void,
  ) => void;
  /** Relay a validated envelope to the service worker. Synchronous contract. */
  readonly sendToWorker: (envelope: CaptureEnvelope) => void;
  /** The page's own window — messages whose `source` is not this are dropped. */
  readonly self: unknown;
}

/**
 * Wire the `message` listener. Every event must pass BOTH the same-window
 * identity check and `isCaptureEnvelope` before `sendToWorker` is called; a
 * `sendToWorker` that throws (worker suspended, context invalidated) is
 * swallowed silently — a thrown error from a content-script `message`
 * listener surfaces as an uncaught error in the host page, and a lost capture
 * entry is an acceptable price where a page-visible crash is not. The catch
 * body must not call `console.*`: the MAIN-world wrapper intercepts console
 * output, so logging a send failure would generate a fresh capture entry for
 * every failure and loop.
 */
export function installCaptureForwarder(deps: ForwarderDeps): void {
  deps.addMessageListener((event) => {
    if (event.source !== deps.self) return;
    if (!isCaptureEnvelope(event.data)) return;
    try {
      deps.sendToWorker(event.data);
    } catch {
      // Worker suspended / extension context invalidated — drop the entry.
      // Never console.* here (feeds the MAIN-world console wrapper).
    }
  });
}

function bootstrapFromWindow(): void {
  if (typeof window === "undefined" || typeof chrome === "undefined") return;
  installCaptureForwarder({
    addMessageListener: (handler) => {
      window.addEventListener("message", (event) => {
        handler({ source: event.source, data: event.data });
      });
    },
    sendToWorker: (envelope) => {
      void chrome.runtime.sendMessage(envelope);
    },
    self: window,
  });
}

bootstrapFromWindow();
