import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      // The site's build and serve scripts live outside src, and the policy one of them sends
      // is load bearing, so they are tested rather than only run.
      "apps/*/scripts/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});
