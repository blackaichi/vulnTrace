# Progress

The state of the work, for a fresh session. One screen; not a transcript.
Updated by every task's last commit ([`WORKFLOW.md`](WORKFLOW.md) § 1.7).

**Last updated:** 2026-10-09, by `V-4`.

## Objective

Close the soundness remediation: every reproduced false `NOT_AFFECTED`,
silent drop and fabricated edge in
[`OPEN-DEBTS.md`](OPEN-DEBTS.md) D-16 and D-17, through the four
structural invariants and two point-fix lanes of
[`REMEDIATION-PLAN.md`](REMEDIATION-PLAN.md), one task at a time. Only
then does capability work (P1-B) resume (OPEN-DEBTS § 4).

## State

- MVP, Foundation (F1–F7), P1-A1..A5 and P1-B1..B3b are merged.
- The remediation is designed (ADRs 0008–0011, the plan's § 6.1
  decisions) and its preparatory tasks are merged: H-0 (real-Node oracle
  harness), A-0 (ADR 0008 coverage reproduction, Amendment A-0 accepted),
  gate enforcement (every hermetic gate runs in CI), BL-001 (a false
  README-notice record corrected), D-03 (`npm test` and
  `npm run test:validation` are both fully offline — OPEN-DEBTS D-03,
  CLOSED) and BL-029 (`node scripts/differential.mjs`: the graph, proof
  and verdict differentials, base against head, over all 139 corpus
  cases — usage in [`WORKFLOW.md`](WORKFLOW.md) § 3).
- Lane A has started. `A-1` made every invocation site of a walked file
  yield an account (ADR 0008 invariant A1: a census of every
  `ts.SyntaxKind`, a handler table, `InvocationAccount`), fixed
  tagged templates, decorators and implicit `super` (PRM-37, PRM-115,
  PRM-19), and found and fixed RWF-057 (a `vm` tag). The no-edge branches
  still taken without a proof are named in `UNPROVEN_NO_EDGE_LEDGER`
  (`src/domain/graph.ts`) with the task that removes each (A-3, A-5).
  `A-2` added the `possible` edge kind (ADR 0008 § 1): reachability
  searches the code behind one, never reports an `AFFECTED` path through
  one, and answers `UNKNOWN` (`possible_invocation`) for a target reached
  only through one. `A-3a` (the first half of `A-3`, split by the project
  owner) is its first producer: ADR 0008 § 2's escape row, § 3's
  fail-closed default and § 4's documented invoking builtins. A builtin is
  identified by binding, never by spelling, and accounted by a table
  (`src/code-intelligence/builtin-callables.ts`) whose non-invoking
  positions are admitted mechanically by a real-Node test run in CI
  (`tests/oracle/builtin-admission.test.ts`); assignments into builtin
  values are escapes. Fixed AUD-01, PRM-12, PRM-114, PRM-117, RWF-060.
  `A-3b` (the second half) removed the last unproven builtin-side no-edge
  account (`module_scope_callee`): an own-export call gets an unknown
  edge, and a JSX element is a site (`jsx`) with its factory's unknown
  edge and possible edges to what it hands the factory -- both fail
  closed, by the project owner's decisions of 2026-10-02 (precision:
  backlog `BL-041`, `BL-042`). Fixed AUD-02, PRM-116, RWF-066. `A-4`
  accounted ADR 0008 § 2's protocol members (a definition the runtime may
  invoke implicitly: a possible edge from the owner that evaluates it;
  the iterator's `next` / `return` / `throw` added, RWF-068) and made every
  accessor its own node, reached by a possible edge (Amendment A-0 part
  B), by the project owner's decisions of 2026-10-04; the census has no
  pending kind left. It re-admitted the builtin positions that fire only
  protocol hooks, restoring RWB-07. Fixed PRM-38, PRM-112, PRM-113,
  PRM-118, RWF-068. `A-5a` (the first half of `A-5`, split by the project
  owner) applied resolution authority on the call-graph side: VT-213's
  callback edge is gone, `==` folds only same-type literals, `require` is
  ambient only when proven lexically in a proven CommonJS module, VT-210
  refuses escaping functions and written parameters, a reassigned
  `function` declaration is unresolved; every no-edge account carries a
  proof (`UNPROVEN_NO_EDGE_LEDGER` deleted). ADR 0008 § 4's receiver-bound
  invoking builtins resolve on a proven receiver (the owner's decision).
  Fixed PRM-13, 14, 15, 16, 17, 104, RWF-071, RWF-072, RWF-073. `A-5b`
  (the second half) replaced VT-208's checker-typed receiver with the
  receiver authority (a stable class for a static call, a `const` bound to
  `new C()` for an instance call, over plain class declarations) and
  withdraws a resolved method edge when any prepared file may write the
  member (`member-writes.ts`, reason `receiver_member_written`). Fixed
  PRM-18. `A-6`, the last of lane A, applied it on the binder side: a
  callee binds to an export only when its whole member chain is consumed
  (PRM-20, at every site); a single trailing `.call` / `.apply` is kept for
  a function export under the same member-write check (RWF-075, found and
  fixed); a destructured require is named by its key (PRM-108's origin; a
  computed key is still open at the consumer, C-4). What binds A-7, E and C
  next: REMEDIATION-PLAN § 5a, "A-3a additions" through "A-6 additions".
- Lane V has started. `V-1` (ADR 0011 predicates 2 and 3) deleted Site
  B's phantom target: a package with no node in the call graph is proved
  unreachable only by family A, and is otherwise `UNKNOWN` (PRM-101); Site
  A vs Site B is chosen by the exact `packageInstance`, never by the
  manifest's name (PRM-102). By the project owner's decision it also added
  ADR 0011 Amendment V-1: family C stands only when every module the
  closure loads has its top level reached from an entrypoint, closing
  RWF-078 (a module loaded only through a re-export declaration is never
  evaluated). `V-2` (predicate 1) made a closure truncated on its own walk
  (`traversal_truncated`) withdraw families B and C like every other
  closure reason (PRM-23; the exclusion and its false premise, "a truncated
  closure is accompanied by a truncated graph", are gone). `V-3`
  (predicate 4) materializes every entrypoint root by declaration
  position: a configured symbol through the export bindings that publish
  it, a root requirement witnessed by a position only, never a node name;
  a symbol that does not materialize is root incompleteness (PRM-25, and
  PRM-31, which ADR 0011 § 2 assigns to lane V). ADR 0011 § 2's
  name-keyed-lookup census is a Foundation test (`VT-INV-V-corroboration`).
  `V-4`, the last of lane V, made the corroboration structural (ADR 0011
  § 2): families B and C are built only from branded proof inputs, each
  produced by one function in `verdict.ts` that checks it
  (`corroborateClosure`: predicate 1, both halves; `corroborateEvaluation`:
  predicate 5; `attributeTarget`: predicate 3); an object literal of one is
  a compile error, a production cast to one fails a Foundation cast census,
  and an input no producer made is refused at runtime. What binds every
  later lane: REMEDIATION-PLAN § 5a, "V-1 additions" through "V-4
  additions".
- Numbers: [`SCORECARD.md`](SCORECARD.md) (measured, generated) and
  [`OPEN-DEBTS.md`](OPEN-DEBTS.md) (debts, P1-B entry criteria).

## Known limitations

**Until the remediation closes, treat every `NOT_AFFECTED` as `UNKNOWN`.**
OPEN-DEBTS § 3 criterion 3 is false on `main`: D-16 and D-17 record
dozens of reproduced paths to a false `NOT_AFFECTED` or a silently
dropped finding. The README says this (`README.md:80-88`, since
`ae82d33`); its `## Status` section now points there too (`BL-001`,
`tests/validation/FINDINGS.md` RWF-053 — an earlier version of this line
said the notice did not exist, which was false).
`npm run test:validation` is hermetic since `D-03` (replays a recorded
OSV snapshot) but is still not run in CI: five of its cases are
deliberately kept failing (OPEN-DEBTS D-09) and the suite exits non-zero
by design regardless of network access (backlog `BL-030`).

## Key decisions

- Soundness > explainability > precision > coverage > performance;
  `UNKNOWN` is first-class (ARCHITECTURE § 2, ADR 0002).
- Remediation invariants: ADR 0008 (call graph, lane A), 0009 (export
  model, E), 0010 (capability flow and resolution, C), 0011 (negative-proof
  corroboration, V). The owner's decisions: REMEDIATION-PLAN § 6.1 and the
  decision records appended to ADR 0008.
- One task at a time; the agent opens the pull request and never merges
  (AGENTS.md § H, [`WORKFLOW.md`](WORKFLOW.md)).

## Current task

`V-4` — proof-input types (`ClosureCorroboration`, `AttributedTarget`)
and mutation tests ([task file](tasks/V-4-proof-input-types.md)):
`READY_FOR_REVIEW`, its pull request awaiting the project owner. `V-3`
merged as PR #88.

## Next

The order is [`tasks/BACKLOG.md`](tasks/BACKLOG.md) § 1. After `V-4`:
`C-1`, then lane B. The P1 gaps `BL-048`
(RWF-074, small, reusing A-5b's whole-graph check), `BL-050` (RWF-076),
`BL-040`, `BL-043` and `BL-051` (live family-A false `NOT_AFFECTED`s) are
candidates to reorder ahead of them.

## Recently discovered

From `V-4`: RWF-082 and `BL-055` (P6, records: ADR 0008 and ADR 0011
still say "nothing here is implemented"). Its one newly refused shape (a
closure marked incomplete with no reason, V-2's audit finding 2) is no
production shape, so no finding.
From `V-3`: RWF-079 and `BL-053` (**P1**: a whole-module export of an
opaque value emits no entrypoint root requirement, and the property export
it overwrites still witnesses the name -- a family-C false `NOT_AFFECTED`,
pre-existing; candidate to fold into `E-3`), RWF-080 and `BL-054` (**P1**:
an ESM destructured export is no export binding), RWF-081 (**P1**, in
`E-4`'s notes: an export written by another module is no root gap).
From `V-2`: no new task; its audit's one open point (the guard reads the
incompleteness list, not `closure.complete`) is bound to `V-4`
(REMEDIATION-PLAN § 5a, "V-2 additions").
From `V-1`: RWF-078 (found by its audits and fixed by it: a module loaded
only through a re-export declaration is never evaluated, so family C stood
over a target it calls) and `BL-052` (P4, precision: evaluate such modules
in the call graph).
From `A-6`: RWF-075 (fixed by A-6: ADR 0008's `.call` / `.apply`
exception read literally), `BL-050` (**P1**, RWF-076: an ES module's
default import read as CommonJS interop, a family-C false `NOT_AFFECTED`),
`BL-051` (**P1**, RWF-077: a destructured loader through `.call`, family
A) and `BL-049` (P4, precision: retire `resolvesToUnrelatedConstructor`). From `A-5b`: `BL-048` (**P1**, RWF-074: VT-214's object-literal member
check misses `with` and writes from other files, a family-C false
`NOT_AFFECTED`). From `A-5a`: RWF-071, RWF-072, RWF-073 (each a false `NOT_AFFECTED`,
fixed by A-5a), and `BL-047` (P2: ADR 0008 § 2's A2 structural gates,
assigned to no task by § 8). From `A-4`: RWF-068 (fixed by A-4: the iterator's own methods),
`BL-046` (**P1**, RWF-070: `await` constructs a promise's `constructor` /
`Symbol.species`, a family-C false `NOT_AFFECTED` outside the protocol
list; needs the project owner's decision) and `BL-045` (P2, RWF-069: the
`path.*` admissions run `util.inspect.custom` through a structured
argument the probe cannot build; no live false `NOT_AFFECTED` since A-4).
From
`A-3b`: `BL-040` (**P1**, RWF-065: `module.parent.require` loads a
module the loader classifier misses, a family-A false `NOT_AFFECTED`;
families B and C fail closed since A-3b), RWF-066 (fixed by A-3b: the
automatic JSX runtime's implicit `require`), `BL-041` and `BL-042`
(precision: resolve the JSX factory; resolve own-export calls through
the write set), `BL-043` (**P1**, RWF-067: a loader capability escaping
through a for-of destructuring assignment, family A), `BL-044` (**P1**,
reproduce first: `importHelpers` loads `tslib` unseen). From `A-3a`: `BL-039` (**P1**, RWF-063: a builtin object monkeypatched
through a parameter, container or destructuring of the global object
keeps the table's no-edge proof), RWF-064 (the builtin probe; fixed in
part), and PRM-13's false-`AFFECTED` direction (VT-213; fixed by A-5a). From
`A-2`: none. From `A-1`: `BL-037` (**P1**, RWF-061: a `vm.Script` reached through a
subclass or factory is a family-A false `NOT_AFFECTED`), `BL-038` (**P1**,
RWF-062: `new A()` resolves to a constructor overload signature), RWF-060 (**P1**,
an implicit constructor forwarding a callback into an ambient or builtin
base; added to A-3's acceptance), `BL-036` (RWF-059, an instance field
initializer's calls attributed to the class-definition owner), `BL-034`
(resolve an explicit `super(...)` through the base authority —
precision) and `BL-035` (RWF-058, a call inside a member decorator's
expression is attributed to the member). From
`BL-029`: `BL-032` (the suites' finding selector is written out
four times, the tool's suite view included) and `BL-033` (vitest's
`Timeout calling "onTaskUpdate"` looks duration-bound, not load-bound;
verify and remove it from the suites). Still open from earlier tasks:
`BL-030` (promote `test:validation` to a CI gate — needs a decision),
`BL-031` (the 39 "Appendix A" citations, RWF-055), `BL-017`, `BL-018`
(with finding RWF-052), `BL-004` (archived P0-Z and P0 closure probes,
added by the project owner).
