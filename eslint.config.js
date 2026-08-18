import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Scoped to the TypeScript project this task owns (src/ + root tool
    // config). Pre-existing spec/task/script content predates the bootstrap
    // and is out of scope for TASK-001.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "fixtures/**",
      // Adversarial test fixtures deliberately contain unusual/invalid-
      // looking code (require() in .cjs, constant conditions, unused
      // exports, ...) -- that's the point, not a lint violation. Same
      // treatment as the shared fixtures/** above.
      "tests/adversarial/*/fixtures/**",
      "docs/**",
      "schemas/**",
      "rules/**",
      "config/**",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
