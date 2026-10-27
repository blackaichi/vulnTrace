# BL-117 — Oracle speed: a local cache of real-Node results, builtin-admission off the critical path, a development tier in `gates.mjs`

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-117
- **Branch**: `bl-117-oracle-speed`
- **Base SHA**: `e6b05216450134e940d8ee0db18d6dc9733c7cf5` (BL-116's merge, PR #122)
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

On 2026-10-27 the project owner accepted a review's proposals for the
workflow (task `BL-116`, its task file § "Project context"). One of them
is this task, and the owner authorized its central piece: "a local on-disk
cache of real-Node oracle results, with CI uncached" (BL-116, decision 4).

`npm run test:oracle` is the slowest suite in the gate set. Its time goes
to real Node, not to the analyzer: the loud-fixture check, the ground
truth and the builtin probes each spawn a separate `node` process, and
none of them reads the analyzer. Their answers depend only on what they
are given. The review measured this on `5c8bcc3` (the backlog row's
numbers); this task re-measures it on its base before relying on it.

BL-089 already reuses a control's *scan* within one run
(`src/testing/oracle/scan-reuse.ts`, `VT_ORACLE_SCAN_REUSE`). This task
does not touch the scan: it caches real Node's answers, across runs.

## Task

### Problem

- `test:oracle` takes about 12 minutes on a 4-core machine, and every
  re-run during a task pays all of it again, although most of its
  real-Node processes get the same inputs on every run.
- `tests/oracle/builtin-admission.globals.test.ts` alone runs for most of
  the suite's wall time. A vitest file runs on one worker, so that file is
  the suite's critical path whatever the other workers do.
- `node scripts/gates.mjs` offers the whole gate set or a hand-written
  `--only`. Nothing names the set to run while a task is being
  implemented.

### Why it matters

Performance of the instrument, which is the last priority
(ARCHITECTURE § 2), and must never become proof authority (§ 9.1). The
risk this task carries is the inverse: **a mis-keyed cache would serve a
case another project's real-Node answer**. The oracle's ground truth is
what every soundness fix rests on, so a wrong ground truth could certify a
false `NOT_AFFECTED` as correct. The cache key is therefore treated as a
soundness-critical piece: every input is named, whatever cannot be named
is not cached, and a `verify` mode checks the cache against fresh runs.

### What to do

1. **Cache.** One module through which every real-Node process of the
   harness runs (`src/testing/oracle/real-node-cache.ts`), keyed by:
   - the harness's own source;
   - the executable (resolved through `PATH`, its real path and file
     identity) and its release;
   - the exact arguments (the script);
   - the child's environment;
   - the project's bytes;
   - what the folders above the project can hand Node.

   It has `on`, `off` and `verify` modes, like `VT_ORACLE_SCAN_REUSE`'s.
   CI runs with it off. The loud-fixture check, the ground truth and the
   builtin probes use it. The analyzer's scan is never cached.
2. **Builtin-admission off the critical path.** Split the per-position
   admission tests of ambient builtins over more files, so that they run
   on several workers. The table test still checks that the files
   together cover every admitted position exactly once.
3. **A development tier** in `scripts/gates.mjs`, as a named, PARTIAL
   preset of gates.
4. **Measure before and after**, as BL-089 did: the oracle suite's wall
   time and test counts on the base; the branch uncached (cache `off`);
   the branch cold; and the branch warm. Then the whole suite once in
   `verify` mode against a warm cache.
5. A fresh-context review of the cache key before the pull request (the
   backlog row).

## Boundaries

### Do not touch

- The analyzer (`src/` outside `src/testing/`).
- Any test's assertion, case, control or threshold. No test is skipped and
  no timeout is raised. The admission tests are moved between files, never
  changed.
- `scan-reuse.ts`'s rules.
- CI's structure (BL-118 owns it). This task only sets the cache off in
  CI.

### STOP conditions

- A real-Node answer that the cache serves differs from a fresh run
  (`verify` fails) and the key cannot be fixed to name the difference.
- Any oracle test's result changes between the base and the branch with
  the cache off.

## Acceptance criteria

- [ ] Every real-Node process of `src/testing/oracle/` runs through the
      cache module. A test checks that no other non-test module of that
      directory imports `node:child_process`.
- [ ] Each key input is attacked by a test that changes it and sees the
      key change: project bytes, paths, symlinks, modes, arguments,
      environment, stdin mode, timeout, executable identity, a
      `package.json` above the project.
- [ ] Each unnameable input is attacked by a test: a `node_modules` above
      the project, `NODE_PATH`, or a project naming its own directory
      makes a run uncached.
- [ ] A timeout and a run that writes into its project are not stored.
- [ ] A served result is re-rooted, `verify` fails on a planted entry,
      and a malformed or mis-keyed entry is never served.
- [ ] `off` runs every process and writes nothing. CI sets it off.
- [ ] The admission tests of ambient builtins run in more than one file.
      The table test checks that the files cover every admitted position
      exactly once.
- [ ] `node scripts/gates.mjs --tier dev` runs the named preset, is
      labelled PARTIAL, and is tested in `src/testing/gates-lib.test.ts`.
- [ ] Measured: the base, the branch with the cache off, cold and warm;
      and a whole-suite `verify` run passing.
- [ ] The fresh-context review of the key is done, and its findings are
      addressed or registered.
- [ ] The full gate set passes.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected differentials: graph,
proof and verdict all zero (no analyzer change). Validation baseline:
unchanged (OPEN-DEBTS D-09).

## Report

In the format of `AGENTS.md` § J. Add:

- the before and after timings and test counts;
- the cache key review's findings.

## Account

<!-- Filled in while working (docs/WORKFLOW.md § 1.2). -->
