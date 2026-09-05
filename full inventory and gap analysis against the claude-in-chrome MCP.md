Currently supported — 16 page actions

┌─────────────────┬────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────┐
│ Group │ Actions │ Notes │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Health │ ping │ relay+extension liveness │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Navigation │ navigateTo(url), navigateBack, navigateForward, │ full parity with claude-in-chrome's navigate │
│ │ reloadTab │ │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Page read │ getPageText(maxChars?) → body.innerText; │ no semantic/accessibility snapshot │
│ │ readPage(maxChars?) → raw outerHTML │ │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Element query │ findElement(selector) → match count only │ no bounding boxes, no text, no refs │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Selector │ clickElement(selector), typeText(selector, text) │ typeText sets .value + fires input/change — it does not send real │
│ interaction │ │ keystrokes │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Coordinate │ clickAt(x,y) (pointerdown/up/click), hover(x,y) │ synthetic/untrusted events; phase 1 confirmed they do reach React │
│ interaction │ (pointerover/mouseover) │ handlers on react.dev + mui.com │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Screenshot │ captureTab → visible-viewport PNG (base64 image │ viewport only; uncapped size │
│ │ block) │ │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Observation │ readConsoleMessages(since?,limit?), │ per-tab ring buffers, cursor-based, fetch/XHR only; full parity with │
│ │ readNetworkRequests(since?,limit?) │ claude-in-chrome │
├─────────────────┼────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ │ executeScript(code) → MAIN-world (0,eval)(code), │ defeated by strict page CSP (phase 1: github.com → hard error). The only │
│ Script eval │ JSON round-trip │ CSP-fragile action; all the others use chrome.scripting function │
│ │ │ injection and survive CSP. │
└─────────────────┴────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────┘

Architecture: one installed MV3 extension + a ws://127.0.0.1:8766 relay; any MCP client connects via one stdio server. Acts only on the active tab of
the current window, top frame only (all_frames:false), permissions [tabs, activeTab, scripting, storage, alarms], no debugger.

Missing vs claude-in-chrome

High-impact gaps (block real "replacement" use)

┌───────────────────────┬─────────────────────────────────┬───────────────────────────┬───────────────────────────────────────────────────────────┐
│ Capability │ claude-in-chrome │ chrome-bridge │ Why it matters │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ Real keyboard │ computer key/hold_key/type │ ✗ none │ Can't press Enter/Tab/Escape/arrows, can't submit a form, │
│ │ │ │ can't use ⌘K/keyboard nav, can't fill native <select> │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ Scroll │ computer scroll │ ✗ (only via executeScript │ Can't reach below-the-fold elements on a strict-CSP page │
│ │ │ → breaks on CSP sites) │ │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ Element → coordinates │ find + read_page return │ findElement returns a │ You must executeScript to get an element's x/y — and │
│ / refs │ actionable refs & boxes │ number │ that's CSP-fragile. This is the biggest ergonomic gap. │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ Tab management │ tabs_context, tabs_create, │ ✗ single active-tab model │ Can't open/close/switch tabs, can't target a background │
│ │ tabs_close │ (the open tabId blocker) │ tab, can't list what's open │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ Accessibility-tree │ read_page (semantic snapshot + │ raw outerHTML only │ No stable, compact, ref-addressable page model — the │
│ read │ refs) │ │ thing agents actually drive from │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ │ │ synthetic untrusted DOM │ Fails on isTrusted checks, native <select> dropdowns, │
│ Trusted input │ CDP-level trusted events │ events │ real drag-drop with dataTransfer, browser chrome, OS file │
│ │ │ │ pickers │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ Rich mouse │ double/right/middle click, │ click + hover only │ No context menus, no drag reorder, no hover-without-click │
│ │ mouse_move, left_click_drag │ │ sequences requiring cursor position │
├───────────────────────┼─────────────────────────────────┼───────────────────────────┼───────────────────────────────────────────────────────────┤
│ Wait primitives │ implicit load/settle handling │ ✗ caller polls, 30 s hard │ No wait-for-selector / network-idle │
│ │ │ timeout per action │ │
└───────────────────────┴─────────────────────────────────┴───────────────────────────┴───────────────────────────────────────────────────────────┘

Medium-impact gaps

┌────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────┐
│ Capability │ chrome-bridge status │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Window / viewport resize (resize_window) │ ✗ — can't test responsive layouts │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ File upload (file_upload) │ ✗ — can't drive <input type=file> (gated on the CDP decision) │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Image injection (upload_image) │ ✗ │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Full-page / element-clipped screenshots │ ✗ — viewport PNG only, no format/quality options │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Batch actions (browser_batch) │ ✗ — every action is its own relay round-trip │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ iframe content │ ✗ — top frame only │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Cross-session / multi-browser (list/select/switch_browser) │ ✗ — one extension, one relay │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Named shortcuts / macros (shortcuts_list/execute) │ ✗ │
├────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ GIF / action recording (gif_creator) │ ✗ │
└────────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────┘

Lower-impact / niche

Cookie & storage inspection (only via CSP-fragile executeScript), download observation, JS dialog handling (alert/confirm/beforeunload),
permission-prompt handling, cursor_position.

What it would take to be a full replacement

The project's own deferred decisions already frame this. In priority order:

1. Resolve CDP-vs-DOM (the horizon-4 evidence feeds this). Strict-CSP executeScript failure + the untrusted-event ceiling mean a DOM-only bridge has a
   hard capability wall. A chrome.debugger/CDP path unlocks trusted input, scroll, keyboard, Runtime.evaluate that ignores CSP, and full-page
   screenshots in one move.
2. A real page model — replace findElement-count + readPage-HTML with an accessibility-tree snapshot returning ref-addressable elements with bounding
   boxes (removes the executeScript-to-get-coordinates dependency).
3. Keyboard action — pressKey / key-chord, even in the DOM model.
4. Scroll action — first-class, not via executeScript.
5. Tab-targeting model (listTabs + optional tabId param) — the other open blocker.
6. Then the medium list: resizeWindow, fileUpload, element/full-page screenshots, browser_batch, iframe support.

Note the flip side: chrome-bridge already beats claude-in-chrome on one axis — it's a persistent, client-agnostic installed extension + relay that any
MCP terminal tool can share, with console/network capture at full parity.
