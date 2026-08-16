import fs from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url);
const tasksDir = new URL("tasks/", root);
const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith(".md")).sort();

if (taskFiles.length !== 30) {
  console.error(`Expected 30 task files, found ${taskFiles.length}`);
  process.exit(1);
}

for (let i = 1; i <= 30; i++) {
  const prefix = `${String(i).padStart(3, "0")}-`;
  if (!taskFiles.some(f => f.startsWith(prefix))) {
    console.error(`Missing task ${prefix}`);
    process.exit(1);
  }
}

const required = [
  "AGENTS.md",
  "START-HERE.md",
  "docs/SDD.md",
  "docs/COMPETITIVE-ANALYSIS.md",
  "docs/MVP-IMPLEMENTATION-PLAN.md",
  "docs/DEFINITION-OF-DONE.md",
  "schemas/result.schema.json",
  "schemas/symbol-rule.schema.json",
  "rules/vulntrace-rules.yml"
];

for (const file of required) {
  if (!fs.existsSync(new URL(file, root))) {
    console.error(`Missing required file: ${file}`);
    process.exit(1);
  }
}

console.log("VulnTrace spec OK: 30 tasks and required files present.");
