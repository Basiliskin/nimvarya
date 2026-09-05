/**
 * Service-worker entry for the standalone extension.
 *
 * At module top level it wires the three pieces together — keepalive alarm,
 * command dispatcher over the real page-action handlers, and the reconnecting
 * bridge client — so a worker that wakes from an alarm re-runs this and
 * re-establishes the socket. None of the wiring lives inside
 * `chrome.runtime.onInstalled` / `onStartup`, which do NOT fire on an
 * alarm-triggered wake.
 *
 * `startServiceWorker` takes its dependencies as arguments so it is unit
 * testable; the guarded top-level call supplies the production ones. Under
 * vitest there is no `chrome` global, so importing this module has no side
 * effect — the same "guard against side-effect-on-import" convention the relay
 * entry uses.
 */

/// <reference types="chrome" />

import { isPageAction } from "../protocol/actions.js";
import { createBridgeClient, DEFAULT_BRIDGE_URL } from "./bridge-client.js";
import type { BridgeClient, BridgeSocketFactory } from "./bridge-client.js";
import { createCommandDispatcher } from "./command-dispatch.js";
import { chromeCaptureDebuggerPorts } from "./debugger-ports.js";
import type { DebuggerPorts } from "./debugger-ports.js";
import { chromeCapturePorts } from "./capture-ports.js";
import type { CapturePorts } from "./capture-ports.js";
import { createCaptureStore, installCaptureIntake } from "./capture-store.js";
import type { CaptureStore } from "./capture-store.js";
import { installBridgeKeepalive } from "./keepalive.js";
import type { AlarmsPort } from "./keepalive.js";
import { pageActionHandlers } from "./page-actions.js";
import { chromeCommandPorts } from "./ports.js";
import type { ChromePorts } from "./ports.js";
import { chromeSandboxTabPorts } from "./sandbox-ports.js";
import type { SandboxTabPorts } from "./sandbox-ports.js";

export interface ServiceWorkerDeps {
  readonly alarms: AlarmsPort;
  readonly ports: ChromePorts;
  readonly sandboxTabPorts: SandboxTabPorts;
  readonly debuggerPorts: DebuggerPorts;
  readonly capturePorts: CapturePorts;
  readonly socketFactory: BridgeSocketFactory;
  readonly url?: string;
}

/**
 * What `startServiceWorker` hands back: the reconnecting bridge client (as
 * before) plus the per-tab capture store, so the final phase can give the
 * store to the readConsoleMessages / readNetworkRequests handlers.
 */
export interface StartedServiceWorker {
  readonly client: BridgeClient;
  readonly captureStore: CaptureStore;
}

export function startServiceWorker(
  deps: ServiceWorkerDeps,
): StartedServiceWorker {
  installBridgeKeepalive(deps.alarms);

  const captureStore = createCaptureStore();
  installCaptureIntake(deps.capturePorts, captureStore);

  const dispatch = createCommandDispatcher(
    pageActionHandlers(
      deps.ports,
      deps.sandboxTabPorts,
      deps.debuggerPorts,
      captureStore,
    ),
  );

  const client = createBridgeClient({
    url: deps.url ?? DEFAULT_BRIDGE_URL,
    socketFactory: deps.socketFactory,
    onCommand: (command) => {
      // `command` is already narrowed to a valid `command` frame by the client;
      // this keeps the dispatcher's looser input type honest.
      const action = isPageAction(command.action) ? command.action : "";
      return dispatch({ id: command.id, action, params: command.params });
    },
  });

  return { client, captureStore };
}

const productionSocketFactory: BridgeSocketFactory = (url) =>
  new WebSocket(url);

if (typeof chrome !== "undefined" && typeof WebSocket !== "undefined") {
  startServiceWorker({
    alarms: chrome.alarms,
    ports: chromeCommandPorts(),
    sandboxTabPorts: chromeSandboxTabPorts(),
    debuggerPorts: chromeCaptureDebuggerPorts(),
    capturePorts: chromeCapturePorts(),
    socketFactory: productionSocketFactory,
  });
}
