#!/usr/bin/env node
/**
 * Repo-relative launcher for the nimvarya MCP server, referenced from the
 * repo-root `.mcp.json` as `node tools/nimvarya/bin/mcp.mjs`.
 *
 * It resolves everything relative to its own location (`import.meta.url`), never
 * `process.cwd()`, so it works whatever directory the MCP client launches it
 * from and wherever the repo is checked out. It registers the `tsx` ESM loader
 * (via `tsx/esm/api`, the non-deprecated programmatic entry) so the TypeScript
 * entry runs under plain `node` with no build step — the same convention
 * `npm run relay` uses.
 *
 * stdio hygiene: this file writes NOTHING to stdout. Loader/Node warnings go to
 * stderr; `NODE_NO_WARNINGS` is set defensively so an experimental-loader notice
 * can never reach a client that parses stdout as JSON-RPC.
 */

import { register } from "tsx/esm/api";

process.env.NODE_NO_WARNINGS ??= "1";

register();

const mainUrl = new URL("../src/mcp/main.ts", import.meta.url).href;
const { runMcpServer } = await import(mainUrl);

await runMcpServer();
