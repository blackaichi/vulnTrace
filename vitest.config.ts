import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scoped to src/ so the separately-run adversarial validation suite
    // (tests/adversarial/, its own vitest.adversarial.config.ts) never
    // gets swept into the main `npm test`/CI run -- it deliberately keeps
    // failing scenarios rather than fixing the analyzer to pass them.
    include: ["src/**/*.test.ts"],
    // The wall-clock performance guards are excluded for a different
    // reason, and get their own run via vitest.performance.config.ts:
    // measuring elapsed time while ~90 other test files compete for the
    // same cores measures the contention, not the analyzer. See that
    // config's own comment.
    exclude: [...configDefaults.exclude, "src/cli/scan-performance.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
