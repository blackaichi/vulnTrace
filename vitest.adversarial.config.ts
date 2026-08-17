import { defineConfig } from "vitest/config";

/**
 * Separate config for the adversarial validation suite
 * (tests/adversarial/), kept out of vitest.config.ts's own `include` so
 * `npm test`/CI never runs it. This suite deliberately keeps scenarios
 * that disagree with the analyzer's actual output rather than fixing the
 * analyzer to pass them -- see tests/adversarial/REPORT.md.
 */
export default defineConfig({
  test: {
    include: ["tests/adversarial/**/*.test.ts"],
  },
});
