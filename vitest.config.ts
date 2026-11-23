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
    /**
     * Values the suite reads with `inject`, so that reading the environment stays in one place
     * the linter allows rather than spreading through test files.
     *
     * `QUARRY_REQUIRE_GOLDEN=1` turns a missing or unlabelled accuracy golden set from a skip
     * into a failure. It is off by default because the labels are not written yet and an
     * ordinary run must pass; CI reports the state instead, and gains the flag once every
     * question is labelled. See `packages/questions/src/golden.test.ts`.
     */
    provide: {
      requireGoldenSet: process.env["QUARRY_REQUIRE_GOLDEN"] === "1",
    },
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});

declare module "vitest" {
  interface ProvidedContext {
    readonly requireGoldenSet: boolean;
  }
}
