# Horizon 07 — sandbox-tab-state-action

## Executive Summary

### 🎯 What are we trying to achieve?

Add a new **read-only** tool, `getTabState`, to the chrome-bridge MCP so an external tool can, on its own, tell apart the dedicated **sandbox tab** from whatever tab the human is looking at. One call returns the sandbox tab's identity, the currently-**focused** tab's identity (of the sandbox tab's own window), and a `sandboxTabActive` flag saying whether the sandbox tab is the one in front. **Done** means: the MCP advertises the tool, a call returns `{ sandboxTab, activeTab, sandboxTabActive }` correctly in every state (empty / stale / live), it never creates or mutates a tab, and the existing gates (`tsc`, `eslint`, `vitest`) stay green.

### 🧠 Why does this change need to happen?

When an agent drives the sandbox tab in the background, the old MCP only ever showed the agent the sandbox tab — there was no way to independently confirm that a *different* tab was actually in front. Proving "the sandbox tab is backgrounded" relied on the human's word. `getTabState` closes that gap: the tool itself can now assert `sandboxTabActive === false` and see both tabs' identities, so background-tab capture is verifiable rather than assumed.

### At a glance

- **Phases:** 4 (2 infrastructure, 1 interface, 1 verification)
- **Complexity:** Low–Medium — one new MCP action plus the read-surface it needs; the gate passed on critic iteration 0 with no blockers or majors.
- **Main risk:** holding the read-only invariant — `getTabState` must never create, focus, or mutate a tab, and must never re-introduce the active tab as an *action* target (the sandbox tab stays the sole action target per horizon 6).
- **Quality/performance target:** `tsc --noEmit`, `eslint --max-warnings 0`, and the package `vitest` all pass; no new manifest permission (the existing `tabs` permission already allows reading tab `url`/`title` by id and querying the active tab).
- **Testing focus:** the result shape in every tab state (no-sandbox → nulls; stale/closed → error; live → both identities + correct flag), the read-only no-mutation property, and the parity surface (advertised-action count 17).

---

## Implementation plan

### Order of work

1. **Add read-only tab-identity reads to ChromePorts** — the port-level ability to read a tab's `url`/`title` by id and find the active tab of a specific window (the existing `queryActiveTab` is current-window-scoped and returns no `url`/`title`).
2. **Add a non-creating sandbox tab id peek** — a side-effect-free read of the persisted sandbox id (unlike `resolveTabId`, which creates a tab).
3. **Add the getTabState action to the MCP catalog** — the action itself: type, handler, catalog entry, parity tests. Consumes both read surfaces.
4. **Verify getTabState in a live Chrome session** — the real-Chrome acceptance gate; the horizon stays `MANUAL_CHROME_CHECK_PENDING` until it passes.

```
graph TD
  A[Add read-only tab-identity reads to ChromePorts<br/>(chromeports-read-tab-identity)] --> C[Add the getTabState action<br/>(add-gettabstate-mcp-action)]
  B[Add a non-creating sandbox tab id peek<br/>(sandbox-ports-peek-stored-tab-id)] --> C
  C --> D[Verify getTabState in a live Chrome session<br/>(verify-gettabstate-live-chrome)]
```

### Phase 0 — Add read-only tab-identity reads to ChromePorts

**Technical ID:** `chromeports-read-tab-identity` · bounded context: chrome-bridge extension — tab-identity read (ChromePorts) · layer: infrastructure · blast radius: medium

- **Goal:** Give ChromePorts the read-only ability to fetch one tab's identity (id/url/title) by its id and to fetch the active tab of a specific window, so a handler can report tab url/title without reusing `queryActiveTab`'s current-window scope.
- **Why:** The MCP currently cannot read a tab's url or title by id, and `queryActiveTab` returns only `{id, windowId}` for the *current* window, so it cannot answer "what is the active tab of the sandbox tab's window". These two reads are the raw material `getTabState` needs.
- **Changes:** add a `TabIdentity` type `{ id: number; url: string; title: string }` to `protocol/types.ts`; add `readTab(tabId)` (via `chrome.tabs.get`) and `activeTabOfWindow(windowId)` (via `chrome.tabs.query({active:true, windowId})`) to `ChromePorts`; leave `queryActiveTab` unchanged; extend both `fakePorts()` helpers.
- **Files / areas:** `src/extension/ports.ts`, `src/protocol/types.ts`, `src/extension/page-actions.unit.test.ts`, `src/extension/service-worker.unit.test.ts`.
- **How to verify:** `TabIdentity` is exported with exactly three fields; both methods reference it (not an inline duplicate); `readTab` propagates a `chrome.tabs.get` rejection (no swallow); `activeTabOfWindow` passes the caller's `windowId` literally and returns `undefined` for an empty window; `queryActiveTab` is byte-unchanged; both `fakePorts()` are extended and `tsc --noEmit` is green.
- **Done when:** `ChromePorts` reads a tab's identity by id and the active tab of a specified window; `tsc --noEmit` stays green with both fakes extended.
- **Depends on:** nothing — can start immediately.
- **Rollback:** remove `readTab`/`activeTabOfWindow` from `ChromePorts` + `chromeCommandPorts()`, drop `TabIdentity`, restore both `fakePorts()`.

### Phase 1 — Add a non-creating sandbox tab id peek

**Technical ID:** `sandbox-ports-peek-stored-tab-id` · bounded context: chrome-bridge extension — sandbox-tab id read (SandboxTabPorts) · layer: infrastructure · blast radius: small

- **Goal:** Give `SandboxTabPorts` a pure read that returns the persisted sandbox-tab id **without creating a tab**, so `getTabState` can report the sandbox tab without mutating any state.
- **Why:** The only existing resolver, `resolveTabId`, **creates** a tab whenever one is not already stored, and a read-only report must not create, focus, or navigate anything. `getTabState` needs a side-effect-free read of the already-persisted id plus an explicit "no sandbox tab yet" answer.
- **Changes:** add `peekStoredSandboxTabId(): Promise<number | undefined>` to `SandboxTabPorts` (reads `chrome.storage.local` under `SANDBOX_TAB_ID_KEY`, never calls any `chrome.tabs.*` create/mutate); implement it by reusing the existing `readStoredTabId()` helper; leave `resolveTabId()` untouched as the sole creator; add the method to both sandbox fakes.
- **Files / areas:** `src/extension/sandbox-ports.ts`, `src/extension/page-actions.unit.test.ts`, `src/extension/service-worker.unit.test.ts`.
- **How to verify:** grep the peek path for any `chrome.tabs.create/update/reload/activate/move/focus/goBack/goForward` and `chrome.windows.create/update` — none appear; the only `chrome.*` call reachable is `chrome.storage.local.get`; empty storage → `undefined` (never `0`, never a create); `resolveTabId` diff is zero; both fakes are extended and `tsc --noEmit` is green.
- **Done when:** `SandboxTabPorts` exposes `peekStoredSandboxTabId`, returning the persisted id (or `undefined`) without creating a tab; `tsc --noEmit` stays green.
- **Depends on:** nothing — can start immediately.
- **Rollback:** remove `peekStoredSandboxTabId` from the interface + `chromeSandboxTabPorts()`, revert the two sandbox fakes.

### Phase 2 — Add the getTabState action to the MCP catalog

**Technical ID:** `add-gettabstate-mcp-action` · bounded context: chrome-bridge MCP — action catalog (getTabState) · layer: interface · blast radius: medium

- **Goal:** Make `getTabState` a first-class read-only MCP action advertised by `listTools` that returns `{ sandboxTab, activeTab, sandboxTabActive }`, reporting the sandbox tab and the focused tab of its window without acting on either.
- **Why:** This is the actual feature — an external MCP client can now independently verify whether the sandbox tab is the focused tab of its window. Because `PAGE_ACTIONS` is the single source of truth and every consumer is typed `Record<PageAction, …>`, adding the action forces the catalog, param/result types, handler maps, tool-catalog entry, and hardcoded action-count tests to land together as one atomic change.
- **Changes:** add `getTabState` to `PAGE_ACTIONS` (16→17) + `PageActionParams`/`PageActionResults`; add `GetTabStateResult` with `sandboxTab`/`activeTab` as `TabIdentity | null` (no-arg params via `{ readonly _?: never }`); add the handler to **both** the raw and guarded maps — peek the id via `peekStoredSandboxTabId()`; **no saved id →** `{ sandboxTab: null, activeTab: null, sandboxTabActive: false }`; **live id →** read the sandbox tab with `readTab(sandboxId)`, query `activeTabOfWindow(sandboxTab.windowId)`, set `sandboxTabActive = activeTab.id === sandboxTab.id`; **closed/stale id →** `readTab` rejects and `guard()` surfaces `{ error }`; the handler never calls `updateTab`/`executeScript`/`captureVisibleTab`/`goBack`/`goForward`/`reload`. Add a `NO_ARGS` catalog entry; update the hardcoded-count tests to 17.
- **Files / areas:** `src/protocol/actions.ts`, `src/protocol/types.ts`, `src/extension/page-actions.ts`, `src/mcp/tool-catalog.ts`, `src/protocol/actions.unit.test.ts`, `src/mcp/tool-catalog.unit.test.ts`, `src/extension/page-actions.unit.test.ts`.
- **How to verify:** `listTools` advertises `getTabState` (count 17, no consumer says 16 / "sixteen tools"); one call returns the exact `{ sandboxTab, activeTab, sandboxTabActive }` shape in empty/stale/live states; the handler is read-only (no mutation method called) and never targets the active tab; `tsc --noEmit`, `eslint --max-warnings 0`, and `vitest` pass with counts at 17.
- **Done when:** the MCP advertises `getTabState` and a call returns the correct shape in every state, never creating a tab; gates green with counts at 17.
- **Depends on:** Phase 0 (readSurface), Phase 1 (peek).
- **Rollback:** remove `getTabState` from `PAGE_ACTIONS`/params/results/handler maps/`TOOL_CATALOG`, delete `GetTabStateParams`/`Result` and `TabIdentity` usage, revert the count assertions to 16.

### Phase 3 — Verify getTabState in a live Chrome session

**Technical ID:** `verify-gettabstate-live-chrome` · bounded context: chrome-bridge MCP — live-Chrome verification · layer: cross-cutting · blast radius: small

- **Goal:** Verify `getTabState` against a real running Chrome via the chrome-bridge MCP and record the result, ending the horizon `MANUAL_CHROME_CHECK_PENDING` until `sandboxTabActive` demonstrably flips false when another tab is focused while the sandbox tab still screenshots.
- **Why:** The whole point is to let a client verify background-tab capture for itself: unit tests prove the result shape but not the live tab-focus behavior. This final phase is the acceptance gate against a real Chrome session.
- **Changes:** load the built chrome-bridge extension in Chrome + start the relay; call the `getTabState` MCP tool and confirm it is advertised and returns the shape; focus a different tab **in the sandbox tab's own window** and confirm `sandboxTabActive` flips to false while `captureTab` still screenshots the background sandbox tab; record the verdict — the phase is **done only** once that verified verdict is recorded, otherwise the horizon stays `MANUAL_CHROME_CHECK_PENDING`.
- **Files / areas:** runtime inspection only — `src/mcp/server.ts`, `src/extension/service-worker.ts` (no code change expected).
- **How to verify:** the recorded verdict comes from a real chrome-bridge MCP session (built extension + relay), not a mock/unit test/Playwright REPL; it records a focused-true baseline, a focus-false state (in the same window), and a post-flip `captureTab`; `sandboxTabActive` actually flips, and the horizon marker is cleared only on that record.
- **Done when:** a live chrome-bridge MCP session records a verified verdict — focusing a different tab flips `sandboxTabActive` to false while `captureTab` still screenshots the sandbox tab; the horizon stands `MANUAL_CHROME_CHECK_PENDING` until then.
- **Depends on:** Phase 2 (the action).

---

## Discovery Findings

| Area | Finding | File | Implication |
|---|---|---|---|
| ChromePorts methods | No url/title-by-id reader, no active-tab-of-window query | `src/extension/ports.ts` | the main net-new code; add two reads |
| queryActiveTab semantics | Current-window-scoped, returns `{id, windowId}` only | `src/extension/ports.ts` | do NOT reuse it; add a distinct window-scoped read |
| protocol params/results | Each action needs a params + results entry | `src/protocol/types.ts` | add `GetTabStateParams`/`Result` + `TabIdentity` |
| handler maps | raw + guarded `Record<PageAction, Handler>` | `src/extension/page-actions.ts` | add to BOTH maps; guard() it |
| sandbox id resolution | `resolveTabId` returns `Promise<number>` | `src/extension/sandbox-ports.ts` | read url/title separately; add a read-only peek |
| tool catalog | `listTools` derives from `PAGE_ACTIONS`; shared `NO_ARGS` schema | `src/mcp/tool-catalog.ts` | reuse `NO_ARGS`, no new schema |
| MCP dispatch | `isPageAction` + generic `sendCommand` | `src/mcp/server.ts` | no server change needed |
| manifest permissions | `tabs` permission present | `extension/manifest.json` | no manifest change needed |
| hardcoded counts | actions.unit.test.ts / tool-catalog.unit.test.ts assert 16 | `src/protocol/actions.unit.test.ts`, `src/mcp/tool-catalog.unit.test.ts` | bump 16→17 |
| fakePorts helpers | both return full ChromePorts literals | `page-actions.unit.test.ts`, `service-worker.unit.test.ts` | extend both fakes to typecheck |
| action-target invariant | every handler resolves via `resolveTabId`; `queryActiveTab` not called | `page-actions.unit.test.ts` | getTabState reads only; assert no mutation |

## Out of Scope (deferred)

- In-page/tab marker stamping (you chose report-only; marking would mutate tab/page state).
- Full tab list (`listTabs`-style) — the agreement names only sandbox + focused pair.
- Re-introducing the active tab as an **action** target — horizon 6 binds the sandbox tab as sole target.
- Per-tab mutation, focusing, or navigation of either reported tab.
- CDP / `chrome.debugger` changes — this is a `chrome.tabs`-based identity read.
- Resolving the dead `queryActiveTab`/`captureVisibleTab`/`NO_ACTIVE_TAB`/`activeTab`-permission surface — its own deferred decision.
- Result-size-cap location/threshold — `getTabState`'s result is tiny; not forced.

## Required Materials

None external — every phase input is in-repo source (ChromePorts, protocol/types.ts, sandbox-ports.ts, manifest permissions) already characterized by discovery. The only non-source prerequisite (running Chrome + relay for Phase 3) is a runtime environment, named in that phase's inputs.

## Success Criteria

1. The chrome-bridge MCP advertises `getTabState` in `listTools`, and one call returns `{ sandboxTab, activeTab, sandboxTabActive }`.
2. It is read-only: no tab is created, navigated, focused, or mutated, and no new manifest permission is required.
3. `sandboxTabActive` is `true` when the sandbox tab is focused, `false` when another tab in the sandbox tab's window is focused.
4. `tsc --noEmit`, `eslint --max-warnings 0`, and `vitest` pass; the action-catalog parity surface (counts at 17) is updated and green.
5. Verified in real Chrome that focusing a different tab flips `sandboxTabActive` to false while the sandbox tab still captures/screenshots, and `getTabState` introduces no path that makes the active tab an action target.

## Alignment Preview

Stage 3.4 raised three advisory concerns (all clarifications, not structural): phase 4 could be mis-read as "record a pending note" rather than "the check really passes"; the new `peek` could look like duplicate surface vs `resolveTabId` (it isn't — `resolveTabId` creates a tab, so a read-only report must not call it); and the empty/closed-sandbox behavior was undefined. All three were folded in as clarifications (phases 2 and 3 contracts pinned). **User accepted the decomposition on first look — 0 redirect rounds.**

## Quality Gate

- **Path:** Full · **Iterations:** 1 (critic iteration 0) · **Verdict:** **PASS**
- Issues raised: 10 dimensions scored, all `pass: true`, all ≥ their minScore, every issue `minor` ("no change needed"). `domain-shape-fit` passed (no force-escalation). **0 blockers, 0 majors, 0 healed.** No adversarial verify or healer pass was needed.

## Full analysis

- **domainShape:** `technical` — browser-driver machinery (extending the MCP action catalog to report Chrome tab identity), no business entities. `domainShapeReason`: matches the project's recorded vision classification.
- **Assumptions:** the sandbox id is already resolvable/persisted; "active tab" means the sandbox tab's own window; the `tabs` permission suffices (no new permission); `getTabState` is a `chrome.tabs` read only; `PAGE_ACTIONS` stays the single source of truth; id-equality (`sandboxTabActive=true`) is a valid state.
- **Risks:** id-equality must be allowed (not an error); multi-window ambiguity (pin to sandbox tab's window); empty/stale failure shape (now pinned: null / error); the action doesn't fit the "targets a tab" model — wire it as a query, not a target; the parity surface is broad (a missed count fails the gate); must not resurrect active-tab-as-target; strict eslint/tsconfig (no `any`, no `!`).

---

*Generated by `/dima-plan-roadmap-ddd-v5-7` · continuation horizon 7 of `agent-agnostic-browser-bridge` (project slug) — the roadmap is a hypothesis, not a contract, past this horizon. Execute with `/dima-plan-roadmap-ddd-v5-7 execute docs/roadmaps/agent-agnostic-browser-bridge/horizons/horizon-07-sandbox-tab-state-action-roadmap.json`.*
