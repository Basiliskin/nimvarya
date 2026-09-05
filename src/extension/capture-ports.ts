/**
 * `CapturePorts` — the extra slice of the `chrome.*` API the service-worker
 * capture intake needs, plus its real implementation.
 *
 * Why a second port interface next to `ChromePorts`:
 *
 *   `ChromePorts` (ports.ts) models the four tab/scripting calls the
 *   page-action handlers make *outward*. Capture intake is the opposite
 *   direction: the service worker has to *receive* runtime messages the
 *   ISOLATED forwarder sends and *observe* tab-removal events so a closed
 *   tab's ring buffers can be freed. Neither surface fits `ChromePorts`, and
 *   widening it would drag capture concerns into the horizon-1 handler code.
 *   A small dedicated port keeps `installCaptureIntake` unit-testable with a
 *   fake that just records the two listeners.
 *
 * `chromeCapturePorts` is covered by a co-located unit test that stubs the
 * `chrome` global, and is also exercised end-to-end by the manual Chrome
 * check recorded in the final phase's notes. No `chrome.*` access happens at
 * module load — every reference is inside `chromeCapturePorts`.
 */

/// <reference types="chrome" />

export interface CapturePorts {
  /**
   * Register a listener for runtime messages. `senderTabId` is the id of the
   * tab the message came from, or `undefined` for a sender with no tab (the
   * extension's own popup / devtools page). The listener must not respond, so
   * the underlying message channel is never held open.
   */
  onRuntimeMessage(
    listener: (message: unknown, senderTabId: number | undefined) => void,
  ): void;
  /** Register a listener fired with a tab's id once that tab is closed. */
  onTabRemoved(listener: (tabId: number) => void): void;
}

/** The production `CapturePorts`, backed by the MV3 extension APIs. */
export function chromeCapturePorts(): CapturePorts {
  return {
    onRuntimeMessage: (listener) => {
      chrome.runtime.onMessage.addListener(
        (message: unknown, sender: chrome.runtime.MessageSender) => {
          listener(message, sender.tab?.id);
          // No return / no sendResponse: pull-only intake never answers.
        },
      );
    },
    onTabRemoved: (listener) => {
      chrome.tabs.onRemoved.addListener((tabId) => {
        listener(tabId);
      });
    },
  };
}
