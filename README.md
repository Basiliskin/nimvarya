# nimvarya

A **standalone, boky-free Chrome-control bridge** for MCP-capable terminal AI
coding tools (Claude Code, Codex CLI, Gemini CLI, Cursor). It is extracted from
boky's devtools bridge but shares no code with it — boky keeps working unchanged.

It has (or will have, as horizons land) three parts:

- **extension/** — a standalone MV3 Chrome extension that executes page actions
  and captures page events;
- **relay** — a local `ws` server that routes frames between the extension and
  any number of controllers, bound to `127.0.0.1`;
- **mcp** — a stdio MCP server exposing the page actions as discrete tools.

## Why it exists

Terminal AI coding tools need a way to drive a real Chrome tab — navigate, read, find, click, type, screenshot, query console / network — through an MCP surface that works across clients (Claude Code, Codex CLI, Gemini CLI, Cursor). `nimvarya` is a standalone, boky-free implementation of that path: an MV3 extension, a local WebSocket relay bound to `127.0.0.1`, and a stdio MCP server that exposes the page actions as discrete tools. It is shared as an open-source community contribution and is independent from boky's devtools bridge.

## License

MIT.

## Setup

```bash
cd tools/nimvarya
npm install
npm run verify   # typecheck + lint + test
```

This package is **self-contained**: its own `package.json`, `tsconfig.json`,
`eslint.config.mjs` and `vitest.config.ts`, its own lockfile, and its own
`npm run verify`. Nothing is inherited from the repo root, and it is deliberately
**not** wired into the root `scripts/verify.sh` (same as `services/nest-host`).

## Conventions

- `src/protocol/actions.ts` — `PAGE_ACTIONS` is the **single source of truth**
  for the supported actions. Every consumer (extension handler map, MCP tool
  catalog) types itself `Record<PageAction, …>` so drift is a `tsc` error.
- Every non-`types.ts` file under `src/` has a co-located `.unit.test.ts` that
  names its exports — the repo-wide `.testguard.json` catch-all applies here.
- Every exported symbol must have an importer. The repo's dead-export hook only
  scans `extension/src`, so this convention is kept by hand in this package.

## Running the parts

```bash
npm run relay              # standalone relay on ws://127.0.0.1:8766 (NIMVARYA_PORT overrides)
npm run build:extension    # → dist/extension/  (Load unpacked in chrome://extensions)
npm run mcp                # stdio MCP server (usually launched by an MCP client, not by hand)
```

## MCP client config

The stdio MCP server advertises the twenty page actions as discrete tools —
`ping`, `navigateTo`, `getPageText`, `readPage`, `findElement`, `clickElement`,
`typeText`, `captureTab`, `readConsoleMessages`, `readNetworkRequests`,
`executeScript`, `evaluatePage`, `navigateBack`, `navigateForward`,
`reloadTab`, `clickAt`, `hover`, `getTabState`, `scrollPage`, `waitFor` —
one clearly-described tool each
(no
`ext_command` umbrella tool, no enum arg).
`captureTab` returns an MCP image block; every other tool returns text; a
relay/extension failure comes back as an `isError` result, never a thrown
transport error.

### `captureTab`

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

### `readConsoleMessages` / `readNetworkRequests`

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

#### Per-client status

Only Claude Code has been hand-verified on this machine. The other three entries
below are configuration documentation, not test results — do not read them as a
guarantee that the snippet works there.

- **Claude Code** — hand-verified. With `npm run relay` running and
  `tools/nimvarya/dist/extension` loaded unpacked, the snippet above (loaded
  from the repo-root `.mcp.json`, i.e. `command: "node"`,
  `args: ["tools/nimvarya/bin/mcp.mjs"]`) served a live `getPageText` call
  (`maxChars: 400`) against `https://react.dev/` and returned the tab's visible
  text — `{ "text": "React\nv19.2\nSearch\n…", "totalChars": 6590, "truncated": true }`.
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

### Manual end-to-end check

1. `npm run relay` in one terminal.
2. `npm run build:extension`, then chrome://extensions → Load unpacked →
   `tools/nimvarya/dist/extension`.
3. Restart the MCP client in the repo; `/mcp` (Claude Code) shows `nimvarya`
   connected with 20 tools.
4. Call the `nimvarya` `getPageText` tool against an open tab — the tab's
   visible text comes back as text content.
5. Call `captureTab` — a PNG screenshot comes back as an image block. Call it
   again with `{ "mode": "element", "elementRef": "<ref>" }` where `<ref>` is a
   CSS-locator returned by `findElement` — a crop of that single element comes
   back as an image block with `width`/`height`. Confirm an over-large element
   is automatically re-captured down the ladder and either comes back as
   `captured: true` with `appliedScale < 1` (and `attempts > 1`) or, if the
   give-up floor is still over the ceiling, as `reason: "too-large"` with
   `size`/`limit`/`floor`/`attempts`; and a bogus elementRef as
   `reason: "element-not-found"`.

   Verified 2026-09-04 (horizon 13) against a live signed-in Chrome via a fresh
   post-rebuild `nimvarya` MCP session, after `npm run build:extension`
   rebuilt `dist/extension/` and the unpacked extension was reloaded in
   `chrome://extensions`. Verified on the deliberately unfocused sandbox tab
   (`getTabState` → `sandboxTabActive: false`, sandbox tab `1799011799`,
   active tab `chrome://extensions/` id `1799007334`). Page:
   `https://en.wikipedia.org/wiki/Chromium_(web_browser)`. `evaluatePage` →
   `{ scrollHeight: 10194, innerHeight: 772, innerWidth: 1512, scrollY: 0,
   devicePixelRatio: 2 }`. Freshness is evidenced by the running build's own
   output shape, not asserted (the horizon-12 precedent): element-mode
   `captureTab` honoured `mode: "element"` and returned an element-only crop (the
   pre-horizon-13 build ignored the params and returned a viewport shot), and the
   default no-arg capture returned `captured: true` where the shipped rev1
   ceiling (600_000) would have rejected it — both only producible by the h13
   rev2 code.

   - **Default / viewport mode** — `captureTab` (no mode field) →
     `{ "captured": true, "width": 3024, "height": 1544, "clipped": false }`.
     `innerWidth` 1512 × DPR 2 = 3024 and `innerHeight` 772 × DPR 2 = 1544, i.e.
     the returned image is exactly the viewport at DPR 2. It came back as an
     **image, not** `{ "captured": false, "reason": "too-large" }`, proving the
     recalibrated ceiling no longer rejects the default capture — the rev1
     attempt-1 regression (`size: 844960 vs limit: 600000`) is gone. The success
     metadata block exposes `width`/`height`/`clipped` but not the byte size, so
     the "comfortably under the ceiling" conclusion rests on the capture being
     accepted plus `MAX_SCREENSHOT_BASE64_CHARS = 1_200_000` (measured live
     ~845 KB / 844960 chars at DPR 2 + headroom), not on an un-surfaced size.
   - **Element mode, scrolled into view first** — target `table.wikitable` (ref
     `#mwArk`), initially below the fold at `scrollY 0` (`getBoundingClientRect`
     → `{ x: 264, y: 4459.77, width: 546.67, height: 201.34 }`, `y` ≫
     `innerHeight` 772). `scrollPage { amountPx: 4250 }` →
     `{ "method": "script", "scrollYBefore": 0, "scrollYAfter": 4250,
     "reachedEnd": false }` (the `Runtime.evaluate` `scrollBy` fallback — the
     wheel path hangs in the unfocused tab, as established in horizon 10). Then
     `captureTab { "mode": "element", "elementRef": "#mwArk" }` →
     `{ "captured": true, "width": 1092, "height": 402, "clipped": false }`.
     Cross-check vs CDP `evaluatePage` `getBoundingClientRect` at the same scroll
     (`scrollY 4250`): page rect `{ x: 264, y: 209.77, width: 546.67, height:
     201.34 }`, `inViewport: true`. Reconciliation with DPR 2: CSS `546.67 × 2 =
     1093.34` ≈ image `1092` px and CSS `201.34 × 2 = 402.69` ≈ image `402` px —
     both within ~2 px of sub-pixel rounding. The returned image content (FreeBSD
     Tier 1 / OpenBSD rows) matches the element's `findElement` innerText;
     `clipped: false` confirms the element was fully in view after the scroll.
   - **Full-page not offered (horizon-13 record; superseded)** — at the horizon-13
     build only two modes existed (`viewport` / `element`), and
     `captureBeyondViewport` was non-functional on the unfocused tab
     (phase-0 probe 2026-09-04: hangs past the 15 s cap or errors CDP `-32000`,
     never an image). Horizon 15 **supersedes this**: the render-the-tab primitive
     (CDP `Emulation.setFocusEmulationEnabled`) enables a brief render pass, so
     `full-page` mode now ships and captures the whole scrollable document.
   - **Un-scrolled below-the-fold limitation (deferred)** — capturing `#mwArk`
     WITHOUT scrolling it into view first yields a BLANK image on the unfocused
     sandbox tab (attempt-1 evidence: ref `#mwArk` at `y = 4459.77`, `scrollY 0`,
     captured blank ~1093×403, reproduced twice) because the tab runs no paint
     pass for off-viewport content (horizon-10 render-pass suspension). Reliable
     below-the-fold element capture is deferred behind the same render-the-tab
     prerequisite; in this horizon the caller scrolls the element into view via
     `scrollPage` first (exactly as done above).
   - **No orphaned `chrome.debugger` attachment** — every CDP-dependent command in
     this run (navigateTo, evaluatePage ×2, findElement, scrollPage, captureTab
     viewport + element) completed promptly with no 15 s `withDebuggerSession`
     timeout and no CDP `-32000`, and `getTabState` still reports the sandbox tab
     correctly. The only wedged-attachment symptom ever observed (the
     `Page.captureScreenshot` path stalling at 15 s until `reloadTab`, recorded in
     the phase-0 probe) was never seen here, so no orphaned attachment is present.
   - **Guard coverage** — horizon 13 recorded that, because every capture path it
     shipped was viewport-bounded (default viewport, or an in-view element clip
     cropped to the viewport), the too-large branch cannot fire on a real capture.
     Horizon 14 **supersedes this claim**: an oversized screenshot is now
     automatically re-captured down the downscale ladder (ceiling 1_200_000, rungs
     0.75/0.5/0.33), so the branch is deliberately reachable and is exercised by the
     horizon-14 live head-to-head (see the horizon-14 verified block below). The
     `page-actions.unit.test.ts` boundary tests still cover the ladder's
     fit-on-a-rung and floor-exhaustion paths, and the `server.unit.test.ts` tests
     cover the give-up non-image routing.

   Verified 2026-09-04 (horizon 14) against a live Chrome session via a fresh
   post-rebuild `nimvarya` MCP session — the deliberate exercise of the
   downscale ladder on a genuinely oversized capture, i.e. the branch the
   horizon-13 "Guard coverage" note above said could not fire. Page:
   `http://127.0.0.1:8123/boky-oversize.html` (served over localhost; a synthetic
   page whose `<canvas>` fills the 1512×772 CSS layout viewport at DPR 2 — 3024×1544
   device pixels — with high-entropy random noise, which is essentially
   incompressible in PNG, so the screenshot is dominated by it).
   `navigateTo` → `getTabState` → `{ url:
   "http://127.0.0.1:8123/boky-oversize.html", title: "oversize 3024x1544 dpr=2" }`,
   `evaluatePage` → `{ cssW: 1512, cssH: 772, dpr: 2, canvasW: 3024, canvasH: 1544,
   pngBase64Chars: 21418778 }`.

   - **Pre-ladder size** — the full-size capture exceeded the ceiling by a large
     margin: the ladder only engages when the initial base64 length is above the
     ceiling, and the in-page full-resolution canvas PNG measured `21418778` base64
     chars; the ladder's own give-up measurement (floor size `1981332` at scale
     `0.33`) implies a full-size ≈ `1981332 ÷ 0.33² ≈ 18.2M` base64 chars. The two
     agree within ~15 % (downscaled PNG encoding is not exactly area-proportional);
     both are ~15–18× the ceiling — a clear, non-marginal margin.
   - **Ceiling / ladder / floor** — `MAX_SCREENSHOT_BASE64_CHARS = 1_200_000`;
     `SCREENSHOT_DOWNSCALE_LADDER_SCALES = [0.75, 0.5, 0.33]`;
     `SCREENSHOT_DOWNSCALE_FLOOR_SCALE = 0.33`.
   - **Observed** — `captureTab` (no args → viewport mode) →
     `{ "captured": false, "reason": "too-large", "size": 1981332, "limit": 1200000,
     "floor": 0.33, "attempts": 4 }`, delivered to the MCP client as an `isError`
     text block (never a throw, never an empty image block).
   - **Interpretation** — the initial capture was over the ceiling, so the handler
     re-captured at 0.75, then 0.5, then 0.33 (`attempts` = 1 initial + 3 rungs);
     even the give-up floor (0.33) returned `size 1981332` which is still
     `> limit 1200000`, so the ladder terminated at the defined give-up outcome.
     This proves the ladder engages on a real oversized capture, runs within its
     bounded rungs (no unbounded loop), completes promptly inside the 15 s cap (no
     orphaned `chrome.debugger` attachment), and emits the documented give-up shape.
   - **Catalog freshness** — the `nimvarya` MCP `captureTab` tool catalog
     already carried the current payload (fresh, not stale): the observed result
     includes the new `floor`/`attempts` give-up fields and the tool description
     matches the observed ladder, so no direct-CDP fallback was needed. (The
     devtools relay `captureTab` is a separate, lower-fidelity capture path and was
     not used as the size authority.)
   - **Supersedes horizon 13** — this is the live exercise of the branch the
     horizon-13 "Guard coverage" note above marked untestable ("cannot fire on a
     real capture"); the horizon-14 run disproves that claim.
6. Open a page that logs to the console and issues a `fetch`/XHR, then call
   `readConsoleMessages` and `readNetworkRequests` — the captured entries come
   back oldest-first with a `nextSince` cursor. Call each again passing the
   returned `nextSince` as `since` and confirm only newer entries are returned
   (and, after ~1 minute idle, that the buffers survived the keepalive).
7. Call `executeScript` with `{ "code": "document.title" }` — the page's title
   comes back as `{ "value": "..." }`. Call it with `{ "code": "window.jQuery &&
   'has-jquery'" }` on a page that loads jQuery to confirm MAIN-world globals are
   in scope, and with `{ "code": "document.body" }` to confirm a DOM node comes
   back as an error, not a value.
8. Navigate the tab to a second page, then call `navigateBack` — the tab returns
   to the first page. Call `navigateBack` again from a tab with no earlier entry
   and confirm the result is an error, not `{ "moved": true }`. Then call
   `navigateForward` — the tab advances to the second page again; call
   `navigateForward` once more and confirm the no-later-entry error.
9. Call `reloadTab` on any open tab and confirm the page refreshes (a client-side
   counter resets, the network panel shows the document re-fetched).
10. Call `clickAt` with the `x`/`y` of a visible button (read them off the page) —
   the button's click handler fires. Call it with an `x`/`y` over blank page
   margin and confirm the result is `{ "found": false, "dispatched": 0 }`, and
   with a negative or fractional coordinate and confirm it comes back as an error.
11. Call `hover` with the `x`/`y` of an element that shows a tooltip / hover
   state on `mouseover` — the hover state appears. Call it over blank page margin
   and confirm `{ "found": false, "dispatched": 0 }`, and with a fractional
   coordinate and confirm the error.
12. Call `evaluatePage` with `{ "code": "document.querySelector('h1')?.innerText" }`
   on github.com (a strict-CSP site) — the headline text comes back as a value.
   Call `executeScript` with the same code to confirm it returns the page's CSP
   error instead, proving the CDP path is what makes the difference.

   Verified 2026-09-03 (horizon 09) against a live signed-in Chrome via the
   `nimvarya` MCP: on the github.com sandbox tab, `evaluatePage`
   `{ code: "document.querySelector('h1')?.innerText" }` →
   `{ "value": "The future of building happens together" }` while `executeScript`
   with the identical code → the page CSP error
   (`script-src github.githubassets.com`). On reddit.com,
   `evaluatePage` `{ code: "document.title + ' | ' + location.hostname" }` →
   `{ "value": "Reddit - The heart of the internet | www.reddit.com" }` (and a
   follow-up DOM read returned `shreddit-app` present, 94 links) while
   `executeScript` with the same code → the page CSP error
   (`script-src 'self' 'strict-dynamic' 'report-sample' 'nonce-…'`).
13. Call `findElement` with `{ "selector": "h1, h2, h3" }` against a real
    page — the result returns one entry per matched element, each carrying a
    CSS-locator `ref`, the element's visible `innerText`, and the fixed
    key-attribute map (`tagName` plus `id`, `class`, `role`, `aria-label`,
    `href`, `name`, `type`, `data-testid`; absent attributes appear as `null`).
    Call it with `{ "selector": ".does-not-exist" }` and confirm the result is
    `{ matches: [], total: 0, truncated: false }`, NOT an error. Call it
    against a high-cardinality selector (every `<a>` or every `<li>` on the
    page) and confirm `matches.length` is capped at `MAX_FIND_ELEMENT_MATCHES`
    (default `50`), `total` is the pre-cap match count, and `truncated: true`.
    Finally call it with a hostile selector (e.g. `">>>not css<<<"`) and
    confirm the result is an empty list — no throw, no error. Re-feed any
    returned `ref` to itself or to `clickElement` and confirm it resolves.

    Verified 2026-09-04 (horizon 12) against a live signed-in Chrome via a
    `nimvarya` MCP session whose tool catalog already carried the horizon-12
    `findElement` description, after `npm run build:extension` reproduced
    `dist/extension/service-worker.js` byte-identically (47 662 bytes). Freshness
    is evidenced by the running extension's own output shape, not asserted: every
    call below returns `{matches, total, truncated}` with per-match
    `ref`/`text`/`attributes`, which the pre-horizon-12 build could not emit (it
    returned `{found, matches: <number>}`). Page:
    `https://en.wikipedia.org/wiki/Chromium_(web_browser)`, on the deliberately
    unfocused sandbox tab (`getTabState` → `sandboxTabActive: false`, sandbox tab
    `1799010670`, active tab `chrome://extensions/`).

    - **Normal match** — `findElement { "selector": "h1#firstHeading" }` →
      `{"matches":[{"ref":"#firstHeading","text":"Chromium (web browser)","attributes":{"tagName":"h1","id":"firstHeading","class":"firstHeading mw-first-heading","role":null,"ariaLabel":null,"href":null,"name":null,"type":null,"dataTestid":null}}],"total":1,"truncated":false}`.
      The `ref` took the unique-id short-circuit; `text` is real visible text, not
      collapsed, from the unfocused tab; absent attributes are `null`, not omitted.
    - **No match** — `findElement { "selector": ".does-not-exist-anywhere-xyz" }` →
      `{"matches":[],"total":0,"truncated":false}`, a success result, **not** an
      error and not a throw.
    - **High-cardinality cap** — `findElement { "selector": "a" }` → exactly 50
      matches with `"total": 2170, "truncated": true`. `MAX_FIND_ELEMENT_MATCHES`
      (50) fired in-page: only 50 descriptors crossed the structured-clone
      boundary while `total` reports the full pre-slice count.
    - **Per-element text cap** — `findElement { "selector": "#mw-content-text p" }`
      → `"total": 46, "truncated": true` with 46 matches. Because 46 < the
      50-element cap, `truncated` here is set *solely* by `MAX_ELEMENT_TEXT_CHARS`
      (500). Confirmed against uncapped lengths read independently via
      `evaluatePage`: `#mwAZ0` is 716 chars in the page and came back at 500
      (cut mid-word at "We will not implemen"); `#mwAg0` is 737 → 500; `#mwLw` is
      351 → returned whole and untruncated.
    - **Adversarial selector** — `findElement` with the hostile string
      `>>>not css<<< "]);alert(1);//` → `{"matches":[],"total":0,"truncated":false}`.
      No throw, no error leak, and no code execution: `evaluatePage` running
      `document.querySelectorAll` on the identical string returns
      `"threw: SyntaxError"`, i.e. the CSS parser rejected it as a selector. The
      `alert(1)` payload never ran — the string reached `querySelectorAll` only as
      a serialized argument.
    - **Ref round-trip** — the `ref` `#toc-Licensing > a:nth-of-type(1)` returned by
      the `"a"` call, re-fed to `findElement`, resolved to exactly one element with
      the same `text` (`"Licensing"`) and `href` (`"#Licensing"`), i.e. `total: 1`.

    Independent corroboration was done with `evaluatePage` (the CDP
    `Runtime.evaluate` path) rather than claude-in-chrome's `find`, because
    Claude in Chrome was not connected in this session — `.mcp.json` configures
    only `extension-bridge` and `nimvarya`, and no claude-in-chrome tool was
    exposed. This is a **substitution against the horizon-12 plan, recorded as
    such**, not a claim the planned head-to-head ran. It does cross mechanisms:
    `evaluatePage` reaches the page through `chrome.debugger`/CDP, while the code
    under test is a `chrome.scripting` ISOLATED-world read, so the two agree
    without sharing an implementation. Field-by-field on the same page and same
    targets: link count `document.querySelectorAll('a').length` → `2170`, exactly
    `findElement`'s `total`; `h1#firstHeading` innerText → `"Chromium (web
    browser)"`, byte-identical to the returned `text`; `#toc-Licensing >
    a:nth-of-type(1)` → found, `text` `"Licensing"`, `href` `"#Licensing"`,
    matching the round-trip; `#mw-content-text p` count → `46`, exactly
    `findElement`'s `total`. No divergence was found in match counts, ordering,
    text, or attribute payloads.

    **Caveat worth knowing, found during this check:** `text` is `innerText`, so it
    is layout-aware and reports *visible* text. Several sidebar `<a>` matches in the
    `"a"` call came back with `"text": ""` while still carrying a working `ref` and
    full attributes. That is correct behavior, not a suspended-render artifact:
    `#n-mainpage-description > a` computes to `visibility: hidden` (the collapsed
    Vector-2022 menu) with a non-zero rect of 186×28, and its `textContent` is
    `"Main page"` while its `innerText` is `""`. A caller that needs DOM text
    regardless of visibility should not read it out of `findElement`. Conversely
    this confirms `innerText` semantics genuinely survive the unfocused sandbox
    tab — visible elements (the `h1`, the table-of-contents links, all 46 content
    paragraphs) returned full real text.

    No new permission: `git -C tools/nimvarya diff HEAD -- extension/manifest.json`
    produced no output (empty), and `diff extension/manifest.json dist/extension/manifest.json`
    exited 0 with no output (identical) against the freshly rebuilt `dist/`.
14. Call `scrollPage` on a public, no-auth page tall enough to scroll in its main
   document (a long article), reading `window.scrollY` (via `evaluatePage`)
   before and after — the value increases. Call `scrollPage` again to show
   cumulative movement. The result's `method` field reports which mechanism moved
   the page; in the deliberately-unfocused sandbox tab the CDP
   `Input.dispatchMouseEvent` wheel path hangs (bounded, then abandoned) and
   `script` (the `Runtime.evaluate` `window.scrollBy`/`scrollTo` fallback) is the
   expected steady-state mechanism. This proves the scroll motion only: the
   unfocused sandbox tab runs no render pass, so materializing virtualized /
   lazy-rendered rows a prior `readPage` missed is out of scope this horizon and
   held for a future one whose job is to make the sandbox tab render.

   Verified 2026-09-03 (horizon 10) against a live signed-in Chrome via a fresh
   post-rebuild `nimvarya` MCP session, on the unfocused sandbox tab
   (`sandboxTabActive: false`), page
   `https://en.wikipedia.org/wiki/Chromium_(web_browser)`
   (`document.documentElement.scrollHeight` 10194, `window.innerHeight` 772):
   - `evaluatePage` `window.scrollY` → `0`
   - `scrollPage` `{ amountPx: 3000 }` →
     `{ "method": "script", "scrollYBefore": 0, "scrollYAfter": 3000, "reachedEnd": false }`
   - `evaluatePage` `window.scrollY` → `3000` (independent confirmation)
   - `scrollPage` `{ toBottom: true }` →
     `{ "method": "script", "scrollYBefore": 3000, "scrollYAfter": 9422, "reachedEnd": true }`
   - `evaluatePage` `window.scrollY` → `9422` (and `9422 + 772 === 10194`, i.e. the
     document bottom)

   Observed `method` was `script` both calls — the wheel path hangs in the
   unfocused tab as expected and the `Runtime.evaluate` `window.scrollBy` /
   `window.scrollTo` fallback moved the page.
15. Call `waitFor` with `{ "mode": "selector-present", "selector": "#wait-here",
   "timeoutMs": 5000 }` on a page that inserts `#wait-here` into the DOM on a
   timer — it returns `{ "mode": "selector-present", "met": true, "elapsedMs": ... }`
   once the node appears. Call it with a selector that never matches and confirm a
   `{ "met": false }` result after the timeout budget, not an error. Call
   `waitFor` with `{ "mode": "fixed-delay", "delayMs": 500 }` and confirm it
   blocks for ~500ms, and with `{ "mode": "network-idle" }` on a page that issues
   a delayed `fetch`/XHR and confirm it returns once traffic goes quiet.
16. Stop the relay and call any tool again — the result is `isError: true` with a
   message naming the action.

### Horizon-13 phase-0 feasibility probe (COMPLETE — SPLIT VERDICT)

Verified **2026-09-04** (horizon 13, phase 0) against live signed-in Chrome
through a fresh `nimvarya` MCP session, with the relay up (`ping` →
`{ ok: true }`) and the rebuilt shim extension loaded (the MCP `captureTab`
schema now accepts `captureBeyondViewport` and `clip`, and the CDP calls
below actually reached `Page.captureScreenshot`). All work was done on the
deliberately **unfocused** sandbox tab (`getTabState` → `sandboxTabActive:
false`, `activeTab` = `chrome://extensions/` id `1799007334`).

**Target page:** `https://en.wikipedia.org/wiki/Chromium_(web_browser)` —
sandbox tab id `1799011796`. `evaluatePage` on it returned
`{ scrollHeight: 10194, innerHeight: 772, innerWidth: 1512, scrollY: 0,
devicePixelRatio: 2 }` on first load; after a `reloadTab` mid-probe the
article re-measured at `scrollHeight: 9271` (same viewport, same DPR) — a
~9.3–10.2k CSS-px-tall page against a 772 CSS-px viewport, i.e. ~12–13
viewports of scroll.

**Below-the-fold clip target:** `document.querySelector('table.wikitable')`
(ref `#mwArk`, the FreeBSD / OpenBSD "Operating system / Status" table).
`getBoundingClientRect` via `evaluatePage`, at `scrollY: 0`:
`{ x: 264, y: 4459.77, width: 546.67, height: 201.34 }`. `y` (4459.77) is
≫ `innerHeight` (772) and the page was never scrolled — the rect is
genuinely off-screen at capture time.

#### Path 1 — visible viewport (`captureTab` no params)

**PASS.** Returned a correctly-painted retina PNG of the first ~772 CSS px
(≈3024×1544 device px at DPR 2), matching the on-screen article header. The
unfocused sandbox tab paints the viewport fine — h6 reaffirmed. Repeated
calls before and after the other two paths all succeeded; wall-clock ≈1–3 s;
no blank / clip / hang; `evaluatePage` and `getTabState` unaffected
throughout; no lingering `chrome.debugger` attachment.

#### Path 2 — full page (`captureTab { captureBeyondViewport: true }`)

**FAIL — this is the horizon's central risk (risk #1) materialising.**
The option reached CDP but never produced a beyond-viewport image:

- **Attempt A (hang):** `Page.captureScreenshot` did not return.
  `chrome.debugger command timed out after 15000ms while capturing`.
  Measured wall-clock (Date.now bracket around the call): **17 105 ms** —
  the 15 s `withDebuggerSession` cap plus overhead. **Side effect:** the
  *next* plain `captureTab` (no params) **also** timed out at 15000 ms —
  the `Page.captureScreenshot` path stayed wedged. `evaluatePage` and
  `getTabState` (CDP `Runtime.evaluate` / `chrome.tabs`) kept working, so
  the debugger session itself was not fully orphaned; only the capture
  path was stuck. `reloadTab` + a 3 s settle **did** clear it (contrary to
  the h10 note that nav/reload does not help — `reloadTab` specifically
  recovered the capture path here). Plain viewport capture worked again
  after the reload.
- **Attempt B (fast error):** after recovery, a second
  `captureBeyondViewport: true` call failed fast — CDP
  `{ "code": -32000, "message": "Unable to capture screenshot" }` — wall
  clock **3 847 ms**. No wedge this time; the following plain `captureTab`
  succeeded.

So `captureBeyondViewport: true` on the unfocused sandbox tab is
non-functional: it either hangs past the 15 s cap (wedging the capture
path until `reloadTab`) or errors with `-32000`. It never returned an
image, so there is no returned-image height to cross-check against
`scrollHeight` — the comparison is moot because the capture does not
happen.

#### Path 3 — single element (`captureTab { clip: { x, y, width, height, scale: 1 } }`)

**PASS.** `clip: { x: 264, y: 4459.77, width: 546.67, height: 201.34,
scale: 1 }` returned a PNG cropped to **exactly** the below-the-fold
`.wikitable` — the returned image content (FreeBSD 13/12, OpenBSD
-current/-stable rows) matches the element's `innerText` captured earlier
by `findElement`. The element was at `y` 4459.77 and was **never scrolled
into view** (`scrollY` stayed 0). Wall-clock **2 058 ms**, well within the
15 s cap. Clean detach — subsequent `evaluatePage` and `captureTab` calls
both succeeded. Chrome composites a clip rect for off-screen content on the
unfocused sandbox tab even though `captureBeyondViewport` fails.

Returned-image **pixel dimensions** are not readable through the current
MCP surface (the image arrives as an MCP image content block with no
width/height metadata — that metadata is exactly what phase 1 adds to
`CaptureTabResult`). The clip result is nonetheless unambiguous: the
returned image is the target element crop and nothing else. Phase 2's
head-to-head does the numeric pixel cross-check once phase 1 ships the
`width`/`height` result fields.

#### h10 failure-mode checklist

| Failure mode | Viewport | `captureBeyondViewport` | `clip` |
|---|---|---|---|
| blank / viewport-clipped / short image | not seen | no image at all (error/hang) | not seen — correct full-element crop |
| hang past 15 s `withDebuggerSession` cap | not seen | **OBSERVED** (17.1 s, attempt A) | not seen (2.06 s) |
| orphaned / wedged debugger attachment | not seen | **capture path wedged** after the timeout; cleared by `reloadTab`; `Runtime.evaluate` never affected | not seen — clean auto-detach |

#### Verdict — SPLIT

- **Element / `clip` capture: PROCEED.** Clip capture of a genuinely
  below-the-fold element works cleanly on the unfocused sandbox tab,
  inside the time cap, with clean detach. Phase 1's element mode is
  feasible as designed.
- **Full-page / `captureBeyondViewport` capture: REPLAN.**
  `captureBeyondViewport: true` is non-functional on the unfocused sandbox
  tab (hang-then-wedge, or `-32000`). Per this phase's compensation clause,
  full-page capture now needs a different mechanism as a prerequisite — a
  briefly-focus/render-the-sandbox-tab capability, or a client-side
  scroll-and-stitch fallback — both currently listed in `outOfScope` and
  both explicit REPLAN triggers. The horizon must be re-scoped: ship the
  two working modes (viewport default + element `clip`) now, and move
  full-page capture behind a render-the-tab prerequisite in a later
  horizon.

Run from a fresh MCP session against real signed-in Chrome with the relay
running, 2026-09-04.

The built extension (`dist/extension/`) is a plain MV3 extension — no `@crxjs`,
no sign-in — built by three chained Vite passes (`npm run build:extension`)
into three JS files:

- `service-worker.js` (ES module) — on load its service worker dials the
  relay, sends `hello role=extension`, keeps itself alive with a
  `chrome.alarms` tick, and answers the page-action commands (`ping`,
  `navigateTo`, `getPageText`, `readPage`, `findElement`, `clickElement`,
  `typeText`, `captureTab`, `readConsoleMessages`, `readNetworkRequests`,
  `executeScript`, `evaluatePage`, `navigateBack`, `navigateForward`,
  `reloadTab`, `clickAt`, `hover`, `getTabState`, `scrollPage`, `waitFor`) on the active tab.
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

### Manual smoke test

1. `npm run relay` in one terminal.
2. `npm run build:extension`, then chrome://extensions → Load unpacked →
   `tools/nimvarya/dist/extension`.
3. The relay logs an extension `hello` within ~2s.
4. Pipe a command frame through a throwaway `ws` client:
   `{"kind":"command","id":"1","action":"getPageText","params":{}}`
   and confirm the active tab's text comes back keyed by the same `id`.

Full usage docs land in a later horizon.

---

See [`docs/marketing/00-product-facts.md`](docs/marketing/00-product-facts.md) for the verified fact list this README is grounded in.
