#!/usr/bin/env node
/**
 * BL-029 — THE GRAPH, PROOF AND VERDICT DIFFERENTIAL, BASE AGAINST HEAD.
 *
 * Usage (from the repository root, after `npm ci`):
 *
 *   node scripts/differential.mjs [--base <ref>] [--corpus <names>]
 *        [--case <ids>] [--out <dir>] [--keep-scratch]
 *        [--use-head-dependencies]
 *   node scripts/differential.mjs --collect <snapshot.json>
 *        [--corpus <names>] [--case <ids>] [--label <text>]
 *   node scripts/differential.mjs --diff <base.json> <head.json> [--out <dir>]
 *
 * `--base` defaults to `git merge-base HEAD main` — the task's base SHA.
 * `--corpus` is a comma-separated subset of `validation`,
 * `adversarial-v1`, `adversarial-v2` (default: all three); `--case` a
 * comma-separated list of case IDs. `--out` defaults to a fresh directory
 * under the OS temp root; the report is also printed to stdout.
 *
 * WHAT IS COMPARED. The HEAD side is this working tree, uncommitted
 * changes included (the report says when it is dirty). The BASE side is a
 * scratch directory holding the base commit's analyzer — its `src/`,
 * `schemas/`, `package.json` and `tsconfig.json`, the only files the
 * analyzer reads at runtime — with this tree's instrument laid over it:
 * `src/testing/` (collector, providers, OSV snapshot replay),
 * `scripts/differential-lib.mjs`, `tests/differential/` and
 * `vitest.differential.config.ts`. Both sides read ONE corpus, this
 * tree's (fixtures, cases, expected verdicts, OSV snapshot), at the same
 * paths. So the same instrument measures both sides over the same inputs,
 * and a difference is attributable to analyzer code only. A case this
 * branch adds is scanned by the base analyzer too, which is how a
 * failing-first case shows its base verdict.
 *
 * DEPENDENCIES. The scratch directory links this tree's `node_modules`.
 * That is only faithful when the two lockfiles agree, so a base whose
 * `package-lock.json` differs is refused unless `--use-head-dependencies`
 * says to measure it with this tree's dependencies anyway (the report
 * then says so).
 *
 * A BASE BEFORE BL-029 has no `onCallGraph` seam: its graph differential
 * is reported unavailable, case by case, never as zero. The proof and
 * verdict differentials come from the scan's own JSON output and need no
 * seam.
 *
 * Exit status: 0 when the report was produced (whatever it contains), 2
 * on a usage error or when a side could not be collected.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffSnapshots,
  renderReport,
  SNAPSHOT_FORMAT,
  summarize,
} from "./differential-lib.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** What the base side takes from the base commit: the analyzer, nothing else. */
const BASE_ANALYZER_PATHS = [
  "src",
  "schemas",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
];

/** What the base side takes from this tree: the instrument. */
const INSTRUMENT_PATHS = [
  "src/testing",
  "scripts/differential-lib.mjs",
  "tests/differential",
  "vitest.differential.config.ts",
];

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { mode: "compare", corpora: undefined, cases: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--base":
        options.base = value();
        break;
      case "--corpus":
        options.corpora = value();
        break;
      case "--case":
        options.cases = value();
        break;
      case "--out":
        options.out = value();
        break;
      case "--label":
        options.label = value();
        break;
      case "--keep-scratch":
        options.keepScratch = true;
        break;
      case "--use-head-dependencies":
        options.useHeadDependencies = true;
        break;
      case "--collect":
        options.mode = "collect";
        options.snapshotOut = value();
        break;
      case "--diff":
        options.mode = "diff";
        options.baseSnapshot = value();
        options.headSnapshot = value();
        break;
      case "--help":
      case "-h":
        options.mode = "help";
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: options.encoding === null ? undefined : "utf-8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

/** Runs the collector with `codeRoot` as the code under measurement. */
function collect({ codeRoot, out, label, corpora, cases }) {
  const vitest = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) {
    throw new Error(
      `vitest not found at ${vitest}; run \`npm ci\` in ${REPO_ROOT} first`,
    );
  }
  const env = {
    ...process.env,
    VT_DIFF_OUT: out,
    VT_DIFF_CORPUS_ROOT: REPO_ROOT,
    VT_DIFF_LABEL: label,
  };
  if (corpora !== undefined) env.VT_DIFF_CORPORA = corpora;
  if (cases !== undefined) env.VT_DIFF_ONLY = cases;
  process.stderr.write(`differential: collecting ${label}\n`);
  // A snapshot left by an earlier run must never stand in for this one.
  rmSync(out, { force: true });
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [vitest, "run", "--config", "vitest.differential.config.ts"],
    { cwd: codeRoot, env, stdio: ["ignore", process.stderr, "inherit"] },
  );
  // The collector writes its snapshot last, atomically, and only when every
  // selected case has a record, so an existing snapshot is a complete one.
  if (!existsSync(out)) {
    throw new Error(
      `collecting ${label} failed (vitest exit ${result.status}, no snapshot written); see the output above`,
    );
  }
  const snapshot = JSON.parse(readFileSync(out, "utf-8"));
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new Error(`collecting ${label} wrote a snapshot of format ${snapshot.format}`);
  }
  const notes = [];
  if (result.status !== 0) {
    // Seen as vitest's `Timeout calling "onTaskUpdate"` worker error, which
    // `docs/WORKFLOW.md` § 3 records as a known exit-non-zero-with-every-
    // test-passing failure. The snapshot is complete (above), so the side
    // is measured; the report still says the run was not clean.
    notes.push(
      `vitest exited ${result.status} while collecting ${label}, after the collector wrote a complete snapshot (every case recorded); see the collection output for the error.`,
    );
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write(`differential: collected ${label} in ${seconds}s\n`);
  return { snapshot, seconds, notes };
}

/** The base side: the base commit's analyzer with this tree's instrument. */
function prepareBase(sha, scratch, useHeadDependencies) {
  const tar = git(["archive", "--format=tar", sha, ...BASE_ANALYZER_PATHS], {
    encoding: null,
  });
  const untar = spawnSync("tar", ["-x", "-C", scratch], { input: tar });
  if (untar.status !== 0) {
    throw new Error(`tar -x failed: ${String(untar.stderr).trim()}`);
  }
  const notes = [];
  const baseLock = readFileSync(path.join(scratch, "package-lock.json"), "utf-8");
  const headLock = readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf-8");
  if (baseLock !== headLock) {
    if (!useHeadDependencies) {
      throw new UsageError(
        `the base's package-lock.json differs from this tree's; its analyzer would run on dependencies it was not locked to. Re-run with --use-head-dependencies to measure it with this tree's dependencies anyway.`,
      );
    }
    notes.push(
      "The base's package-lock.json differs from the head's; the base was measured with the head's dependencies (--use-head-dependencies).",
    );
  }
  for (const rel of INSTRUMENT_PATHS) {
    const from = path.join(REPO_ROOT, rel);
    const to = path.join(scratch, rel);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(scratch, "node_modules"),
    "dir",
  );
  return notes;
}

function writeResults(outDir, diff, report, snapshots) {
  mkdirSync(outDir, { recursive: true });
  if (snapshots !== undefined) {
    writeFileSync(path.join(outDir, "base.json"), JSON.stringify(snapshots.base) + "\n");
    writeFileSync(path.join(outDir, "head.json"), JSON.stringify(snapshots.head) + "\n");
  }
  writeFileSync(path.join(outDir, "diff.json"), JSON.stringify(diff, null, 2) + "\n");
  writeFileSync(path.join(outDir, "report.md"), report + "\n");
  process.stdout.write(report + "\n");
  process.stderr.write(`differential: results in ${outDir}\n`);
}

function compare(options) {
  const baseRef = options.base ?? git(["merge-base", "HEAD", "main"]).trim();
  const baseSha = git(["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const dirty = git(["status", "--porcelain"]).trim() !== "";
  const baseLabel = `base ${baseRef} (${baseSha.slice(0, 7)})`;
  const headLabel = `head working tree at ${headSha.slice(0, 7)}${dirty ? ", with uncommitted changes" : ""}`;
  const outDir =
    options.out ?? mkdtempSync(path.join(tmpdir(), "vulntrace-differential-"));
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(path.join(tmpdir(), "vulntrace-differential-base-"));
  try {
    const notes = prepareBase(baseSha, scratch, options.useHeadDependencies);
    const base = collect({
      codeRoot: scratch,
      out: path.join(outDir, "base.json"),
      label: baseLabel,
      corpora: options.corpora,
      cases: options.cases,
    });
    const head = collect({
      codeRoot: REPO_ROOT,
      out: path.join(outDir, "head.json"),
      label: headLabel,
      corpora: options.corpora,
      cases: options.cases,
    });
    notes.push(
      ...base.notes,
      ...head.notes,
      "Both sides scanned the head's corpus (fixtures, cases, expected verdicts, OSV snapshot); only the analyzer differs.",
      `Collection time: base ${base.seconds}s, head ${head.seconds}s.`,
    );
    const diff = diffSnapshots(base.snapshot, head.snapshot);
    const report = renderReport(diff, { notes });
    writeResults(outDir, { ...diff, summary: summarize(diff) }, report);
  } finally {
    if (options.keepScratch) {
      process.stderr.write(`differential: scratch kept at ${scratch}\n`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "help") {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf-8")
      .split("\n")
      .slice(1, 20)
      .join("\n");
    process.stdout.write(header + "\n");
    return;
  }
  if (options.mode === "collect") {
    const headSha = git(["rev-parse", "HEAD"]).trim();
    collect({
      codeRoot: REPO_ROOT,
      out: path.resolve(options.snapshotOut),
      label: options.label ?? `working tree at ${headSha.slice(0, 7)}`,
      corpora: options.corpora,
      cases: options.cases,
    });
    return;
  }
  if (options.mode === "diff") {
    const base = JSON.parse(readFileSync(options.baseSnapshot, "utf-8"));
    const head = JSON.parse(readFileSync(options.headSnapshot, "utf-8"));
    const diff = diffSnapshots(base, head);
    const outDir =
      options.out ?? mkdtempSync(path.join(tmpdir(), "vulntrace-differential-"));
    writeResults(outDir, { ...diff, summary: summarize(diff) }, renderReport(diff));
    return;
  }
  compare(options);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `differential: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
