/**
 * MV3 service-worker keepalive.
 *
 * An MV3 service worker is suspended after ~30s with no pending work, which
 * drops the outbound relay WebSocket with it. A recurring `chrome.alarms` tick
 * is the standard MV3 keepalive: each firing is itself service-worker activity,
 * so it resets the idle timer before the connection is dropped. Copied
 * (boky-free already) from boky's infrastructure bridge keepalive module.
 */

const ALARM_NAME = "bridge-keepalive";
const PERIOD_MINUTES = 0.5;

/** The subset of the `chrome.alarms` API this module depends on. */
export interface AlarmsPort {
  create(name: string, info: { periodInMinutes: number }): void;
  onAlarm: {
    addListener(callback: (alarm: { name: string }) => void): void;
  };
}

let installed = false;

/** Idempotent: calling this more than once still registers the alarm only once. */
export function installBridgeKeepalive(alarms: AlarmsPort): void {
  if (installed) return;
  installed = true;

  alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });
  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    // No-op: the alarm firing is itself the keepalive. The bridge client's own
    // reconnect timer re-establishes the socket if this wake finds it closed.
  });
}

/** Test-only: reset the idempotency guard between tests. */
export function resetBridgeKeepaliveForTests(): void {
  installed = false;
}
