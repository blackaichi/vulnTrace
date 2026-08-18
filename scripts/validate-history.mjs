import fs from "node:fs";

// Validates that the historical bootstrap-kit archive (docs/history/,
// see its own README.md) is still intact -- the original TASK-001..030
// task specs and the kit docs they reference. Not a check on the live
// product (docs/SDD.md's own current accuracy is a separate concern);
// this only guards against the historical record itself going missing
// or being partially deleted.

const root = new URL("../", import.meta.url);
const tasksDir = new URL("docs/history/tasks/", root);
const taskFiles = fs
  .readdirSync(tasksDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

if (taskFiles.length !== 30) {
  console.error(`Expected 30 task files, found ${taskFiles.length}`);
  process.exit(1);
}

for (let i = 1; i <= 30; i++) {
  const prefix = `${String(i).padStart(3, "0")}-`;
  if (!taskFiles.some((f) => f.startsWith(prefix))) {
    console.error(`Missing task ${prefix}`);
    process.exit(1);
  }
}

const required = [
  "AGENTS.md",
  "docs/history/START-HERE.md",
  "docs/SDD.md",
  "docs/COMPETITIVE-ANALYSIS.md",
  "docs/MVP-IMPLEMENTATION-PLAN.md",
  "docs/DEFINITION-OF-DONE.md",
  "schemas/result.schema.json",
  "schemas/symbol-rule.schema.json",
  "rules/vulntrace-rules.yml",
];

for (const file of required) {
  if (!fs.existsSync(new URL(file, root))) {
    console.error(`Missing required file: ${file}`);
    process.exit(1);
  }
}

console.log(
  "VulnTrace history OK: 30 bootstrap tasks and required kit files present.",
);
