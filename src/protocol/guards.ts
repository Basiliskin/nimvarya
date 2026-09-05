/**
 * Hand-written type guards for the wire protocol. Every socket message is
 * parsed as `unknown` and narrowed through these — there are no `as` casts on
 * parsed input anywhere in the package.
 */

import { isPageAction } from "./actions.js";
import type {
  BridgeMessage,
  Command,
  CommandResponse,
  HelloMessage,
  Observation,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  return (
    isRecord(value) &&
    value["kind"] === "hello" &&
    (value["role"] === "extension" || value["role"] === "controller")
  );
}

export function isCommand(value: unknown): value is Command {
  return (
    isRecord(value) &&
    value["kind"] === "command" &&
    typeof value["id"] === "string" &&
    isPageAction(value["action"]) &&
    isRecord(value["params"])
  );
}

export function isCommandResponse(value: unknown): value is CommandResponse {
  if (!isRecord(value) || value["kind"] !== "command-response") return false;
  if (typeof value["id"] !== "string") return false;
  const hasResult = "result" in value && value["result"] !== undefined;
  const hasError = typeof value["error"] === "string";
  // Exactly one of result / error.
  return hasResult !== hasError;
}

export function isObservation(value: unknown): value is Observation {
  return (
    isRecord(value) &&
    value["kind"] === "observation" &&
    (value["observationType"] === "console" ||
      value["observationType"] === "network" ||
      value["observationType"] === "page-error") &&
    typeof value["tabId"] === "number" &&
    typeof value["timestamp"] === "number"
  );
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  return (
    isHelloMessage(value) ||
    isCommand(value) ||
    isCommandResponse(value) ||
    isObservation(value)
  );
}
