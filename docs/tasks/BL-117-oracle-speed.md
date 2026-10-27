# BL-117 — Oracle speed: a local cache of real-Node results, builtin-admission off the critical path, a development tier in `gates.mjs`

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-117
- **Branch**: `bl-117-oracle-speed`
- **Base SHA**: `e6b05216450134e940d8ee0db18d6dc9733c7cf5` (BL-116's merge, PR #122)
- **Commits**:
  - `docs(tasks): BL-117 task file — oracle speed`
  - `test(BL-117): cache real-Node oracle results on disk, locally`
  - `test(BL-117): spread builtin-admission's ambient positions over 4 files`
  - `build(BL-117): a dev tier in gates.mjs; WORKFLOW notes the cache`
  - (this commit) `docs(BL-117): records — account, backlog, progress`
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

- [x] Every real-Node process of `src/testing/oracle/` runs through the
      cache module. A test checks that no other non-test module of that
      directory imports `node:child_process`.
- [x] Each key input is attacked by a test that changes it and sees the
      key change: project bytes, paths, symlinks, modes, arguments,
      environment, stdin mode, timeout, executable identity, a
      `package.json` above the project.
- [x] Each unnameable input is attacked by a test: a `node_modules` above
      the project, `NODE_PATH`, or a project naming its own directory
      makes a run uncached.
- [x] A timeout and a run that writes into its project are not stored.
- [x] A served result is re-rooted, `verify` fails on a planted entry,
      and a malformed or mis-keyed entry is never served.
- [x] `off` runs every process and writes nothing. CI sets it off.
- [x] The admission tests of ambient builtins run in more than one file.
      The table test checks that the files cover every admitted position
      exactly once.
- [x] `node scripts/gates.mjs --tier dev` runs the named preset, is
      labelled PARTIAL, and is tested in `src/testing/gates-lib.test.ts`.
- [x] Measured: the base, the branch with the cache off, cold and warm;
      and a whole-suite `verify` run passing.
- [x] The fresh-context review of the key is done, and its findings are
      addressed or registered.
- [x] The full gate set passes.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected differentials: graph,
proof and verdict all zero (no analyzer change). Validation baseline:
unchanged (OPEN-DEBTS D-09).

## Report

In the format of `AGENTS.md` § J. Add:

- the before and after timings and test counts;
- the cache key review's findings.

## Account

### Premises, verified

- **Real Node is the oracle suite's time.** Measured on the base
  (`e6b0521`), on this 4-core machine, loaded by other sessions (load
  about 6 to 8): `test:oracle` ran in 765 s wall, with 44 files and 1,434
  tests passing; the files' summed time was 2,053 s.
  `builtin-admission.globals.test.ts` alone took 707 s. The backlog row's
  numbers (716 s, 670 s on `5c8bcc3`) hold in shape.
- **None of the harness's real-Node processes reads the analyzer.** The
  loud-fixture check, the ground truth and the probes run `node` on the
  fixture's files or on a script. Only `runOracleScan` runs the analyzer,
  and it is not cached.
- **The fixtures read environment variables** (`BL074_NOPE`,
  `VT_RWF050_OFF`, `VT_NEVER_SET`, `VT_SILENT`). So the child's
  environment must be in the key. It is now an allow-list
  (`childEnvironment`), the same in every mode, and keyed whole.
- **No probe needs this process's working directory.** The probes load
  only builtins (globals and `module:path:*`). They now run in their own
  empty project, which the key can name.

### Deviations from the task's wording

- The child's environment is now an allow-list in every mode, not only
  when the cache is on. A variable outside the list can no longer reach a
  real-Node child, so it cannot change an answer behind the key.
  Measured: no ground truth moved (`off` against the base, below). The
  key review checked every fixture's environment reads.
- The builtin probes ran in this process's working directory and now run
  in an empty temporary one.
- The loud-fixture check no longer echoes the child's stderr into the
  test output. Its failure message prefers stderr, then stdout (`||`
  where `??` let an empty stderr hide stdout).
- Only the Node running the suite is cached. A ground truth run by any
  other executable runs uncached every time (key review, F4).

### The cache key review (two rounds; `Audit: no`, the row asks for it)

Round 1 was `BLOCKED`, with four confirmed holes, each reproduced by the
reviewer and each fixed with a test that fails on the code before it:

- **F1:** entries were framed by NUL bytes with no length, so one file's
  bytes could imitate the entries after it. Now each entry is one JSON
  record, and a file is recorded by the SHA-256 of its bytes.
- **F2:** the symlink-escape check was lexical (`d -> .`,
  `e.js -> d/../x`). It now compares real paths, and a dangling link
  counts as an escape.
- **F3:** `NODE_OPTIONS=--require <file>` was keyed as text, not by the
  file's bytes. Now any `NODE_*` or `UV_*` variable but `NODE_ENV` makes
  a run uncacheable.
- **F4:** a version manager's shim kept its file identity while it ran
  another release. Now only `process.execPath`'s Node is cached.
- **F5 (low):** re-rooting is literal. The header now says so.

Round 2 was `BLOCKED`, with one confirmed hole and three hardenings, all
fixed with a test each that fails on round 1's code:

- **N1:** the folders above the project were walked on the spelled path,
  but Node resolves from the real one, so a symlinked `TMPDIR` left them
  unkeyed. Both chains are now walked, and both parents keyed.
- **U1:** the key is now computed again after the run, and a result is
  stored only when the key is unchanged.
- **U2:** `process.versions` is keyed.
- **U3:** a FIFO, socket or device makes a run uncacheable.

There was no third round (WORKFLOW § 1.5). Round 2's fixes are listed for
the owner under "Needs human review".

### Mutations (each caught by a named test in `real-node-cache.test.ts`)

Every mutation is caught except two. M3 (key without the executable's
identity) and M18 (key without the harness source) are reviewed only:
testing them would mean changing the Node binary or the module's own
source in place. `harnessSourceDigest` itself is tested (M19). The
mutations, each with the test that catches it:

- the project fingerprint, the environment, the manifests above, and the
  real parent dropped from the key;
- a `node_modules` above, `NODE_PATH`, an escaping link, or a lexical
  link check ignored;
- no re-rooting;
- a run that writes into its project, or a timeout, stored;
- an entry served under another key;
- the child given the whole environment;
- `verify` serving like `on`, and CI not turning the cache off;
- `NODE_*` keyed as text, NUL framing, any executable keyed, the
  spelled-path-only walk, no recheck after the run, `process.versions`
  dropped, special files cached.

Two shard mutations are also caught: a position in two groups, and a
group registered twice.

### Measurements (`test:oracle`, 4 cores, other sessions running)

| Run | Code | Wall | Files | Tests | Summed file time | Largest file |
| --- | --- | --- | --- | --- | --- | --- |
| base | `e6b0521` | 765 s | 44 | 1,434 passed | 2,053 s | `builtin-admission.globals` 707 s |
| off | branch | 734 s | 47 | 1,435 passed | 1,993 s | `globals-4` 219 s |
| cold | branch | 596 s | 47 | 1,435 passed | 1,570 s | `globals-4` 188 s |
| warm | branch | 244 s | 47 | 1,435 passed | 524 s | `bl099-namespace-export-member-read` 66 s |
| cold, final | final | 596 s | 47 | 1,435 passed | 1,579 s | `globals-4` 191 s |
| verify, final | final | 699 s | 47 | 1,435 passed | 1,885 s | `globals-4` 208 s |

The extra test is the registration check. The cold run stored 10,374
entries.

- With the cache off, the suite is CPU-bound on four cores: about
  2,000 s of file time. Taking the 707 s file off the critical path
  therefore saves little wall time here.
- A warm run is 3.1 times faster than the base. What remains is mostly
  the analyzer's scans, which are never cached.

The first whole-suite `verify` run (on the code before the last fix)
failed two tests. Both differences were the process ID in a Node
warning's `(node:<pid>)` prefix (PRM-15's `MODULE_TYPELESS_PACKAGE_JSON`
warning), which differs between any two fresh runs. `verify` now masks
it, with a test. No other difference was found. On the final code, the
whole-suite `verify` run passes: every result of the 10,374 the cold run
stored matched a fresh run of the same inputs.
