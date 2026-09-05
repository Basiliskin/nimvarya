# Product Facts

> Single source of truth for all downstream marketing skills. No promotional material may claim more than this document supports.

## Verified facts

Every fact traced to a repository file, the README, or the user. The `source:` field is restricted to `<repo-relative path>` | `README` | `user`.

- Package name is `nimvarya`, `private: true`, `type: module` — source: `package.json`
- Described in `package.json` as "Standalone, boky-free Chrome-control bridge for MCP-capable terminal AI coding tools" — source: `package.json`
- Has three parts: an MV3 Chrome `extension/`, a local `relay` (`ws` server), and an `mcp` stdio server — source: README
- Targeted at MCP-capable terminal AI coding tools: Claude Code, Codex CLI, Gemini CLI, Cursor — source: README
- The extension is an MV3 extension (manifest_version 3) with name "Chrome Bridge", version 0.1.0 — source: `extension/manifest.json`
- Manifest declares permissions: `tabs`, `activeTab`, `scripting`, `storage`, `alarms`, `debugger`, with `<all_urls>` host permissions — source: `extension/manifest.json`
- Extension service worker is an ES module (`service-worker.js`, `type: module`) — source: `extension/manifest.json`
- Extension ships two content scripts: a MAIN-world `page-script.js` and an ISOLATED-world `capture-forwarder.js`, both at `document_start` — source: `extension/manifest.json`
- The package is a plain MV3 extension built with three chained Vite passes (`npm run build:extension`) into three JS files (`service-worker.js`, `page-script.js`, `capture-forwarder.js`) — source: README, `vite.extension.config.ts`, `package.json`
- Built with no `@crxjs`, no sign-in — source: README
- Default relay URL is `ws://127.0.0.1:8766`, overridable via `NIMVARYA_PORT` (port) and `NIMVARYA_URL` (full URL) — source: README, `src/relay/main.ts`, `src/controller/controller-client.ts`
- The relay binds `127.0.0.1` only and is a trimmed port of boky's `services/nest-host/src/bridge-relay/bridge-relay.service.ts` — source: `src/relay/relay.ts`
- The relay supports exactly one extension socket and any number of controllers; routing: `command` → every extension, `command-response`/`observation` → every controller — source: `src/relay/relay.ts`, `src/protocol/types.ts`
- Wire protocol has four frame kinds: `hello`, `command`, `command-response`, `observation` — source: `src/protocol/types.ts`
- A socket's role is fixed by its FIRST `hello` frame and never changes — source: `src/relay/relay.ts`
- `PAGE_ACTIONS` is the single source of truth for the supported actions: `ping`, `navigateTo`, `getPageText`, `readPage`, `findElement`, `clickElement`, `typeText`, `captureTab`, `readConsoleMessages`, `readNetworkRequests`, `executeScript`, `evaluatePage`, `navigateBack`, `navigateForward`, `reloadTab`, `clickAt`, `hover`, `getTabState`, `scrollPage`, `waitFor`, `closeSandboxTab` (21 actions) — source: `src/protocol/actions.ts`
- Every consumer (extension handler map, MCP tool catalog) types itself `Record<PageAction, …>` so drift is a `tsc` error — source: README, `src/mcp/tool-catalog.ts`
- The MCP server advertises one discrete tool per action (no `ext_command` umbrella tool, no enum arg) — source: README, `src/mcp/tool-catalog.ts`
- MCP server name: `nimvarya`, version `0.0.0` — source: `src/mcp/main.ts`, `package.json`
- MCP `captureTab` returns a PNG as an MCP image block; every other tool returns text — source: README, `src/mcp/main.ts`
- A relay/extension failure surfaces as an `isError: true` MCP result, never a thrown transport error — source: README, `src/mcp/main.ts`
- `captureTab` captures the deliberately-unfocused sandbox tab via Chrome DevTools Protocol `Page.captureScreenshot`, working even when the tab is not the one the human is looking at — source: README, `src/extension/page-actions.ts`
- `captureTab` supports three modes discriminated by `mode`: `viewport` (default), `element` (uses `elementRef` CSS-locator), `full-page` (whole scrollable document via `captureBeyondViewport`) — source: README, `src/protocol/types.ts`, `src/mcp/tool-catalog.ts`
- `captureTab` enforces a screenshot size policy: `MAX_SCREENSHOT_BASE64_CHARS = 1_200_000`, downscale ladder rungs `[0.75, 0.5, 0.33]`, give-up floor `0.33` — source: `src/extension/page-actions.ts`
- An oversized capture is automatically re-taken smaller down the ladder until a rung fits or the give-up floor is still over the ceiling, returning `{ captured: false, reason: "too-large", size, limit, floor, attempts }` — source: README, `src/extension/page-actions.ts`
- `evaluatePage` uses CDP `Runtime.evaluate` (CSP-safe) to read values on strict-CSP sites like github.com, reddit.com, LinkedIn where `executeScript`'s `chrome.scripting` eval is blocked — source: README, `src/mcp/tool-catalog.ts`, `src/extension/debugger-ports.ts`
- `executeScript` runs in MAIN world, exposing page globals and libraries — source: README, `src/mcp/tool-catalog.ts`
- `findElement` returns matched elements (not just a count), each with a self-contained CSS-locator `ref`, the element's visible `innerText`, and a fixed key-attribute map (`tagName` + `id`, `class`, `role`, `aria-label`, `href`, `name`, `type`, `data-testid`; absent attributes reported as `null`) — source: README, `src/protocol/types.ts`, `src/mcp/tool-catalog.ts`
- `findElement` caps results in-page at `MAX_FIND_ELEMENT_MATCHES = 50` and per-element text at `MAX_ELEMENT_TEXT_CHARS = 500` — source: `src/extension/page-actions.ts`
- A selector with no matches returns `{ matches: [], total: 0, truncated: false }`, NOT an error; a hostile selector returns the same empty list without throwing — source: README, `src/mcp/tool-catalog.ts`
- `readConsoleMessages` and `readNetworkRequests` read per-tab in-memory ring buffers with `since`/`limit` cursor; reading never deletes entries — source: README, `src/extension/capture-buffer.ts`
- Capture buffer caps: `DEFAULT_MAX_ENTRIES = 500` per tab per channel, `MAX_CONSOLE_TEXT_BYTES = 8192`, `MAX_BODY_PREVIEW_BYTES = 4096` — source: README, `src/protocol/capture.ts`, `src/extension/capture-buffer.ts`
- Buffers are in memory in the extension's service worker and are lost when the tab closes or the MV3 service worker is suspended — source: README, `src/extension/capture-buffer.ts`
- `scrollPage` scrolls the sandbox tab's page down, trying CDP `Input.dispatchMouseEvent` wheel first then a `window.scrollBy`/`window.scrollTo` script fallback, and reports `method` (`wheel` | `script` | `none`) — source: README, `src/mcp/tool-catalog.ts`, `src/extension/debugger-ports.ts`
- `waitFor` blocks until one of three page conditions holds (`selector-present`, `network-idle`, `fixed-delay`), bounded by an optional `timeoutMs` (default 10 000, clamped to `[100, 25000]`); a timeout is a normal `{ met: false }` result, never an error — source: README, `src/mcp/tool-catalog.ts`
- `closeSandboxTab` closes the dedicated sandbox tab (if any), clears its persisted id, and is no-op-safe: returns `{ closed: true, hadTab: true }` or `{ closed: false, hadTab: false }`, never throws — source: README, `src/mcp/tool-catalog.ts`, `src/extension/sandbox-ports.ts`
- The bridge drives all page actions through one auto-created, reused "sandbox tab" (not whatever the human is focused on), and `captureTab` can capture it even when unfocused — source: README, `src/extension/sandbox-ports.ts`
- Page actions like `executeScript` enforce a flat size ceiling `MAX_EXECUTE_SCRIPT_RESULT_CHARS = 1_000_000`; over-cap returns a structured non-throwing `OversizeResult` (`{ tooLarge, actualBytes, limitBytes }`) — source: `src/extension/size-limits.ts`, `src/extension/page-actions.ts`
- `readConsoleMessages` and `readNetworkRequests` results are bounded by `MAX_CONSOLE_READ_RESULT_CHARS = 1_000_000` and `MAX_NETWORK_READ_RESULT_CHARS = 3_000_000`; over-cap returns the same structured non-throwing outcome — source: README, `src/extension/page-actions.ts`
- All non-image failure outcomes (captureTab, oversize results) surface as `isError: true` JSON text blocks at the MCP layer — source: `src/mcp/main.ts`
- Controller-side client uses `crypto.randomUUID()` string command ids (not per-instance integer counters) to avoid collisions across two controllers — source: `src/controller/controller-client.ts`
- Controller-side reconnect backoff doubles 1000 → 15000 ms, resets to 1000 on a successful open; `close()` disables reconnection for good — source: `src/controller/controller-client.ts`
- TypeScript compiled with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` — source: `tsconfig.json`
- ESLint runs with `typescript-eslint`'s `strictTypeChecked` config plus custom rules banning `JSON.parse(x) as T` and `satisfies` — source: `eslint.config.mjs`
- Vitest runs `src/**/*.unit.test.ts` and `src/**/*.int.test.ts` under `node` environment — source: `vitest.config.ts`
- Every non-`types.ts` file under `src/` has a co-located `.unit.test.ts` — source: README
- Type check, lint (`--max-warnings 0`) and tests run together via `npm run verify` — source: `package.json`
- Wired into Claude Code via the repo-root `.mcp.json` (`command: "node"`, `args: ["nimvarya/bin/mcp.mjs"]`) — source: `.mcp.json`, README
- The MCP server is launched by `node tools/nimvarya/bin/mcp.mjs`, which uses `tsx/esm/api` to run the TypeScript entry under plain `node` with no build step — source: `bin/mcp.mjs`
- Manually verified for Claude Code via `npm run relay` + `npm run build:extension` (Load unpacked in `chrome://extensions`) → `getPageText` against `https://react.dev/` (verified 2026-09-04, horizon 13) — source: README
- Verified that `captureTab` element-mode honors `mode: "element"` and returns an element-only crop (horizon 13) — source: README
- Verified the downscale ladder on a live oversized capture: pre-ladder base64 ≈ 18.2M chars, give-up floor `size: 1981332`, `limit: 1200000`, `attempts: 4` (horizon 14, 2026-09-04) — source: README
- Verified `findElement` against `https://en.wikipedia.org/wiki/Chromium_(web_browser)` (horizon 12, 2026-09-04): match counts and per-element `innerText` consistent with independent CDP reads — source: README
- Verified `scrollPage` via the `script` (`Runtime.evaluate`) fallback on the unfocused sandbox tab (horizon 10, 2026-09-03) — source: README
- Verified `evaluatePage` reads values on github.com and reddit.com where `executeScript` returns the page CSP error (horizon 09, 2026-09-03) — source: README
- The package is self-contained: its own `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, its own lockfile; not wired into the root `scripts/verify.sh` — source: README
- Scope is technical developer-tooling: extracted from boky's working extension↔WebSocket-relay↔MCP path into a standalone, boky-free Chrome-control tool — source: README, `docs/roadmaps/nimvarya/vision.md`
- Primary goal: open-source community contribution — source: user
- Open-source status: MIT license — source: user
- Production URL: none — local-only tool that users install themselves and point an MCP client at the local stdio server — source: user
- Features not visible in the repo: none — the repo is the full picture — source: user

## Repository evidence

Concrete file paths in this repository that back the Verified facts.

- `package.json`
- `tsconfig.json`
- `eslint.config.mjs`
- `vitest.config.ts`
- `vite.extension.config.ts`
- `.mcp.json`
- `.gitignore`
- `extension/manifest.json`
- `bin/mcp.mjs`
- `README.md`
- `src/protocol/actions.ts`
- `src/protocol/types.ts`
- `src/protocol/capture.ts`
- `src/protocol/guards.ts`
- `src/relay/main.ts`
- `src/relay/relay.ts`
- `src/controller/controller-client.ts`
- `src/mcp/main.ts`
- `src/mcp/server.ts`
- `src/mcp/tool-catalog.ts`
- `src/extension/service-worker.ts`
- `src/extension/page-script.ts`
- `src/extension/capture-forwarder.ts`
- `src/extension/bridge-client.ts`
- `src/extension/ports.ts`
- `src/extension/capture-ports.ts`
- `src/extension/sandbox-ports.ts`
- `src/extension/debugger-ports.ts`
- `src/extension/page-actions.ts`
- `src/extension/command-dispatch.ts`
- `src/extension/capture-buffer.ts`
- `src/extension/capture-store.ts`
- `src/extension/size-limits.ts`
- `src/extension/wait-condition.ts`
- `src/extension/keepalive.ts`
- `docs/roadmaps/nimvarya/vision.md`
- `docs/roadmaps/nimvarya/horizons/` (horizon plan/status JSONs)

## User-provided facts

Only the four non-derivable categories: production URL, primary goal, open-source status, features not visible in the repository.

- Production URL: none — nimvarya is a local-only tool; users install it themselves and point an MCP client at the local stdio server (`node nimvarya/bin/mcp.mjs`).
- Primary goal: open-source community contribution.
- Open-source status: open-source, MIT license.
- Features not visible in the repository: none — the repo is the full picture.

## Unknown

Gaps recorded as open. Never invent an answer here.

- Number of active users / installs (not measurable from the repo).
- Performance benchmarks (FPS, latency, throughput) for any of the 21 page actions.
- Browser support beyond Chrome MV3 (the extension targets Chrome's MV3 surface; other browsers are not declared in the repo).
- Whether `captureTab` works on browsers that support the MV3 surface but not CDP `Page.captureScreenshot` semantics for the unfocused tab.
- Number of MCP clients besides Claude Code that have been hand-verified — only Claude Code is recorded as hand-verified in the README; Codex CLI, Gemini CLI and Cursor are documented but unverified on this machine (source: README).
- Whether the package has been published to npm or another registry (`package.json` declares `private: true`, no publish scripts).
- Whether an issue tracker, CI badge, or community channels exist.
- Adoption outside the author's machine.
- Telemetry, analytics, or crash-reporting (none is visible in the repo, but absence is not a positive claim).

## Forbidden assumptions

Never claim the following without explicit evidence. Un-evidenced occurrences are parked here, not in Verified facts.

- fastest
- most secure
- better than competitors
- privacy-preserving