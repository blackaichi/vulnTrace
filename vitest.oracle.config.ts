import { defineConfig } from "vitest/config";

/**
 * Config for the real-Node oracle harness's own self-tests
 * (tests/oracle/ -- see docs/tasks/H-0-real-node-oracle-harness.md),
 * kept out of vitest.config.ts's own `include` for the same reason every
 * other dedicated suite is: this suite is about the HARNESS's own
 * guarantees (loud fixture, controls, ground truth, the builtin probe),
 * not about the analyzer, and every later soundness-fix task adds its
 * failing-first reproductions here rather than to the default `npm test`
 * run.
 *
 * `testTimeout` is raised for the same reason vitest.validation.config.ts
 * and vitest.binding-grammar.config.ts raise it: every case here spawns
 * one or more real, separate Node processes (the loud-fixture check, the
 * ground-truth run, the builtin probe) on top of a real `runScanCommand`
 * scan, which is slower than an in-process unit test.
 */
export default defineConfig({
  test: {
    include: ["tests/oracle/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
