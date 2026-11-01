#!/usr/bin/env node
/**
 * Task BL-120 — checks the subjects of the commits this branch adds
 * against AGENTS.md § H (`commit-subject-policy.mjs` holds the rule).
 *
 *   node scripts/check-commit-subjects.mjs [--base <ref>] [--head <ref>] [--task <ID>]
 *
 * `--base` defaults to `git merge-base HEAD origin/main` (or `main` when
 * there is no `origin/main`): the commits checked are `<base>..<head>`
 * (`--head` defaults to `HEAD`),
 * merges excluded. `--task` names the branch's task; without it, the task
 * is the scope of the first commit not scoped `tasks`, and every other
 * commit must agree.
 *
 * It is run by the finish step (`.claude/skills/task-finish/SKILL.md`),
 * before the push. It is not one of AGENTS.md § I's gates: earlier history
 * is not rewritten, so the rule binds only the commits a branch adds.
 *
 * Exit status: 0 when every subject complies (or the branch adds none), 1
 * on a violation, 2 on a usage or git error.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  branchSubjectProblems,
  SUBJECT_LIMIT,
} from "./commit-subject-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  return result.status === 0 ? result.stdout : undefined;
}

function fail(message) {
  console.error(`check-commit-subjects: ${message}`);
  process.exit(2);
}

const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const value = argv[i + 1];
  if (["--base", "--head", "--task"].includes(arg) && value !== undefined) {
    options[arg.slice(2)] = value;
    i += 1;
  } else {
    fail(`unknown or incomplete argument: ${arg}`);
  }
}

let base = options.base;
if (base === undefined) {
  const upstream =
    git(["rev-parse", "--verify", "--quiet", "origin/main"]) !== undefined
      ? "origin/main"
      : "main";
  base = git(["merge-base", options.head ?? "HEAD", upstream])?.trim();
  if (!base) fail(`no merge base between HEAD and ${upstream}`);
}

const head = options.head ?? "HEAD";
const log = git(["log", "--no-merges", "--reverse", "--format=%h%x09%s", `${base}..${head}`]);
if (log === undefined) fail(`git log ${base}..${head} failed`);
const commits = log
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    const tab = line.indexOf("\t");
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });

const { taskId, violations } = branchSubjectProblems(
  commits.map((c) => c.subject),
  { taskId: options.task },
);

console.log(
  `checked ${commits.length} commit subject(s) in ${base.slice(0, 12)}..${head} against AGENTS.md § H (at most ${SUBJECT_LIMIT} characters, \`<type>(<task ID>): <summary>\`), task ${taskId ?? "(none found)"}`,
);
for (const v of violations) {
  console.log(`  ${commits[v.index].sha} ${v.subject}`);
  for (const p of v.problems) console.log(`    - ${p}`);
}
process.exit(violations.length === 0 ? 0 : 1);
