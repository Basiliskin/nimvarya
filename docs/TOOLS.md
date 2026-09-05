# Tool reference

Full behavioral reference for the twenty page-action tools the `nimvarya` MCP
server exposes. For the high-level pitch and setup, see the [README](../README.md).
For dated verification traces (live-Chrome runs proving this behavior), see
[`VERIFICATION.md`](VERIFICATION.md).

The stdio MCP server advertises the twenty page actions as discrete tools —
`ping`, `navigateTo`, `getPageText`, `readPage`, `findElement`, `clickElement`,
`typeText`, `captureTab`, `readConsoleMessages`, `readNetworkRequests`,
`executeScript`, `evaluatePage`, `navigateBack`, `navigateForward`,
`reloadTab`, `clickAt`, `hover`, `getTabState`, `scrollPage`, `waitFor` —
one clearly-described tool each (no `ext_command` umbrella tool, no enum arg).
`captureTab` returns an MCP image block; every other tool returns text; a
relay/extension failure comes back as an `isError` result, never a thrown
transport error.

## `captureTab`

`captureTab` captures a PNG screenshot of the deliberately-unfocused sandbox tab
via Chrome DevTools Protocol (`Page.captureScreenshot`), so it works even when
the tab is not the one a human is looking at. Three modes, discriminated by `mode`
(default `"viewport"`):

- **`viewport`** (default) — capture the tab's current rendered viewport. An
  over-large viewport capture is automatically re-taken smaller down the
  downscale ladder (see **Screenshot size policy** below).
- **`element`** — capture a single element addressed by `elementRef`, a
  self-contained CSS-locator string from `findElement`. The ref is resolved to
  the element's bounding rect via `Runtime.evaluate`
  (`document.querySelector(ref).getBoundingClientRect()`, document-relative),
  then captured as a CDP `clip` rect with `scale: 1`.
- **`full-page`** — capture the tab's whole scrollable document (beyond the
  viewport) via `Page.captureScreenshot({ captureBeyondViewport: true })`. A real
  render pass is briefly enabled on the sandbox tab for the duration of one
  capture (CDP `Emulation.setFocusEmulationEnabled({ enabled: true })`), then
  disabled and the unfocused-tab invariant restored.

A real capture returns `{ captured: true, dataUrl, width, height, clipped,
appliedScale, attempts }` (an MCP image block; `width`/`height` are the returned
image's pixel dimensions, `clipped` is `true` when the element rect exceeded the
viewport, `appliedScale` is the render scale applied — `1` for a full-size capture
or a downscale-ladder rung — and `attempts` counts the captures taken).
An oversized result does not fail: the capture is automatically re-taken smaller
down a bounded downscale ladder (render scales `0.75` / `0.5` / `0.33`; see
**Screenshot size policy** below) until the payload fits — reporting the applied
scale and attempt count — or the give-up floor is still over the ceiling, which
returns `{ captured: false, reason: "too-large", size, limit, floor, attempts }`
carrying the measured size at the floor, the ceiling, the floor scale, and the
attempt count. A no-match or zero-area element returns
`{ captured: false, reason: "element-not-found" | "zero-area" }`, and a
relay/tab problem returns `{ captured: false, reason: "tab-unavailable",
detail }`. Every non-image outcome is surfaced to the MCP client as an
`isError` text block, never an empty image block.

Full-page capture is offered: a brief, reversible render pass is enabled on the
sandbox tab for the duration of one capture via
`Emulation.setFocusEmulationEnabled({ enabled: true })`, then disabled and the
unfocused-tab invariant restored. The horizon-15 phase-0 probe (2026-09-04)
confirmed that `captureBeyondViewport: true` returns non-blank beyond-viewport
pixels only under that render pass, within the 15 s `withDebuggerSession` cap.
The whole-document capture is driven down the same bounded downscale ladder as
the viewport and element modes (see **Screenshot size policy** below).

### Screenshot size policy

`captureTab` enforces one documented **size policy** — the constants that govern
how an oversized screenshot is handled, co-located in `src/extension/page-actions.ts`:

- **Base64 ceiling** — `MAX_SCREENSHOT_BASE64_CHARS` = **1_200_000** base64
  characters. A capture whose encoded base64 length exceeds this is considered
  too large for the AI client (the real dpr-2 viewport base64 is ~845 KB /
  844,960 chars, measured live 2026-09-04, so the ceiling has headroom).
- **Downscale ladder rungs** — `SCREENSHOT_DOWNSCALE_LADDER_SCALES` =
  **`[0.75, 0.5, 0.33]`** (`as const`), in strictly-decreasing render-scale order.
  A viewport capture at these scales is produced by the debugger port's
  whole-viewport scaled-clip option; an element capture lowers its clip's
  `scale` field.
- **Give-up floor** — `SCREENSHOT_DOWNSCALE_FLOOR_SCALE` = **0.33**, equal to the
  ladder's last rung. A capture still over the ceiling here yields the give-up
  outcome.

**How the ladder progresses.** A capture that already fits the ceiling is returned
unchanged (`appliedScale: 1`, `attempts: 1`). Otherwise the handler re-takes the
screenshot at each rung in descending-scale order (0.75, then 0.5, then 0.33),
measuring the base64 payload length after each attempt, and stops at the first
rung whose length is at or below the ceiling — that rung's image is returned with
`appliedScale: <rung>` and `attempts: 1 + <rungs actually tried>`. Every rung
attempt runs inside the CDP session's 15 s cap with the debugger detached in a
`finally`. If even the give-up floor is still over the ceiling, the handler
returns a defined non-throwing give-up outcome:

```json
{ "captured": false, "reason": "too-large",
  "size": <base64 length measured at the give-up floor>,
  "limit": 1200000, "floor": 0.33, "attempts": 4 }
```

`size` is the payload length at the floor rung, `limit` the base64 ceiling,
`floor` the give-up scale, and `attempts` the initial capture plus every rung
tried (so `size` > `limit` for a give-up, and `attempts` ≤ `1 + rungs.length`).
This is surfaced to the MCP client as an `isError` text block — never a blocking
image, never a throw. The caller never has to retry an oversized capture itself.

**Which result you get, at a glance.** A capture is oversized only when its
payload exceeds 1_200_000 base64 chars. The ladder always converges: a page dense
enough that even scale 0.33 stays over the ceiling is the only case that returns
`captured: false`; every smaller case returns `captured: true` with a lower
`appliedScale`. To distinguish a downscaled-but-successful result from a give-up,
read the `captured` field — a give-up also carries `reason: "too-large"`.

The ladder is **scale-only PNG** — a JPEG / quality rung is deliberately out of
scope (YAGNI; a scale-only ladder is a complete delivery, and a JPEG rung would
force a new dimension parser and a generalized data-URL strip).

## `readConsoleMessages` / `readNetworkRequests`

The extension keeps a per-tab ring buffer of the active tab's console output
(`readConsoleMessages` — `log`/`info`/`warn`/`error`/`debug` and uncaught
errors) and its `fetch` / `XHR` traffic (`readNetworkRequests` — method, URL,
status, duration, and a bounded response-body preview).

`executeScript` evaluates a JavaScript expression in the active tab's page
(MAIN world, so page globals and libraries are in scope) and returns its value,
round-tripped through JSON. An expression that yields `undefined`, a function, a
DOM node, or a circular structure comes back as an `{ error }` sentinel, as does
a page whose Content-Security-Policy blocks `eval`. An over-large result (over
1 000 000 JSON characters) is the one distinct case: it is **not a thrown
error** but a structured, non-throwing too-large result — surfaced at the MCP
layer as `isError: true` with `{ tooLarge: true, actualBytes, limitBytes }` — so
a caller can tell "too large to return" apart from a genuine failure.

`evaluatePage` is the sibling for strict-CSP sites: it evaluates a JavaScript
expression in the active tab's page through Chrome DevTools Protocol
(`Runtime.evaluate`), which is not subject to the page's Content-Security-Policy,
so it reads values on github.com, reddit.com and LinkedIn where `executeScript`'s
`chrome.scripting` eval is blocked. Same JSON round-trip and error contract —
including the non-throwing over-large too-large result above; it reads page
state but does not reliably mutate it.

`findElement` returns the matched elements themselves — not just a count — for a
CSS selector against the sandbox tab. Each match carries (a) a self-contained
CSS-locator **ref** that the same `findElement` / `clickElement` selector
string input accepts (an `#id` short-circuit or an `:nth-of-type` chain capped
at 8 levels, so obfuscated-class pages do not produce huge selectors), (b) the
element's visible `innerText`, and (c) a fixed key-attribute map: `tagName`
plus `id`, `class`, `role`, `aria-label`, `href`, `name`, `type`, and
`data-testid` (absent attributes reported as `null` per the package
convention — never omitted, never `undefined`). The selector reaches
`document.querySelectorAll` only as a serialised argument of an
`ISOLATED`-world `chrome.scripting.executeScript` function ref, so it is
CSP-safe and can never be evaluated as code. The result is capped in-page
before the structured-clone boundary: at most `MAX_FIND_ELEMENT_MATCHES`
elements (default `50`) with each element's innerText capped at
`MAX_ELEMENT_TEXT_CHARS` characters (default `500`). The shape is
`{ matches: [...], total: <pre-slice count>, truncated: <bool> }`. A selector
with no matches returns `{ matches: [], total: 0, truncated: false }`, NOT
an error; a hostile selector (syntax error, unbalanced bracket, etc.) yields
the same empty list from the injected function's own try/catch and never
throws across the wire.

`scrollPage` scrolls the sandbox tab's page down through Chrome DevTools Protocol
— `Input.dispatchMouseEvent` as a synthetic wheel first, falling back to a
`window.scrollBy`/`window.scrollTo` script scroll (`Runtime.evaluate`) when the
wheel did not move the page. Its verified capability this horizon is the scroll
motion itself — it increases the sandbox tab's `window.scrollY`. Its eventual aim
is to materialise virtualized / lazy-rendered list rows (rows a framework only
renders into the DOM once scrolled near the viewport) that the ISOLATED-world
reads (`readPage`/`getPageText`/`findElement`) miss because they never trigger a
scroll — but that is **not** proven yet: the deliberately-unfocused sandbox tab
runs no render pass, so scroll events / `IntersectionObserver` /
`content-visibility` never fire there. Row materialisation is held for a future
horizon whose job is to make the sandbox tab render. It takes an optional `amountPx`
(pixels to scroll down, default `2000`) and an optional `toBottom` (one large
downward jump to the current bottom; always downward, no repeat count — call it
again for more), and reports which mechanism actually moved the page in the
result's `method` field (`wheel` | `script` | `none`) with the before/after
`scrollY` and a best-effort `reachedEnd`.

`waitFor` is the settle primitive that replaces a hand-inserted delay between
actions. It blocks until one of three page conditions holds in the sandbox tab and
returns `{ "mode": ..., "met": ..., "elapsedMs": ... }`:
- `selector-present` — a CSS selector appears in the sandbox tab's DOM. Scoped to
  JS-driven DOM mutation only: the deliberately-unfocused sandbox tab runs no
  render pass, so IntersectionObserver / `content-visibility` / lazy-rendered
  nodes are NOT observed.
- `network-idle` — captured `fetch`/`XHR` traffic goes quiet for a window.
- `fixed-delay` — a delay elapses.
Every mode is bounded by an optional `timeoutMs` (default `10000`, clamped to
`[100, 25000]`); hitting the budget is a normal `{ "met": false }` result, never
an error. The three modes are mutually exclusive. It adds no new manifest
permission and evaluates no caller-supplied string as JavaScript — the selector
is only ever passed as a serialisable argument.

`navigateBack` moves the active tab to its previous history entry (the browser's
Back button); it takes no arguments and comes back as an error when the tab has
no earlier entry.

`navigateForward` moves the active tab to its next history entry (the browser's
Forward button); it takes no arguments and comes back as an error when the tab
has no later entry.

`reloadTab` reloads the active tab (the browser's reload button), re-serving the
page from the network; it takes no arguments.

`closeSandboxTab` closes the dedicated sandbox tab — the single tab this bridge
drives all page actions through — and clears its persisted id, so the next page
action lazily recreates a fresh one. It is no-op-safe and never throws: it
returns `{ closed: true, hadTab: true }` when a live sandbox tab was closed, or
`{ closed: false, hadTab: false }` when there is no sandbox tab, the stored id
points to an already-closed tab, or it is called twice in a row. It is scoped to
exactly the sandbox tab, so no other open tab is affected; capture-buffer
eviction for the closed tab is handled by the extension's existing tab-removed
listener, not by this tool. It is an explicit caller-invoked action — the bridge
never closes the tab on its own.

`clickAt` clicks at an `x`/`y` page coordinate (both required, non-negative
integers, CSS pixels from the top-left of the viewport): it dispatches
`pointerdown`, `pointerup` and `click` on the element returned by
`document.elementFromPoint`. Synthetic events are untrusted, so some framework
handlers may ignore them; the result reports `found` (whether an element sat
under the point) and `dispatched` (how many events were fired — `0` when nothing
was there).

`hover` is `clickAt`'s sibling for the hover gesture: at the same `x`/`y` page
coordinate (both required, non-negative integers) it dispatches `pointerover`
then `mouseover` on the element returned by `document.elementFromPoint` — e.g. to
reveal a tooltip before reading it — and dispatches no `pointerdown`/`pointerup`/
`click`. Same untrusted-event caveat and same `found` / `dispatched` result shape
as `clickAt`.

Both `read*` tools take an
optional `since` (non-negative integer, default `0`) and `limit` (positive
integer, default `100`, clamped to `500`) and return:

- `entries` — matching entries, oldest first, each stamped with a monotonic
  `seq`; at most `limit` of them
- `nextSince` — the cursor to pass back as `since` on the next call to get only
  newer entries. **Reading never deletes entries**; a non-positive/`NaN`/string
  `since` or `limit` is rejected with an error, not coerced.
- `dropped` — `true` when the ring overwrote entries your `since` never covered
- `truncated` — `true` when strictly more entries matched than were returned

Buffer caps (all from `src/protocol/capture.ts` /
`src/extension/capture-buffer.ts`): `DEFAULT_MAX_ENTRIES` = 500 entries per tab
per channel, `MAX_CONSOLE_TEXT_BYTES` = 8192, `MAX_BODY_PREVIEW_BYTES` = 4096.
The buffers are **in memory in the extension's service worker** — they are lost
when the tab is closed or the MV3 service worker is suspended, and a `since`
held from before a suspension is treated as `0` (a full window) rather than an
error.

On top of those per-entry/per-buffer caps, each `read*` result is also bounded
as a whole: `MAX_CONSOLE_READ_RESULT_CHARS` = 1_000_000 and
`MAX_NETWORK_READ_RESULT_CHARS` = 3_000_000 (both `src/extension/page-actions.ts`),
each measured against the JSON length of the entire serialised result (the
`entries` array plus `nextSince`/`dropped`/`truncated`), not any single entry.
A read whose serialised result exceeds its ceiling is not trimmed or
paginated down to fit — the whole result is replaced wholesale by the same
non-throwing too-large outcome `executeScript`/`evaluatePage` use, surfaced at
the MCP layer as `isError: true` with `{ tooLarge: true, actualBytes,
limitBytes }`, so a caller can tell "too large to return" apart from a genuine
failure. No console/network entries are returned in that case — retry with a
smaller `limit`.

## MCP registration

It is registered for Claude Code in the repo-root `.mcp.json`. Use exactly this
one snippet (the `args` path is relative to the repo root):

```json
{
  "nimvarya": {
    "type": "stdio",
    "command": "node",
    "args": ["tools/nimvarya/bin/mcp.mjs"],
    "env": {}
  }
}
```

The relay URL defaults to `ws://127.0.0.1:8766`; set `NIMVARYA_URL` in
`env` to point elsewhere. The launcher resolves its own location via
`import.meta.url`, so the client's working directory does not matter.

### Per-client status

Only Claude Code has been hand-verified on this machine. The other three entries
below are configuration documentation, not test results — do not read them as a
guarantee that the snippet works there.

- **Claude Code** — hand-verified. See [`VERIFICATION.md`](VERIFICATION.md) for
  the live-call trace.
- **Gemini CLI** — config-documentation-only; no live Gemini tool call was run
  (live Gemini verification is out of scope for this project). Gemini CLI does
  not pick up a pasted `mcpServers` block from `~/.gemini/settings.json` (that
  file has never carried an `mcpServers` key); register the server with its
  subcommand instead:

  ```bash
  gemini mcp add nimvarya -- node tools/nimvarya/bin/mcp.mjs
  ```

- **Codex CLI** — documentation-only. The `codex` binary is not installed on this
  machine, so the snippet has not been exercised there.
- **Cursor** — documentation-only. The `cursor-agent` binary is not installed on
  this machine, so the snippet has not been exercised there.

## Built extension architecture

The built extension (`dist/extension/`) is a plain MV3 extension — no `@crxjs`,
no sign-in — built by three chained Vite passes (`npm run build:extension`)
into three JS files:

- `service-worker.js` (ES module) — on load its service worker dials the
  relay, sends `hello role=extension`, keeps itself alive with a
  `chrome.alarms` tick, and answers the page-action commands on the active tab.
  `readPage` / `getPageText` cap output at 200 000 characters
  (`maxChars` param overrides) and report `truncated` + `totalChars`; the two
  `read*` tools query the per-tab capture ring buffers with a `since`/`limit`
  cursor.
- `page-script.js` (classic IIFE) — declared in the manifest as a
  `document_start` content script in the **MAIN** world; wraps the page's
  `console`, `fetch`, and `XMLHttpRequest` and posts bounded capture entries
  to the page via `window.postMessage`.
- `capture-forwarder.js` (classic IIFE) — a `document_start` content script
  in the default **ISOLATED** world; picks up those envelopes and relays them
  to the service worker over `chrome.runtime.sendMessage`.

Only `service-worker.js` is emitted by the first (output-emptying) pass; the
two content-script passes append to `dist/extension/` without wiping it.
