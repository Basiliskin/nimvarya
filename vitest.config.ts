import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.unit.test.ts", "src/**/*.int.test.ts"],
    environment: "node",
  },
});
