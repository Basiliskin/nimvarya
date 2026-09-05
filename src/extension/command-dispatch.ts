/**
 * Command dispatcher — turns an incoming `command` frame into exactly one
 * `command-response` frame.
 *
 * The handler map is typed `Record<PageAction, Handler>`, so the extension
 * fails to compile if `PAGE_ACTIONS` gains an entry with no handler. That is
 * the compile-time parity check on the extension side, replacing boky's
 * runtime `check-command-parity.mjs` regex.
 */

import { isPageAction } from "../protocol/actions.js";
import type { PageAction } from "../protocol/actions.js";
import type { CommandResponse } from "../protocol/types.js";

/**
 * A handler returns a result payload or, on bad params / a handled failure, an
 * `{ error }` sentinel. It may also throw — the dispatcher turns a throw into
 * an `error` response too.
 */
export type HandlerOutcome =
  | { readonly result: unknown; readonly error?: undefined }
  | { readonly error: string; readonly result?: undefined };

export type Handler = (
  params: unknown,
) => Promise<HandlerOutcome> | HandlerOutcome;

/** The shape the dispatcher accepts — deliberately looser than `Command` so an
 *  unknown `action` string is representable (and testable). */
export interface IncomingCommand {
  readonly id: string;
  readonly action: string;
  readonly params: unknown;
}

export type CommandDispatcher = (
  command: IncomingCommand,
) => Promise<CommandResponse>;

export function createCommandDispatcher(
  handlers: Record<PageAction, Handler>,
): CommandDispatcher {
  return async (command: IncomingCommand): Promise<CommandResponse> => {
    const { id, action } = command;
    if (!isPageAction(action)) {
      return { kind: "command-response", id, error: `unknown action ${action}` };
    }
    try {
      const outcome = await handlers[action](command.params);
      if (outcome.error !== undefined) {
        return { kind: "command-response", id, error: outcome.error };
      }
      return { kind: "command-response", id, result: outcome.result };
    } catch (error) {
      return {
        kind: "command-response",
        id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
