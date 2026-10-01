# A-3a — Escaped function values; invoking and non-invoking builtins with mechanical admission; global hook assignments

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: A-3a
- **Branch**: a-3a-escaped-values
- **Base SHA**: 51c980c766a5976e8936a645f0c79228d2d10d38
- **Commits**:
  - `862c51d` docs(tasks): A-3a task file — escaped function values, builtin admission, hook assignments
  - `6bdb2e6` test(A-3a): real-Node reproductions — escaped values, invoking builtins, hook assignments, RWF-060
  - `b0b8f31` test(A-3a): mechanical admission — the builtin probe, the builtin table, the admission test
  - `3de78b0` fix(A-3a): escape row, builtin accounts, hook assignments, RWF-060, Reflect.construct
  - `bfad4e1` docs(A-3a): records — findings, debts, plan § 5a, backlog, progress, scorecard
  - (this commit) test(A-3a): record the builtin table's version-dependent keys (CI on Node 20 and 26)
- **Superseded by**: —

## Project context

Third task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 4). The
backlog row `A-3` is split in two by the project owner's decision of
2026-09-30 (reply "go split" to the announcement of `A-3`): **A-3a** (this
task) and **A-3b** (own-export calls, JSX). The split keeps every
acceptance criterion `A-3` carried; the table at the end of "Task" says
which half owns each.

The specification is
[ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
§ 2 (the escape row, the closed no-edge proofs), § 3 (fail-closed
default), § 4 (documented invoking builtins, the non-invoking allowlist,
primitive-only arguments) and § 8's A-3 row, read with its three decision
records: Decision 1 (2026-09-26), Amendment A-0 part A (2026-09-27, the
retaining rule and mechanical admission), and the allowlist admission
ruling (2026-09-27, per-argument-position admission with conditions (a)
and (b)). The acceptance lines are REMEDIATION-PLAN § 5a's "A-0
additions", "A-1 additions" and "A-2 additions" for A-3.

Findings closed: AUD-01 (except the shapes A-4 owns: iterators and
`toJSON`), PRM-12, PRM-114, PRM-117, RWF-060, and PRM-37's A-1 status
update (`Reflect.construct` of a class with an instance field
initializer).

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured.** `classifyCallee` and `classifyConstructee`
  (`src/code-intelligence/call-graph.ts`) return
  `unproven_no_edge("ambient_global_callee")` for any callee whose root
  identifier's TEXT is on `KNOWN_GLOBAL_IDENTIFIERS`, after only the
  lexical local-declaration lookup, and
  `unproven_no_edge("builtin_module_callee")` for a callee bound to a
  Node builtin module. The ambient check is by spelling: a parameter or
  `const` named `JSON` or `Promise` whose member is called is treated as
  the ambient global (defect class A). Neither outcome looks at the
  arguments.
- **Measured.** For a builtin-module callee, VT-213's inline-callback
  fallback runs first, so `fs.readFile(f, () => ...)` gets a RESOLVED
  edge to the callback, by an authority ADR 0008 § 6 reopens (PRM-13).
- **Measured.** `bindCallee` returns only the specifier for a builtin
  (`{ kind: "builtin", specifier }`), not which member is called; for a
  resolved import it returns the first property of the chain and drops
  the rest (PRM-20, A-6). An escaped VALUE `lib.a.b` would be attributed
  to `a`.
- **Measured.** `resolveNamedBinding` returns
  `unresolved` / `no_declaration` exactly when no enclosing scope declares
  the name: the lexical proof that a root identifier is the global.
- **Measured.** The H-0 builtin probe (`src/testing/oracle/builtin-probe.ts`)
  records a throw in `fired` (`THREW:<message>`) and reports
  `ranUserCode: fired.length > 0`, as the admission ruling says. Two
  further limits, not stated anywhere: it reads `fired` synchronously
  after the call, so a hook the builtin schedules for later is not seen
  (`Promise.resolve({ then() {...} })`: `[]` synchronously, `["then"]` at
  process exit, Node v22.11.0); and it fills every other argument
  position with whatever the template author wrote, so a position is
  probed against one context only.
- **Measured, and a plan statement that no longer holds.**
  REMEDIATION-PLAN § 5a says "CI does not run the probe today … A-3 must
  make CI run the admission probes". Since task RWF-051-typecheck,
  `.github/workflows/ci.yml` runs `npm run test:oracle`, whose suite is
  `tests/oracle/**`. The criterion is met by putting the admission test
  there; the CI configuration is not changed.
- **Measured (real Node v22.11.0).** Which hooks fire, per argument
  position, for candidate builtins: `Array.isArray`, `Object.is`,
  `Number.isInteger`/`isFinite`/`isNaN`/`isSafeInteger`: none.
  `Object.keys`, `Object.getOwnPropertyNames`, `Buffer.isBuffer`, the
  `path` functions, `fs.existsSync`: Proxy traps only. `Object.entries`,
  `Object.values`: getter and Proxy traps, and both return values taken
  from the argument (retaining). `JSON.stringify`: getter, `toJSON`,
  Proxy traps. `JSON.parse`, `String`, `Math.max`, `new Error`,
  `parseInt`, `encodeURIComponent`, `new Date`: `toString` /
  `Symbol.toPrimitive` (and `valueOf`) plus Proxy `get`. `util.inspect`:
  `util.inspect.custom`. `new Map`, `new Set`, `Array.from`:
  `Symbol.iterator`.
- **Consequence for this task, derived from the ruling.** Condition (b)
  requires an oracle case in which a vulnerable call inside each fired
  hook, reached through the builtin at that position, never yields
  `NOT_AFFECTED`. For a protocol-member hook (`toString`, `valueOf`,
  `Symbol.toPrimitive`, `toJSON`, `then`, `Symbol.iterator`) that case is
  a false `NOT_AFFECTED` on `main` and stays one until A-4 accounts
  protocol members: an object-literal method has no incoming edge. So
  before A-4 no position whose probe fires a protocol hook can pass (b).
  `JSON.parse`'s first argument is one of them, and RWB-07's expected
  cost (`NOT_AFFECTED → UNKNOWN`, REMEDIATION-PLAN § 5a) applies unless
  RWB-07's argument is provably primitive. This is reported, not
  relaxed.
- **Scope move, decided here.** `A-3`'s announced split put PRM-114
  (`Error.prepareStackTrace = fn`) in A-3b. It is in A-3a instead: the
  assignment form of the escape row is what makes this task's no-edge
  proofs sound against the direct monkeypatching of a builtin
  (`Math.max = fn; Math.max(1)`), so the proofs cannot land without it.
  Reported as a deviation.

## Task

### Problem

A function value handed to code the graph does not model is invisible:
a callback passed to `setTimeout`, `new Promise`, `process.nextTick`,
`fs.readFile`; a hook stored on `Error.prepareStackTrace` or `globalThis`;
a Proxy trap; a property-descriptor getter; an object whose
`[util.inspect.custom]` `console.log` runs; the arguments a derived class
with no constructor forwards to an ambient base (`class P extends
Promise {}`). Each call gets no edge, the callback's body is never
searched, and family C certifies a target Node calls as unreachable.

### Why it matters

Soundness first: every shape above is a reproduced false `NOT_AFFECTED`
(AUD-01, PRM-12, PRM-114, PRM-117, RWF-060). Defect class B (the analyzer
assumes a builtin runs nothing of the program's own) and, for the ambient
check by spelling, class A.

### What to do

1. **The probe** (`src/testing/oracle/builtin-probe.ts`): report a throw
   separately from a hook that fired; observe until the probe process
   exits, so a deferred hook is seen; add an admission probe that runs
   each argument kind at a position against several contexts for the
   other positions, and a non-retaining probe (operations applied to the
   call's result, and to the argument afterwards compared with a run
   without the call, fire nothing new). Existing probe tests keep their
   meaning.
2. **The builtin table** (a new module under
   `src/code-intelligence/`): a closed table of known builtin callables
   (ambient globals, and Node builtin module members, by exact member
   path). Each entry is plain known, or a documented invoking builtin
   with the position it invokes (ADR 0008 § 4), or has admitted
   non-invoking positions. `new Proxy` and `Proxy.revocable` are
   excluded from admission by name.
3. **Mechanical admission** (`tests/oracle/`, run in CI by
   `npm run test:oracle`): for every admitted position, the probe's fired
   hooks are classified against the ruling's (a) (protocol list, accessor
   body, Proxy trap), with a throw never counted as a hook; each fired
   hook has a generated oracle case proving (b); the position is
   non-retaining. Every table entry exists in real Node. The admission
   outcome of every builtin the "mechanical admission" criterion names
   as an example is asserted and reported.
4. **Identity**: an ambient callee is one whose root identifier resolves
   to NO declaration (`resolveNamedBinding`), not one whose spelling is
   on the list; a builtin-module callee's member path comes from the
   binder's own declaration authority (extend `SymbolBindingBuiltin` with
   the exact export path, and `SymbolBindingResolved` with the unconsumed
   property chain, so an escaped value is attributed only when the whole
   chain is consumed).
5. **The call-graph account** of a call or `new` whose callee is:
   - a known builtin (table): per argument, an attributable function
     value (inline function, arrow or class expression; a lexically bound
     local function or class; an exact import) gets a *resolved* edge at
     a documented invoking position and a *possible* edge otherwise, at
     any depth of object and array literal arguments (the escape row,
     including a property descriptor); a non-primitive value it cannot
     attribute gets an `unknown` edge unless the position is admitted;
     with no edge at all, the account is a no-edge proof:
     `PrimitiveOnlyArguments` or `NonInvokingBuiltin`;
   - ambient or builtin but not in the table, unresolved, or unknown:
     its unknown edge as today, plus the escape row's possible edges for
     attributable function values.
   The escape row takes precedence over every admitted position.
6. **The assignment form of the escape row**: an assignment whose target
   is rooted in an ambient global (outside the CommonJS module-scope
   bindings `module`, `exports`, `require`, whose writes are the export
   model's) or in a builtin module value. A new invocation site kind with
   its handler and census entry.
7. **RWF-060**: a `new` whose callee resolves to an implicit constructor
   follows the implicit-constructor chain; when it ends at an ambient,
   builtin, unresolved or unknown base, the `new`'s own arguments are
   accounted as arguments of a call to that base.
8. **`Reflect.construct(C, …)`** reaches `C`'s constructor node (explicit
   or implicit), resolved, as a documented invoking builtin.
9. **Domain** (`src/domain/graph.ts`): `InvocationAccount` gains a proven
   no-edge variant carrying a `NoEdgeProof`, each variant with a named
   owner test; `builtin_module_callee` is deleted from
   `UnprovenNoEdgeReason`; `ambient_global_callee` is narrowed to the
   CommonJS module-scope roots and handed to A-3b (AUD-02). A new
   `DynamicCallReason` subtype for an escaped value the graph cannot
   attribute, `unmodeled_construct`, non-widening; in both schema reason
   enums. No seventh category.
10. **Reproductions first** (`tests/oracle/`, loud fixture, both controls,
    real-Node ground truth), shown failing on the base: every AUD-01
    shape the audit lists (timers, `queueMicrotask`, `process.nextTick`,
    `new Promise`, `Array.from`'s mapper, the `JSON.parse` reviver,
    `Reflect.apply`, a `globalThis` store, `process.on` then `emit`, a
    named local callback), PRM-12, PRM-114, RWF-060's three shapes, the
    `Reflect.construct` case, `new Readable({ read })`. The A-0 records
    this task closes are deleted and their cases assert `UNKNOWN`. A case
    whose correct answer is `UNKNOWN` by the fail-closed default may
    declare, with a reason, that its negative control is `UNKNOWN` too;
    the harness reports it.
11. **A-2's producer obligations**: a test over the corpora and the
    reproductions that every emitted `possible` edge's target is a graph
    node in a walked file; a production-`buildFinding` reproduction per
    emitted site kind ending `UNKNOWN` with `possible_invocation`.
12. **Measure** the precision cost with ADR 0008 § 5's method (the
    differential tool over all corpus cases; validation case by case
    against OPEN-DEBTS D-09), and report RWB-07.
13. **Records**: FINDINGS status rows and appended sections; the ledger;
    REMEDIATION-PLAN § 5a (the split, and what A-4 inherits: re-admitting
    protocol-hook positions once (b) can pass); OPEN-DEBTS; backlog,
    progress, scorecard.

### Which half owns what

| Item from `A-3`'s specification | Owner |
| --- | --- |
| Escaped function values (arguments, members, descriptors) | A-3a |
| Invoking and non-invoking allowlists, mechanical admission, the probe | A-3a |
| Global hook assignments (PRM-114) | A-3a (moved; see premises) |
| A-1 additions: RWF-060, `Reflect.construct` | A-3a |
| A-2 additions (producer obligations) | A-3a for its sites; A-3b for its own |
| Own-export calls (AUD-02) | A-3b |
| JSX (PRM-116) | A-3b |

## Boundaries

### Do not touch

- Protocol members and accessor bodies (A-4): `deferredToAccessor`
  stays. VT-213's displacement for unresolved callees (PRM-13), VT-208,
  VT-210, the folding, lexical `require` (A-5); the binder's refusal of
  trailing chains for callees (A-6): this task adds the chain as data and
  uses it only for escaped values.
- Own-export calls and JSX (A-3b).
- `.github/workflows/ci.yml` (see premises), the proof families,
  `buildFinding`'s proof selection.
- The locked `rwf-046-require-binding-authority` worktree.

### STOP conditions

- A verdict moves to a WRONG answer on any corpus case or reproduction
  (`STOPPED_ON_FINDING`). A move to `UNKNOWN` is the expected, reported
  precision cost.
- Admitting a builtin the plan's examples need would require relaxing
  the ruling's conditions, or extending ADR 0008 § 4's documented
  invoking list (`NEEDS_DECISION`).
- A non-additive output-schema change becomes necessary
  (`NEEDS_DECISION`).
- The independent audit blocks on something outside this scope.

## Acceptance criteria

REMEDIATION-PLAN § 5a's criteria for A-3, except the A-3b rows above,
each answered in the report; and:

- [ ] Every AUD-01 (A-3a shapes), PRM-12, PRM-114, PRM-117 and RWF-060
      reproduction fails on the base and is `UNKNOWN` or a correct
      `AFFECTED` on the branch; none is `NOT_AFFECTED`.
- [ ] The A-0 records `S1.*`, `S2.defineProperty-enumerable.*`, `S3.*`
      are deleted and assert `UNKNOWN`; `S4.*` stay `NOT_AFFECTED`;
      `S2.defineProperty.*` are `NOT_AFFECTED` or `UNKNOWN`;
      `S2.literal.*` are `AFFECTED` or `UNKNOWN`.
- [ ] Every admitted position passes the mechanical admission test in
      `tests/oracle/` (hooks classified against (a), a throw never a
      hook, a generated (b) case per fired hook, non-retaining, deferred
      hooks observed); `new Proxy` and `Proxy.revocable` are never
      admitted; the escape row takes precedence.
- [ ] The report names the admission outcome, with the hooks that fired,
      of `console.*`, `util.inspect`, `util.format`, `Object.keys`,
      `Object.getOwnPropertyNames`, `JSON.stringify`, `Object.assign`,
      `Object.entries`, and `JSON.parse` (both positions); the reviver
      position is never admitted.
- [ ] A no-edge account for an ambient or builtin call is either a
      `PrimitiveOnlyArguments` or a `NonInvokingBuiltin` proof, each with
      a named owner test; `builtin_module_callee` no longer exists;
      `ambient_global_callee` covers only the module-scope roots, owned
      by A-3b.
- [ ] Ambient identity is lexical: a shadowing parameter or local named
      like a builtin gets no proof and no invoking-builtin edge (tested).
- [ ] A-2's producer obligations hold for every emitted `possible` edge
      (walked-file test; one production-`buildFinding` reproduction per
      site kind with `possible_invocation`).
- [ ] Graph, proof and verdict differentials reported separately, with
      every moved case listed; RWB-07's verdict reported; validation
      compared case by case with OPEN-DEBTS D-09.
- [ ] Each mutation of the new rules is caught by a named test.
- [ ] An independent audit returned `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: a non-zero graph
differential (the new edges), and verdict movements only to `UNKNOWN`
(the fail-closed default before A-4) or to a correct `AFFECTED`.

## Report

In the format of `AGENTS.md` § J. Also report: the admission table
(every candidate, its positions, the hooks that fired, admitted or not
and why); the precision cost and what A-4 can recover; the plan
statement on CI that no longer holds; the PRM-114 scope move.

## Corrections (2026-10-01)

Appended during the task; the text above is unchanged.

1. **"Findings closed: AUD-01 (except the shapes A-4 owns: iterators and
   `toJSON`)".** Inexact. The iterator and `toJSON` shapes are separate
   round-2 items ADR 0008 § 8 gives A-4, not AUD-01 variants; AUD-01's
   own record (callbacks to ambient builtins, the descriptor getter and
   the Proxy traps A-0 appended) is closed in full.
2. **"`ambient_global_callee` is narrowed".** It was narrowed and RENAMED
   `module_scope_callee`, since what remains is not about ambient
   globals.
3. **The builtin table is rooted in `AMBIENT_GLOBAL_NAMES` only**, not in
   every global Node supplies: the first version also listed `URL`,
   `atob`, `TextEncoder` and seven more, whose writes the escape row did
   not see (the first independent audit; see FINDINGS RWF-063).
4. **`require("<builtin>").member(...)` is NOT identified as the
   builtin** (What to do 4 named it as an authority): trusting it turned
   base `UNKNOWN`s into false `NOT_AFFECTED`s through monkeypatch forms
   RWF-063 leaves open (the second independent audit).
5. **Additions not in "What to do"**, each required to make a criterion
   hold: `RETURNS_PRIMITIVE` (builtins whose result is always primitive,
   checked against real Node -- precision of the fail-closed default);
   the post-walk withdrawal of a `possible` edge into an unwalked file and
   the `onCallGraph` seam's `walkedFiles`, so the A-2 obligation holds by
   construction and is checked over the corpora;
   `scripts/generate-builtin-callables.mjs`.
6. **Admissions withdrawn after measurement or audit:** `fs.readFileSync`
   and `clearImmediate` (probe), `fs.existsSync`, `clearTimeout`,
   `clearInterval` (structured arguments the probe cannot build; RWF-064
   is therefore fixed in part).
7. **Test fixtures edited.** Two unit fixtures replace an unrelated
   builtin call with an equivalent template literal on the same line
   (`String(fn)`, `console.log(..., module.exports)`), so the controls
   that use them keep testing their own mechanism; one A-1 oracle case
   hands `String.raw` a primitive (`"" + …`); the RWF-047 widening suite
   observes the probed call's own edge. Each is explained where it is
   made.
8. **The oracle suite's exit code.** With every test passing, the A-3a
   oracle suite first exited 1 on vitest's `Timeout calling
   "onTaskUpdate"` (3 runs of 3; the base suite ran clean 2 of 2). The
   cause was load: the admission test ran up to 44 real-Node probes at
   once. On the project owner's instruction the admission test was split
   (`builtin-admission.test.ts`, `.globals.test.ts`, `.modules.test.ts`),
   and so were the reproductions (`a3a-escaped-values.test.ts`,
   `.audit.test.ts`); what removed the error was capping the probes at
   four concurrent processes (clean 3 runs of 3). Recorded on backlog
   BL-033.
9. **The builtin table across Node versions** (after the pull request
   was opened). The table is enumerated from one Node (v22.11.0), and the
   admission test asserted that every key exists in the Node running it.
   That premise was false for the supported range: PR #80's first CI run
   failed on both matrix Nodes, with 12 keys absent in Node 20 (for
   example `Array.fromAsync`, `fs.glob`) and 23 absent in Node 26 (for
   example the removed `util.is*`, `timers.enroll`). Every per-position
   admission test passed on both. Membership grants no authority by
   itself, so the keys stay. They are recorded with what was measured in
   `VERSION_DEPENDENT_BUILTIN_CALLABLES` (`builtin-callables.ts`), and
   the test now requires that every missing key is recorded there, that
   no key with a behaviour entry, a primitive-return entry or a
   never-admitted entry is recorded there (mutation: recording
   `Array.isArray` is caught), and that every recorded key is in the
   table. The commits were already pushed, so this is a separate commit
   rather than folded into the admission commit (AGENTS.md § H allows no
   uninstructed force-push).

## Outcome (2026-10-01)

**Acceptance criteria**: all **yes**.

- Reproductions: 46 real-Node cases (`tests/oracle/a3a-escaped-values.test.ts`);
  26 of the first 28 fail on the base; of the 18 added from the
  independent audit, 16 fail on the commit they were found on and two
  are open-defect records owned by PRM-13 (VT-213, task A-5), the correct
  verdict left standing (with the parameter named `setTimeout`, three in
  all).
- A-0 records `S1.*`, `S2.defineProperty-enumerable.*`, `S3.*` deleted,
  asserting `UNKNOWN`; `S4.*` stay `NOT_AFFECTED`; `S2.defineProperty.*`
  are `UNKNOWN`; `S2.literal.*` stay `AFFECTED`.
- Mechanical admission: `tests/oracle/builtin-admission.test.ts`, run in
  CI. Admitted: `Array.isArray`, `Object.is` (both), `Number.isInteger` /
  `isFinite` / `isNaN` / `isSafeInteger`, `Object.keys`,
  `Object.getOwnPropertyNames`, `Buffer.isBuffer`, the `path` functions.
  Not admitted, with the hooks that fired: `console.log`, `util.inspect`,
  `util.format` (`util.inspect.custom`); `JSON.stringify` (getter,
  `toJSON`); `Object.assign`, `Object.entries` (getter; retaining);
  `JSON.parse` #0 (`toString`, `Symbol.toPrimitive` -- protocol hooks,
  condition (b) cannot pass before A-4) and #1 (calls its function);
  `fs.readFileSync`, `clearImmediate`, `fs.existsSync`, `clearTimeout`,
  `clearInterval` (Corrections 6). `new Proxy` / `Proxy.revocable` are
  excluded by name.
- Proofs: `primitive_only_arguments` and `non_invoking_builtin`, each
  with owner tests in `src/code-intelligence/call-graph.escape-row.test.ts`;
  `builtin_module_callee` deleted; `module_scope_callee` (AUD-02) left to
  A-3b.
- A-2 obligations: enforced after the walk and asserted over all three
  corpora and every oracle case; one production-`buildFinding`
  reproduction per emitting site kind
  (`src/analysis/verdict.possible-edge.test.ts`).
- Mutations: 19, each caught by a named test (the report lists them).
- Differentials (139 cases): graph 21 cases changed, +401/−0 sites, none
  re-resolved; proof 2 findings; verdict 1 (`RWB-07` `NOT_AFFECTED` →
  `UNKNOWN`, the anticipated cost), none into `NOT_AFFECTED`.
- Validation: six known failures (OPEN-DEBTS D-09), `RWB-07` added.
- Independent audit: `BLOCKED` three times (all findings in scope, fixed
  and reproduced), then `CERTIFIED`.

**Discovered**: RWF-063 (backlog `BL-039`, P1), RWF-064 (fixed in part),
PRM-13's false-`AFFECTED` direction (appended there).
