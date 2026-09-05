# Verification log

Dated, live-Chrome traces backing the behavior documented in
[`TOOLS.md`](TOOLS.md). This is a running log, not a test report — new
horizons append to it rather than rewriting history. See the
[README](../README.md) for setup.

## Manual end-to-end check

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

## Horizon-13 phase-0 feasibility probe (COMPLETE — SPLIT VERDICT)

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

### Path 1 — visible viewport (`captureTab` no params)

**PASS.** Returned a correctly-painted retina PNG of the first ~772 CSS px
(≈3024×1544 device px at DPR 2), matching the on-screen article header. The
unfocused sandbox tab paints the viewport fine — h6 reaffirmed. Repeated
calls before and after the other two paths all succeeded; wall-clock ≈1–3 s;
no blank / clip / hang; `evaluatePage` and `getTabState` unaffected
throughout; no lingering `chrome.debugger` attachment.

### Path 2 — full page (`captureTab { captureBeyondViewport: true }`)

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

### Path 3 — single element (`captureTab { clip: { x, y, width, height, scale: 1 } }`)

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

### h10 failure-mode checklist

| Failure mode | Viewport | `captureBeyondViewport` | `clip` |
|---|---|---|---|
| blank / viewport-clipped / short image | not seen | no image at all (error/hang) | not seen — correct full-element crop |
| hang past 15 s `withDebuggerSession` cap | not seen | **OBSERVED** (17.1 s, attempt A) | not seen (2.06 s) |
| orphaned / wedged debugger attachment | not seen | **capture path wedged** after the timeout; cleared by `reloadTab`; `Runtime.evaluate` never affected | not seen — clean auto-detach |

### Verdict — SPLIT

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

## Manual smoke test

1. `npm run relay` in one terminal.
2. `npm run build:extension`, then chrome://extensions → Load unpacked →
   `tools/nimvarya/dist/extension`.
3. The relay logs an extension `hello` within ~2s.
4. Pipe a command frame through a throwaway `ws` client:
   `{"kind":"command","id":"1","action":"getPageText","params":{}}`
   and confirm the active tab's text comes back keyed by the same `id`.
