import { defineConfig } from "vitest/config";

/**
 * BL-029 — runs the differential tool's collector
 * (`tests/differential/collect.run.ts`), and nothing else. Invoked by
 * `scripts/differential.mjs`, once per side; not an `npm run` gate and not
 * part of CI. The collector's logic is tested under `npm test`
 * (`src/testing/differential-*.test.ts`).
 *
 * One test per case, run in file order (a single file, so in sequence).
 * The per-case timeout is ten times the suites' 30 s: a branch that makes
 * one scan slower should still be measured, not abort the whole side. It
 * bounds a hang and asserts nothing about speed.
 */
export default defineConfig({
  test: {
    include: ["tests/differential/collect.run.ts"],
    testTimeout: 300_000,
  },
});
