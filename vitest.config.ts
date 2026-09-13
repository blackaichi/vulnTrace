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
    // Raised above vitest's 5s default for the same reason
    // vitest.validation.config.ts raises it: a number of tests here run a
    // REAL end-to-end scan over vendored `node_modules` (the VT-307d
    // closure wiring against the RWB fixtures, the type-checker-backed
    // call-graph cases), and several legitimately take 4-8 seconds. At the
    // 5s default they sat right on the edge and passed or failed according
    // to how loaded the machine was -- measured at 26, 16 and 5 failures
    // across three runs of the same commit, every one a timeout and not an
    // assertion, and no faster on the merge base.
    //
    // This is deliberately NOT how the wall-clock performance guards work:
    // those assert on elapsed time, so they pass their own per-test
    // timeout (`THRESHOLD_MS + 5_000`) tied to the threshold they measure,
    // and run under their own config. A generous ceiling here only bounds
    // pathological hangs; it asserts nothing about speed.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
