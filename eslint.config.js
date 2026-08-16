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
      "docs/**",
      "tasks/**",
      "schemas/**",
      "rules/**",
      "config/**",
      "prompts/**",
      "scripts/**",
      "vulntrace_agent_kit_v0.6/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
