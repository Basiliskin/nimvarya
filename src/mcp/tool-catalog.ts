/**
 * The MCP tool catalog — one discrete tool per `PAGE_ACTIONS` entry.
 *
 * Two of the tools — `readConsoleMessages` / `readNetworkRequests` — read a
 * per-tab ring buffer of captured page activity with a shared `since` / `limit`
 * cursor (`SINCE_LIMIT_PROPERTIES`).
 *
 * Boky's MCP server exposed a single `ext_command` tool whose `action` was an
 * enum of 20 boky-specific names. Terminal MCP clients (Codex CLI, Gemini CLI,
 * Cursor) handle enum-valued params inconsistently, so this package advertises
 * one clearly-described tool per action instead.
 *
 * `TOOL_CATALOG` is typed `Record<PageAction, ToolCatalogEntry>`: adding an
 * action to `PAGE_ACTIONS` without a catalog entry is a `tsc` error. That is the
 * compile-time replacement for boky's runtime regex `check-command-parity.mjs`.
 * `listTools()` derives the advertised list from `PAGE_ACTIONS` (never from
 * `Object.keys(TOOL_CATALOG)`), so an accidental extra catalog entry could never
 * be advertised without a matching action.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { PAGE_ACTIONS } from "../protocol/actions.js";
import type { PageAction } from "../protocol/actions.js";

/**
 * A JSON-Schema object description of one tool's arguments. The index signature
 * matches the SDK `Tool.inputSchema` catch-all so the catalog assigns cleanly to
 * `Tool[]` without a cast.
 */
interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Record<string, object>;
  readonly required?: string[];
  readonly additionalProperties: false;
  readonly [key: string]: unknown;
}

interface ToolCatalogEntry {
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

const NO_ARGS: JsonSchemaObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const SINCE_LIMIT_PROPERTIES = {
  since: {
    type: "integer",
    minimum: 0,
    description:
      "Sequence cursor: only entries with a `seq` greater than this are returned. Omit (or pass 0) to read from the start of the buffer. Pass the `nextSince` from the previous result to get only entries captured since that call. Defaults to 0.",
  },
  limit: {
    type: "integer",
    minimum: 1,
    description:
      "Maximum number of entries to return, oldest first. Defaults to 100, clamped to a maximum of 500. If more entries matched than were returned the result reports `truncated: true`.",
  },
} as const;

const COORDINATE_PROPERTIES = {
  x: {
    type: "integer",
    minimum: 0,
    description:
      "X page coordinate in CSS pixels, measured from the left edge of the viewport.",
  },
  y: {
    type: "integer",
    minimum: 0,
    description:
      "Y page coordinate in CSS pixels, measured from the top edge of the viewport.",
  },
} as const;

const MAX_CHARS_PROPERTY = {
  maxChars: {
    type: "integer",
    minimum: 1,
    description:
      "Maximum number of characters to return; the result is truncated past this and reports `truncated: true`. Defaults to 200000.",
  },
} as const;

/**
 * The `scrollPage` input schema. Both properties are optional — the port applies
 * the `amountPx` default (2000) and the `toBottom` single-jump semantics, and a
 * caller needing more scrolling calls the tool again (no `direction`, no repeat
 * count). Deliberately kept as a shared `as const` block, mirroring the other
 * scalar/coordinate property blocks above.
 */
const SCROLL_PROPERTIES = {
  amountPx: {
    type: "number",
    minimum: 0,
    description:
      "Pixels to scroll down. Optional — defaults to 2000 (roughly one large viewport). Scroll is always downward.",
  },
  toBottom: {
    type: "boolean",
    description:
      "One large downward jump toward the current bottom (document.documentElement.scrollHeight), not a loop. Optional — a caller needing more scrolling calls the tool again.",
  },
} as const;

/**
 * The `waitFor` input schema fields. `mode` is the exclusive discriminator; the
 * mode-specific fields (`selector` for `selector-present`, `delayMs` for
 * `fixed-delay`) are required by exactly one branch of the tool schema's `oneOf`,
 * so the modes cannot both be satisfied by one payload. `timeoutMs` is optional
 * everywhere and bounded to the poll module's clamped range
 * (`[MIN_TIMEOUT_MS, HARD_CAP_MS]`).
 */
const WAIT_FOR_PROPERTIES = {
  mode: {
    type: "string",
    enum: ["selector-present", "network-idle", "fixed-delay"],
    description:
      "Which page condition to wait for — mutually exclusive: `selector-present` (a CSS selector appears in the sandbox tab's DOM), `network-idle` (captured fetch/XHR traffic goes quiet for a window), or `fixed-delay` (a delay elapses).",
  },
  selector: {
    type: "string",
    description:
      "Required for `selector-present`: the CSS selector to wait for. Scoped to JS-driven DOM mutation only — the deliberately-unfocused sandbox tab runs no render pass, so IntersectionObserver / content-visibility / lazy-rendered nodes are NOT observed.",
  },
  delayMs: {
    type: "integer",
    minimum: 0,
    description:
      "Required for `fixed-delay`: milliseconds to wait before resolving met.",
  },
  timeoutMs: {
    type: "integer",
    minimum: 100,
    maximum: 25000,
    description:
      "Overall budget in ms for the wait. Clamped to [100, 25000]. Defaults to 10000.",
  },
} as const;

export const TOOL_CATALOG: Record<PageAction, ToolCatalogEntry> = {
  ping: {
    description:
      "Health check — confirms the relay and extension are connected. Takes no arguments.",
    inputSchema: NO_ARGS,
  },
  navigateTo: {
    description: "Navigate the active browser tab to a URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute URL to load in the active tab.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  getPageText: {
    description:
      "Return the visible text (`document.body.innerText`) of the active tab.",
    inputSchema: {
      type: "object",
      properties: { ...MAX_CHARS_PROPERTY },
      additionalProperties: false,
    },
  },
  readPage: {
    description:
      "Return the full HTML (`document.documentElement.outerHTML`) of the active tab.",
    inputSchema: {
      type: "object",
      properties: { ...MAX_CHARS_PROPERTY },
      additionalProperties: false,
    },
  },
  findElement: {
    description:
      "Return the matched elements from the sandbox tab that match a CSS selector. Each match carries a self-contained CSS-locator ref (re-usable by findElement / clickElement), the element's visible innerText, and a fixed key-attribute map (tagName plus id, class, role, aria-label, href, name, type, data-testid; absent attributes reported as null). Result is capped in-page — at most `MAX_FIND_ELEMENT_MATCHES` elements returned (default 50), each innerText capped at `MAX_ELEMENT_TEXT_CHARS` characters (default 500) — with the pre-slice count in `total` and `truncated: true` set when either cap fired. A selector with no matches returns `{ matches: [], total: 0, truncated: false }`, NOT an error.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to match against the active tab's DOM.",
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  clickElement: {
    description:
      "Click the first element in the active tab matching a CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to click.",
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  typeText: {
    description:
      "Set the value of the first form field / contenteditable matching a CSS selector and dispatch input/change events.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the field to type into.",
        },
        text: { type: "string", description: "Text to enter into the field." },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
  captureTab: {
    description:
      'Capture a PNG screenshot of the active tab via Chrome DevTools Protocol (`Page.captureScreenshot`). Defaults to the current rendered viewport; pass `mode: "element"` with an `elementRef` (a CSS-locator ref from `findElement`) to capture a single element, or `mode: "full-page"` to capture the whole scrollable document (a real render pass is briefly enabled on the sandbox tab for the duration of one capture, then restored). Returns a `data:image/png;base64,...` dataUrl as an MCP image block plus width/height/clipped metadata and, when an oversized screenshot was automatically re-taken smaller, the applied render scale (`appliedScale`) and attempt count (`attempts`). An oversized result is automatically re-captured down a bounded downscale ladder (render scales 0.75 / 0.5 / 0.33); a rung that fits returns the image with the applied scale recorded, and exhausting the give-up floor returns a defined too-large outcome carrying `size` / `limit` / `floor` / `attempts` rather than a blocking image. A no-match / zero-area element returns a structured non-image outcome.',
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["viewport", "element", "full-page"],
          description:
            "Which capture to perform — `viewport` (the default) captures the current rendered viewport; `element` captures one element addressed by `elementRef`; `full-page` captures the whole scrollable document. Omit (or `viewport`) for the default viewport capture.",
        },
        elementRef: {
          type: "string",
          description:
            "Required when `mode` is `element`: a self-contained CSS-locator ref from `findElement`, resolved to the element's bounding box for the clip capture. Ignored when `mode` is `viewport` or `full-page`.",
        },
      },
      additionalProperties: false,
    },
  },
  readConsoleMessages: {
    description:
      "Return console messages (log/info/warn/error/debug and uncaught errors) captured from the active tab, oldest first. Reading never deletes entries: pass the returned `nextSince` back as `since` on the next call to get only newer messages. Buffers are per-tab, in memory in the extension, and are lost when the tab closes or the extension's service worker is suspended. An over-large result comes back as a structured too-large error, not a value.",
    inputSchema: {
      type: "object",
      properties: { ...SINCE_LIMIT_PROPERTIES },
      additionalProperties: false,
    },
  },
  readNetworkRequests: {
    description:
      "Return network requests (fetch and XHR) captured from the active tab, oldest first, with method, URL, status, duration and a bounded response-body preview. Reading never deletes entries: pass the returned `nextSince` back as `since` on the next call to get only newer requests. Buffers are per-tab, in memory in the extension, and are lost when the tab closes or the extension's service worker is suspended. An over-large result comes back as a structured too-large error, not a value.",
    inputSchema: {
      type: "object",
      properties: { ...SINCE_LIMIT_PROPERTIES },
      additionalProperties: false,
    },
  },
  executeScript: {
    description:
      "Evaluate a JavaScript expression in the active tab's page (MAIN world, so page globals and libraries are in scope) and return its value. The value is round-tripped through JSON: an expression that yields `undefined`, a function, a DOM node, a circular structure, or an over-large result comes back as an error, not a value. A page whose Content-Security-Policy blocks `eval` also comes back as an error.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript expression to evaluate in the page. The last expression's value is returned (e.g. `document.title`, `window.location.href`, `JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))`).",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  evaluatePage: {
    description:
      "Evaluate a JavaScript expression in the active tab's real page context via Chrome DevTools Protocol (`Runtime.evaluate`, which is not subject to the page's Content-Security-Policy) and return its value. Unlike `executeScript`, this reads values on strict-CSP sites (github.com, reddit.com, LinkedIn) where `chrome.scripting` eval is blocked. It reads page state; it does not reliably mutate it. The value is round-tripped through JSON: `undefined`, a non-serialisable value, a thrown error, or an over-large result comes back as an error, not a value.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript expression to evaluate in the page. The last expression's value is returned (e.g. `document.querySelector('h1')?.innerText`).",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  navigateBack: {
    description:
      "Move the active browser tab back to its previous history entry (like the browser's Back button). Takes no arguments. Returns an error if the tab has no earlier entry.",
    inputSchema: NO_ARGS,
  },
  navigateForward: {
    description:
      "Move the active browser tab forward to its next history entry (like the browser's Forward button). Takes no arguments. Returns an error if the tab has no later entry.",
    inputSchema: NO_ARGS,
  },
  reloadTab: {
    description:
      "Reload the active browser tab (like the browser's reload button), re-serving the page from the network. Takes no arguments.",
    inputSchema: NO_ARGS,
  },
  clickAt: {
    description:
      "Click at an x/y coordinate in the active tab: dispatch pointerdown, pointerup and click on the element sitting under that point (document.elementFromPoint). Synthetic events are untrusted, so some framework handlers may not react. Returns whether an element was found and how many events were dispatched.",
    inputSchema: {
      type: "object",
      properties: { ...COORDINATE_PROPERTIES },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  hover: {
    description:
      "Hover at an x/y coordinate in the active tab: dispatch pointerover and mouseover on the element sitting under that point (document.elementFromPoint), e.g. to reveal a tooltip before reading it. Synthetic events are untrusted, so some framework handlers may not react. Returns whether an element was found and how many events were dispatched.",
    inputSchema: {
      type: "object",
      properties: { ...COORDINATE_PROPERTIES },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  getTabState: {
    description:
      "Return the dedicated sandbox tab and the currently-focused (active) tab of the sandbox tab's window, each as { id, url, title }, plus a `sandboxTabActive` flag for whether the sandbox tab is itself that focused tab. Read-only: no tab is created, focused, or mutated. Takes no arguments.",
    inputSchema: NO_ARGS,
  },
  scrollPage: {
    description:
      "Scroll the dedicated sandbox tab down via Chrome DevTools Protocol to materialise virtualized / lazy-rendered list rows the ISOLATED-world DOM reads (`readPage`/`getPageText`/`findElement`) cannot reach — those reads never trigger a scroll. Tries a synthetic `Input.dispatchMouseEvent` wheel first, then a `window.scrollBy`/`window.scrollTo` `Runtime.evaluate` fallback, and reports which mechanism actually moved the page in the result's `method` field (`wheel` | `script` | `none`). Always scrolls downward.",
    inputSchema: {
      type: "object",
      properties: { ...SCROLL_PROPERTIES },
      additionalProperties: false,
    },
  },
  waitFor: {
    description:
      "Block until one of three page conditions holds in the sandbox tab, then return `{ mode, met, elapsedMs }`. A timeout is a normal `{ met: false }` result, never an error. Selector mode observes JS-driven DOM mutation only — the sandbox tab's render pass is suspended, so IntersectionObserver / content-visibility / lazy-rendered nodes are not seen.",
    inputSchema: {
      type: "object",
      properties: { ...WAIT_FOR_PROPERTIES },
      required: ["mode"],
      additionalProperties: false,
      oneOf: [
        {
          properties: {
            mode: { enum: ["selector-present"] },
            selector: { ...WAIT_FOR_PROPERTIES.selector },
          },
          required: ["mode", "selector"],
        },
        {
          properties: { mode: { enum: ["network-idle"] } },
          required: ["mode"],
        },
        {
          properties: {
            mode: { enum: ["fixed-delay"] },
            delayMs: { ...WAIT_FOR_PROPERTIES.delayMs },
          },
          required: ["mode", "delayMs"],
        },
      ],
    },
  },
  closeSandboxTab: {
    description:
      "Close the dedicated sandbox tab (if one exists) and clear its persisted id, so the next page action lazily recreates a fresh tab. No-op-safe and never throws: returns `{ closed: true, hadTab: true }` when a live sandbox tab was closed, or `{ closed: false, hadTab: false }` when there is no sandbox tab, the stored id points to an already-closed tab, or it is called twice in a row. Scoped to exactly the sandbox tab — no other (non-sandbox) open tab is affected. Capture-buffer eviction for the closed tab is handled by the extension's existing tab-removed listener, not by this tool. Takes no arguments.",
    inputSchema: NO_ARGS,
  },
};

/**
 * The `tools/list` payload, derived from `PAGE_ACTIONS` so the advertised set is
 * exactly the supported action set — in that order.
 */
export function listTools(): Tool[] {
  return PAGE_ACTIONS.map((name) => ({
    name,
    description: TOOL_CATALOG[name].description,
    inputSchema: TOOL_CATALOG[name].inputSchema,
  }));
}
