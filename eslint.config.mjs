// @ts-check
import tseslint from "typescript-eslint";

/**
 * Purpose-built flat config for this standalone package.
 *
 * It mirrors boky's *strictness* bar (no `any`, no non-null assertions,
 * type-only imports, no `JSON.parse(x) as T` / `satisfies` casts) but
 * deliberately does NOT copy boky's layer-boundary zones or its
 * raw-messaging bans — this package has its own layering and its own
 * transport code.
 */
export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "bin/**"],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.mjs",
            "vitest.config.ts",
            "vite.extension.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Only accepted JSON shape: parse -> unknown -> schema/guard.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message:
            "JSON.parse(x) as T is banned — parse into `unknown`, then narrow with a hand-written type guard.",
        },
        {
          selector: "TSSatisfiesExpression",
          message:
            "`satisfies` is banned — express the constraint with an explicit type annotation or a guard.",
        },
      ],
    },
  },
  {
    // The MCP SDK marks its low-level `Server` `@deprecated` "for the high-level
    // API". This package deliberately uses the low-level `Server` for hand-built
    // JSON-Schema tool definitions: the high-level `McpServer` takes Zod shapes
    // and auto-derives `tools/list`, which would defeat the compile-time
    // `Record<PageAction, …>` parity design in `src/mcp/tool-catalog.ts`.
    files: ["src/mcp/server.ts"],
    rules: {
      "@typescript-eslint/no-deprecated": "off",
    },
  },
  {
    // Test files exercise the typed production helpers with fakes; vitest's
    // matcher/mock surface (`expect.any`, `vi.mocked`) is intentionally loose,
    // so the `any`/unbound-method noise it produces is silenced HERE ONLY —
    // production strictness under `src/**` (non-test) is unchanged.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
];
