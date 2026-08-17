import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scoped to src/ so the separately-run adversarial validation suite
    // (tests/adversarial/, its own vitest.adversarial.config.ts) never
    // gets swept into the main `npm test`/CI run -- it deliberately keeps
    // failing scenarios rather than fixing the analyzer to pass them.
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
