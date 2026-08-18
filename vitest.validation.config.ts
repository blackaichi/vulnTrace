import { defineConfig } from "vitest/config";

/**
 * Config for the real-world CVE validation suite (tests/validation/,
 * currently an empty scaffold -- see its own README.md), kept out of
 * vitest.config.ts's own `include` for the same reason the adversarial
 * suites are: this is real-world evidence, not part of the fast default
 * `npm test` run.
 *
 * `passWithNoTests` is required today: the suite has zero cases until the
 * next phase adds real fixtures, and `npm run test:validation` should
 * succeed trivially rather than error on "no test files found" until then.
 */
export default defineConfig({
  test: {
    include: ["tests/validation/**/*.test.ts"],
    passWithNoTests: true,
  },
});
