import { defineConfig } from "vitest/config";

/**
 * Config for the binding-form grammar sweep (tests/binding-grammar/),
 * kept out of vitest.config.ts's own `include` for the same reason the
 * adversarial suites are: it is an instrument whose cells are authored
 * against JavaScript semantics rather than against this analyzer, and it
 * deliberately records the cells where the two disagree.
 *
 * `testTimeout` is raised for the same reason every other suite raises
 * it: the sweep builds real call graphs over real vendored fixture
 * packages on disk.
 */
export default defineConfig({
  test: {
    include: ["tests/binding-grammar/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
