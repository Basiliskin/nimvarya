# Next-horizon Planning Brief — agent-agnostic-browser-bridge

Written by horizon 17's planning on 2026-09-04. Describes the next unstarted horizon (horizon 18). Overwritten each horizon.

Horizon 17 (planned, not yet executed) adds byte-size caps to readConsoleMessages/readNetworkRequests, reusing horizon 16's shared oversize-result pattern (size-limits.ts's checkSizeLimit/buildOversizeResult), with a resolved design decision to fully replace the response on oversize (matching executeScript/evaluatePage exactly, no entry-trimming). 4 phases (measure real sizes + record to decisions.md, add byte-size ceiling to reads, widen the MCP isError branch, document catalog+README). This horizon is a complete, self-contained unit — no unfinished slice to carry forward.

## Unknowns

- Does the existing count-based limit=500 already keep results well under whatever byte ceiling horizon 17 picked — will the new oversize path ever actually fire in practice, or is it dead-in-practice code guarded only by unit tests?
- Now that horizon 17 measured real console vs. network JSON.stringify(entries) sizes, are those figures close enough that the two separate constants should be consolidated into one, or did the measurement confirm they genuinely diverge?
- For the read tools specifically (which already have a since/limit/nextSince cursor protocol, unlike executeScript/evaluatePage), is the flat wholesale-replace-on-oversize policy the right long-term UX, or does the cursor protocol make a partial-trim degradation a strictly better fit that was only deferred this horizon for scope-discipline reasons?
- What are the final, as-landed byte-ceiling constant values and MAX_READ_LIMIT-vs-ceiling relationship — under what realistic entry count/content mix does a caller actually hit the new cap?

## Research before planning

- Read the decisions.md line(s) horizon 17 phase 0 appended with the measured JSON.stringify(entries).length for a 500-entry console read and a 500-entry network read.
- Read the final tools/chrome-bridge/src/extension/page-actions.ts readCapture closure and the two new MAX_CONSOLE_READ_RESULT_CHARS/MAX_NETWORK_READ_RESULT_CHARS constants (with their doc comments) to see the actual chosen ceiling values.
- Read tools/chrome-bridge/src/mcp/server.ts's widened toolName guard around the isOversizeResult check to see its final shape and confirm the comment is accurate.
- Read tools/chrome-bridge/README.md's readConsoleMessages/readNetworkRequests section as landed.
- Check docs/roadmaps/agent-agnostic-browser-bridge/decisions.md in full for any other horizon-17 binding decisions and for the still-open cross-horizon backlog items.

## Decisions the next horizon cannot avoid

- Whether to consolidate MAX_CONSOLE_READ_RESULT_CHARS and MAX_NETWORK_READ_RESULT_CHARS into a single shared read-result ceiling now that horizon 17 produced real measurements for both, versus keeping them separate.
- Whether the flat wholesale-replace-on-oversize policy for readConsoleMessages/readNetworkRequests should evolve toward a partial/degraded read instead of discarding the whole batch, given these two tools already have a since/limit/nextSince protocol.
- Whether to finally remove the dead active-tab code surface (queryActiveTab/captureVisibleTab/NO_ACTIVE_TAB/activeTab permission) — deferred since horizon 6 and again explicitly out of scope this horizon.
- Whether to take on the persistent-CDP-session redesign, a JPEG/quality downscale rung for captureTab, or investigate whether there's real demand for a second render-primitive consumer.

## Artifacts to inspect

- tools/chrome-bridge/src/extension/page-actions.ts
- tools/chrome-bridge/src/extension/size-limits.ts
- tools/chrome-bridge/src/mcp/server.ts
- tools/chrome-bridge/src/extension/capture-buffer.ts
- tools/chrome-bridge/src/mcp/tool-catalog.ts
- tools/chrome-bridge/README.md
- docs/roadmaps/agent-agnostic-browser-bridge/decisions.md

## Recommended scope for horizon 18

Horizon 17 closed out the byte-cap feature itself (measurement, ceiling wiring, MCP error-surfacing, and
docs for both read tools) as a complete, self-contained unit — there is no unfinished slice of that
feature to carry forward. The next horizon should therefore be scoped as a fresh, small pick from the
standing cross-horizon backlog rather than a continuation: either (a) a narrow follow-up strictly on this
size-cap work — e.g. deciding, now that real measurements exist, whether to consolidate the two
read-result constants, informed by re-reading decisions.md's phase-0 numbers — or (b) one bounded item
from the older backlog (dead active-tab code removal, persistent-CDP-session redesign, captureTab
JPEG/quality rung, or investigating a second render-primitive consumer), picked deliberately rather than
by default. Avoid combining several backlog items into one horizon; each carries its own scoping/risk
profile and the discipline this project has shown (flat-ceiling precedent, deferred-until-measured
constants) is worth preserving by keeping horizons single-purpose.
