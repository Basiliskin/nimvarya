Hard blockers

1. executeScript is dead on LinkedIn — page CSP blocks unsafe-eval.
   Every call returned Evaluating a string as JavaScript violates the following Content Security Policy directive. This runs in the page's MAIN world,
   which inherits the site's CSP. It took out the skill's entire intended extraction path (pull headline, skills[], experience[], dates,
   window.location.href, section visibility as structured values) and also killed using fetch() to hit LinkedIn's own Voyager/GraphQL API.
   Fix: evaluate the header through CDP Runtime.evaluate via the evaluatePage action (horizon 09), since the isolated-world and MAIN-world string-eval routes are both blocked under MV3. This
   single change fixes most of the rest.

2. No scroll primitive. There's no scrollPage / scrollBy / scrollToElement. The skill's tooling table assumes one ("scrollPage (via executeScript)") but
   with executeScript blocked there's nothing. LinkedIn's new profile UI is React Server Components + virtualized lists that only render sections when
   they enter the viewport.
   Cost: couldn't load the full Skills list (~15 of 40+), Recommendations, and on the main profile page the About/Experience/Featured sections never
   rendered at all.
   Fix: a scroll({dy}) / scrollToBottom() tool driven from the extension, not the page.
   
   Horizon 10 status (2026-09-03): a scrollPage action now ships (CDP Input.dispatchMouseEvent wheel + Runtime.evaluate window.scrollBy/scrollTo fallback).
   Two problems found: (1) the wheel hangs on the sandbox tab, so scrollPage now bounds it (session 15s timeout + guaranteed detach, plus a bounded
   wheel attempt that falls through to the Runtime.evaluate scroll) so it can actually move the window; (2) DEEPER: the deliberately-unfocused sandbox tab
   suspends the browser render pass (scroll events, IntersectionObserver, and content-visibility:auto all confirmed dead on a trivial local page), so no
   virtualized/lazy list materializes rows there on any scroll. scrollPage can move the window but cannot reveal rows — the LinkedIn
   skills-list/Recommendations materialization this item exists to enable will need the sandbox tab to render, or a different scroll target.

   RESOLVED for window movement (2026-09-03, horizon 10): scrollPage verified live to increase the unfocused sandbox tab's window.scrollY
   (0 → 3000 → 9422/bottom on a long Wikipedia article, observed method "script"). STILL OPEN as a future-horizon item: virtualized /
   lazy-rendered row materialization, which depends on the sandbox tab running a render pass (see blocker 3 and the roadmap blockers.md).

3. No wait/settle primitive. No waitForSelector, waitForNavigation, or network-idle option. getPageText / readPage are point-in-time snapshots — on an
   SPA that's mid-hydration you get the skeleton (main profile page returned ~1,800 chars, zero sections). My only lever was reloadTab then immediately
   re-read and hope.
   Fix: optional {waitFor: "selector" | "networkidle", timeoutMs} on the read tools.

   RESOLVED (2026-09-03, horizon 11): a standalone `waitFor` page action ships (wait-condition poll module + full parity
   surface, PAGE_ACTIONS 19→20). Live head-to-head passed in a fresh post-rebuild chrome-bridge MCP session against
   https://animevost.org/ (executeScript-injected fixtures; top-level data: URL nav is blocked by Chrome):
   - selector-present: {met:true, elapsedMs:427} on a JS-inserted node; {met:false, elapsedMs:3000} on a nonexistent selector (clean not-met, no throw).
   - network-idle: {met:true, elapsedMs:523–841} after real /time.php fetch bursts stop; {met:false, elapsedMs:4000} against a timer-free recursive fetch loop.
   - fixed-delay: {met:true, elapsedMs:505 / 1505 / 2006} for delayMs 500 / 1500 / 2000 — wall-clock accurate.
   - CSP-safe: adversarial selector `img"];window.__pwned=1;alert(1)//` → {met:false}, no dialog, window.__pwned undefined; selector reaches querySelectorAll only as a serialized arg.
   - Manifest: git diff vs HEAD empty; source vs built dist permissions identical (no new permission).
   Discovery: the unfocused sandbox tab throttles page timers to ~1/sec, so the network-idle timeout path needs a
   timer-free fetch chain to exercise live (parallels blocker 2's h10 render-pass-suspension finding).

Partial blockers

4. readNetworkRequests doesn't return response bodies for the requests that matter. LinkedIn's RSC/Voyager responses came back as contentType:
   application/octet-stream, bodyPreview length 0. So I couldn't recover the structured profile JSON from the network layer as a fallback. (Also the full
   dump was 766K chars → spilled to a file; a urlPattern filter helps but the bodies were still empty.)
   Fix: capture and expose response bodies (at least for text/* and application/json), even truncated.

5. clickElement is CSS-selector-only, no text or XPath. LinkedIn's class names are obfuscated and rotate per deploy (_96169ba5 bbd5e08b a0590980 …).
   Several clicks on "…more", "Show all skills", and category tabs returned clicked: false — element was aria-hidden, not yet in the DOM, or the synthetic
   click was ignored by the React handler.
   Fix: support clickElement({text}) / getByRole, and dispatch a fuller event sequence (pointerdown/mouseup/click) so framework handlers fire.

6. findElement returns only a count, not the elements. It's an existence check, not an extraction tool — no refs, no text, no attributes.
   (claude-in-chrome's equivalent find returns usable refs.)
   Fix: return matched elements with a ref + innerText + key attributes.

   RESOLVED (2026-09-04, horizon 12): `findElement` now returns `{matches, total, truncated}`, each match carrying a
   self-contained CSS-locator `ref`, the element's visible `innerText`, and the fixed key-attribute map (`tagName` plus
   `id`, `class`, `role`, `aria-label`, `href`, `name`, `type`, `data-testid`; absent attributes `null`). Still a pure
   ISOLATED-world `chrome.scripting` read — no new manifest permission, no CDP, no caller-supplied string eval — with the
   cap applied in-page before the structured-clone boundary (`MAX_FIND_ELEMENT_MATCHES` 50, `MAX_ELEMENT_TEXT_CHARS` 500).
   Live-verified on https://en.wikipedia.org/wiki/Chromium_(web_browser) — normal match, empty-not-error no-match, the
   50-of-2170 element cap, text truncation at 500 (716→500), a hostile selector rejected as a SyntaxError by the CSS
   parser with no execution, and a returned `ref` re-resolving to its original element. Full quoted evidence in the
   "Verified 2026-09-04 (horizon 12)" block under manual-verification step 13 in README.md.
   Caveat: `text` is `innerText`, so `visibility: hidden` elements match and get a working `ref` but return `""`.
   Note: the planned claude-in-chrome head-to-head could not run (Claude in Chrome not connected in that session);
   corroboration was done cross-mechanism via CDP `evaluatePage` instead, and is recorded in the README as a substitution.

7. captureTab is viewport-only. No full-page screenshot, no element screenshot, and with no scroll I can't even walk down the page taking tiles.
   Anything below the fold is invisible.
   Fix: captureTab({fullPage: true}).
