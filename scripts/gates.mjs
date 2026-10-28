#!/usr/bin/env node
/**
 * BL-089 — RUN THE GATE SET OF `AGENTS.md` § I LOCALLY, FAST, UNWEAKENED.
 *
 * Usage (from the repository root, after `npm ci`):
 *
 *   node scripts/gates.mjs [--only <names> | --tier dev] [--serial]
 *        [--out <dir>] [--base <ref>] [--no-cache] [--verbose]
 *
 * 1. THE FAST GATES (typecheck, lint, format, scorecard check,
 *    check-docs, build, validate:history, validate:metadata), each with
 *    exactly § I's command. They run concurrently (`--serial`: one at a
 *    time), and the run STOPS at the first failure: the others are
 *    stopped, nothing else runs, and the failing gate's output is shown.
 * 2. THE TEST SUITES, one after another, never concurrently (the
 *    performance guards measure wall clock): test:foundation, npm test,
 *    test:performance, test:adversarial, test:binding-grammar,
 *    test:oracle, test:validation. Each runs through `npm run <script>`,
 *    exactly as § I runs it, with a JSON reporter added after `--` for
 *    the counts. Every suite runs even when an earlier one failed, and the
 *    summary gives each one's exit code, test files and tests.
 *
 *    EACH TEST FILE RUNS EXACTLY ONCE. `test:foundation` is a deliberate
 *    subset of `npm test` (vitest.foundation.config.ts, F6 § 25), and CI
 *    runs both, unchanged. Here, `npm test` runs with the foundation files
 *    excluded (`--exclude`, which adds to vitest.config.ts's own exclude),
 *    because the foundation run just ran them under the same rules. Before
 *    any suite runs, the runner asks vitest for every suite's file list
 *    with the exact arguments it will use (the script's own, read from
 *    `package.json` and never restated, plus that exclusion), and refuses
 *    to start unless no file is in two suites and the two halves of
 *    `npm test` are exactly `npm test`'s own file list.
 *
 *    `test:validation` exits non-zero by design (OPEN-DEBTS D-09). It
 *    passes here only when exactly the cases
 *    `tests/validation/cases/cases.json` marks `knownFailure` fail, and
 *    nothing else: a new failure, and a known failure that now passes, are
 *    both deviations. Each known failure's assertion message is printed so
 *    that its verdict can be compared with the baseline's; the
 *    differential's verdict section shows any verdict that moved.
 * 3. THE DIFFERENTIAL, `node scripts/differential.mjs` (its base side
 *    cached, see that script's header), with `--base` and `--no-cache`
 *    passed through. Its report is not a pass/fail gate; its summary and
 *    the path to the full report are printed.
 *
 * `--only typecheck,test:oracle,…` runs only the named gates (names as in
 * the summary; `test` is `npm test`) — for re-running the affected suites
 * between audit rounds (docs/WORKFLOW.md § 1.5). Such a run is labelled
 * PARTIAL: it is not the gate set, and the full run happens once on the
 * final HEAD before the pull request. When `test` is selected without
 * `test:foundation`, it runs whole.
 *
 * `--tier dev` (task BL-117) is a named `--only`: the gates that check
 * the code (`DEV_TIER` in gates-lib.mjs, which says what it leaves out and
 * why), for the loop while a task is implemented. It is PARTIAL too.
 *
 * The oracle suite's real-Node answers come from the on-disk cache of
 * `src/testing/oracle/real-node-cache.ts` unless `VT_ORACLE_NODE_CACHE`
 * says otherwise (`off`, or `verify`); the summary states the mode the
 * run used. The analyzer's scans are never cached.
 *
 * Each gate's full output goes to `<out>/<gate>.log` (`--out` defaults to
 * a fresh directory under the OS temp root); `--verbose` also streams it.
 * The environment is passed through unchanged.
 *
 * Exit status: 0 when every gate that ran passed (test:validation: exactly
 * its known failures); 1 otherwise; 2 on a usage error.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_GATE_NAMES,
  compareValidation,
  DEV_TIER,
  DIFFERENTIAL,
  exactlyOnceProblems,
  FAST_GATES,
  readVitestReport,
  SUITES,
  table,
  vitestArgs,
} from "./gates-lib.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { serial: false, verbose: false, noCache: false };
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
      case "--only": {
        const names = value()
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n !== "");
        const unknown = names.filter((n) => !ALL_GATE_NAMES.includes(n));
        if (unknown.length > 0) {
          throw new UsageError(
            `unknown gate: ${unknown.join(", ")} (known: ${ALL_GATE_NAMES.join(", ")})`,
          );
        }
        options.only = names;
        break;
      }
      case "--tier": {
        const tier = value();
        if (tier !== "dev") {
          throw new UsageError(`unknown tier: ${tier} (known: dev)`);
        }
        options.tier = tier;
        break;
      }
      case "--serial":
        options.serial = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--out":
        options.out = value();
        break;
      case "--base":
        options.base = value();
        break;
      case "--no-cache":
        options.noCache = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.tier !== undefined) {
    if (options.only !== undefined) {
      throw new UsageError("--tier and --only cannot be combined");
    }
    options.only = [...DEV_TIER];
  }
  return options;
}

/** The real-Node cache mode the oracle suite will use (real-node-cache.ts's rule, restated for the summary). */
function oracleCacheMode() {
  const value = process.env.VT_ORACLE_NODE_CACHE;
  if (value !== undefined && value !== "") return value;
  const ci = process.env.CI;
  return ci !== undefined && ci !== "" && ci !== "false" ? "off (CI)" : "on (default)";
}

const strip = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const seconds = (ms) => (ms / 1000).toFixed(1);

/** Every child still running, so a stop (first failure, Ctrl-C) reaches its whole process group. */
const LIVE = new Set();

function stop(child) {
  try {
    // `npm run x` is npm, then a shell, then x: signal the whole group.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

process.on("SIGINT", () => {
  for (const child of LIVE) stop(child);
  process.exit(130);
});

/** Runs one command, its output to `<out>/<name>.log`; resolves with its exit and duration. */
function run(name, argv, { out, verbose }) {
  const log = path.join(out, `${name.replace(/[^a-z0-9.-]+/gi, "_")}.log`);
  const stream = createWriteStream(log);
  const started = Date.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  LIVE.add(child);
  for (const pipe of [child.stdout, child.stderr]) {
    pipe.on("data", (chunk) => {
      stream.write(chunk);
      if (verbose) process.stderr.write(chunk);
    });
  }
  const done = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      LIVE.delete(child);
      stream.end(() =>
        resolve({ name, exit: code ?? signal, ms: Date.now() - started, log }),
      );
    });
  });
  return { child, done };
}

function tail(file, lines = 40) {
  try {
    return strip(readFileSync(file, "utf-8")).trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no output)";
  }
}

async function fastGates(gates, options, rows) {
  const limit = options.serial ? 1 : Math.min(gates.length, os.availableParallelism());
  const queue = [...gates];
  const running = new Map();
  let failed;
  const startNext = () => {
    const gate = queue.shift();
    if (gate === undefined) return;
    process.stderr.write(`gates: ▶ ${gate.name}\n`);
    const handle = run(gate.name, gate.argv, options);
    running.set(gate.name, handle);
  };
  while (running.size < limit && queue.length > 0) startNext();
  while (running.size > 0) {
    const result = await Promise.race([...running.values()].map((h) => h.done));
    running.delete(result.name);
    const ok = result.exit === 0;
    rows.push([result.name, ok ? "pass" : "FAIL", String(result.exit), seconds(result.ms), "", ""]);
    process.stderr.write(`gates: ${ok ? "✔" : "✘"} ${result.name} (${seconds(result.ms)}s)\n`);
    if (!ok && failed === undefined) {
      failed = result;
      for (const [name, handle] of running) {
        stop(handle.child);
        await handle.done;
        rows.push([name, "stopped", "", "", "", ""]);
      }
      running.clear();
      queue.length = 0;
      break;
    }
    startNext();
  }
  for (const gate of queue) rows.push([gate.name, "not run", "", "", "", ""]);
  return failed;
}

function listFiles(args) {
  const out = mkdtempSync(path.join(os.tmpdir(), "vulntrace-gates-list-"));
  const file = path.join(out, "list.json");
  const result = spawnSync(
    process.execPath,
    [VITEST, "list", ...args.slice(1), "--filesOnly", `--json=${file}`],
    { cwd: REPO_ROOT, encoding: "utf-8", env: process.env },
  );
  if (result.status !== 0 || !existsSync(file)) {
    throw new Error(
      `vitest list ${args.slice(1).join(" ")} failed (exit ${result.status}): ${strip(result.stderr).slice(0, 2000)}`,
    );
  }
  return JSON.parse(readFileSync(file, "utf-8")).map((entry) =>
    path.relative(REPO_ROOT, entry.file),
  );
}

/** Each selected suite's vitest arguments, with `npm test` split from the foundation when both run. */
function suitePlan(selected) {
  const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")).scripts;
  const plan = selected.map((suite) => ({
    ...suite,
    args: vitestArgs(scripts, suite.script),
    extraArgs: [],
  }));
  const foundation = plan.find((s) => s.name === "test:foundation");
  const test = plan.find((s) => s.name === "test");
  let fullTest;
  if (foundation !== undefined && test !== undefined) {
    fullTest = listFiles(test.args);
    const foundationFiles = listFiles(foundation.args);
    test.extraArgs = foundationFiles.flatMap((file) => ["--exclude", file]);
    test.label = "npm test (without the foundation files, which ran above)";
  }
  // The file lists come from the exact arguments each suite will run with.
  const lists = Object.fromEntries(
    plan.map((s) => [s.name, listFiles([...s.args, ...s.extraArgs])]),
  );
  const problems = exactlyOnceProblems(lists, fullTest);
  return { plan, lists, fullTest, problems };
}

async function testSuites(plan, lists, options, rows) {
  const cases = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "tests", "validation", "cases", "cases.json"), "utf-8"),
  );
  let allPassed = true;
  for (const suite of plan) {
    const json = path.join(options.out, `${suite.name.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
    // Through `npm run`, exactly as § I runs it (npm's environment
    // included); only the foundation exclusion and the JSON reporter are
    // added, after `--`.
    const argv = [
      "npm",
      "run",
      suite.script,
      "--",
      ...suite.extraArgs,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${json}`,
    ];
    process.stderr.write(`gates: ▶ ${suite.label ?? suite.name} (${lists[suite.name].length} files)\n`);
    const result = await run(suite.name, argv, options).done;
    let report;
    try {
      report = readVitestReport(readFileSync(json, "utf-8"));
    } catch {
      report = undefined;
    }
    let status;
    if (report === undefined) {
      status = "FAIL (no report)";
    } else if (suite.name === "test:validation") {
      const v = compareValidation(report.failures, cases);
      status = v.matches ? "pass (baseline)" : "FAIL (baseline)";
      process.stderr.write(
        `gates:   test:validation known failures (cases.json knownFailure): ${v.known.join(", ")}\n`,
      );
      for (const id of v.failedIds) {
        process.stderr.write(`gates:     ${id}: ${v.observed[id]}\n`);
      }
      if (v.unexpected.length > 0) {
        process.stderr.write(
          `gates:   FAILING, NOT MARKED knownFailure (compare with OPEN-DEBTS D-09): ${v.unexpected.join(", ")}\n`,
        );
      }
      if (v.nowPassing.length > 0) {
        process.stderr.write(
          `gates:   MARKED knownFailure, NOW PASSING (compare with OPEN-DEBTS D-09): ${v.nowPassing.join(", ")}\n`,
        );
      }
    } else if (result.exit === 0) {
      status = "pass";
    } else if (report.failed === 0 && report.failedFiles === 0) {
      // docs/WORKFLOW.md § 3: a known vitest worker timeout under load.
      status = "FAIL (exit ≠ 0, every test passed: rerun alone)";
    } else {
      status = "FAIL";
    }
    if (report !== undefined && report.files !== lists[suite.name].length) {
      status = `FAIL (ran ${report.files} of ${lists[suite.name].length} files)`;
    }
    if (!status.startsWith("pass")) allPassed = false;
    const counts =
      report === undefined
        ? ["", ""]
        : [
            String(report.files),
            `${report.tests} (${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped)`,
          ];
    rows.push([suite.name, status, String(result.exit), seconds(result.ms), ...counts]);
    process.stderr.write(`gates: ${status.startsWith("pass") ? "✔" : "✘"} ${suite.name}: ${status} (${seconds(result.ms)}s)\n`);
    if (report !== undefined && suite.name !== "test:validation") {
      for (const f of report.failures.slice(0, 20)) {
        process.stderr.write(`gates:     ✘ ${f.fullName}: ${f.message}\n`);
      }
    }
  }
  return allPassed;
}

async function differential(options, rows) {
  const out = path.join(options.out, "differential");
  const argv = [process.execPath, path.join(REPO_ROOT, "scripts", "differential.mjs"), "--out", out];
  if (options.base !== undefined) argv.push("--base", options.base);
  if (options.noCache) argv.push("--no-cache");
  process.stderr.write("gates: ▶ differential\n");
  const result = await run(DIFFERENTIAL, argv, options).done;
  const ok = result.exit === 0;
  rows.push([DIFFERENTIAL, ok ? "report" : "FAIL", String(result.exit), seconds(result.ms), "", ""]);
  const report = path.join(out, "report.md");
  if (ok && existsSync(report)) {
    const text = readFileSync(report, "utf-8");
    process.stdout.write(`\n## Differential (${report})\n\n${text.split("\n").slice(0, 60).join("\n")}\n`);
  } else {
    process.stdout.write(`\n## Differential FAILED (${result.log})\n\n${tail(result.log)}\n`);
  }
  return ok;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf-8").split("\n").slice(1, 60);
    process.stdout.write(header.join("\n") + "\n");
    return 0;
  }
  options.out = options.out ?? mkdtempSync(path.join(os.tmpdir(), "vulntrace-gates-"));
  mkdirSync(options.out, { recursive: true });
  const wanted = (name) => options.only === undefined || options.only.includes(name);
  const started = Date.now();
  const rows = [];
  const header = ["gate", "result", "exit", "seconds", "test files", "tests"];
  const finish = (code) => {
    const partial =
      options.only === undefined
        ? ""
        : `\nPARTIAL RUN (${options.tier === undefined ? "--only" : `--tier ${options.tier}:`} ${options.only.join(",")}): not the AGENTS.md § I gate set. Run every gate once on the final HEAD before the pull request (docs/WORKFLOW.md § 1.5).\n`;
    const cache = wanted("test:oracle")
      ? `\nReal-Node answers (test:oracle): VT_ORACLE_NODE_CACHE ${oracleCacheMode()}.\n`
      : "";
    process.stdout.write(
      `\n## Gates\n\n${table(header, rows)}\n\nTotal ${seconds(Date.now() - started)}s; logs in ${options.out}\n${cache}${partial}`,
    );
    return code;
  };

  const fast = FAST_GATES.filter((g) => wanted(g.name));
  if (fast.length > 0) {
    const failed = await fastGates(fast, options, rows);
    if (failed !== undefined) {
      process.stdout.write(`\n## ${failed.name} FAILED (${failed.log})\n\n${tail(failed.log)}\n`);
      for (const s of SUITES.filter((x) => wanted(x.name))) rows.push([s.name, "not run", "", "", "", ""]);
      if (wanted(DIFFERENTIAL)) rows.push([DIFFERENTIAL, "not run", "", "", "", ""]);
      return finish(1);
    }
  }

  let ok = true;
  const suites = SUITES.filter((s) => wanted(s.name));
  if (suites.length > 0) {
    const { plan, lists, fullTest, problems } = suitePlan(suites);
    if (problems.length > 0) {
      process.stdout.write(
        `\n## Refusing to run the suites: a test file would not run exactly once\n\n${problems.join("\n")}\n`,
      );
      return finish(1);
    }
    const executions = Object.values(lists).reduce((n, files) => n + files.length, 0);
    process.stderr.write(
      `gates: ${executions} test files across ${plan.length} suites, each exactly once` +
        (fullTest === undefined ? "\n" : ` (npm test's ${fullTest.length} split into the foundation's ${lists["test:foundation"].length} and the other ${lists["test"].length})\n`),
    );
    ok = (await testSuites(plan, lists, options, rows)) && ok;
  }

  if (wanted(DIFFERENTIAL)) {
    ok = (await differential(options, rows)) && ok;
  }
  return finish(ok ? 0 : 1);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`gates: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
