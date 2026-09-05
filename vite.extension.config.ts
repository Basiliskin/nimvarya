/**
 * Build for the standalone extension.
 *
 * Plain Vite — deliberately no `@crxjs`. Three build passes, selected by
 * `--mode`, chained in `package.json`'s `build:extension` script:
 *
 *   --mode service-worker  (runs first) emits `service-worker.js` as an ES
 *       module and copies the hand-written `extension/manifest.json`. This is
 *       the ONLY pass with `emptyOutDir: true` — it must run first so it never
 *       wipes the content-script bundles the later passes produce.
 *   --mode page-script     emits `page-script.js` as a classic IIFE bundle
 *       (Chrome injects manifest content scripts as classic scripts, so an ES
 *       module would fail with "Cannot use import statement outside a module").
 *   --mode capture-forwarder  emits `capture-forwarder.js`, same IIFE format.
 *
 * The two content-script passes set `emptyOutDir: false` explicitly and each
 * build a single entry with `inlineDynamicImports`, so the shared
 * `src/protocol/capture.ts` is inlined into each bundle rather than split into
 * a chunk file Chrome could not load at injection time.
 *
 * An unknown `--mode` throws — a typo in the build script must fail loudly, not
 * silently fall back to the output-emptying service-worker pass.
 *
 * Output: `dist/extension/{service-worker.js, page-script.js,
 * capture-forwarder.js, manifest.json}` and nothing else.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Plugin, UserConfig } from "vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

function copyManifestPlugin(): Plugin {
  return {
    name: "nimvarya:copy-manifest",
    closeBundle() {
      mkdirSync(`${root}dist/extension`, { recursive: true });
      copyFileSync(
        `${root}extension/manifest.json`,
        `${root}dist/extension/manifest.json`,
      );
    },
  };
}

function contentScriptConfig(entry: string, outFile: string): UserConfig {
  return {
    build: {
      outDir: "dist/extension",
      emptyOutDir: false,
      target: "es2022",
      minify: false,
      sourcemap: false,
      rollupOptions: {
        input: entry,
        output: {
          format: "iife",
          entryFileNames: outFile,
          inlineDynamicImports: true,
        },
      },
    },
  };
}

const serviceWorkerConfig: UserConfig = {
  build: {
    outDir: "dist/extension",
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: "src/extension/service-worker.ts",
      output: {
        format: "es",
        entryFileNames: "service-worker.js",
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [copyManifestPlugin()],
};

export default defineConfig(({ mode }) => {
  switch (mode) {
    case "service-worker":
      return serviceWorkerConfig;
    case "page-script":
      return contentScriptConfig(
        "src/extension/page-script.ts",
        "page-script.js",
      );
    case "capture-forwarder":
      return contentScriptConfig(
        "src/extension/capture-forwarder.ts",
        "capture-forwarder.js",
      );
    default:
      throw new Error(
        `vite.extension.config.ts: unknown --mode ${JSON.stringify(mode)} — ` +
          `expected one of service-worker, page-script, capture-forwarder`,
      );
  }
});
