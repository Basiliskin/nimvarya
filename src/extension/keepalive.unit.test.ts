import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installBridgeKeepalive,
  resetBridgeKeepaliveForTests,
} from "./keepalive.js";
import type { AlarmsPort } from "./keepalive.js";

function fakeAlarms(): {
  port: AlarmsPort;
  create: ReturnType<typeof vi.fn>;
  listeners: ((alarm: { name: string }) => void)[];
} {
  const listeners: ((alarm: { name: string }) => void)[] = [];
  const create = vi.fn();
  return {
    create,
    listeners,
    port: {
      create,
      onAlarm: {
        addListener: (cb) => listeners.push(cb),
      },
    },
  };
}

describe("installBridgeKeepalive", () => {
  beforeEach(() => {
    resetBridgeKeepaliveForTests();
  });

  it("registers the alarm exactly once even when called repeatedly", () => {
    const alarms = fakeAlarms();
    installBridgeKeepalive(alarms.port);
    installBridgeKeepalive(alarms.port);
    installBridgeKeepalive(alarms.port);

    expect(alarms.create).toHaveBeenCalledTimes(1);
    expect(alarms.create).toHaveBeenCalledWith("bridge-keepalive", {
      periodInMinutes: 0.5,
    });
  });

  it("ignores alarms with another name without throwing or dialing", () => {
    const alarms = fakeAlarms();
    installBridgeKeepalive(alarms.port);

    expect(alarms.listeners).toHaveLength(1);
    expect(() => {
      alarms.listeners.forEach((cb) => {
        cb({ name: "some-other-alarm" });
      });
    }).not.toThrow();
  });

  it("resetBridgeKeepaliveForTests lets a later call re-register", () => {
    const first = fakeAlarms();
    installBridgeKeepalive(first.port);
    resetBridgeKeepaliveForTests();
    const second = fakeAlarms();
    installBridgeKeepalive(second.port);

    expect(second.create).toHaveBeenCalledTimes(1);
  });
});
