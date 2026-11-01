#!/usr/bin/env node
/**
 * Task BL-120 — MEASURE OPTION PROTOTYPES AGAINST A BASE.
 *
 * A decision task (BL-094, BL-096, BL-111, BL-114) prototypes each option
 * as a patch against its base, outside the analyzer's committed code, and
 * measures what each costs and what each closes. Each of those tasks did
 * it by hand, with its own `measure.sh` or `census.mjs`. This script does
 * it once for any set of patches:
 *
 *   node scripts/measure-options.mjs [--base <ref>] [--scratch <dir>]
 *        [--out <dir>] [--oracle <filters>] [--no-oracle]
 *        [--no-differential] [--corpus <names>] [--case <ids>]
 *        [--census <module.mjs>] [--census-roots <dirs>]
 *        [--use-head-dependencies] [--cleanup]
 *        <option.patch>...
 *
 * `--base` defaults to `git merge-base HEAD main`. Every patch must apply
 * to it (`git apply`); an option's name is its file name without
 * `.patch`.
 *
 * FOR THE BASE AND THEN EACH OPTION, ONE AFTER ANOTHER (never
 * concurrently: the oracle suite and the corpus scans compete for CPU, and
 * the performance-sensitive suites measure wall clock):
 *
 * 1. PREPARE. A detached worktree of the base under
 *    `<scratch>/sides/<name>` (created once, reset on a later run), with
 *    this checkout's `node_modules` COPIED into it, never symlinked (a
 *    symlink makes `tests/validation/hermeticity.test.ts` fail
 *    spuriously). The base's `package-lock.json` must equal this
 *    checkout's, or the copy would not be the base's dependencies;
 *    `--use-head-dependencies` measures anyway and the report says so.
 *    The patch is applied and `dist` is built (`tsconfig.build.json`).
 * 2. THE ORACLE SUITE (`vitest.oracle.config.ts`), reported by
 *    `measure-options-reporter.mjs` (vitest's JSON shape, with each
 *    failure's asserted value kept: vitest's own JSON reporter drops the
 *    text that tells a flipped record from a lost control);
 *    `--oracle` passes vitest file filters (comma-separated) to
 *    run only part of it, `--no-oracle` skips it. Real Node's answers are
 *    served from the user-level cache (`src/testing/oracle/real-node-cache.ts`)
 *    shared by every side; the analyzer's scans never are.
 * 3. THE DIFFERENTIAL'S SNAPSHOT (`scripts/differential.mjs --collect`,
 *    the base commit's own copy), with `--corpus` / `--case` passed on;
 *    each option is then compared with the base's snapshot
 *    (`--diff`), so the base side is collected exactly once.
 *    `--no-differential` skips it.
 * 4. THE CENSUS (only with `--census`): the module's default export is
 *    called once per side as `await census({ dist, root })`, with the
 *    side's absolute `dist` and worktree, and returns a predicate
 *    `(file, text) => boolean` (or a promise of one). It runs in a child
 *    process over every `.js` / `.cjs` / `.mjs` file under the roots
 *    (`--census-roots`, comma-separated; default the base side's
 *    `node_modules`; a file over 2 MB, or one the predicate throws on, is
 *    skipped and counted). A side whose build lacks what the module needs
 *    (the base, usually) throws, and is reported "unavailable".
 *
 * WHAT IS REPORTED (`measure-options-lib.mjs` holds the comparison, and
 * says how each quantity is classified): per option, the open-soundness-
 * defect records flipped or drifted, the controls lost and tests gained;
 * the graph, proof and verdict differentials, with every verdict that
 * moved, those into `NOT_AFFECTED` first; the suites' `NOT_AFFECTED`
 * proofs lost, by corpus, and the suite verdicts moved into
 * `NOT_AFFECTED`; and the census. `<out>/report.md` (also printed),
 * `<out>/summary.json`, and every raw report and log beside them. `--out`
 * defaults to `<scratch>/results`; `--scratch` to a fresh directory under
 * the OS temp root named after the base.
 *
 * A worktree is registered with this repository until it is removed:
 * `--cleanup` removes every side's worktree after the run (`git worktree
 * remove --force`); otherwise they are kept for a later run and the report
 * names them.
 *
 * Exit status: 0 when the report was produced (whatever it contains), 2
 * on a usage error or when the base side could not be prepared.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  aggregateCensus,
  compareOracle,
  oracleOutcomes,
  oracleTotals,
  renderReport,
  summarizeDifferential,
} from "./measure-options-lib.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// The census child: `--census-run <module> <dist> <root> <out.json> <roots…>`.
// ---------------------------------------------------------------------------

const EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const CENSUS_SIZE_LIMIT = 2_000_000;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

async function censusRun([modulePath, dist, root, out, ...roots]) {
  const census = (await import(pathToFileURL(path.resolve(modulePath)).href)).default;
  if (typeof census !== "function") {
    throw new Error(`${modulePath} has no default-exported function`);
  }
  const predicate = await census({ dist, root });
  const entries = [];
  let skipped = 0;
  for (const r of roots) {
    for (const file of walk(r)) {
      let text;
      try {
        if (statSync(file).size > CENSUS_SIZE_LIMIT) {
          skipped += 1;
          continue;
        }
        text = readFileSync(file, "utf8");
      } catch {
        skipped += 1;
        continue;
      }
      try {
        entries.push({ file, flagged: Boolean(await predicate(file, text)) });
      } catch {
        skipped += 1;
      }
    }
  }
  writeFileSync(out, JSON.stringify({ ...aggregateCensus(entries), skipped }) + "\n");
}

// ---------------------------------------------------------------------------
// The driver.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { patches: [], oracle: true, differential: true };
  const takesValue = new Set([
    "--base",
    "--scratch",
    "--out",
    "--oracle",
    "--corpus",
    "--case",
    "--census",
    "--census-roots",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      options[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else if (arg === "--no-oracle") options.oracle = false;
    else if (arg === "--no-differential") options.differential = false;
    else if (arg === "--use-head-dependencies") options.useHeadDependencies = true;
    else if (arg === "--cleanup") options.cleanup = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new UsageError(`unknown argument: ${arg}`);
    else options.patches.push(path.resolve(arg));
  }
  return options;
}

function run(command, args, { cwd, log, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (log !== undefined) {
    writeFileSync(
      log,
      `$ ${command} ${args.join(" ")}\n(cwd ${cwd ?? process.cwd()}, exit ${result.status})\n\n${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error}` : ""}`,
    );
  }
  return result;
}

function git(args, cwd = REPO_ROOT) {
  const result = run("git", args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function prepareSide({ name, patch, base, scratch, out }) {
  const dir = path.join(scratch, "sides", name);
  if (existsSync(dir)) {
    if (git(["rev-parse", "HEAD"], dir).trim() !== base) {
      throw new Error(`${dir} exists and is not a worktree of ${base}`);
    }
    git(["reset", "-q", "--hard", base], dir);
    git(["clean", "-fdq"], dir);
  } else {
    mkdirSync(path.dirname(dir), { recursive: true });
    git(["worktree", "add", "--detach", dir, base]);
  }
  if (!existsSync(path.join(dir, "node_modules"))) {
    cpSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  if (patch !== undefined) {
    const applied = run("git", ["apply", patch], {
      cwd: dir,
      log: path.join(out, `apply-${name}.log`),
    });
    if (applied.status !== 0) {
      throw new Error(`the patch does not apply to the base (apply-${name}.log)`);
    }
  }
  rmSync(path.join(dir, "dist"), { recursive: true, force: true });
  const built = run("npx", ["tsc", "-p", "tsconfig.build.json"], {
    cwd: dir,
    log: path.join(out, `build-${name}.log`),
  });
  if (built.status !== 0) {
    throw new Error(`the build failed (build-${name}.log)`);
  }
  return dir;
}

function runOracle({ name, dir, out, filters }) {
  const report = path.join(out, `oracle-${name}.json`);
  rmSync(report, { force: true });
  // This checkout's reporter, by absolute path (the base has none): it
  // keeps the asserted value a record's failure carries, which vitest's
  // own JSON reporter drops (`measure-options-reporter.mjs`).
  const reporter = fileURLToPath(new URL("./measure-options-reporter.mjs", import.meta.url));
  run(
    "npx",
    [
      "vitest",
      "run",
      "--config",
      "vitest.oracle.config.ts",
      "--reporter=dot",
      `--reporter=${reporter}`,
      ...filters,
    ],
    {
      cwd: dir,
      log: path.join(out, `oracle-${name}.log`),
      env: { ...process.env, VT_MEASURE_OPTIONS_REPORT: report },
    },
  );
  if (!existsSync(report)) {
    throw new Error(`no vitest report (oracle-${name}.log)`);
  }
  return oracleOutcomes(JSON.parse(readFileSync(report, "utf-8")), dir);
}

function collectSnapshot({ name, dir, out, corpus, cases }) {
  const snapshot = path.join(out, `snapshot-${name}.json`);
  const script = path.join(dir, "scripts", "differential.mjs");
  if (!existsSync(script)) {
    throw new Error("the base has no scripts/differential.mjs (it predates BL-029)");
  }
  const args = [script, "--collect", snapshot, "--label", name];
  if (corpus !== undefined) args.push("--corpus", corpus);
  if (cases !== undefined) args.push("--case", cases);
  rmSync(snapshot, { force: true });
  const result = run("node", args, { cwd: dir, log: path.join(out, `collect-${name}.log`) });
  if (result.status !== 0 || !existsSync(snapshot)) {
    throw new Error(`the snapshot could not be collected (collect-${name}.log)`);
  }
  return snapshot;
}

function diffSnapshots({ name, baseDir, baseSnapshot, snapshot, out }) {
  const dir = path.join(out, `diff-${name}`);
  const result = run(
    "node",
    [path.join(baseDir, "scripts", "differential.mjs"), "--diff", baseSnapshot, snapshot, "--out", dir],
    { cwd: baseDir, log: path.join(out, `diff-${name}.log`) },
  );
  const file = path.join(dir, "diff.json");
  if (result.status !== 0 || !existsSync(file)) {
    throw new Error(`the snapshots could not be compared (diff-${name}.log)`);
  }
  return summarizeDifferential(JSON.parse(readFileSync(file, "utf-8")));
}

function runCensus({ name, dir, out, module, roots }) {
  const file = path.join(out, `census-${name}.json`);
  rmSync(file, { force: true });
  const result = run(
    "node",
    [fileURLToPath(import.meta.url), "--census-run", module, path.join(dir, "dist"), dir, file, ...roots],
    { cwd: dir, log: path.join(out, `census-${name}.log`) },
  );
  if (result.status !== 0 || !existsSync(file)) {
    const first = String(result.stderr).trim().split("\n").find((l) => l !== "") ?? "";
    return { error: `the census module failed on this side (census-${name}.log): ${first}` };
  }
  return JSON.parse(readFileSync(file, "utf-8"));
}

function attempt(side, part, fn) {
  try {
    return fn();
  } catch (error) {
    side.partErrors.push(`${part}: ${error.message}`);
    return undefined;
  }
}

async function main(argv) {
  if (argv[0] === "--census-run") {
    await censusRun(argv.slice(1));
    return 0;
  }
  const options = parseArgs(argv);
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf-8").split("*/")[0]);
    return 0;
  }
  if (options.patches.length === 0) throw new UsageError("name at least one option patch");
  for (const patch of options.patches) {
    if (!existsSync(patch)) throw new UsageError(`no such patch: ${patch}`);
  }
  const names = options.patches.map((p) => path.basename(p).replace(/\.patch$/, ""));
  if (new Set([...names, "base"]).size !== names.length + 1) {
    throw new UsageError(`option names must be distinct and not "base": ${names.join(", ")}`);
  }

  const base = git([
    "rev-parse",
    "--verify",
    `${options.base ?? git(["merge-base", "HEAD", "main"]).trim()}^{commit}`,
  ]).trim();
  const scratch = path.resolve(
    options.scratch ?? path.join(os.tmpdir(), `vt-measure-options-${base.slice(0, 12)}`),
  );
  const out = path.resolve(options.out ?? path.join(scratch, "results"));
  mkdirSync(out, { recursive: true });
  const notes = [];

  const headLock = readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf-8");
  if (git(["show", `${base}:package-lock.json`]) !== headLock) {
    if (!options.useHeadDependencies) {
      throw new UsageError(
        "the base's package-lock.json differs from this checkout's, so the copied node_modules are not the base's dependencies; pass --use-head-dependencies to measure anyway",
      );
    }
    notes.push("Measured with this checkout's dependencies: the base's `package-lock.json` differs (`--use-head-dependencies`).");
  }
  const census =
    options.census === undefined ? undefined : path.resolve(options.census);
  const filters = options.oracle === undefined || options.oracle === true ? [] : options.oracle.split(",");

  const sides = [{ name: "base" }, ...names.map((name, i) => ({ name, patch: options.patches[i] }))];
  const measured = [];
  let baseDir;
  let baseOracle;
  let baseSnapshot;
  let roots;
  for (const side of sides) {
    const started = Date.now();
    const record = { name: side.name, partErrors: [] };
    measured.push(record);
    console.error(`measure-options: ${side.name} — preparing`);
    let dir;
    try {
      dir = prepareSide({ ...side, base, scratch, out });
    } catch (error) {
      if (side.name === "base") throw error;
      record.error = error.message;
      continue;
    }
    record.dir = dir;
    if (side.name === "base") {
      baseDir = dir;
      roots = (options.censusRoots?.split(",") ?? [path.join(dir, "node_modules")]).map((r) =>
        path.resolve(r),
      );
    }
    if (options.oracle !== false) {
      console.error(`measure-options: ${side.name} — oracle suite`);
      const outcomes = attempt(record, "oracle", () =>
        runOracle({ name: side.name, dir, out, filters }),
      );
      if (side.name === "base") {
        baseOracle = outcomes;
        record.oracle = outcomes && oracleTotals(outcomes);
      } else if (outcomes !== undefined && baseOracle !== undefined) {
        record.oracle = compareOracle(baseOracle, outcomes);
      }
    }
    if (options.differential) {
      console.error(`measure-options: ${side.name} — differential snapshot`);
      const snapshot = attempt(record, "differential", () =>
        collectSnapshot({ name: side.name, dir, out, corpus: options.corpus, cases: options.case }),
      );
      if (side.name === "base") baseSnapshot = snapshot;
      else if (snapshot !== undefined && baseSnapshot !== undefined) {
        record.differential = attempt(record, "differential", () =>
          diffSnapshots({ name: side.name, baseDir, baseSnapshot, snapshot, out }),
        );
      }
    }
    if (census !== undefined) {
      console.error(`measure-options: ${side.name} — census`);
      record.census = runCensus({ name: side.name, dir, out, module: census, roots });
    }
    record.seconds = Math.round((Date.now() - started) / 1000);
  }

  for (const r of measured) {
    for (const e of r.partErrors) notes.push(`\`${r.name}\`: ${e}`);
  }
  if (census !== undefined) {
    notes.push(`Census roots: ${roots.map((r) => `\`${r}\``).join(", ")}.`);
  }
  if (filters.length > 0) {
    notes.push(`The oracle suite was run on part of its files only: ${filters.map((f) => `\`${f}\``).join(", ")}.`);
  }
  if (options.corpus !== undefined || options.case !== undefined) {
    notes.push(`The differential covers part of the corpora only (--corpus ${options.corpus ?? "all"}, --case ${options.case ?? "all"}).`);
  }
  notes.push(
    `Time per side: ${measured.map((r) => `\`${r.name}\` ${r.seconds ?? "—"} s`).join(", ")}.`,
  );
  if (options.cleanup) {
    for (const r of measured) {
      if (r.dir !== undefined) git(["worktree", "remove", "--force", r.dir]);
    }
    notes.push("The sides' worktrees were removed (`--cleanup`).");
  } else {
    notes.push(
      `The sides' worktrees are kept under \`${path.join(scratch, "sides")}\` for a later run; remove each with \`git worktree remove --force <dir>\`, or pass \`--cleanup\`.`,
    );
  }

  const report = renderReport({ base, sides: measured, notes });
  writeFileSync(path.join(out, "report.md"), report);
  writeFileSync(
    path.join(out, "summary.json"),
    JSON.stringify({ base, sides: measured, notes }, null, 2) + "\n",
  );
  process.stdout.write(report);
  console.error(`measure-options: report in ${out}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`measure-options: ${error.message}`);
    process.exit(2);
  },
);
