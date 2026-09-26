# A-0 — ADR 0008 coverage reproduction (getters, `util.inspect.custom`, non-protocol Proxy traps)

## Status

- **Status**: done. First verdict `NEEDS_DECISION`; the project owner
  accepted ADR 0008 "Amendment A-0" (parts A and B, with conditions) on
  2026-09-27, recorded by the commits listed under "Owner decision"
  below
- **Branch**: `a0-adr0008-coverage-reproduction`
- **Base SHA**: `276a208b841dba65e35424238af49aafdea6e418` (main after
  `docs(tasks): mark H-0 real-Node oracle harness done`)
- **Commits**:
  - `53d507d` — this task file, in-progress
  - `b9521e5` — runtime refusal of a malformed oracle case
    (`src/testing/oracle/`, `tests/oracle/case-guards.runtime.test.ts`)
  - `2a7f361` — `tests/oracle/` type-checked by `npm run typecheck`
  - `2a2f3a2` — builtin probe: a plain-object Proxy argument kind
  - `c6812b4` — FINDINGS: PRM-117, PRM-118, RWF-051; AUD-01 appended
  - `8018729` — the 32 A-0 cases (`tests/oracle/adr0008-coverage.*`)
  - `ce640f1` — ADR 0008 "Amendment A-0 (PROPOSED)", appended
  - `0ca519f` — REMEDIATION-PLAN § 5a: A-0 entry; lane-A acceptance
  - `ed45804` — regenerated `docs/SCORECARD.md`
  - `4178e9f` — this status set to done (with the Corrections section)
  - Owner decision (2026-09-27):
    - `c84cbd1` — ADR 0008 "Decision record — Amendment A-0" and two
      corrections, appended
    - `6e8dfb4` — REMEDIATION-PLAN: § 2.5 matrix rows, RWF-051-typecheck
      (order 1b), A-7 (order 30), A-3 / A-4 conditions, probe note
    - `b93ac27` — OPEN-DEBTS D-17: updated failure-class counts, appended
    - the commit recording the decision in this file
- **Superseded by**:

## Project context

Lane A of [`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) (the call
graph) is designed in
[`docs/adr/0008-invocation-accounting-and-resolution-authority.md`](../adr/0008-invocation-accounting-and-resolution-authority.md),
including its appended "Decision record — project owner, 2026-09-26".
That record checks § 2's protocol-member rule against the seven
argument-kind paths of the non-invoking-builtin admission test and finds:
`valueOf` / `toString` / `Symbol.toPrimitive` / `toJSON` covered; plain
getters **not** covered; `util.inspect.custom` **not** covered; Proxy traps
covered only through a named protocol member.

It is not yet established whether any *other* rule in ADR 0008 — the
escape rule for values passed to unmodeled code (§ 2), the fail-closed
default (§ 3), the no-edge proofs, or the analyzer's existing attribution
of accessor bodies — closes those paths anyway. This task finds out, by
reproduction against real Node with the H-0 oracle harness
(`src/testing/oracle/`, `tests/oracle/`, `npm run test:oracle`), before
lane A is built. It is the harness's first real use.

Premises, and how each is established (AGENTS.md § D):

- H-0's harness is on `main` at the base SHA: `src/testing/oracle/`,
  `tests/oracle/`, the `test:oracle` script — **measured** (present).
- `npm run typecheck` does not type-check `tests/` — **measured**:
  `tsconfig.json` `include` is `["src"]`; H-0's own
  `src/testing/oracle/case.guards.test.ts` states the same and was placed
  under `src/` for that reason.
- Getters are read by `JSON.stringify` / `Object.assign` / object spread /
  `Object.entries` for every definition form named in S2 — **measured
  false for three of the four forms** in Node v22.11.0 (see Corrections
  if this changes the task's shape): those builtins read only **own
  enumerable** properties, so a class instance getter (on the
  prototype), a class static getter (non-enumerable) and an
  `Object.defineProperty` getter without `enumerable: true`
  (non-enumerable by default) are never invoked. Only the object-literal
  getter is. The cases are still built as specified, with the measured
  ground truth; an `enumerable: true` `defineProperty` variant is added so
  the mechanism the prompt intended is actually exercised.
- `util.inspect.custom` is invoked by `console.log`, `util.inspect` and
  `util.format("%o")`; the named Proxy traps fire for `Object.keys`,
  `Object.getOwnPropertyNames`, `in` and `JSON.stringify`;
  `Array.isArray` and `Object.is` run no user code — **measured** in
  Node v22.11.0 and re-confirmed in the suite with the H-0 builtin probe.
- Sweep round 2 recorded the `Object.defineProperty` getter and Proxy
  `get` trap as KNOWN AUD-01 — **measured** in
  `docs/audits/2026-09-premise-sweep-round-2.md` § 4 (a direct property
  read, not a builtin read); AUD-01's FINDINGS section does not yet say
  so.

## Task

### Problem

ADR 0008's protocol-member rule is a closed, named list. Three
implicit-invocation mechanisms — getters read by builtins,
`util.inspect.custom`, and non-protocol Proxy traps (`ownKeys`, `has`,
`get` on arbitrary keys) — are outside that list. If no other rule of the
ADR closes them, lane A as designed leaves a path to a false
`NOT_AFFECTED` open.

### Why it matters

Soundness first: each mechanism runs user code that can reach a
vulnerable target with no call-graph edge, which is exactly the lane-A
failure family C certifies as unreachable. Defect class B (correct
binding, wrong runtime-value semantics: "a builtin runs no user code").

### What to do

1. **Harden the harness.** A case with an empty `boundNames`, a missing
   control (neither `controls` nor a declared inapplicable reason) or no
   ground-truth command fails at **runtime**, not only at compile time.
   Make `tests/oracle/` (only) type-checked by `npm run typecheck`. Prove
   both with a deliberate empty-`boundNames` case (fails typecheck **and**
   runtime), then remove it. Register as a tooling finding (next free RWF
   number, status Open) that nothing under `tests/` is type-checked, so
   the type-level half of `tests/binding-grammar/`'s `@ts-expect-error`
   disagreement pin has never been enforced by a gate. Fix nothing beyond
   `tests/oracle/`.
2. **Reproduce on `main`**, each case with a loud fixture, both controls
   and real-Node ground truth, the vulnerable call reached only through
   the named mechanism:
   - **S1** `util.inspect.custom` via `console.log(obj)`,
     `util.inspect(obj)`, `util.format("%o", obj)`;
   - **S2** a getter (object literal; class instance; class static;
     `Object.defineProperty` function expression) read through
     `JSON.stringify(o)`, `Object.assign({}, o)`, `{...o}`,
     `Object.entries(o)`;
   - **S3** Proxy traps: `Object.keys(p)` → `ownKeys`,
     `Object.getOwnPropertyNames(p)` → `ownKeys`, `"k" in p` → `has`,
     `JSON.stringify(p)` → `ownKeys` and `get`;
   - **S4** precision controls: an object whose method calls the
     vulnerable function, passed to `Array.isArray(obj)` and
     `Object.is(obj, x)`; builtin behaviour confirmed with the H-0 probe.
   Record per case the verdict and proof family on `main`, and the ground
   truth.
3. **Register** each false-`NOT_AFFECTED` case: attach it (appended text)
   to an existing finding whose mechanism it is; otherwise a new
   `PRM-117`+ finding, status Open, fix lane A, in the existing PRM field
   format. No duplicates.
4. **Pin** each reproduced false `NOT_AFFECTED` as an
   open-soundness-defect record (`src/testing/open-soundness-defect.ts`
   via the harness's `toVerdictObservation`): forbidden `NOT_AFFECTED`,
   admissible `{UNKNOWN, AFFECTED}`, expected after lane A `UNKNOWN`,
   observed the exact current result. Pin S4 as ordinary passing tests
   asserting `NOT_AFFECTED`.
5. **Does ADR 0008 close each case?** From the ADR's text (body and
   Decision record), quote the rule that makes each case `UNKNOWN`, or
   state that none does, distinguishing the escape rule, the protocol
   rule and accessor-body attribution. For any unclosed case, append to
   ADR 0008 an "Amendment A-0 (PROPOSED — requires project-owner
   decision)" section (minimal rule change, why sound, precision cost
   against S4, implementing lane-A task), change nothing else in the ADR,
   implement nothing, and report `NEEDS_DECISION`.
6. **Plan.** In `docs/REMEDIATION-PLAN.md`, add A-0 to § 5a before A-1
   with its status, and add every pinned case to the acceptance criteria
   of the lane-A task that closes it.

## Boundaries

### Do not touch

- Any non-test file under `src/` outside `src/testing/` (no analyzer
  change); `src/testing/oracle/` only for hardening.
- Other ADRs; `docs/audits/`; `README.md`; `scripts/`.
- ADR 0008's body (an appended amendment section only).
- `tests/validation/FINDINGS.md` except new entries and appended text.
- `docs/REMEDIATION-PLAN.md` except the A-0 entry and acceptance
  additions.
- Any worktree but this task's own. No finding is fixed.

### STOP conditions

- `main` lacks `src/testing/oracle/`, `tests/oracle/` or `test:oracle`.
- A case cannot be given a loud fixture, both controls and ground truth.
- Closing a case needs an analyzer change, or a change outside the
  boundaries above.

## Acceptance criteria

- [ ] Task file committed first and marked done at the end
- [ ] Harness rejects empty `boundNames` / missing control / missing
      ground truth at runtime; `tests/oracle/` is type-checked; both shown
- [ ] The tests/-not-type-checked problem registered as a tooling finding
- [ ] Every S1–S4 case built with loud fixture, both controls and ground
      truth; builtin behaviour confirmed with the probe
- [ ] Every reproduced case attached to an existing finding or registered
      as a new PRM — no duplicates
- [ ] Every reproduced case pinned as an open-soundness-defect record; S4
      pinned as passing precision controls
- [ ] For each case: the ADR 0008 rule that closes it quoted, or "none"
- [ ] Any unclosed case has a PROPOSED amendment appended to ADR 0008,
      and the verdict is `NEEDS_DECISION`
- [ ] Plan updated: A-0 in § 5a; pinned cases in lane-A acceptance
- [ ] No analyzer file changed; differentials zero; gates green;
      validation at the five known failures
- [ ] Pushed; no PR; no merge; clean commit metadata

## Gates

The full set in `AGENTS.md` section I, unrelaxed, including
`npm run test:oracle`. Analyzer differentials must be zero (no analyzer
file changes). Validation: exactly the five documented known failures
(OPEN-DEBTS D-09), same verdicts.

## Report

In the format of `AGENTS.md` section J, plus: an evidence table with one
row per case (mechanism, analyzer result on `main`, ground truth, finding
ID, the ADR 0008 rule that closes it quoted or "none"); the builtin probe
results used; the harness hardening proof; and, if any, the proposed
amendment (rule, soundness argument, precision cost, implementing task).

## Corrections

Appended 2026-09-26, per `README.md` ("once executed, a task file is not
rewritten"). Each item is also reported under DEVIATIONS.

1. **S2's premise is false for three of its four definition forms**
   (measured in Node v22.11.0 and pinned). `JSON.stringify`,
   `Object.assign`, object spread and `Object.entries` read only **own
   enumerable** properties. A class instance getter (on the prototype), a
   class static getter (non-enumerable) and a default
   `Object.defineProperty` getter (non-enumerable) are never run by them.
   The cases were built as specified, with that ground truth. An
   `enumerable: true` `defineProperty` variant was added, so that the
   mechanism the task named is actually exercised.
2. **Two class-getter families are false `AFFECTED`, not false
   `NOT_AFFECTED`.** The analyzer attributes accessor bodies to the
   enclosing owner (round 1's PRM-46, recorded there as TRUE), so a
   getter real Node never runs yields a path that does not exist. Step 3
   asks for false `NOT_AFFECTED` only. This was registered anyway, as
   PRM-118, and pinned the same way (admissible `UNKNOWN`/`NOT_AFFECTED`),
   because a fabricated edge is a soundness defect (AGENTS.md § E).
3. **Two S3 cases were added**, with the Proxy handler bound to a
   `const` (triggered by `Object.keys` and by `in`). Step 5 has to
   distinguish a function that is an object member of an argument from a
   method of an object passed by name. The `in` variant is the case ADR
   0008 as written does not close.
4. **The H-0 builtin probe was hardened a second time** (within "hardening
   only"). Its only Proxy argument wrapped a callable target, and
   `JSON.stringify` returns early for a callable, so the probe could not
   show the `ownKeys` enumeration that S3 relies on. A `proxyPlainObject`
   argument kind was added.
5. **The typecheck gate was widened through `package.json`'s `typecheck`
   script** (`tsc --noEmit && tsc --noEmit -p tests/oracle/tsconfig.json`).
   The root `tsconfig.json` has `rootDir: "src"`, so adding
   `tests/oracle` to its `include` was not the minimal change.
6. **A-0 is order `1a`** in `REMEDIATION-PLAN.md` § 5a, not a renumbered
   order 2, so that the order numbers later rows cite stay valid.

## Owner decision (appended 2026-09-27)

The project owner decided the `NEEDS_DECISION` this task reported.
Amendment A-0 is **accepted**: part A with a mechanical-admission
condition (every non-invoking allowlist entry needs a passing H-0
builtin-probe test, run in CI), and part B with two conditions (A-4
measures its precision cost before merging; a later reader-builtin
precision task is added). Extending the escape rule to every member of
any object passed to any builtin was considered and rejected. The
decision is recorded in ADR 0008, "Decision record — Amendment A-0". Its
conditions are in `docs/REMEDIATION-PLAN.md` § 5a (A-3 and A-4
acceptance; RWF-051-typecheck as order 1b; A-7 as order 30).

Deviations while recording it, also reported:

1. The inspection claim ("inspection is covered by the protocol-member
   rule") is in ADR 0008 § 2, not in the Decision record, as the
   decision prompt had it. The correction names § 2.
2. The plan has no "Phase 4". The reader-builtin task was added as A-7,
   order 30 in § 5a, after every lane task.
3. Two facts measured on 2026-09-27 are recorded in A-3's acceptance and
   were not in the decision. First, CI (`.github/workflows/ci.yml`) does
   not run `npm run test:oracle`. Second, `JSON.parse`, the only builtin
   call in RWB-07's source, has a firing probe (`toString`,
   `Symbol.toPrimitive`, Proxy `get`), so mechanical admission may cost
   RWB-07's correct `NOT_AFFECTED`.
