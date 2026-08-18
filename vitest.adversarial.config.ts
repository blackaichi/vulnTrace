import { defineConfig } from "vitest/config";

/**
 * Separate config for both adversarial validation suites
 * (tests/adversarial/v1/, the original 34-scenario suite, and
 * tests/adversarial/v2/, the independent 45-scenario suite built to
 * detect overfitting to v1), kept out of vitest.config.ts's own `include`
 * so `npm test`/CI's default run never runs them. Both suites
 * deliberately keep scenarios that disagree with the analyzer's actual
 * output rather than fixing the analyzer to pass them -- see each suite's
 * own REPORT.md.
 */
export default defineConfig({
  test: {
    include: ["tests/adversarial/**/*.test.ts"],
  },
});
