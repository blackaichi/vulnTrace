import { defineConfig } from "vitest/config";

/**
 * Separate config for the v2 adversarial validation suite
 * (tests/adversarial-v2/), kept out of vitest.config.ts's own `include` so
 * `npm test`/CI never runs it, and kept independent from
 * vitest.adversarial.config.ts (the original 34-scenario suite) so the two
 * suites never share a test run. This suite deliberately keeps scenarios
 * that disagree with the analyzer's actual output rather than fixing the
 * analyzer to pass them -- see tests/adversarial-v2/REPORT.md.
 */
export default defineConfig({
  test: {
    include: ["tests/adversarial-v2/**/*.test.ts"],
  },
});
