import { defineConfig } from "vitest/config";

/**
 * Config for the real-world CVE validation suite (tests/validation/ -- see
 * its own README.md), kept out of vitest.config.ts's own `include` for the
 * same reason the adversarial suites are: this is real-world evidence, not
 * part of the fast default `npm test` run.
 *
 * `testTimeout` is raised well above vitest's 5s default: each case hits
 * the real, live OSV API and walks a real, non-trivial npm package (e.g.
 * lodash's full lodash.js), which is slower than the stubbed-provider
 * adversarial suites.
 *
 * `passWithNoTests` stays on so `npm run test:validation` never errors on
 * "no test files found" if cases.json is ever temporarily emptied.
 */
export default defineConfig({
  test: {
    include: ["tests/validation/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
