# Progress

The state of the work, for a fresh session. One screen; not a transcript.
Updated by every task's last commit ([`WORKFLOW.md`](WORKFLOW.md) § 1.7).

**Last updated:** 2026-10-27, by `BL-114`.

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
  `BL-081` (`BL-039` folded in) widened § 2's escape row by ADR 0008's
  BL-081 decision record (option (a)): a store is an escape unless the
  object it writes onto is proven to be one the program created
  (`isProvenFreshObject`), since a builtin object reaches a user binding
  through routes no spelling shows; a `for…of` head and a `with` body are
  stores. RWF-110, RWF-063 and RWF-120 (found by it) are fixed in part:
  its independent audit ran ten rounds without certifying the class, the
  last round's RWF-122 and RWF-123 were fixed after it without a further
  round (the project owner's decision), and `BL-091` re-audits. RWF-070's
  recorded form and D-16's Step 2 verdict close as a side effect.
  REMEDIATION-PLAN § 5a, "BL-081 additions". `BL-091` re-audited it in
  three rounds. RWF-122 and RWF-123 held. Every round found more live
  shapes, each fixed (RWF-124, RWF-126 to RWF-128: a derived class
  inherits accessors; TypeScript's emit assigns static fields and makes a
  class's `prototype` writable). The class is still not certified, and
  `BL-094` asks the project owner whether the rule needs a structural
  change (ADR 0008, the note on the BL-081 decision record). `BL-099`
  carried TypeScript's namespace scope into call resolution
  (`named-bindings.ts`): an exported variable used in its own block is a
  read of the namespace's object (`h(1)` → `N.h(1)`), and no name is
  looked up past a namespace, whose merged members no file's syntax shows
  (both `namespace_member`, an unknown callee; an import or a global used
  in a namespace's body too, a precision cost); a namespace's own
  `import X = A.b` is a declaration of its block. Fixed RWF-141 and
  RWF-145's `import X =` form; and, from its audit, RWF-147: a function
  declared in a nested block is not seen outside it (strict code), and a
  class static block is a var scope. `BL-109` added what an inherited
  builtin calls on its receiver by name to the protocol-member row (ADR
  0008, "Decision record — BL-109", the project owner's decision): `join`
  (an array's `Array.prototype.toString`) is a protocol name, and every
  member of an object literal whose `__proto__` is not proven `null` or a
  plain literal, or of a class with an `extends` other than `null`, is a
  protocol member, whatever its key (`toISOString`, `utf8Slice`, a Node
  stream's `on` / `read` / `destroy` …, measured by
  `scripts/bl109-implicit-receiver-methods.mjs`). Fixed RWF-151, RWF-152
  (found by it) and RWF-153 (found by its audit).
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
- Lane C has started. `C-1` (ADR 0010 invariant C2) made module
  resolution run in Node's resolution mode whatever the tsconfig says: one fixed, branded set of
  NodeNext options (`NodeResolutionOptions`, module-resolver.ts), and a
  tsconfig `baseUrl` / `paths` mapping consulted only as a cross-check --
  one that disagrees with Node is `unresolved_module`. Fixed PRM-33 (22 of
  40 tsconfig shapes named `main` where Node loads `exports`) and RWF-083
  (a mapping shadowing an installed package or a sibling instance). By the
  project owner's decision (strict C2), ADV-023, ADV2-015 and ADV2-016 are
  `UNKNOWN`: real Node cannot load their aliased imports (RWF-084). Its
  audit's findings, fixed: the `types` export condition (RWF-087) and the
  declaration fallback's `exports` guard (RWF-088). The
  census `VT-INV-C-runtime-resolution` guards the authority. What binds
  C-2..C-5: REMEDIATION-PLAN § 5a, "C-1 additions". `BL-092` made the
  loader classifier recognise a `Module` instance's lookup list
  (`module_paths`, C-4's registry item done early), `module.__proto__`,
  an instance's inherited loaders and the CommonJS wrapper's `arguments`
  by what they are, and read every write target and `with` head: fixed
  RWF-129, RWF-130, PRM-107's false `NOT_AFFECTED`, RWF-133..135, RWF-138
  (ADR 0010, "Note — task BL-092").
- Lane B has started. `B-1` made every advisory OSV returns end in a
  finding or an accounted `unreportedCandidates` entry: the provider
  follows `next_page_token` to the end (a page cap, a repeated token or a
  failed page is a provider failure, exit 4), and the OSV cache key marks
  the paginated answer format (PRM-65); a record the normalizer cannot use,
  an empty `id` included, is an `undetermined` entry per instance
  (`advisory_record_malformed`), never only a diagnostic or a lost report
  (AUD-10, AUD-11); a withdrawn advisory is the new `withdrawn`
  disposition, output schema `0.7` (AUD-14, decision 10). Invariant
  `VT-INV-B-provider-completeness`. What binds B-2..B-6: REMEDIATION-PLAN
  § 5a, "B-1 additions". `B-2` made version applicability SemVer's and
  OSV's: strict SemVer precedence with prereleases, never `semver.coerce`
  (AUD-05); a range VulnTrace cannot order (GIT, ECOSYSTEM, untyped, no
  `introduced`, an entry with no bounds) is `indeterminate`, an `UNKNOWN`
  finding, never `not_applicable` (AUD-09); SEMVER events are walked
  sorted, as OSV specifies (RWF-091, found by it; RWF-092 from its
  audit). Invariant
  `VT-INV-B-version-applicability`. REMEDIATION-PLAN § 5a, "B-2
  additions". `B-3` made the OSV cache the user's, never the scanned
  project's: the user cache directory (`XDG_CACHE_HOME`, `LOCALAPPDATA`,
  `~/.cache`), and a directory inside the project, by any path or
  symlink, is refused and the scan runs uncached (AUD-07); an entry is a
  validated envelope served only for its own key and for `ttlHours`
  (default 24) after the provider answered (AUD-06); a write failure is
  a `cache` diagnostic, never exit 4 (PRM-35). Invariant
  `VT-INV-B-cache-authority`. REMEDIATION-PLAN § 5a, "B-3 additions".
  `B-4` made every installed package reach the report: a lock entry is
  never dropped for a missing name or version (a nameless `file:` entry is
  named by its manifest or linking entry, PRM-34; a named, versionless one
  is an instance, RWF-093); an instance with no established version is
  queried without one and is `UNKNOWN` per advisory (decision 4, PRM-64);
  an unreadable manifest is recorded (PRM-66); and the installed tree plus
  the closure's loaded instances are cross-checked against the lockfile,
  each unlisted package an identity entry by its exact instance (decision
  9, AUD-08). Four reason subtypes, no new category. Invariant
  `VT-INV-B-inventory-identity`. REMEDIATION-PLAN § 5a, "B-4 additions".
  `B-5` made the exit code say whether anything was left undecided
  (decision 3, AUD-12): `1` when something is `AFFECTED`, else `5` when a
  finding is `UNKNOWN` or an unreported candidate is `undetermined`, else
  `0` (`withdrawn` is decided); `--lenient-exit` restores `0` for the
  undecided case. Every result carries a `summary` of counts (schema
  `0.8`) from which the exit code is computed. An empty `--cve` is a usage
  error and an unmatched one is said (PRM-111); the versionless "no
  advisory" detail uses the unfiltered set (PRM-36); the HTML overview
  falls back to `unknownReasons` (PRM-110). Invariant
  `VT-INV-B-exit-decision`. REMEDIATION-PLAN § 5a, "B-5 additions".
  `B-6`, the last of lane B, made a rule apply only to the package it
  names (AUD-15): a finding for another package of a multi-package
  advisory is `UNKNOWN` with `rule_package_mismatch`, decided before any
  instance matching. REMEDIATION-PLAN § 5a, "B-6 additions".
- Lane E's preparation. `RWF-050-repro` reproduced RWF-050 (a
  definitely-abrupt call in a MAY-evaluated module-time position was not a
  module-evaluation cutoff: a live family-C false `NOT_AFFECTED`).
  `BL-063` fixed it: the cutoff is MAY for expressions as for statements
  (`mayEndModuleEvaluation`), excluding only positions module evaluation
  never evaluates; 41 "keeps authority" tests inverted, each grounded under
  real Node (9 are labelled precision costs). ADR 0009 § 8 carries a
  decision record for E-1's precision acceptance. It found RWF-094 (a
  statement that MAY throw through an unproven callee is still not a
  cutoff), backlog `BL-064`, and its audit RWF-095 (a tagged template of
  a proven-abrupt callee is never a cutoff), backlog `BL-065`.
  REMEDIATION-PLAN § 5a, "BL-063 additions". `BL-065` fixed RWF-095 (a
  tagged template is a call of its tag); its audit found RWF-096 and
  RWF-097, two more gaps in the callee summary (backlog `BL-066`,
  `BL-067`). REMEDIATION-PLAN § 5a, "BL-065 additions". `BL-066` (with
  `BL-067` folded in) fixed both: the callee summary reads a concise body,
  every required statement position, a `return`'s expression and the
  default parameters an invocation runs, memoized (which also
  removes a pre-existing super-linear cost). It found RWF-098, the
  summary's remaining refusals of invocations real Node never completes
  (backlog `BL-068`, after `BL-064`'s decision). REMEDIATION-PLAN § 5a,
  "BL-066 additions". `BL-064` fixed RWF-094 under option (a), an ADR 0009
  § 1 clause 4 amendment with a decision record for the owner: when the
  module's objects can be observed, an export's last write keeps its
  authority only if everything between the first competing write and it
  is proven to complete (`competingWritesCannotBeObservedApart`). It
  closed RWF-098's verdict-level records, and its audit's RWF-100 (a
  stale property write attributed in place of a refused whole-module
  write). REMEDIATION-PLAN § 5a, "BL-064 additions". `E-1` opened lane
  E: an export is attributed only when the file's complete write set (a
  closed `ExportWriteKind` census of every reference to its export
  objects) determines one effective write, and its local resolves by
  binding, never by name. 45 live false `NOT_AFFECTED`s closed
  (PRM-26..30, 62, 63), with a decision record in ADR 0009 for its
  precision cost (3.9 % of `node_modules` export bindings; ten
  adversarial-v2 holder findings to `UNKNOWN`); RWF-103 and RWF-104 await
  the owner's decision (`BL-074`, `BL-075`). REMEDIATION-PLAN § 5a,
  "E-1 additions". `E-2` gated the forwarding hop on the same write set:
  PRM-61's shapes had already been closed by E-1's model (measured), and
  the hop's fall-through for a name the write set withdraws (RWF-105,
  five live false `NOT_AFFECTED`s and a false `AFFECTED`) is fixed at no
  measured precision cost; its audit blocked on RWF-106, which shares
  RWF-103's open decision. REMEDIATION-PLAN § 5a, "E-2 additions".
  `BL-074` took that decision's recommended option (b), module-graph-aware
  (ADR 0009 decision record, for the owner to confirm by merging): a load
  whose module can hand back this file's exports object, or the object its
  whole-module re-export forwards, is an alias of it wherever its value
  flows (`load-reach.ts`). RWF-103 and RWF-106 closed: 34 live false
  `NOT_AFFECTED`s; precision 1,251 of 5,061 `node_modules` export bindings
  (option (a) would cost 1,640), no corpus verdict moved.
  REMEDIATION-PLAN § 5a, "BL-074 additions". `BL-075` took option (a)
  for RWF-104 (ADR 0009 decision record): no builtin is trusted to only
  read an export object, since builtins are shared by every module of the
  process (the entry itself replaced `Object.keys` in one measured shape,
  so the "closure" option was the wrong set), and no `instanceof` is
  inert (its audit's RWF-112) unless it is a function or base class the
  file declares. Eleven live false `NOT_AFFECTED`s closed, at 9 of 4,774
  attributions; RWB-09a moves `AFFECTED → UNKNOWN` (a sixth known
  validation failure, pending the owner's decision; backlog `BL-085`).
  REMEDIATION-PLAN § 5a, "BL-075 additions". `BL-084` (with `BL-086`
  folded in) censuses every route to a function or class the final export
  object may be without spelling its binding (`ownObjectRoutes`:
  `arguments.callee`, `new.target`, `constructor` / `caller` / `callee`
  reads, run-time keys unless provably numeric, `Reflect.get`, stack
  callsites) like the binding itself, and a `super` write as a `this`
  write; a route handed on withdraws the named exports and keeps the
  whole-module function (ADR 0009 decision record). Thirty-five live
  false `NOT_AFFECTED`s closed (RWF-114..117), at 1 of 4,765
  attributions; no corpus verdict moved. REMEDIATION-PLAN § 5a, "BL-084
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
OSV snapshot) but is still not run in CI: the cases OPEN-DEBTS D-09 lists
(six since `BL-075`) are deliberately kept failing and the suite exits
non-zero by design regardless of network access (backlog `BL-030`).
`node scripts/gates.mjs` runs the whole gate set locally, each test file
exactly once (`BL-089`; [`WORKFLOW.md`](WORKFLOW.md) § 3).

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

`BL-114` — Repeat BL-111's loader inventory on Node 20 and 26
([task file](tasks/BL-114-loader-inventory-node-releases.md)):
`READY_FOR_REVIEW`. No analyzer change. The inventory, bounded by release
(`scripts/bl114-loader-inventory-releases/releases.md`), found two live
false `NOT_AFFECTED`s:
- RWF-158, on CI's Node 20, which no option of BL-111's proposal sees;
- RWF-160, on CI's Node 26, found by the independent audit; only (A)
  sees its plain form.

It also fixed RWF-159, BL-111's records that made CI fail on Node 26. `BL-111` merged as PR #120 with its Node 26 check failing. The
owner's decision on ADR 0010's "Proposed decision — BL-111" is still
pending; read its "Note — task BL-114" with it. BL-094's O2e is also still
awaiting the owner, so `BL-107` waits.

## Next

The order is [`tasks/BACKLOG.md`](tasks/BACKLOG.md) § 1. After `BL-114`:
`BL-113` (implements BL-111's decision, now with RWF-158 and RWF-160), `BL-115` (which
Node releases the contract and CI cover; a decision), `BL-107` (implements O2e,
still awaiting the owner), `BL-098` (the decision on `process` handed on, RWF-140, P1), `BL-108`
(design, P1: a TypeScript source analysed as the program its emit runs),
`BL-101` (RWF-143, P1, an ES5 class's methods; after BL-107, whose O2e
makes its cost one to measure first), `BL-079` (RWF-108, P0, at E-4's
boundary), `E-3` (entrypoint roots), `E-4`, `E-5`. `BL-080` (RWF-109 and,
since BL-097, RWF-144, a live false `NOT_AFFECTED`: raised to P0),
`BL-078` (RWF-107), `BL-082` (RWF-111), `BL-083` (RWF-113), `BL-087`
(RWF-118) and `BL-090` (RWF-121) need decisions. The P1 gaps `BL-057` and
`BL-058` (small, `module-resolver.ts` only, from C-1), `BL-048`
(RWF-074), `BL-050` (RWF-076), `BL-040`, `BL-043` and `BL-051` (live
family-A false `NOT_AFFECTED`s) are candidates to reorder ahead of the
rest of lane E. `BL-068` is narrowed to RWF-098's single-write unit
records (P2). `BL-102` (RWF-145's open part, P2, masked) records a
namespace's and an enum's declarations; `BL-103` (RWF-146, P1, not measured
live) makes the export model's binding lookup read a namespace's scope;
`BL-104` (RWF-148, P1, live) stops taking a bodiless function declaration
for a binding. `BL-106` (P3, precision) narrows BL-105's import-as-load
withdrawals.

## Recently discovered

From `BL-114`:
- `RWF-158` (live, pre-existing, P1): on v20.19+, v22.12+ and v24.0.0 to
  v24.11.1, `Object.prototype.source = <text>` replaces a `require()`d ES
  module's dependencies. The store is a primitive under a spelled name,
  and none of BL-111's options (A), (B) or (B′) sees it. It is in
  `BL-113`'s scope.
- `RWF-159` (fixed): BL-111's `inherited-read.source-*` records asserted
  v22.11.0's ground truth on every release, so CI failed on Node 26.
  Release-dependent ground truth now reads `tests/oracle/node-release-routes.ts`.
- `RWF-160` (live, pre-existing, P1, found by the independent audit): from
  v22.15.0, and on v24 and v26, `Object.prototype.paths = [<dir>]` becomes
  every later module's lookup list (`this.paths ??= …`). It is in
  `BL-113`'s scope.
- A v20-only RWF-156 route through `trySelf`'s inherited `data` / `path`
  reads; every option closes it.
- `BL-115` (P2, decision): which Node releases the contract and CI cover.

From `BL-111`: Node v22.11.0's loader also reads data properties by
inheritance. `Object.prototype.source`, a primitive store, replaces an ES
module's source in real Node; it is `UNKNOWN` with the analyzer, since only
`import()` reaches it there. Backlog `BL-114` (P2) repeats the inventory on
Node 20 and 26, where `require()` of an ES module may make it live.

From `BL-110`, found by its certification audit and the re-audits that
followed:
- a first form of the use check was quadratic in selection nesting
  (fixed before review);
- a TypeScript type reference is no erased position under decorator
  metadata (fixed before review: only a type query is exempt);
- `BL-112` (P2, performance, pre-existing): the classifier's resolution is
  exponential on a DAG of `const` aliases, and a deep syntax tree overflows
  the stack.

PRM-21's whole-file shadow of `module` is confirmed live on the lookup list.

From `BL-096`, all live and pre-existing:

- `RWF-154`: `module.paths instanceof H` hands the lookup list to the
  program's own `Symbol.hasInstance`, with no builtin replaced.
- Found by its independent audit (four rounds; the fourth certified
  the recommendation):
  - `RWF-155`: the list in a shorthand property, used on the spot.
  - `RWF-157`: a `const` that may hold `require` or the list is resolved
    to the first.
  - `RWF-156`: a replaced builtin receives the lookup state from Node's
    own loader, with no use of the list. Open under every option: backlog
    `BL-111` (P1, design across lanes A and C).

The proposed decision closes the first three for the lookup list.

RWF-136 is wider than its record: 29 of its own cases are live (every
member read the list does not own, every conversion, spread, `await`,
`instanceof`'s right operand, and the routes the resolver answers
`ambiguous` for, such as `require.cache[__filename].paths`). Its proof family is B, not A. The backlog's
option (b) as worded is unsound, because an element read past the list's
end is an inherited lookup. A list of fail-closed uses misses whatever it
does not name, so the recommendation is an allow-list (b2). Backlog
`BL-110` (P1) implements the decision.

From `BL-109`: `RWF-152` (a member a builtin calls on its receiver by
name, defined in a `__proto__` literal: `toISOString`, `utf8Slice`, a Node
stream's members; live, pre-existing, fixed in BL-109) and, by its
independent audit, `RWF-153` (the same members in a derived class, whose
`prototype` inherits the builtin with no call; live, pre-existing, fixed in
BL-109 at a measured precision cost: 293 of 29,748 clean nodes). Its inventory's
limits: a member called only once the receiver holds more internal state
than it builds, and triggers it does not run (Node's printing of an
uncaught thrown object).

From `BL-094`: `RWF-151`, found by its independent audit, a live false
`NOT_AFFECTED` pre-existing on the base: an own `join` (stored or
defined) on an object inheriting `Array.prototype.toString` runs on every
coercion, and `join` is not a protocol member
(backlog `BL-109`, **P0**). Two more backlog rows: `BL-107` (P1, implement
the decision if accepted, with its certification round) and `BL-108`
(P1, design: of the escape row's 195 historical false `NOT_AFFECTED`s,
100 come from analysing a TypeScript source while Node runs its emit, 47
of them outside the escape row's proofs). BL-101's fix direction would, under
O2e, make every TypeScript class method an escape: a cost BL-094 did not
measure.

From `BL-105`: RWF-150 is wider than its record (a self-import holds the
module's own exports object: four more live false `NOT_AFFECTED`s, and two
more, a write to a self-import's named binding, found by its independent
audit; all fixed in BL-105) and narrower (its cast and alias call forms
were masked `UNKNOWN`s). Its own corpus differential caught a false
`NOT_AFFECTED` the change introduced (a withdrawn entrypoint export lost
its root), fixed before review. The precision cost its audit measured, an
import handed on that may reach back: `BL-106`, P3.

From `BL-100`: `RWF-149` (a class decorator's result replaces the class,
but a construction resolved to the declared one; live, pre-existing, fixed
in BL-100); by its independent audit, a shadowed `undefined` taken for a
decorator's `nothing` under a mutation no test caught (a test gap, closed),
a per-construction definition lookup quadratic in a file's statements
(introduced, fixed with a per-file index) and `RWF-150` (a TypeScript ES
module's own export overwritten through a cast or an alias is no export
write; live, pre-existing: `BL-105`, P0).

From `BL-099`: `RWF-145` (a namespace's own `import X =`, nested
namespace and enum are declarations of the block that makes them; the
`import X =` form live and fixed in BL-099, the other two masked:
`BL-102`, P2). RWF-141's class is wider than its record: from another
block of the namespace the resolver bound an exported member's name to an
outer declaration (defect class A), fixed with it. By its independent
audit: an ambient block's implicit exports and module augmentation of an
exported namespace (both live, pre-existing, fixed), a regression of its
own first fix (`import x = require(…)` in a namespace taken for a load;
fixed before merge), and `RWF-146` (the
export model's `lexicalDeclarationOf` does not read a namespace's scope:
`BL-103`, P1); `RWF-147` (a function declared in a nested block, and a
class static block's hoisting; live, pre-existing, fixed) and `RWF-148` (a
bodiless function declaration taken as a binding; live, pre-existing:
`BL-104`, P1).

From `BL-097`: `RWF-144` (a frame name built at run time or a frame
member reached by enumeration, live, pre-existing: `BL-080`, raised to
P0); by its independent audit, the `with` and regular-expression
spellings (fixed in BL-097) and a second inspector route,
`Debugger.evaluateOnCallFrame` (live, pre-existing, recorded under
`AUD-04`: `C-4`).

From `BL-095`, by its independent audit (five rounds): twenty-seven live
false `NOT_AFFECTED`s of RWF-131's and RWF-132's class, fixed in BL-095;
`RWF-141` (a call through a namespace's exported variable: `BL-099`, P0),
`RWF-142` (TypeScript's decorator helpers: `BL-100`, P0) and `RWF-143` (an
ES5 class's methods: `BL-101`, P1), all live and pre-existing.

From `BL-092`: `RWF-133` (a write target the loader check did not read),
`RWF-134` (the wrapper's `arguments`), `RWF-135` (an aliased
`module.require`), all live and fixed in BL-092; by its independent
audit, `RWF-138` (a `with` head; fixed), `RWF-136` (the read-only
exemptions under a replaced `Array.prototype`: decision `BL-096`, P1),
`RWF-137` (the wrapper's `arguments` through `caller`: `BL-097`, P0) and
`RWF-139` (an arrow called on the spot: C-3) and `RWF-140` (`process`
handed on or wrapped: decision `BL-098`, P1), all live and pre-existing.

From `BL-091`: by its re-audit, `RWF-124` and `RWF-126` (a derived
class's `prototype` and static side inherit from its base) and `RWF-127`
and `RWF-128` (TypeScript's class emit), all live and fixed in BL-091;
`RWF-129` and `RWF-130` (lane C, live, pre-existing: `BL-092`, P0); by
its independent audit, `RWF-131` and `RWF-132` (two more stores
TypeScript's emit makes, live, pre-existing: `BL-095`, P0). From
measuring BL-081's last observations, `RWF-125` (a masked memo collision,
fixed) and two pre-existing super-linear costs (`BL-093`, P3). `BL-094`
(P1): the decision on the rule.

From `BL-081`: `RWF-120` (a `for…of` head, a `with` body and an iteration
stored into a builtin unseen, even by name; live, fixed in part in BL-081),
`RWF-122` and `RWF-123` (found by its tenth audit round, fixed after it,
not re-audited: backlog `BL-091`, P1) and `RWF-121`
(`BL-090`, P2: a replaced documented invoking builtin keeps its resolved
callback edge, a false `AFFECTED`, pre-existing; named in RWF-063 since
A-3a, never registered). `BL-046` is narrowed to `static [Symbol.species]`.

From `BL-089`: `RWF-119` (records, fixed in BL-089: three records still
said `test:validation` keeps five cases failing, and the committed
`REPORT.md` showed `RWB-09a` passing, while D-09 has listed six since
`BL-075`).

From `BL-084`: `RWF-116` (a sloppy exported function is the `caller` of
what it calls, and its own `arguments` property is its frame's arguments
object; live, fixed in BL-084) and `RWF-117` (a `super` property write is
a write onto `this`; live, fixed in BL-084); its audit found `RWF-118`
(`BL-087`, P1, masked: a call that returns its receiver, `Api.valueOf()`,
is taken for a read) and `BL-088` (P3, performance: a quadratic shape in the self-held-read replay).

From `BL-075`: `RWF-110` (`BL-081`, P0, live, pre-existing: the call
graph takes `Object.keys(…)` for the builtin while another module may have
replaced it through `({}).constructor` or a parameter) and `RWF-111`
(`BL-082`, P1, masked: the export census's define arm trusts the builtin
for the names it does not spell; 1,115 of 3,810 `node_modules`
attributions to untrust it); its audit found `RWF-112` (fixed in BL-075)
and `RWF-113` (`BL-083`, P1, masked: `Object.prototype` members another
module defines) and `RWF-114` (`BL-084`, P0, live, pre-existing:
`arguments.callee` reaches the exported function) and `RWF-115`
(`BL-086`, P0, live, pre-existing: `new.target` does too). RWF-104's framing of option (b) ("the module
closure") is corrected: the patcher can be the entry.

From `BL-074`: its independent audit found `RWF-107` (`BL-078`, P1,
masked: what a call through a load returns is not followed; the fix is a
measured precision trade-off) and `RWF-108` (`BL-079`, P0, live,
pre-existing: another module stores this file's exports object on a third
module's object, which this file loads and writes through), `RWF-109`
(`BL-080`, P1, masked: a registry member reached through a key computed
at run time), and the assignment-value, sloppy-`this` and stack-frame
routes BL-074 closes. `BL-077` (P3,
precision): narrow the withdrawals TypeScript's emit helpers and a tainted
`typescript` closure cause. RWF-103's premise that the per-file rule
withdraws "nearly every TypeScript-emitted file" is corrected (32.4%).

From `E-2`: `RWF-105` (the forwarding hop forwarded a name the file
writes onto the object it forwards; five live family-C false
`NOT_AFFECTED`s and a false `AFFECTED`, pre-existing; fixed in `E-2`).
PRM-61 turned out to be closed already by E-1's model. Its audit found
`RWF-106` (`BL-076`, P0, pre-existing: the hop forwards a name written
onto the forwarded object through a load result's dataflow), which waits
on the RWF-103 decision.

From `E-1`: `RWF-101` (an export written before its `var` initializer
runs is attributed to the initializer; a fabricated edge and false
`AFFECTED`, backlog `BL-071`, P2) and `BL-072` (P3, precision: narrow the
file-wide withdrawals, chiefly a class method handing its `this` on).
Its audit's seventeen further live shapes are fixed in `E-1`; it also
found `RWF-102` (`BL-073`, P1, masked), `RWF-103` (`BL-074`) and `RWF-104`
(`BL-075`), two P0 live classes pre-existing on the base that need the
owner's decision.

From `BL-064`: `RWF-100` (found by its audit, a live family-C false
`NOT_AFFECTED` partly pre-existing: a refused whole-module write left a
stale property write attributed; fixed in `BL-064`) and `BL-070` (P4,
precision: shapes real Node completes that the completion grammar does
not prove). `BL-068` is narrowed and lowered to P2.

From `BL-066`: `BL-068` (RWF-098, four shapes the callee summary still
refuses though real Node never completes them — a certainly-`undefined`
argument, a destructuring parameter's nested default, unconditional
self-recursion, the third wrapper hop). From its independent audit:
`BL-069` (P2: RWF-099, the summary over-claims abruptness real Node
contradicts; measure first whether it reaches a false `AFFECTED`).
