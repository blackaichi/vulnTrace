import { defineConfig } from "vitest/config";

/**
 * Config for the performance regression guards
 * (src/cli/scan-performance.test.ts), kept out of vitest.config.ts's own
 * `include` for a reason specific to what these tests measure: wall-clock
 * time.
 *
 * Under the default `npm test` run, vitest executes ~90 test files across
 * every available worker at once, so a wall-clock assertion is really
 * measuring this machine's contention at that moment rather than the
 * analyzer's cost. Measured on the same commit and machine, the single
 * large file guard takes ~1.8-2.3s run on its own and ~4.6s run inside
 * the full parallel suite -- enough to trip a 4.5s threshold that has
 * nothing to do with the analyzer having changed. Giving these guards
 * their own run (and `fileParallelism: false`, so they never overlap each
 * other either) makes the number they assert on the number they are
 * actually about.
 */
export default defineConfig({
  test: {
    include: ["src/cli/scan-performance.test.ts"],
    fileParallelism: false,
  },
});
