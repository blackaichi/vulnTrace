# Remediation plan: invariants for the reproduced soundness findings

Status: **proposed** (design only; nothing here is implemented). Written by
the task [`docs/tasks/remediation-design.md`](tasks/remediation-design.md).

This plan turns about 65 reproduced findings into four structurally enforced
invariants, one ADR each, plus two lanes of point fixes. It maps every
finding to the invariant or point fix that closes it, and to the task that
implements it.

None of these findings is registered in `tests/validation/FINDINGS.md` or
`docs/OPEN-DEBTS.md` yet; a later task does that. Until then, the three
investigations that reproduced them are the source:

- the independent audit, **AUD-01 … AUD-16** (its report is not in the
  repository; only its one-line summaries were available to this design);
- the comment-premise sweep, round 1, **PRM-11 … PRM-38** (FALSE items;
  PRM-11 is RWF-047 on a new surface; PRM-37/38 are the two round-1
  mechanisms this plan originally left unnumbered, matched to the IDs
  `record-soundness-audits` assigned by task
  [`remediation-reconciliation`](tasks/remediation-reconciliation.md));
- the comment-premise sweep, round 2, **PRM-101 … PRM-116**, with
  **PRM-60 … PRM-67** settled FALSE.

All reproductions ran the real `runScanCommand` against real Node, with loud
fixtures and positive and negative controls, at `62b52b9`.

## 1. The common cause

When the analyzer meets a construct it does not model, it treats it as
"nothing happens here" instead of failing closed. That shows up in four
places, each of which gets one invariant:

| Lane | Where "not modeled" became "nothing happens" | Invariant | ADR |
| --- | --- | --- | --- |
| **A** call graph | a site that invokes code got no edge; or an edge was resolved on an assumed authority and displaced the honest `unknown` | A1 invocation accounting; A2 resolution authority | [0008](adr/0008-invocation-accounting-and-resolution-authority.md) |
| **E** export model | one write of an export was taken to be the only write | complete write set, one effective write | [0009](adr/0009-export-attribution-by-complete-write-set.md) |
| **C** capability flow and resolution | a loader capability was lost in an expression form the classifier did not enumerate; the resolver used the project's TypeScript mode instead of Node's | C1 capability flow total over syntax kinds; C2 Node's runtime resolution | [0010](adr/0010-capability-flow-and-runtime-resolution.md) |
| **V** verdict corroboration | a negative proof drawn from a lookup keyed by a name, or from a closure fact that was not checked | negative proofs keyed by exact identity and corroborated by a complete closure | [0011](adr/0011-negative-proof-corroboration.md) |
| **B** intake, cache, output | point fixes | — | § 7 |
| **D** disclosure | point fixes | — | § 7 |

## 2. Finding matrix

Every finding, with no finding left unmapped. "FNA" = false `NOT_AFFECTED`;
"FA" = false `AFFECTED`. Task IDs refer to the ADRs' § 8 tables and to § 7
below.

### 2.1 Independent audit

| Finding | Summary | Impact | Lane | Closed by | Task |
| --- | --- | --- | --- | --- | --- |
| AUD-01 | callbacks passed to ambient builtins get no edge | FNA | A | A1 escaped function values | A-3 |
| AUD-02 | a module calling its own `exports.x()` gets no edge | FNA | A | A1 own-export calls | A-3 |
| AUD-03 | `process.getBuiltinModule` loads code; the closure stays complete | FNA (A) | C | C1 loader table | C-4 |
| AUD-04 | `inspector` `Runtime.evaluate` | FNA (A) | C | C1 loader table | C-4 |
| AUD-05 | `semver.coerce` strips prereleases | wrong applicability | B | point fix | B-2 |
| AUD-06 | the OSV cache never expires | stale advisories | B | point fix | B-3 |
| AUD-07 | a cache inside the scanned tree is trusted | poisoned input | B | point fix | B-3 |
| AUD-08 | lockfile-only inventory | silent drop | B | point fix (see decision 9) | B-4 |
| AUD-09 | GIT ranges compared as semver; an empty `affected` entry → `not_applicable` | false `not_applicable` | B | point fix | B-2 |
| AUD-10 | a malformed record appears only in diagnostics | silent drop | B | point fix | B-1 |
| AUD-11 | an empty `id` fails the whole report | lost report | B | point fix | B-1 |
| AUD-12 | an all-`UNKNOWN` scan exits 0 | wrong exit code | B | point fix (decision 3) | B-5 |
| AUD-13 | ESM→CJS default interop | FNA (per audit summary) | E | E write set, consumer side | E-5 |
| AUD-14 | a withdrawn advisory is ignored | false finding | B | point fix (decision 10) | B-1 |
| AUD-15 | false `UNKNOWN` reason on a rule/package mismatch | false reason | B | point fix | B-6 |
| AUD-16 | false README and HTML sentences | false statement | D | point fix | D-1 |

### 2.2 Comment-premise sweep, round 1

| Finding | Summary | Impact | Lane | Closed by | Task |
| --- | --- | --- | --- | --- | --- |
| PRM-11 | re-export origin ignores a property write on the required source (RWF-047 surface) | FNA | E | E writes by other modules | E-4 |
| PRM-12 | builtin-bound callee emits no edge (`fs.readFile(f, cb)`) | FNA | A | A1 escaped function values | A-3 |
| PRM-13 | VT-213 inline callback displaces an unattributable callee's `unknown` | FNA | A | A2 | A-5 |
| PRM-14 | `==`/`!=` folded as `===`/`!==`, branch pruned | FNA | A | A1 (pruning only by proof) | A-5 |
| PRM-15 | static `require` matched by text; a local `function require` is not seen | FNA | A | A2 (lexical `require`) | A-5 |
| PRM-16 | VT-210 uses same-file callers only for an exported function | FNA | A | A2 | A-5 |
| PRM-17 | VT-210 ignores parameter reassignment (and `arguments[0]` writes) | FNA | A | A2 | A-5 |
| PRM-18 | VT-208 static type used as the runtime receiver | FNA | A | A2 | A-5 |
| PRM-19 | derived class implicit constructor has no edge to `super` | FNA | A | A1 implicit `super` | A-1 |
| PRM-20 | `bindCallee` truncates a trailing property chain | FNA | A | A2 | A-6 |
| PRM-21/22 | whole-file, first-match shadow and alias lookup in the loader classifier | FNA (A) | C | C1 lexical provenance | C-2 |
| PRM-23 | a truncated closure does not block families B/C | FNA | V | V closure corroboration | V-2 |
| PRM-24 | `cluster.fork` is not a loader (decided: widens like `child_process.fork`) | FNA (A) | C | C1 loader table | C-4 |
| PRM-25 | symbol entrypoints matched by node-name text | FNA and FA | V | V identity-keyed roots | V-3 |
| PRM-26 | export→function map by first name match | FNA | E | E lexical identity | E-1 |
| PRM-27 | a later string-key or getter override ignored | FNA | E | E write set | E-1 |
| PRM-28 | computed export key resolved scope-blind | FNA | E | E lexical constants | E-1 |
| PRM-29 | deferred or configure-time export write ignored | FNA | E | E write set | E-1 |
| PRM-30 | literal unpacking wins over a later `module.exports.x = …` | FNA | E | E write set | E-1 |
| PRM-31 | a same-name decoy satisfies the root requirement | FNA | E | E roots witnessed by identity | E-3 |
| PRM-32 | `this.x = …` and aliases of `module.exports` invisible at an entrypoint | FNA | E | E write set at entrypoints | E-3 |
| PRM-33 | tsconfig `module: commonjs` → node10 resolution ignores package `exports` | FNA (A) | C | C2 | C-1 |
| PRM-34 | nameless lock entry for a `file:` dependency silently dropped | silent drop | B | point fix | B-4 |
| PRM-35 | a cache write failure aborts the scan | wrong exit code | B | point fix | B-3 |
| PRM-36 | `--cve` produces a false "no advisory discovered" reason | false reason | B | point fix | B-5 |
| PRM-37 | tagged templates emit no edge | FNA | A | A1 | A-1 |
| PRM-38 | implicit protocol calls: coercion (`toString`; `valueOf`/`Symbol.toPrimitive` share the mechanism but were not separately reproduced), thenables, `Symbol.iterator` (`for…of`) | FNA | A | A1 protocol members | A-4 |

### 2.3 Comment-premise sweep, round 2

| Finding | Summary | Impact | Lane | Closed by | Task |
| --- | --- | --- | --- | --- | --- |
| PRM-60 | non-widening `unsupported_*` reasons "could not load a new module" (settled FALSE; same premise as PRM-105/109) | FNA (A) | C | C1 total value-flow table | C-3 |
| PRM-61 | forwarding hop takes the first own binding (stale `exports`) | FNA and FA | E | E write set gates the hop | E-2 |
| PRM-62 | ESM `export let` reassigned keeps its initializer | FNA | E | E write set | E-1 |
| PRM-63 | bracket/alias `module.exports` writes (4 of 8 shapes uncompensated) | FNA | E | E write set | E-1 |
| PRM-64 | a versionless instance is evaluated only against its siblings' version-filtered advisories | silent drop | B | point fix (decision 4) | B-4 |
| PRM-65 | OSV `next_page_token` discarded | silent drop | B | point fix (decision 5) | B-1 |
| PRM-66 | a malformed workspace manifest with a versionless lock entry is dropped | silent drop | B | point fix | B-4 |
| PRM-67 | `SUPPORTED_MODEL_EXCLUSIONS` omits `--import` and `--conditions` | false scope statement | D | point fix (decision 11) | D-1 |
| PRM-101 | Site B phantom target certified by family C for a package loaded only through `export *` | FNA | V | V closure corroboration | V-1 |
| PRM-102 | Site A/B selected by manifest package name | FNA | V | V instance-keyed selection | V-1 |
| PRM-103 | a cyclic importer observes an intermediate export value | FNA | E | E write set (re-entrant `require`) | E-1 |
| PRM-104 | a reassigned `function` declaration resolves to its stale body | FNA | A | A2 | A-5 |
| PRM-105 | escape sweep: member access and call results value-opaque (= PRM-60) | FNA (A) | C | C1 | C-3 |
| PRM-106 | `require` excluded as a capability receiver (`require.bind`) | FNA (A) | C | C1 | C-3 |
| PRM-107 | `module.paths` recognised only as a literal chain | FNA (B) and FA | C | C1 loader table; C-5 for the FA | C-4, C-5 |
| PRM-108 | import name recorded from the local name for string/computed destructuring keys | FNA (A) | A (origin) and C (consumer) | A2; C1 | A-6, then C-4 |
| PRM-109 | `graph.ts` non-widening justification (= PRM-60) | FNA | C | C1 | C-3 |
| PRM-110 | HTML summary renders "no reason recorded" for an `UNKNOWN` with reasons | false reason | B | point fix | B-5 |
| PRM-111 | `--cve=""` is accepted and silently filters everything out | silent drop | B | point fix | B-5 |
| PRM-112 | `instanceof` → `[Symbol.hasInstance]` emits no edge | FNA | A | A1 protocol members | A-4 |
| PRM-113 | `for await` → `[Symbol.asyncIterator]` emits no edge | FNA | A | A1 protocol members | A-4 |
| PRM-114 | `Error.prepareStackTrace = fn` emits no edge | FNA | A | A1 escaped values (global hook assignment) | A-3 |
| PRM-115 | TypeScript decorators emit no edge | FNA | A | A1 | A-1 |
| PRM-116 | JSX elements emit no edge to the component | FNA | A | A1 (possible edge) | A-3 |
| round 2 KNOWN | `arguments` aliasing (→ PRM-17); `.call.call` (→ PRM-20); `Function.prototype.apply.call`, `Reflect.apply`/`construct`, `defineProperty` get/set, Proxy trap, `toJSON` (→ AUD-01); iterator spread/destructuring/`yield*`/`Array.from` (→ round-1 iterator); `new Readable({ read })` (→ PRM-12/13); two-hop `vm` alias (→ PRM-21/22) | FNA | as mapped | as mapped | as mapped |

### 2.4 Existing record

| Finding | Summary | Impact | Lane | Closed by | Task |
| --- | --- | --- | --- | --- | --- |
| RWF-047 (OPEN-DEBTS D-16) | a member write on a require-bound module object keeps its static attribution | FNA and FA | E | E writes by other modules | E-4 |
| RWF-050 | RWF-026's inherited MAY-execute conditional/logical abrupt-operand gap (`flag && bail()`, `flag ? bail() : v`, `z ||= bail()`), given a register row but not independently reproduced | possible FNA — UNCLASSIFIED | none yet: plausibly E (export attribution's abrupt-completion machinery, by analogy with RWF-026's own family — `FINDINGS.md` RWF-050) | reproduce end to end against real Node first; only then classify (defect class, proof family, lane) | **RWF-050-repro** (added by `remediation-reconciliation`; see § 5a) |

Added by task
[`remediation-reconciliation`](tasks/remediation-reconciliation.md):
`RWF-050` was missing from this plan entirely. It is registered in
`tests/validation/FINDINGS.md` as UNCLASSIFIED — none of the three audits
behind this plan independently reproduced it, so it cannot honestly be
assigned a lane yet. `RWF-050-repro` is a reproduce-first task (§ 5a): its
job is to establish, against real Node, whether the gap reaches a real
verdict at all, and only then to classify it. Its likely home is lane E,
because the mechanism it inherits from RWF-026 (`mayEndModuleEvaluation`'s
abrupt-completion reachability) is the same machinery ADR 0009 § 1
clause 3 (E-1's scope) keeps and narrows; this is a hypothesis for
scheduling purposes only; the task itself decides.

### 2.5 Task A-0 (ADR 0008 coverage reproduction)

Added 2026-09-27, when the project owner decided ADR 0008's Amendment
A-0 (its "Decision record — Amendment A-0"). Task
[`A-0`](tasks/A-0-adr0008-coverage-reproduction.md) registered these
findings. Its eleven other false-`NOT_AFFECTED` cases are attached to
AUD-01 (§ 2.1) and are not listed again.

| Finding | Summary | Impact | Lane | Closed by | Task |
| --- | --- | --- | --- | --- | --- |
| PRM-117 | `[util.inspect.custom]()` run by `console.log` / `util.inspect` / `util.format("%o")` gets no edge | FNA | A | fail-closed default (§ 3), held by Amendment A-0 part A's mechanical-admission condition: no inspecting builtin on the non-invoking allowlist | A-3 |
| PRM-118 | a getter or setter body is attributed to the enclosing owner, so an accessor real Node never runs gives a fabricated `AFFECTED` path | FA | A | Amendment A-0 part B: an accessor is its own owner, reached by a *possible* edge | A-4 (precision restored by A-7) |
| RWF-051 | nothing under `tests/` is type-checked, so a type-level guard written there is enforced by no gate (`tests/oracle/` excepted since A-0) | tooling | none (tooling) | type-check everything under `tests/` and fix the latent errors it reveals | **RWF-051-typecheck** (§ 5a, order 1b) |

## 3. The three tests that pin a false premise

| Test | Pinned premise | Task that changes it |
| --- | --- | --- |
| `src/code-intelligence/symbol-binder.test.ts` "ignores a trailing method chain on an already-bound named import" | PRM-20 | **A-6** |
| `src/code-intelligence/call-graph.test.ts` VT-213 "connects a call site to an inline callback regardless of the method name (no special-casing)" (`obj.someUtterlyArbitraryMethodName(() => vulnerable())`, `obj` a parameter). It pins the premise by omission: it asserts the callback edge and never the callee's `unknown` edge, so it still passed under the prototype | PRM-13 | **A-5** (adds the missing assertion) |
| `src/analysis/verdict.negative-proof.test.ts` "case 10b: traversal_truncated ALONE does NOT block families B/C" | PRM-23 | **V-2** |

## 4. Precision cost, measured

Every number below was measured with throwaway prototypes in scratch
clones outside the repository, never committed, at `62b52b9`. The method is
in § 9. "Changed" means the verdict moved; for each lane, the direction and
the case are named in its ADR.

| Lane (prototype) | Adversarial scenarios (122) | Validation cases (17) | Validation findings (85) | Targeted reproductions flipped |
| --- | --- | --- | --- | --- |
| A, modeled | 1 (ADV2-021, a prototype shortcut the design removes) | 0 | 0 | 36 / 36 |
| A, possible → unknown (upper bound of the design) | 1 (the same) | 0 | 0 | — |
| A, strict (no non-invoking allowlist) | 1 (the same) | 1 (RWB-07 `NOT_AFFECTED → UNKNOWN`) | 1 | — |
| E (upper bound: the prototype withdrew every name written twice, which the revised ADR 0009 rule does not) | 1 (ADV2-028, a prototype shortcut the design removes) | 0 | 0 | 19 / 20 (PRM-11 needs E-4) |
| C | 0 | 0 (RWB-09a first timed out at the runner's 30 s limit; re-run without the limit: unchanged `AFFECTED`) | 0 | 11 / 11 |
| V | 0 | 0 | 0 | 5 / 5 |

**What the corpora can and cannot show.** The validation corpus has 85
findings, of which 15 are definitive (10 `AFFECTED`, 5 `NOT_AFFECTED`) and
70 are already `UNKNOWN` (mostly for want of a rule). A lane can only move a
definitive finding, so the measured cost is a cost on those 15 and on the
122 adversarial scenarios. Each lane's first implementation task repeats
this measurement and reports every movement case by case.

**The repository's own suite** (`npx vitest run`, 4,480 tests) under each
prototype: A 5 failures, C 5, V 20, E 303. Every failure is assigned in the
lane's ADR § 8, either as a test that must change or as a precision control
the design must keep green. Lane E's 303 are the reason ADR 0009's
invariant was revised: they pin a sound "last definitely-reached write
wins" rule that the crude prototype discarded.

**Wall time.** Validation suite, run alone: baseline 115 s; A 103 s; E 138 s;
V 145 s; **C 337 s (≈ 2.9×)**. Lane C's cost is an implementation
requirement: ADR 0010 § 2 makes an operation-count gate part of the
invariant.

## 5. Lane ordering

**Superseded 2026-09-26** by § 5a's single sequential schedule (project
owner decision 12, § 6.1: the project owner runs one task at a time, not
two concurrent slots). This section's text, table and reasoning are kept
unchanged, because § 5a's single order is built directly from the
prevalence, criticality, dependency and file-overlap reasoning stated
here — it resolves each wave's two slots into one sequence instead of
replacing the reasoning.

At most two lanes run at a time, in two slots:

| Wave | Slot 1 (call-graph side) | Slot 2 (proof and intake side) |
| --- | --- | --- |
| 1 | **A** (A-1 → A-2 → A-3 → A-4 → A-5 → A-6) | **V** (V-1 → V-2 → V-3 → V-4), then **C-1** |
| 2 | A continues | **B** (B-1 … B-6) |
| 3 | **E** (E-1 → E-2 → E-3 → E-4 → E-5) | **C** (C-2 → C-3 → C-4 → C-5) |
| 4 | — | **D** (D-1) |

Reasoning:

- **Prevalence first.** Lane A's shapes are ordinary code: timer and
  Promise callbacks, JSX, decorators, derived classes with no constructor,
  `fs` callbacks. Lane V's PRM-101 is ordinary code too (`export *` barrels),
  and V is the smallest lane with zero measured cost, so it goes first in
  slot 2. C-1 (PRM-33, a TypeScript project with `module: commonjs`) is
  ordinary code and touches only `module-resolver.ts` and `ts-project.ts`, so
  it is pulled forward to follow V.
- **Criticality.** Lane B holds five silent drops (PRM-34, PRM-64, PRM-65,
  PRM-66, PRM-111), which are critical failures under the contract;
  B follows V and C-1 in slot 2 rather than waiting for the analysis lanes.
- **Dependencies.** A-2's `possible` edge kind precedes A-3 and A-4. C-4
  consumes A-6's import-name fix. E-4 edits `symbol-binder.ts`, lane A's
  file, so E follows A. E-3 (root requirements in `module-model.ts`) builds
  on V-3 (root materialization in `verdict.ts`), so V precedes E. B-6
  (AUD-15) edits `verdict.ts`, so it follows V. D-1 edits
  `html-report.ts`, which B-5 (PRM-110) also edits, so D follows B.
- **Lane C's heavy tasks go last** in slot 2: its remaining shapes are
  mostly deliberate capability laundering, and C-2/C-3 carry the
  performance requirement.

### 5.1 Parallel-safety and file overlap

| Pair | Files in common | Parallel-safe? |
| --- | --- | --- |
| A ∥ V | none. A-2 changes `analysis/reachability.ts`'s result (possible edges); V changes `verdict.ts`, which consumes it | **yes**, provided A-2 does not edit `verdict.ts`; if it must, A-2 waits for V-3 |
| A ∥ C-1 | none | **yes** |
| A ∥ B | none (`src/vulnerabilities/`, `src/cache/`, `src/dependencies/`, `src/cli/` vs `src/code-intelligence/`) | **yes** |
| E ∥ C | none (`module-model.ts`, `export-forwarding.ts`, `commonjs-reexports.ts` vs `loader-constructs.ts`, `module-resolver.ts`, `ts-project.ts`). Both read `named-bindings.ts`, which lane A changed earlier | **yes** |
| A ∥ E | `symbol-binder.ts` (A-6, E-4); root derivation semantics | **no**: E after A |
| A ∥ C-2..C-5 | `source-index.ts` (A-6 origin, C-4 consumer); `call-graph.ts` consumes `loader-constructs.ts` | **no** for C-4 before A-6; C-2 and C-3 would be safe, but are scheduled after A anyway |
| V ∥ E | root derivation (`verdict.ts` V-3, `module-model.ts` E-3) | **no**: E after V |
| V ∥ B | `verdict.ts` (B-6 only) | **yes** except B-6, which follows V |
| B ∥ D | `src/cli/html-report.ts` (B-5, D-1) | **no**: D after B |

### 5a. Single sequential schedule (decided 2026-09-26)

Recorded by task
[`remediation-reconciliation`](tasks/remediation-reconciliation.md),
per decision 12 (§ 6.1): the project owner runs **one task at a time**.
This replaces § 5's two-slot table with one order. It is built from § 5's
own reasoning and § 5.1's file-overlap table, resolved into a single
sequence by, in order: (1) hard dependencies (§ 5.1: a task that must
follow another is never moved earlier); (2) prevalence of the
false-`NOT_AFFECTED`/silent-drop shape in real code, as § 5's own
"Prevalence first" and "Criticality" bullets already argue; (3) task size,
preferring a small task first when (1) and (2) do not decide the order.
`RWF-050-repro` (§ 2.4) is placed immediately before **E-1**: it has no
file dependency on any other task (it is a reproduction, not a fix), so
it can run anywhere, and its plausible mechanism sits inside lane E's
scope (ADR 0009 § 1 clause 3) — placing it immediately before lane E
starts is the earliest point at which a scope change it finds is still
free to fold into E's own task files, rather than requiring rework of an
E task already drafted.

**H-0, the shared real-Node oracle harness.** Not previously in this plan;
added here as its first task, per the task prompt that produced this
schedule. Scope: one shared library, callable from any suite, that runs a
fixture package's assertion against real, installed Node (spawn or
`vm`-isolated, never the analyzer) and reports whether the fixture's
bound name is really invoked/reached/loaded — the exact "loud fixture,
real-Node ground truth" check that AGENTS.md § G requires and that every
audit reproduction in `docs/audits/` and § 9's measurement method already
does by hand, ad hoc, per lane. Files: a new module under `tests/` (for
example `tests/real-node-oracle/`), consumed by `tests/binding-grammar/`,
the new capability-grammar and write-set-grammar sweeps (ADR 0010 § 2,
ADR 0009 § 2), and every lane's own suites. No existing behaviour changes;
this is test infrastructure only.

Status: **done** — built as `src/testing/oracle/` (the library, excluded
from the build like `open-soundness-defect.ts`) plus `tests/oracle/` (the
dedicated suite, `npm run test:oracle`), rather than the illustrative
`tests/real-node-oracle/` location above. See
[`docs/tasks/H-0-real-node-oracle-harness.md`](tasks/H-0-real-node-oracle-harness.md).

**A-0, ADR 0008 coverage reproduction.** Added by task
[`A-0`](tasks/A-0-adr0008-coverage-reproduction.md) as order **1a**,
between H-0 and A-1, so the existing order numbers (which later rows
cite) stay unchanged. Scope: reproduce, before lane A is built, the
implicit invocations ADR 0008's protocol-member rule does not name
(`util.inspect.custom`, getters read by builtins, non-protocol Proxy
traps), pin them, and decide from the ADR's text whether it closes each.
No analyzer change.

Status: **done; Amendment A-0 accepted by the project owner on
2026-09-27**, parts A and B, with conditions (ADR 0008, "Decision record
— Amendment A-0"). The conditions are A-3's and A-4's acceptance
criteria below. The rest of this paragraph is the status as A-0 first
recorded it. 32 cases in
`tests/oracle/adr0008-coverage.test.ts`. False `NOT_AFFECTED`: 3 under
the new PRM-117 (`util.inspect.custom`) and 11 attached to AUD-01 (an
enumerable `defineProperty` getter; non-protocol Proxy traps). False
`AFFECTED`: 8 under the new PRM-118 (accessor bodies attributed to the
enclosing owner). One false `NOT_AFFECTED` case (a named Proxy handler
triggered by `in`) and PRM-118 are closed by no rule of ADR 0008 as
written. ADR 0008's appended "Amendment A-0" proposes the change, which
is **not decided**. See "A-0 additions to lane-A acceptance", below the
table.

**RWF-051-typecheck, widened: gate enforcement.** Added 2026-09-27 as
order **1b**, immediately after A-0 and before A-1, when the project
owner decided Amendment A-0. Scope, widened while executing: type-check
everything under `tests/` and fix the latent errors it reveals (including
`tests/binding-grammar/harness.ts:328`); AND make CI
(`.github/workflows/ci.yml`) run every hermetic gate in `AGENTS.md`
section I, on pull requests and on push to `main` (previously it ran a
subset, on pull requests only). Closes RWF-051 (§ 2.5). Reason: lane A
adds `tests/binding-grammar/` rows (ADR 0008 § 2), and that suite relies
on type-level guards, so those guards must be enforced by a gate — and
actually run in CI, not only when an agent happens to run them locally —
before lane A starts adding to it. Status: **done**
(`docs/tasks/gate-enforcement.md`).

**A-7, reader builtins invoke accessors.** Added 2026-09-27 as order
**30**, after every lane, by the project owner's Amendment A-0 decision
(part B, condition 2). Scope: model the reader builtins
(`JSON.stringify`, `Object.assign`, object spread, `Object.entries` and
similar) as invoking the own enumerable accessors of attributable
objects, with a resolved edge where real Node guarantees the read. The
correct `AFFECTED` results that A-4 turns into `UNKNOWN` (for example
`S2.literal.*` in `tests/oracle/adr0008-coverage.test.ts`) then become
proven `AFFECTED` again. It is a precision task: it may add an edge only
where real Node runs the accessor. `S2.class-instance.*`,
`S2.class-static.*` and `S2.defineProperty.*` are not read by these
builtins and must not become `AFFECTED`. ADR 0008 § 8 does not list it.
Status: **planned**.

**Note on the H-0 builtin probe** (recorded 2026-09-27, by the project
owner's Amendment A-0 decision). `probeBuiltinArgKind` in
`src/testing/oracle/builtin-probe.ts` catches an exception from the call
and records it in `fired` as `THREW:<message>`, then reports
`ranUserCode: fired.length > 0`. A builtin that **throws** is therefore
reported as `ranUserCode: true`, whether or not any user hook ran. For
admission this errs on the conservative side: it can keep an entry off
the allowlist, never put one on. But it is inaccurate. Measured
2026-09-27, Node v22.11.0: `JSON.parse(__ARG__)` throws for all nine
argument kinds, so it reports `ranUserCode: true` for all nine, while
real user hooks fire only for `toString`, `toPrimitive` and the two
Proxy kinds (`get`). The probe is not changed. A task that builds a
mechanical admission test on it (A-3) must read `fired`, not
`ranUserCode` alone.

| Order | Task | Lane | Reasoning |
| --- | --- | --- | --- |
| 1 | H-0 | — | every later task's failing-first tests, precision measurements (§ 4, § 9) and grammar sweeps (ADR 0009 § 2, ADR 0010 § 2) need real-Node ground truth; building the shared harness once, first, avoids each lane reimplementing its own ad hoc version, which is what § 9's method describes happening already |
| 1a | A-0 | A | reproduction only, no analyzer change: lane A's design must be checked against the implicit invocations the ADR 0008 Decision record lists as not covered, before A-1..A-6 are built on it; uses H-0, so it follows H-0 |
| 1b | RWF-051-typecheck, widened: gate enforcement | — (tooling) | type-check everything under `tests/` and fix the latent errors it reveals (including `tests/binding-grammar/harness.ts:328`), AND make CI run every hermetic gate: lane A adds `tests/binding-grammar/` rows that rely on type-level guards, and those guards must be enforced by a gate that actually runs, in CI, first |
| 2 | A-1 | A | first task of the most prevalent lane (§ 5 "Prevalence first": timer/Promise callbacks, JSX, decorators, derived classes are ordinary code); a hard dependency of A-2/A-3/A-4 (ADR 0008 § 8) |
| 3 | A-2 | A | hard dependency: A-3 and A-4 emit `possible` edges that A-2 defines (ADR 0008 § 8) |
| 4 | A-3 | A | prevalent shapes (escaped callbacks, JSX, own-export calls); depends on A-1, A-2 |
| 5 | A-4 | A | prevalent shapes (coercion, thenables, iterators); depends on A-1, A-2 |
| 6 | A-5 | A | independent of A-2 per ADR 0008 § 8, but has no reason to move earlier than A-3/A-4; closes six PRM reproductions including the two pinned-test corrections |
| 7 | A-6 | A | independent of A-2; scheduled last in lane A because C-4 (order 27) and E-4 (order 23) both consume its import-name and trailing-chain fix, so it must finish before either, which it does either way once A-1..A-5 are done |
| 8 | V-1 | V | § 5 "Prevalence first": `export *` barrels are ordinary code; V is the smallest lane, zero measured cost, and has no dependency on A, so it follows A only because A was judged more prevalent, not because it must |
| 9 | V-2 | V | depends only on V-1 in ADR 0011 § 8's own order |
| 10 | V-3 | V | depends on V-1, V-2; E-3 (order 22) depends on V-3, so V must finish before E |
| 11 | V-4 | V | "locks V-1..V-3" per ADR 0011 § 8; last in the lane by construction |
| 12 | C-1 | C | § 5 "pulled forward to follow V": ordinary code (a TypeScript project with `module: commonjs`), touches only two files, no dependency on A or V |
| 13 | B-1 | B | § 5 "Criticality": lane B's silent drops are critical failures under the contract; B has no dependency on A, V or C-1 (§ 5.1: A ∥ B yes), so it runs as soon as V and C-1 (already ahead of it for prevalence reasons) are done |
| 14 | B-2 | B | independent point fix within lane B; order among B-1..B-5 follows § 7's own table order, since no dependency or prevalence distinction is stated between them |
| 15 | B-3 | B | as B-2 |
| 16 | B-4 | B | as B-2; closes four of lane B's five silent drops (PRM-34, PRM-64, PRM-66, AUD-08) |
| 17 | B-5 | B | as B-2; carries decision 3's exit-code scheme (§ 6.1 item 3) |
| 18 | B-6 | B | hard dependency: edits `verdict.ts` after V (§ 5.1) |
| 19 | RWF-050-repro | none yet | placed immediately before lane E starts (see above); has no file dependency, so this is the latest point that still lets its result change E's scope before E's own tasks are drafted |
| 20 | E-1 | E | hard dependency: after A (symbol-binder.ts is shared with A-6, and A-1's `ExportWriteKind` work needs nothing from A, but E-1 also needs the abrupt-completion machinery RWF-050-repro just checked); largest and first task of lane E per ADR 0009 § 8's own order |
| 21 | E-2 | E | depends on E-1 (forwarding hops consult the write set E-1 builds), per ADR 0009 § 8 |
| 22 | E-3 | E | hard dependency: builds on V-3 (order 10), already done; per ADR 0009 § 8's own order |
| 23 | E-4 | E | hard dependency: consumes A-6 (order 7), already done; per ADR 0009 § 8's own order |
| 24 | E-5 | E | last in lane E per ADR 0009 § 8; scope to be determined from the (not-yet-in-repository) independent audit report |
| 25 | C-2 | C | § 5 "Lane C's heavy tasks go last": remaining lane-C shapes are deliberate capability laundering and carry the performance requirement (§ 4, § 9); no dependency forces it later than this, but nothing forces it earlier either |
| 26 | C-3 | C | depends on C-2's total value-flow table, per ADR 0010 § 8's own order |
| 27 | C-4 | C | hard dependency: consumes A-6 (order 7), already done |
| 28 | C-5 | C | depends on C-4's loader-table work (`verdict.ts` path check reads the loader-mutation reason C-4 introduces), per ADR 0010 § 8's own order |
| 29 | D-1 | D | hard dependency: edits `html-report.ts` after B-5 (order 17), per § 5.1 |
| 30 | A-7 | A (precision) | the project owner's Amendment A-0 decision, part B, condition 2 ("later, after the lanes"): restores, as proven `AFFECTED`, the correct results A-4 turns into `UNKNOWN`; needs A-4 (order 5) and A-3 (order 4); soundness tasks come first, so it follows every lane |

#### A-0 additions to lane-A acceptance

Added by task A-0. Every case named below is in
`tests/oracle/adr0008-coverage.test.ts`. A case pinned there as an
open-soundness-defect record is closed when its live result becomes
`UNKNOWN`. The fix then deletes the record and asserts `UNKNOWN`, the
same way every such record in this repository is closed. The task each
case is assigned to is the one ADR 0008 names for the rule that closes
it (its "Amendment A-0" section quotes each rule).

**A-3** (escaped function values; the invoking and non-invoking
allowlists and their real-Node tests) also accepts only when:

- [ ] `S1.console.log`, `S1.util.inspect`, `S1.util.format-o` (PRM-117)
      are `UNKNOWN`. They are closed by the fail-closed default: none of
      `console.*`, `util.inspect` or `util.format` may be admitted to the
      non-invoking allowlist, per the Decision record's admission rule.
- [ ] `S2.defineProperty-enumerable.JSON.stringify`, `.Object.assign`,
      `.spread` and `.Object.entries` (AUD-01) are `UNKNOWN`, by the
      escape row ("a property descriptor").
- [ ] `S3.Object.keys.ownKeys`, `S3.Object.getOwnPropertyNames.ownKeys`,
      `S3.in.has`, `S3.JSON.stringify.ownKeys`, `S3.JSON.stringify.get`
      (AUD-01, inline handler) are `UNKNOWN`, by the escape row at
      `new Proxy(...)`. No non-invoking allowlist entry for `Proxy` may
      remove that edge.
- [ ] `S3.Object.keys.ownKeys.named-handler` (AUD-01) is `UNKNOWN`, by
      the fail-closed default at `Object.keys`.
- [ ] `S3.in.has.named-handler` (AUD-01) is `UNKNOWN`. **ADR 0008 as
      written does not close it**; this criterion depends on Amendment
      A-0 part A (retaining builtins), which awaits a project-owner
      decision. *(Update, 2026-09-27: part A is accepted; see the
      criteria below.)*
- [ ] `S4.Array.isArray`, `S4.Object.is` stay `NOT_AFFECTED` (precision
      controls: both builtins pass the admission test and store nothing).
- [ ] `S2.defineProperty.*` (a default, non-enumerable getter; real Node
      never runs it) stay `NOT_AFFECTED` or `UNKNOWN`. `UNKNOWN` is the
      expected, sound precision cost of the escape row.
- [ ] `S2.literal.*` stay `AFFECTED` or `UNKNOWN`, never `NOT_AFFECTED`.

Added 2026-09-27: Amendment A-0 part A is accepted with a condition (ADR
0008, "Decision record — Amendment A-0"). **A-3** also accepts only when:

- [ ] A builtin is admitted as a `NonInvokingBuiltin` only if it runs no
      user code through any path at the call (Decision 1) **and** is
      non-retaining: it does not return or store an object through which
      a later operation can invoke user code taken from its arguments.
- [ ] `new Proxy` and `Proxy.revocable` are excluded from the allowlist
      by name.
- [ ] The escape rule takes precedence over every allowlist entry: no
      entry removes an edge the escape row gives.
- [ ] **Mechanical admission.** Every allowlist entry has a passing H-0
      builtin-probe test, run in CI, so that an entry whose probe fires
      cannot be admitted by hand. Examples whose probe fires: `console.*`,
      `util.inspect`, `util.format`, `Object.keys`,
      `Object.getOwnPropertyNames`, `JSON.stringify`, `Object.assign`,
      `Object.entries`. PRM-117's closure and the closure of
      `S3.Object.keys.ownKeys.named-handler` depend on this criterion.
      Two facts measured on 2026-09-27 bear on it:
      - **CI does not run the probe today.** `.github/workflows/ci.yml`
        runs `npm test` (`src/**/*.test.ts` only), not `npm run
        test:oracle`, and `tests/oracle/builtin-probe.test.ts` is not
        under `src/`. A-3 must make CI run the admission probes.
      - **The probe reports a throwing builtin as `ranUserCode: true`**
        (see "Note on the H-0 builtin probe", above the table). The
        admission test must read which hooks fired, not `ranUserCode`
        alone.
- [ ] RWB-07's verdict is reported. § 5 measured that without the
      allowlist RWB-07 loses its correct `NOT_AFFECTED`. The only builtin
      call in its source (`src/config.js`) is `JSON.parse(text)`, and
      `JSON.parse`'s probe fires `toString`, `Symbol.toPrimitive` and the
      Proxy `get` trap (measured 2026-09-27). If `JSON.parse` is not
      admissible under this criterion, the expected cost is RWB-07
      `NOT_AFFECTED → UNKNOWN`. A-3 reports the result and does not relax
      the criterion to avoid it.

Added 2026-09-27: the project owner's allowlist admission ruling (ADR
0008, "Decision record — allowlist admission ruling"), recorded by task
[`task-0-workflow-bootstrap`](tasks/task-0-workflow-bootstrap.md).
**A-3** also accepts only when:

- [ ] Admission is decided **per argument position**. A position passes
      only if every hook the probe observes firing for it is (a) a member
      of ADR 0008 § 2's protocol list, an accessor body (Amendment A-0
      part B) or a Proxy trap (part A), **and** (b) proven by an oracle
      case in which a vulnerable call inside that hook, reached through
      this builtin at this position, never yields `NOT_AFFECTED`. Any
      other hook (the builtin calling a function argument,
      `util.inspect.custom`, an unlisted method) fails the position.
- [ ] The admission test reads the hooks that fired and classifies each
      against (a); it does not read `ranUserCode`.
- [ ] The H-0 builtin probe reports a throw separately from a hook that
      fired (`src/testing/oracle/builtin-probe.ts` today records a throw
      in `fired`).
- [ ] Part A's conditions still hold for every admitted position:
      non-retaining; `new Proxy` and `Proxy.revocable` excluded by name;
      the escape row takes precedence.
- [ ] `JSON.parse`'s reviver position is never admitted. If its first
      position is admitted, RWB-07's `NOT_AFFECTED` is reported as kept
      and the oracle case that proves (b) for it is named.
- [ ] Every position admitted under (a) that the "mechanical admission"
      criterion above lists as an example whose probe fires (for example
      `Object.keys`, `JSON.stringify`) is named in A-3's report, with the
      hooks that fired and the oracle case for each.

**A-4** (protocol members) also accepts only when, **if** Amendment A-0
part B (accessor bodies) is accepted *(update, 2026-09-27: part B is
accepted, with two conditions; the criteria after this list apply)*:

- [ ] `S2.class-instance.*` and `S2.class-static.*` (PRM-118: eight false
      `AFFECTED`) are `UNKNOWN`. ADR 0008 as written closes none of them.
- [ ] `S2.literal.*` stay `AFFECTED` or `UNKNOWN`, never `NOT_AFFECTED`.
      That is, an accessor body is given a possible edge, never no edge.
- [ ] The RWB-09 validation case is re-measured, since its `semver` and
      `lru-cache` code contains accessors.

Added 2026-09-27: Amendment A-0 part B is accepted with two conditions
(ADR 0008, "Decision record — Amendment A-0"). **A-4** also accepts only
when:

- [ ] A getter or setter (object literal or class, instance or static) is
      its own owner, reached from its defining owner by a *possible*
      edge. No accessor ever gets no edge.
- [ ] **Condition 1: precision cost measured before merge**, with ADR
      0008 § 5's method: the adversarial table, the validation tables and
      the finding-level dump by (case, advisory, instance), each movement
      reported case by case. RWB-09a and RWB-09b (`semver`,
      `lru-cache`), the full validation results (against OPEN-DEBTS
      D-09's known failures) and the full adversarial results are
      reported explicitly.
- [ ] **Condition 2: the precision task is scheduled.** A-7 (§ 5a, order
      30: reader builtins invoke the own enumerable accessors of
      attributable objects) stays in the plan. A-4's report lists each
      correct `AFFECTED` it turned into `UNKNOWN`, since those are the
      results A-7 must restore.

A lane-A task that makes any of these cases `UNKNOWN` earlier than
listed deletes that case's record in the same way.

#### A-1 additions to lane-A acceptance

Added by task A-1 (2026-09-28), from its independent audit. The cases
are in `tests/validation/FINDINGS.md` (RWF-060; PRM-37's A-1 status
update).

**A-3** also accepts only when:

- [ ] The arguments of a `new` (or call) whose callee RESOLVES to a
      derived class's implicit constructor are accounted as the
      arguments of a call to its base when the implicit-constructor chain
      ends at an ambient or builtin constructor
      (`class P extends Promise {}`, `new P(() => lib.parse("x"))`; a
      `stream.Readable` subclass handed `{ read() {...} }`). ADR 0008
      § 2's escape row as written names only a call or `new` whose callee
      is ambient, builtin, unresolved or unknown, so it would not reach
      these arguments. RWF-060 becomes `UNKNOWN` (or `AFFECTED` for a
      documented invoking builtin such as the `Promise` executor), never
      `NOT_AFFECTED`.
- [ ] A class value handed to an ambient or builtin API that constructs
      it (`Reflect.construct(A, [])`, ADR 0008 § 4's documented invoking
      builtins) reaches the class's constructor node -- explicit, or the
      synthesized implicit constructor -- because task A-1 accounts a
      tagged template or decorator in an instance field initializer from
      that node (`evaluatingOwnerOf`). `` class A { f = lib.parse`x`; }
      Reflect.construct(A, []); `` is `UNKNOWN` or `AFFECTED`, never
      `NOT_AFFECTED` (FINDINGS.md, PRM-37's A-1 status update).

#### A-2 additions to lane-A acceptance

Added by task A-2 (2026-09-28), which introduced the `possible` edge
kind with no producer. Its semantics are enforced where the edge is
consumed (`src/analysis/reachability.ts`; the owners of
`affected-path-resolved-edges-only`). What a PRODUCER must guarantee
cannot be checked there, so it binds the tasks that emit one
(`CallEdgeResolution`'s documentation in `src/domain/graph.ts` states the
same three rules).

**A-3** and **A-4** each also accept only when:

- [ ] Every `possible` edge they emit points at a node whose file the
      graph WALKS, exactly as for a resolved edge. Reachability reads a
      node with no outgoing edges as "searched, calls nothing", so a
      `possible` edge into an unwalked body would make an unsearched
      region look complete — a false family C. A test over the corpora
      and the task's reproductions asserts, for every emitted `possible`
      edge, that its target is a node of the graph and that its file was
      walked.
- [ ] A `possible` edge is emitted only for an over-approximation ADR 0008
      § 2 names, to an attributable target. An unattributable value gets
      an `unknown` edge (§ 3), and a call the language guarantees gets a
      resolved edge with its authority (§ 4), never a `possible` one.
- [ ] At least one reproduction per emitted site kind reaches the
      production `buildFinding` on a real project through an emitted (not
      injected) `possible` edge and is `UNKNOWN` with
      `value_uncertainty` / `possible_invocation`, extending
      `src/analysis/verdict.possible-edge.test.ts`.
- [ ] The graph differential reports the emitted edges in the
      differential tool's `withdrawn to possible` / `unknown to possible`
      classes, case by case.

#### A-3a additions to lane-A acceptance

Added by task A-3a (2026-10-01). The criteria above are unchanged; this
records how `A-3` was split, one statement above that no longer holds,
and what A-3a's outcome binds on the tasks after it.

**The split.** The project owner split backlog row `A-3` on 2026-09-30
into **A-3a** (escaped function values, the invoking and non-invoking
builtins with mechanical admission, global hook assignments, the "A-1
additions") and **A-3b** (own-export calls AUD-02, JSX PRM-116). Every
"A-3" criterion above applies to the half that owns its subject; the
"A-2 additions" apply to each half for the `possible` edges it emits.

**A statement above that no longer holds.** "CI does not run the probe
today" was true when measured (2026-09-27). Since task
RWF-051-typecheck, `.github/workflows/ci.yml` runs `npm run test:oracle`,
whose suite is `tests/oracle/**`; A-3a's admission test
(`tests/oracle/builtin-admission.test.ts`) runs there, and the CI
configuration was not changed.

**A-4** also accepts only when:

- [ ] Every argument position A-3a could not admit BECAUSE a protocol
      hook fires there (condition (b) cannot pass before protocol
      members are accounted) is re-probed and, where the admission test
      now passes, admitted: at least `JSON.parse`'s first position
      (RWB-07's `NOT_AFFECTED`, lost by A-3a), `String`, `Number`,
      `parseInt`, `parseFloat`, `encodeURIComponent`, the `Math`
      functions, `new Error` / `new Date`'s first positions, and the
      builtin constructors commonly subclassed with no constructor
      (`Error`, `events`' `EventEmitter`), whose forwarded arguments A-3a
      accounts with an unknown edge at the implicit constructor. The
      report lists each position with its hooks and oracle cases, and
      each verdict it restores.

**A-3b** also accepts only when:

- [ ] `module_scope_callee` (the last unproven reason A-3a left on the
      builtin side: a call rooted in `module`, `exports`, `require`,
      `__dirname`, `__filename`) is removed or its remainder is named in
      `UNPROVEN_NO_EDGE_LEDGER` with the findings it carries.

#### A-3b additions to lane-A acceptance

Added by task A-3b (2026-10-02). The criteria above are unchanged; this
records what A-3b's outcome, and the project owner's three decisions of
2026-10-02 it rests on, bind on the tasks after it.

**Outcome.** `module_scope_callee` is removed, not narrowed: a call or
`new` rooted in an undeclared CommonJS module-scope binding gets an
unknown edge (`own_export_call` for `exports…` / `module.exports…`,
`loader_capability_escape` for any other member of `module` or
`require`). A JSX element or fragment is the invocation site `jsx`: its
factory's unknown edge (`jsx_factory_call`, or the closure-widening
`jsx_runtime_load` when its compiled form may load a module, which the
module-load closure records too, RWF-066), plus possible edges to the
component and to every function it hands the factory. ADR 0008 § 2's
own-export row allows "the own export's node, or unknown", and its JSX
row names only the component; both are taken at their fail-closed
reading.

**What it binds.**

- **A-5** (VT-210): a function used as a JSX factory is called at sites
  that spell no call, so VT-210's premise that it sees every call site
  of a function fails for it. Harmless while every JSX site carries an
  unknown edge; any task that resolves the factory (backlog `BL-041`)
  must first make VT-210 count or refuse such a function.
- **E-1 / E-2**: own-export calls are left unknown for want of the
  export's complete write set; backlog `BL-042` resolves them once it
  exists, and must respect in-module write order and the `exports` alias
  going stale after `module.exports = …`.
- **C-4** (or backlog `BL-040`): `module.parent.require` and
  `module.children[i].require` load modules the loader classifier does
  not see (RWF-065); the call graph fails closed on them, the module-load
  closure does not yet.
- **C-3** (or backlog `BL-043`): a loader capability escaping through a
  for-of destructuring assignment is invisible to the closure (RWF-067,
  found by A-3b's independent audit); A-3b's classic-JSX-factory rule
  widens on any such write, the spelled call does not yet.

#### A-4 additions to lane-A acceptance

Added by task A-4 (2026-10-04). The criteria above are unchanged; this
records A-4's outcome, the project owner's two decisions of 2026-10-04
(ADR 0008, "Decision record — iterator methods and unreadable keys"), and
what they bind on the tasks after it.

**Outcome.** A definition under a key that may be a protocol member's is
the invocation site `protocol_member`, accounted from the owner that
evaluates it: a possible edge to a method, to each attributable function
a property, field or store hands over, and an unknown `protocol_value`
edge for a value it cannot attribute. A key is a protocol key unless
proven otherwise; ADR 0008 § 2's list gains the iterator's `next`,
`return` and `throw` (RWF-068). Every getter and setter with a body is
its own node (kind `accessor`), reached from its definer by a possible
edge (the site `accessor`); its body, parameters and any class defined in
them are walked under it. The census has no `pending` kind left. The
positions A-3a could not admit because a protocol hook fires there are
admitted where the mechanical admission test now passes (the task file's
Outcome lists them).

**What it binds.**

- **A-5** (VT-208): `resolveInstanceMethod` keeps only `MethodDeclaration`s
  of the checker's property. A getter is never what `o.x()` calls -- the
  call invokes what the getter returns -- so a change that admits an
  accessor declaration there must resolve to the returned value, never to
  the accessor's node (which is kept out of every function lookup,
  `accessorNodeIdByLocation`).
- **A-7**: the correct `AFFECTED` results A-4 turned into `UNKNOWN` are
  `S2.literal.*` in `tests/oracle/adr0008-coverage.test.ts` (an own
  enumerable object-literal getter read by `JSON.stringify`,
  `Object.assign`, spread, `Object.entries`) and, outside A-7's reader
  builtins, a getter read directly (`o.v`;
  `accessor.literal-getter.read` in `tests/oracle/a4-protocol-members.test.ts`),
  which needs a resolved edge for a property read of a known accessor. No
  corpus case moved.
- **RWF-002 / E**: an `o[k] = v` with an unreadable key and an
  unattributable value is an unknown `protocol_value` edge; a
  target-relevance rule must treat it like any escaped value (ADR 0008
  § 7), and lane E's write set may later prove such a key.
- **BL-036** (RWF-059): a protocol value in an instance field is
  accounted from the constructor; calls in an instance field initializer
  keep the class-definition owner, as before.
- **BL-046** (RWF-070): `constructor` and `Symbol.species` are outside the
  list and reached by `await` (SpeciesConstructor); amending the list is
  the project owner's decision.
- **BL-045** (RWF-069): the builtin probe's single-feature argument kinds
  cannot show a hook only a structured argument reaches (a null-prototype
  value inspected by an argument-type error message); every admission
  also rests on reading the implementation. A-3a's `path.*` admissions
  contradict rule (a) this way.

#### A-5 split, and A-5a additions to lane-A acceptance

Added by task A-5a (2026-10-04). The criteria above are unchanged; this
records how `A-5` was split, the project owner's decision that binds the
second half, and what A-5a's outcome binds on the tasks after it.

**The split.** The project owner split backlog row `A-5` on 2026-10-04
into **A-5a** (VT-213, constant folding, the lexical `require`, VT-210,
`function` declaration stability: PRM-13, 14, 15, 16, 17, 104) and
**A-5b** (VT-208 receivers: PRM-18). Every "A-5" criterion above, and ADR
0008 § 8's A-5 row, applies to the half that owns its subject.

**Outcome of A-5a.**

- VT-213's resolved edge to an inline callback is gone (an unattributable
  callee keeps its unknown edge; the callback gets the escape row's
  possible edge).
- ADR 0008 § 4's receiver-bound documented invoking builtins give a
  resolved edge on a proven receiver, by the project owner's second
  decision of 2026-10-04:
  - the iteration methods on an array literal with a first element;
  - `then` / `finally` on `Promise.resolve()` of a value carrying no
    function;
  - `catch`, `then`'s second argument and `finally` on
    `Promise.reject(…)`.

  Deleting VT-213 alone had turned ADV2-018 and ADV2-024 into `UNKNOWN`.
- `==` / `!=` are folded only for two literals of the same type.
- A static `require` is a no-edge account only for the lexically proven
  ambient `require` (`ambient_static_require`), in a file proven to be a
  CommonJS module whose wrapper `arguments` it never reads. The import
  extraction and the require provenance bind a name only through it.
- VT-210 refuses any of these:
  - an exported or escaping function;
  - a file with JSX;
  - a written parameter, wrappers included;
  - `arguments`, `eval` or `with`;
  - a spread at or before the position (RWF-071).

  It skips an erased TypeScript `this` parameter (RWF-073).
- A reassigned `function` declaration is `reassigned`.
- The member-write scanner sees destructuring and `for…of` targets
  (RWF-072).
- `InvocationAccount` has no `unproven_no_edge` variant: all four of ADR
  0008 § 2's no-edge proofs are real, and `UNPROVEN_NO_EDGE_LEDGER` is
  deleted.

**A claim of ADR 0008 measured false (`AGENTS.md` § C).** § 5's
"designed configuration … 0 / 122 adversarial" for "VT-213 no longer
displaces" was measured on a prototype that KEPT VT-213's resolved
callback edge and only added the callee's unknown edge (§ 8: the pinned
test "still passed under the prototype"). That edge is itself fabricated
(PRM-13's A-3a appendix). Removing it costs ADV2-018 and ADV2-024 unless
the receiver-bound builtins of § 4 are modeled, which A-5a does.

**A-5b (the project owner's decision of 2026-10-04).** Keep § 4's
static-member exception and A2's `const x = new C()` receiver authority,
but withdraw a resolved method edge when ANY walked file may write that
member: an assignment, a dynamic key, or a reflective mutator
(`Object.defineProperty`, `Object.assign`, …). Also require a chain of
plain class declarations, with no field or accessor shadowing the method
in any class of the chain, and no constructor `return`.

Measured on the base `3d87189` with the oracle harness (Node v22.11.0),
each a false `NOT_AFFECTED`:

- `let inst = new Safe()` reassigned to `new Danger()` by a deferred
  write;
- `this.go()` in a base method, overridden by the subclass that is
  instantiated;
- `inst.run = () => lib.parse(…)` before `inst.run()`;
- a base-class field of the method's name shadowing a subclass method;
- a static method overwritten from a third file before the entry calls
  it (the shape the decision closes).

`Lib.run()` on a stable class and `const d = new D(); d.run()` stay
`AFFECTED` (the precision guards, ADV2-021's shape). The case programs
are kept for A-5b; a constructor that returns another object was not
measured validly (its fixture did not parse) and is re-measured there.

**What A-5a binds.**

- **A-5b**: VT-208 is untouched; the `this.m()` receiver is resolved by
  the checker today and is not one of A2's authorities.
- **A-6** (PRM-108): `extractRequireBindings` now binds a name only through
  the ambient `require` (`isAmbientStaticRequireCall`); the string- and
  computed-key fix must keep that condition.
- **BL-039** (RWF-063): the receiver-bound builtins trust `Array.prototype`
  and `Promise` the way A-3a's table trusts the global builtins, so a
  monkeypatch through a parameter or a container reaches them too; the
  fix must cover both.
- **BL-041** (the JSX factory): VT-210 refuses every function in a file
  with a JSX site. A task that resolves the factory may narrow this to the
  functions that can be the factory, never drop it.
- **ADR 0008 § 2's other A2 structural gates** (the branded
  `resolvedEdge(authority, target)`, the binding-grammar A2 rows,
  `VT-INV-A2-resolution-authority`) are assigned to no task by § 8.
  Backlog `BL-047` carries them, after A-5b and A-6.

#### A-5b additions (task A-5b, 2026-10-05)

**Outcome of A-5b** (the project owner's decision of 2026-10-04, recorded
above).

- VT-208 / VT-216 (`resolveInstanceMethod`) and the type-checked
  `ts.Program` it built are deleted. A method edge is resolved only by the
  receiver authority (`resolveReceiverMethod`): a static call on a class
  bound through the graph's own class authority (the lexical `class`
  binding, or an exact import of a class its own file never reassigns),
  or an instance call on a `const` bound to `new C()` (through `const`
  alias hops). The chain must be plain: no decorator, no constructor
  `return`, every base a class bound the same way, readable member names;
  an instance's field of the name anywhere in the chain, or an accessor or
  static field found before the method, refuses.
- After the walk, every prepared file is scanned once
  (`member-writes.ts`), and a resolved method edge is withdrawn to the new
  unknown reason `receiver_member_written` (`value_uncertainty`,
  non-widening) when any file may write the member: an assignment in any
  form, a dynamic key, `__proto__` (also as a string handed to a call),
  `with`, a reflective mutator read by name (`Object.defineProperty` /
  `defineProperties` / `assign` / `setPrototypeOf`, `Reflect.set` /
  `defineProperty` / `deleteProperty` / `setPrototypeOf`, `util.inherits`,
  `__defineGetter__` / `__defineSetter__`; a `__proto__` key a mutator
  copies), or `Object`, `Reflect` or the global object used as a value --
  or when any file may write the export slot an imported class of the
  chain was read from (`m.Lib = m.Evil`). The call's arguments then get
  the escape row's edges an unknown callee gets; files they discover are
  walked, to a fixed point.
- The constructor `return` shape § 5a could not measure is measured: a
  false `NOT_AFFECTED` on the base, `UNKNOWN` on the branch.
- **What VT-208 resolved beyond the plan's shapes.** It asked the checker
  about ANY receiver: `this`, a parameter, an element access
  (`this[CACHE].get()` in `lru-cache` resolved to `LRUCache#get`). Over
  the 139 corpus cases the graph differential is 3 cases (RWB-03, RWB-09a,
  RWB-09b), 134 resolved edges withdrawn to unknown (74 `this`, 35
  receiver bindings, 20 indexed receivers, 5 `receiver_member_written`);
  the proof and verdict differentials are 0. ADV-021, ADV2-020, ADV2-021,
  ADV2-022 and ADV2-041 keep their resolved edges.

**What A-5b binds.**

- **BL-048** (RWF-074, discovered here): VT-214's object-literal member
  check is the binding's own scope and assignment forms only, so `with`
  and a write from another file reach a false `NOT_AFFECTED`. The fix
  records VT-214's edge and withdraws it with the same whole-graph check.
- **BL-047**: the receiver authority is one of A2's closed set
  ("a receiver bound once to a `new` expression of a class with no member
  writes", and § 4's static members); the branded
  `resolvedEdge(authority, target)` must name it.
- **Lane E**: an imported class is attributed through
  `exportNameToNodeId` / `exportedClassOf`, the export attribution `new C()`
  already trusts. The method edge does not merely inherit it: task A-5b's
  independent audit showed it resolving `m.Lib.run()` where the
  constructor edge for `new m.Lib()` stays unknown, so a written export
  slot (`m.Lib = m.Evil`, a deferred `swap()`, PRM-29's shape) was a new
  false `NOT_AFFECTED`. The method edge therefore also guards the export
  slot by name. What it still inherits from the attribution: a
  whole-module export replaced by `module.exports = …` (refused by the
  attribution today; PRM-29 / PRM-30, E-1), and ES module live-binding
  re-exports (not measured: the harness entry is CommonJS).

#### A-6 additions (task A-6, 2026-10-05)

**Outcome of A-6** (ADR 0008 invariant A2, binder side; § 8's A-6 row).

- `bindCallee` binds a callee only when the binding and the chain's
  leading members name one export and no member is read after it; any
  other chain past a package export is `not_an_import` (PRM-20, all three
  spellings, at every site that resolves a callee through the binder).
  `SymbolBindingResolved.unconsumedChain` is gone, so a resolved binding
  cannot carry a chain; a builtin's member path is still the builtin
  table's key.
- The § 8 row's exception, a single trailing `.call` / `.apply`, is a
  separate result kind (`resolved_function_method`) that only a call site
  accepts, resolved only to a function export (never a class constructor,
  an accessor or a module node) and withdrawn by task A-5b's whole-graph
  member-write check on the method's name. The row read literally is a
  false `NOT_AFFECTED` (RWF-075, fixed here): a written `call` / `apply`,
  and a class's own static `call`.
- `extractRequireBindings` names an element by its key's exact text (an
  identifier, a string literal, a computed string literal); a numeric key
  records no name; an unreadable computed key keeps the base's row, the
  local name, which is not an import name but which the loader classifier
  can only widen on -- dropping it turned two base `UNKNOWN`s into false
  `NOT_AFFECTED`s (task A-6's independent audit, finding 1).

**What A-6 binds.**

- **C-4** (PRM-108's consumer): an unreadable computed key whose local
  name is not a loader-capable member of that builtin -- `{ [k]: f }`,
  `{ [k]: isMainThread }`, `{ ["fo" + "rk"]: f }`, `worker_threads`'s
  `Worker` under any local name -- is still a family-A false
  `NOT_AFFECTED`, however the binding is used (open-soundness-defect record `key.computed-dynamic` in
  `tests/oracle/a6-binder-resolution-authority.*`). C-4 must fail closed on
  a destructured builtin binding whose member it cannot name; the index
  then stops recording the local name for it. RWF-077 (a destructured
  loader called through `.call` / `.apply`, backlog `BL-051`) is the same
  classifier's. The index admits computed string-literal keys and
  `named-bindings.ts` does not (it refuses every computed key, so the call
  graph's attribution fails closed); E-1's lexical computed-key constants
  should align the two.
- **E-4**: `symbol-binder.ts`'s export attribution now covers exactly
  "an exact export with the whole member chain consumed"; a member write
  on a module object (RWF-047) still reaches the attribution itself, as
  before.
- **BL-047**: `resolved_function_method` is one more A2 authority the
  branded `resolvedEdge(authority, target)` must name.
- **`resolvesToUnrelatedConstructor`** (`call-graph.ts`) was written
  against the truncation; it now refuses only a whole-module member naming
  a class export (`lib.Klass()`, `new lib.Klass()`) and fails closed.
  Retiring it is a precision question (backlog `BL-049`).
- **RWF-076** (backlog `BL-050`, found by A-6's audit): a default import's
  first member is read as a named export whatever the target's module
  format; for an ES module target it is a member of the `default` export.

#### V-1 additions (task V-1, 2026-10-06)

**Outcome of V-1** (ADR 0011 predicates 2 and 3, and Amendment V-1's
predicate 5; § 8's V-1 row).

- `phantomNode` is deleted. A Site B target with no real node is
  `unresolvedReason` (`vulnerable_target_unresolved`) once family A's gate
  has had its chance; the evidence names the closure's shortfall
  (unavailable, incomplete with its reasons, or showing the instance
  loaded), and the unknown edges reachable from the entrypoints are still
  reported, as the phantom search reported them.
- A finding with a `packageInstance` takes Site A exactly when the call
  graph holds a file of that instance (`graphFilesOfInstance`, from the F5
  index's single pass). The name-keyed `graphPackageInstances` survives
  for a finding with no instance and for the family-B / Site-B choice.
- **Family C's closure corroboration** (Amendment V-1, the project owner's
  decision of 2026-10-06): family C stands only when the `<module>` node
  of every module the closure loads is reachable from an entrypoint (one
  walk per scan); otherwise `UNKNOWN` (`loaded_module_not_evaluated`,
  `unmodeled_construct`). It closes `RWF-078` -- a module loaded only
  through a re-export declaration (`export *`, or a name imported through
  `export { x } from`) is never evaluated, so family C stood over a target
  it calls -- at Site A and for the application's and other packages'
  modules, and with it the false `NOT_AFFECTED` V-1's instance-keyed
  selection had first extended to a nested fork-named instance.
- The finding's `target` is no longer set for an unattributed Site B
  target, as for Site A's.

**What V-1 binds.**

- **V-2**: of § 8's V-2 row, `verdict.f4-proof-mutation.test.ts`'s "a
  closure truncated on its OWN walk" audit and the `scan-security.test.ts`
  VT-202 truncation test were both phantom-backed: the first now asserts
  no takeover, the second runs over a real, attributed target (a
  side-effect import of the package) and still asserts VT-202's own
  reason; `verdict.negative-proof.test.ts` case 10b no longer pins the
  exclusion: it asserts only that a Site B target is not family C. What
  remains for V-2 is the exclusion itself over a real target (PRM-23):
  `invalidatesCallGraphNegativeProof`, the family-C matrix's
  "closure_incomplete_traversal_truncated_only" control and the F2
  proof-guard test "is unchanged for a present, incomplete closure". A
  truncated closure lists fewer modules, but predicate 5 is still safe
  there by a counting argument (Amendment V-1): it passes only if the
  graph holds at least `maxFiles` files, which marks the graph truncated
  and withdraws family C first. V-2's rule concerns `traversal_truncated`
  over a real target in general.
- **V-3**: the name-keyed lookups left in `verdict.ts` are
  `graphPackageInstances` and those V-3's census names.
  `graphPackageInstances` attributes no target any more, but it is not
  only a label: it chooses between family B and Site B for an instance the
  graph never traversed, and Site B's family A also needs the advisory's
  module, resolved from the project root, to land in the instance. An
  unloaded nested install is therefore family B when a same-named instance
  is in the graph and `UNKNOWN` when none is -- sound both ways, a
  precision difference (task V-1's independent audit, finding 4). Its
  census direction is `refuse-only` in effect (either branch reaches
  `NOT_AFFECTED` only through a complete closure without the instance);
  V-3 should record it so, with this caveat.
- **V-4**: `ClosureCorroboration` should carry predicate 5 (every loaded
  module's top level reached) beside predicate 1; `AttributedTarget` has
  one producer fewer to type.
- **Verdicts V-1 moves toward `NOT_AFFECTED`**: an instance whose
  manifest name differs from the advisory's now takes Site A, and where
  the base answered `UNKNOWN` through the name-keyed route the branch
  answers family C over the instance's real target -- the proof a
  same-named instance already gets -- when, and only when, predicate 5
  holds: oracle-confirmed `NOT_AFFECTED` (`name-mismatch.nested.safe`).
- **Precision**: a package loaded only through `export *` and not called
  is `UNKNOWN` at Site B (ADR 0011 § 5); a scan that loads any module only
  through a re-export declaration -- including the ordinary named-barrel
  pattern -- loses family C (predicate 5). A module-evaluation edge through
  every re-export declaration (§ 7; backlog `BL-052`) wins both back.

#### V-2 additions (task V-2, 2026-10-08)

**Outcome of V-2** (ADR 0011 predicate 1; § 8's V-2 row).

- `callGraphNegativeProofBlockers` reports every reason a present closure
  recorded; `invalidatesCallGraphNegativeProof` and its one exclusion,
  `traversal_truncated`, are deleted. A family-C candidate under a
  truncated closure is `UNKNOWN` (`traversal_truncated`,
  `budget_exceeded`). Family B was already blocked by its own `complete`
  check, which answers first (`package_instance_absence_uncorroborated`).
- PRM-23 was live at `buildFinding` and no longer end to end: lane A's
  call graph withdraws family C on the round-1 hook itself, and V-1's
  predicate 5 covered a truncated closure in production by a counting
  argument (both walks get `scan.ts`'s one `maxFiles`). V-2 makes
  predicate 1 hold without that argument.
- § 8's V-2 row, checked: the `scan-security.test.ts` VT-202 truncation
  test does NOT change reason -- the `graphTruncated` branch answers
  before the closure guard; matrix item 7's new `traversal_truncated`
  entry (family B) is a regression lock, passing on the base.

**What V-2 binds.**

- **V-4**: the guard reads the incompleteness list only, not
  `closure.complete` (V-2's independent audit, finding 2): a closure with
  `complete: false` and an empty list would pass it. No production
  closure has that shape -- the one builder sets `complete` exactly when
  the list is empty -- so the branded `ClosureCorroboration` V-4 adds
  should check both halves of predicate 1, and a mutation test should
  build that shape.

#### V-3 additions (task V-3, 2026-10-08)

**Outcome of V-3** (ADR 0011 predicate 4; § 2's census; § 8's V-3 row).

- `entrypointSourceNodes` roots and witnesses by POSITION only. Every
  candidate arrives from `entrypointRootCandidates` as a source position:
  a function value's own, or the callable a provenance name declares at
  the export's site, resolved lexically (`lexicalDeclarationOf`,
  `named-bindings.ts`; an overload set is its implementation). A
  configured symbol selects the requirements whose canonical export name
  is the symbol; a symbol no binding publishes, a gap that names no
  export, and an unreadable entrypoint file are root incompleteness
  (`entrypoint_root_incomplete`).
- The rules that keep the positions honest, each fail-closed: the
  exported name is no provenance (RWF-011) and resolves nothing; a name
  used by an export written inside a function body resolves nothing (the
  model collects such names by a whole-file, name-keyed walk); a refused
  (reassigned) binding's names neither root nor witness, nor does any
  name the file assigns anywhere; a function value
  witnesses only when evaluated before the export reads it; an ESM default
  export with no recorded local requires a root read off its own
  statement; in symbol mode a CommonJS whole-module binding and a
  withdrawn symbol binding make the symbol's roots incomplete (the
  file-wide widening roots nothing there). The withdrawn widening resolves its identifiers lexically
  from their own reference, and whatever it cannot name a callable for is
  root incompleteness, never nothing (V-3's independent audit, finding 1:
  the first fix had dropped such a root silently).
- PRM-31 (assigned to E-3) is closed by V-3: it is ADR 0011 § 2's `1190`,
  which "this lane removes", and predicate 4 cannot hold while it stands.
  This is part of E-3's row ("name fallback may widen but not witness"):
  under V-3 the name fallback neither witnesses NOR widens. E-3 keeps
  PRM-32 and gains RWF-079.
- The census (`src/testing/name-lookup-census.ts`, found through the
  TypeScript checker): ADR § 2's line list, checked -- `verdict.ts:303`
  is today's `findExportNodeInFile` synthetic fallback (`test-flag-only`);
  `1105`, `1149`, `1190` were the three `entrypointSourceNodes` lookups
  (removed); `module-model.ts:6004` (`mapExportsToFunctions`, PRM-26) and
  each of its callers are `open` (E-1); `6100`
  (`findExportedClassMembers`' member name) is `widen-only`;
  `call-graph.ts:1694` is today's `resolvesToUnrelatedConstructor`
  (`refuse-only`, four call sites); `graphPackageInstancesByName` is
  `refuse-only` with V-1's caveat. ADR § 2's three directions gained a
  fourth, `open` (the finding and the task that removes it), so the census
  can list a known-unsound lookup without calling it sound.
- Measured: twenty-one real-Node cases whose replaced answer was wrong
  (eighteen on the base, three more on earlier rounds of the fix, found by
  the task's independent audits;
  three are `UNKNOWN` now where the base was right -- two `AFFECTED` by a
  root found by spelling, one `NOT_AFFECTED` for a withdrawn symbol -- a
  precision cost), sound on the branch; the 139 corpus cases' graph, proof and verdict differentials all
  0. ADR § 8's note on the two VT-205 unit tests held: they now read a real
  entrypoint file.

**What V-3 binds.**

- **V-4**: register predicates 1-3 and the branded proof-input types under
  `VT-INV-V-corroboration`, which V-3 registered with the census and
  predicate 4's owners.
- **E-1**: the census's `open` entries (PRM-26) are E-1's to remove; the
  census fails until each removed one is deleted from it.
- **E-3**: RWF-079 (a whole-module export of an opaque value emits no root
  requirement; the property export it overwrites still witnesses the
  name), backlog `BL-053`.
- **E-1**: RWF-080 (an ESM destructured export is no export binding),
  backlog `BL-054`.
- **E-4**: RWF-081 (an entrypoint's export written by another module is no
  root and no root gap).

#### V-4 additions (task V-4, 2026-10-09)

**Outcome of V-4** (ADR 0011 § 2's structural gate; § 8's V-4 row). Lane V
is complete.

- Families B and C are built only from branded proof inputs, each
  produced by one function in `src/analysis/verdict.ts` that checks it:
  `corroborateClosure` (`ClosureCorroboration`: predicate 1, both halves
  -- present, roots, `complete`, no recorded reason -- with
  `instanceLoaded` recorded), `corroborateEvaluation`
  (`EvaluatedClosureCorroboration`: predicate 5 beside it, V-1's binding)
  and `attributeTarget` (`AttributedTarget`: predicate 3, a member of the
  analyzed graph). `confirmedAbsentInstanceEvidence` and
  `confirmedUnreachableTargetEvidence` are the only builders of the two
  evidence objects, whose interfaces (`src/domain/evidence.ts`) now carry a
  nominal brand.
- Three layers: an object literal of any of the five types is a compile
  error (`@ts-expect-error` cases checked by `npm run typecheck`); a
  production type assertion to one outside its producer fails the
  Foundation cast census (`src/testing/proof-input-casts.ts`, through the
  TypeScript checker, with a self-test); an input no producer made is
  refused at runtime (a module-private mark) and `buildFinding` answers
  `UNKNOWN`.
- V-2's audit, finding 2, closed: a closure `{ complete: false,
  incompleteness: [] }` left family C standing at `buildFinding` (failing
  first in the F2 and F4 suites); it is now refused with the existing
  `module_load_closure_unavailable` (ADR 0011 § 3: no new token). Not a
  production shape: the builder sets `complete` exactly when the list is
  empty.
- Deviations from ADR 0011 § 2 and § 8, each measured: no
  `UnattributedTarget` type -- V-1 deleted the phantom, so nothing
  produces one, and the family-C constructor accepts only an
  `AttributedTarget`; the proof-input types live in `verdict.ts` beside
  their producers, not in `src/domain/evidence.ts` (`src/domain/` imports
  nothing outside itself, and a `ClosureCorroboration` holds a
  `ModuleLoadClosure`); only the two evidence brands are in
  `evidence.ts`. Family A is unchanged: predicate 1 is stated for B and
  C, and F4's family-A control `incompleteness_recorded_without_clearing_complete`
  certifies family A's own read of the closure.
- Measured: twenty-five mutations of production source, each caught by a
  named test or by `tsc` (listed in the pull request). Through the
  production `buildFinding`, six reach a false `NOT_AFFECTED` or a
  surviving family in the F2/F4 suites or the real-Node oracle (predicate
  1's two halves -- the list half only on a shape no builder produces, a
  builder's own shape keeping `UNKNOWN` with a changed reason -- predicate
  5, predicate 2's instance-keyed site, family B's corroboration and
  constructor together, predicate 4's root incompleteness); one is caught
  there by a changed reason only, the verdict staying `UNKNOWN` (family
  B's per-target read, which the corroboration backs). The rest are layers no production
  input reaches: the roots check, graph membership and the runtime marks
  (unit tests), the brands (`@ts-expect-error`, by `tsc`), a forged
  literal (the cast census), and the three refusals in `checkReachability`
  and `buildFinding`, each of whose WHOLE deletion is a compile error by
  a `satisfies` at its use. Not covered (the re-audit): deleting only
  the `sawUnknown = true` line of `checkReachability`'s per-node
  attribution refusal still compiles and no test reaches it, since no
  producer returns a node outside the graph; under that mutation an
  unattributed node of a second target would be skipped silently. Over
  the 139 corpus cases: graph, proof and verdict differentials all 0.
- The independent audit blocked the first version on two in-scope holes,
  both fixed: the cast census missed mapped wrappers (`Partial<Finding>`,
  `Pick`, `Omit`, `Readonly`) and function types, and a production import
  of `src/testing/`'s fixtures; and predicate 3 was checked only for the
  first unreachable target node, not for every node family C rests on.
  The census now states the routes it cannot see (`any`, a generic cast
  helper, a type predicate or `asserts` function, an overload, `as
  never`, a `@ts-expect-error`); the two evidence objects carry no runtime
  mark, so for them the census and review are the only layers.

**What V-4 binds.**

- **B-6, E-1..E-5, C-1..C-5, and every later task**: a new or moved
  family-B or family-C proof goes through `corroborateClosure` and the
  evidence constructors; the cast census fails on any assertion-based
  other way, and its header lists the routes it cannot see.
- **The independent re-audit certified V-4** with four non-blocking gaps,
  three fixed on the branch (symbol-keyed index signatures; the import
  check's reach stated; this section's wording) and one recorded above
  (the single-line `sawUnknown` deletion).
- **D-01**: the proof inputs are frozen values; `AnalysisProofContext`'s
  own transitive immutability is still D-01's.
- **Family A**, if a later task routes it through the corroboration: the
  F4 control above flips to an invalidating mutation, which reopens a
  certified decision and needs the project owner's.

#### C-1 additions (task C-1, 2026-10-09)

**Outcome of C-1** (ADR 0010 invariant C2; § 8's C-1 row). Lane C has
started.

- Module resolution never reads the project's tsconfig.
  `src/code-intelligence/module-resolver.ts` resolves under one fixed set
  of options, `NodeResolutionOptions` (`module` and `moduleResolution`
  NodeNext, `allowJs`), branded, with one producer
  (`nodeResolutionOptions`). Fixed PRM-33, which was wider than recorded:
  22 of ADR 0010 § 1's 40 tsconfigs named `main` where Node loads the
  `exports` target.
- A tsconfig `baseUrl` / `paths` mapping is consulted only as a
  cross-check: when it gives a different outcome than Node's resolution,
  the specifier is `unresolved_module`, naming both answers. Fixed RWF-083
  (a mapping shadowing an installed package, or naming a sibling installed
  instance), found by this task.
- The noDts resolution runs first, so TypeScript's `types` export
  condition, which Node never matches, no longer names the loaded file
  (RWF-087). A bare specifier governed by an `exports` or `imports` map no
  longer falls back to `main` or a sibling file when only a declaration
  resolves, decided from the package the specifier names, located as Node
  locates it, rather than TypeScript's `packageId` or the manifests above
  the declaration (RWF-088).
- Foundation invariant `VT-INV-C-runtime-resolution`: a census through the
  TypeScript checker of every production call into TypeScript's module
  resolution (each must receive the brand; only the producer may assert
  it), with a scratch-tree self-test; and the 40-row table against real
  `node`. End-to-end: `tests/oracle/c1-runtime-resolution.test.ts`.
- The project owner's decision of 2026-10-09 (strict C2; ADR 0010's
  appended decision record): ADV-023, ADV2-015, ADV2-016 and the fixture
  suite's `typescript-paths` case move `AFFECTED` → `UNKNOWN`, their
  expected verdicts corrected with the reason (real `node` throws on their
  aliased imports). § 5's "0 / 122" had not measured the `paths` clause
  (RWF-084).
- Mutations, each caught by a named test: the runtime path handed the
  tsconfig's options (22 table rows, the census, the cross-check cases);
  the cross-check dropped; the mapping followed when Node cannot resolve;
  the mapping followed always (the sibling-instance borrow test); the
  `exports` guard on the fallback dropped; and the first version's
  resolver itself (four oracle cases and four resolver tests fail on it:
  RWF-087, RWF-088), and the second version's resolver (the two re-audit
  oracle cases fail on it).
- **The independent audit BLOCKED the first version, and its re-audit
  the second**, each on in-scope findings fixed on the branch. First: the `types` condition (finding 1,
  which C-1 had turned from the base's `UNKNOWN` into a false
  `NOT_AFFECTED` for node10 projects) and the fallback guard's bypass
  (finding 2). Then two more bypasses of that guard (a subpath proxy
  manifest with its own `name`; a declaration from a separate `@types`
  package), fixed by locating the named package as Node does. Its notes
  are recorded: the census's brand cannot tell the
  cross-check's options from the runtime ones, and it does not see
  resolution written by hand (its header says so); the PRM-33 table is
  for a `.js` importer; RWF-086 (out of scope, open). The second
  re-audit CERTIFIED the change, with one non-blocking, pre-existing
  finding recorded as RWF-089 (`BL-058`): VT-304's fallback still takes
  a package root's `main` for a subpath specifier. C-1's `exports` /
  `imports` guard is sound for what it covers; the fallback as a whole is
  not.
- Cost: with a tsconfig `baseUrl` / `paths`, every specifier is resolved
  twice (Node's and the cross-check), with no cache and no structural
  operation-count test recording it. The performance gate is green; a
  project with no mapping resolves once, as before.

**What C-1 binds.**

- **C-2..C-5, and every later task**: a resolution that decides which file
  loads goes through `createModuleResolver`; the census fails on any other
  call into TypeScript's module resolution in production, and its header
  lists the routes it cannot see.
- **D-1** (disclosure): RWF-085, `module-sync` -- which file loads depends
  on the Node version and on require(esm), which the analyzer does not
  know (backlog `BL-056`). Same class as PRM-67's runtime flags.
- **BL-055**: ADR 0010's own "nothing here is implemented" status line is
  now false as well (RWF-082's status update).
- **BL-057** (RWF-086): C2 is implemented for the resolution mode, the
  mapping and the `types` condition; TypeScript's extension substitution
  and order inside `node_modules` are still not Node's.
- **BL-058** (RWF-089): VT-304's fallback, `main` for a subpath.

#### B-1 additions (task B-1, 2026-10-10)

**Outcome of B-1** (§ 7's B-1 row; decisions 5 and 10). Lane B has
started.

- `OsvProvider` follows `next_page_token` until none is returned,
  repeating the query with a top-level `page_token` (OSV's documented
  protocol; a page may carry a token and no records). A failed page, a
  repeated token, a token that is not a non-empty string, and more than
  100 pages fail the query as `OsvResponseError` (exit 4). Fixed PRM-65.
- The OSV cache key carries an answer-format marker, so an entry cached
  before B-1 (a first page only, under the same tool version, with no
  expiry) is never served again. Not in § 7's B-1 row: required for PRM-65
  to reach a user with a warm cache. B-3 keeps the cache's location,
  validation and expiry.
- A record the normalizer cannot use (a refused shape, an empty `id`, an
  unreadable `withdrawn`, no `affected` entry for the queried package) is
  an `unreportedCandidates` entry for every exact instance of the name:
  `advisory_applicability`, `undetermined`, reason
  `advisory_record_malformed` (a subtype of `analysis_precondition_unmet`;
  no seventh category), its id named only when one can be read. The
  diagnostic is kept. Under `--cve`, it is filtered out only when its id
  and aliases are both readable and neither names the filter. Fixed AUD-10
  (malformed and unmatched) and AUD-11.
- An advisory withdrawn by the scan's start is not analyzed: a
  `withdrawn` entry per exact instance, reason `advisory_withdrawn`, no
  category. A `withdrawn` time in the future is not a withdrawal yet; a
  live copy of an id displaces a withdrawn copy. Output schema `0.7`; the
  schema refuses a `withdrawn` entry with a category, another reason, or
  no advisory. The HTML report labels it "Withdrawn by the provider".
  Fixed AUD-14.
- Foundation invariant `VT-INV-B-provider-completeness` (owners
  `src/cli/scan.b1-provider-completeness.test.ts`,
  `src/vulnerabilities/osv-provider.pagination.test.ts`).
- Twenty mutations, each caught by a named test: first page only; the
  cap returning a short list; the repeated-token check; an empty token
  accepted; `page_token` not sent; a later page's failure returning the
  pages before it; an empty id accepted; `withdrawn` not read;
  `withdrawn` honoured whatever its time; the withdrawn branch removed;
  unusable records not accounted; unusable records not de-duplicated
  across version queries; the `null`-record guard removed; two sibling
  borrows (every unusable entry, and every withdrawn entry, naming the
  first instance); `--cve` dropping an unreadable record; the first copy
  winning when withdrawn; the cache marker removed; the schema's
  `withdrawn` rule relaxed; the HTML label.
- **The independent audit CERTIFIED the change**, with non-blocking
  findings, fixed on the branch: a `null` record (reachable from a
  corrupted cache file, whose shape is unchecked until B-3) crashed the
  new identity reader (finding 1); untested later-page failure and
  cross-query de-duplication (2a, 2b); the invariant's "exactly one
  accounted place" overclaimed (a usable and an unusable copy of one id
  give both a finding and an entry; finding 4). Recorded, not changed:
  a later live copy of an id never displaces the first live copy (2c),
  and two live copies with different contents collapse to the first in
  sorted version order (note 5), both pre-existing class-C behaviour no
  test can pin without pinning a possibly wrong answer; the timestamp
  refine is unreachable under zod 3.25 (2d, kept as a guard); a
  `withdrawn` written with an offset (`+00:00`) instead of OSV's
  required `Z` makes the record unusable rather than live (note 3, for
  the project owner); a withdrawn advisory outside an instance's range is
  reported `withdrawn`, not `not_applicable` (note 6).
- Over the 139 corpus cases: verdict differential 0, proof 0, graph 0,
  unreported candidates +0/−0 (no recorded OSV answer is paginated,
  withdrawn or unusable, so the corpora do not reach this change; the
  task's own tests do). Validation equals the D-09 baseline.

**What B-1 binds.**

- **B-2..B-6, and every later task**: an advisory the provider returns
  ends in a finding or an `unreportedCandidates` entry per exact
  instance. A new way for the scan to skip one adds an entry, never only
  a diagnostic.
- **B-3**: the cache stores whole paginated answers; a change to what a
  provider answer contains changes `CACHED_ANSWER_FORMAT`
  (`src/cache/osv-cache.ts`).
- **B-5**: decision 3's exit codes count `advisory_record_malformed` as
  an undetermined candidate (its disposition is `undetermined`). Whether a
  `withdrawn` entry counts as "decided", like `not_applicable`, is for B-5
  to settle against decision 3's wording ("a determinate not-applicable
  disposition"); B-1 does not decide it.
- **BL-059** (RWF-090): the schema enforces "category if and only if
  undetermined" for `withdrawn` only.

#### B-2 additions (task B-2, 2026-10-10)

**Outcome of B-2** (§ 7's B-2 row). Version applicability follows SemVer
and OSV's own evaluation.

- The installed version and every bound are parsed by `parseSemVer`
  (`src/vulnerabilities/version-matching.ts`), never `semver.coerce`, and
  compared by SemVer precedence, prereleases included, build metadata
  ignored. A value that is not a SemVer version, or a numeric prerelease
  identifier at or above `Number.MAX_SAFE_INTEGER` (node-semver compares it
  inexactly; audit finding 1), is `indeterminate`. Fixed AUD-05.
- `VersionRange` is `VersionInterval | UninterpretableVersionRange`
  (`src/domain/vulnerability.ts`). The normalizer keeps `ranges[].type`;
  only a `SEMVER` range is ordered. A GIT, ECOSYSTEM, other or untyped
  range, an `affected` entry with no ranges and no versions, a SEMVER range
  with no `introduced`, a bound that is not a SemVer version, two event
  kinds at one version, and an event naming two kinds (RWF-092, audit
  finding 2) are uninterpretable. `matchVersion` answers `indeterminate`
  for an empty list and for an uninterpretable range no other range or
  listed version covers: an `UNKNOWN` finding with
  `advisory_version_applicability_indeterminate`, never a `not_applicable`
  entry. No output schema change, no new reason. Fixed AUD-09.
- A SEMVER range's events are sorted and walked as OSV's `IncludedInRanges`
  specifies, into disjoint intervals; reading them in array order was a
  silent drop. Found and fixed RWF-091. A `limit` event is still not
  applied (it only narrows a range; ignoring it never hides a finding).
- Foundation invariant `VT-INV-B-version-applicability` (owners
  `src/vulnerabilities/version-applicability.b2.test.ts`,
  `src/cli/scan.b2-version-applicability.test.ts`): a sweep against a
  literal transcription of OSV's evaluation pseudo-code (3000 generated,
  shuffled SEMVER entries x 18 installed versions, exact agreement), and an
  AST census that no production file under `src/` names `coerce`.
- Sixteen mutations, each caught by a named test: coercion restored; an
  uninterpretable range excluding; an empty list `not_affected`; an
  undecided range outvoted; events unsorted; every range type read as
  SEMVER; an empty entry unmarked; a no-`introduced` range dropped; a
  cross-kind tie accepted; a later `introduced` reopening a range;
  `last_affected` exclusive; an unparseable bound skipped; a sibling borrow
  (every instance evaluated with the first instance's version); the
  `versions` list dropped; the unsafe-identifier guard removed; a two-kind
  event accepted.
- **The independent audit CERTIFIED the change** (a 200,000-record fuzz
  against its own transcription of OSV's pseudo-code, `limit` included: 0
  unsafe disagreements), with two non-blocking findings fixed on the branch
  (findings 1 and 2 above) and re-audited `CERTIFIED`. Recorded, not
  changed: OSV's `IncludedInVersions` compares by equality, so an
  unparseable listed version or a GIT range next to a range that excludes
  the version is `indeterminate` here where OSV would say "not affected"
  (deliberate, fail-closed); `semver.parse` tolerates a leading `v` and
  surrounding whitespace, consistently on both sides.
- Over the 139 corpus cases: verdict differential 0, proof 0, graph 0,
  unreported candidates +0/−0 (no corpus instance is a prerelease; the
  snapshot's ECOSYSTEM ranges are all for Maven and RubyGems entries).
  Validation equals the D-09 baseline.

**What B-2 binds.**

- **B-3..B-6, and every later task**: applicability is decided only by
  `matchVersion` over the normalizer's ranges; a new range shape the
  normalizer cannot order is an `UninterpretableVersionRange`, never an
  empty or narrower interval. The OSV cache stores raw answers, so B-2
  reaches a warm cache without a `CACHED_ANSWER_FORMAT` change; a change
  to the stored answer's shape still needs one (B-1).
- **B-5**: an `indeterminate` applicability is an `UNKNOWN` finding, so
  decision 3's exit codes count it as undecided.

#### B-3 additions (task B-3, 2026-10-10)

**Outcome of B-3** (§ 7's B-3 row, decision 8). The OSV cache is the
user's, validated, expiring, and never fatal.

- The default cache directory is the user cache directory
  (`src/cache/cache-location.ts`): `XDG_CACHE_HOME` when absolute, else
  `LOCALAPPDATA` on Windows, else `~/.cache`, then `vulntrace/osv`; no
  absolute base means no cache. A directory that is, or resolves through a
  symlink to, a place inside the scanned project (the project root
  included) is refused, and the scan runs uncached with a `cache`
  diagnostic; a path through a dangling link, or a root that cannot be
  resolved, is refused too. Validation alone could not close AUD-07 (a
  planted `[]` is a well-formed answer); the location does. The scanned
  project's config cannot set the location. Fixed AUD-07.
- An entry is a strict envelope `{format, key, fetchedAt, vulns}`, `vulns`
  validated with the provider's own schema (`OsvVulnerabilityListSchema`,
  exported from `osv-provider.ts`). An entry under another key, stamped in
  the future, or as old as the TTL or older is a miss.
  `CACHED_ANSWER_FORMAT` changed with the stored shape, so no pre-B-3 entry
  is ever served. Fixed AUD-06.
- `vulnerabilities.cache.ttlHours`: default **and maximum** 24. The
  scanned project's config may shorten the expiry, never lengthen it; a
  value above 24 is an invalid configuration (exit 2), not clamped. The
  store refuses a TTL that is not a finite, positive number of
  milliseconds (audit finding 1: `ttlHours: 1e308` was finite in hours and
  `Infinity` in milliseconds, so an entry never expired).
- A failed write never fails the query: `createCachingProvider` returns
  the provider's answer and reports the failure; the scan counts failures
  and reports them once as a `cache` diagnostic, never exit 4. Writes are
  atomic (temporary file, then rename). The cache directory and the error
  naming it are on stderr only, never in the JSON output (audit finding
  3). Fixed PRM-35.
- Foundation invariant `VT-INV-B-cache-authority` (owners
  `src/cache/osv-cache.test.ts`, `src/cache/cache-location.test.ts`,
  `src/cli/scan.b3-osv-cache.test.ts`). Ten mutations, each caught by a
  named test: expiry removed; a future stamp served; schema validation
  removed; the key check removed; a write failure propagated; the
  containment check removed; symlinks not resolved; the default moved back
  into the project; a relative `XDG_CACHE_HOME` accepted; the configured
  TTL ignored.
- No test run writes to the user cache directory (measured with a
  sentinel `XDG_CACHE_HOME`): `scan.integration.test.ts`, the one test that
  wrote into the default cache, now scans uncached.
- **The independent audit BLOCKED on finding 1** (above), fixed on the
  branch with findings 3 and 4 (the example config's Windows location),
  and re-audited **CERTIFIED**. Recorded, not changed (finding 2): on a
  case-insensitive mount under Linux, `realpath` does not fold case, so a
  cache directory the user points into the project with different case is
  not recognised as inside it; only the user's own environment can do
  this. Also noted: the output says how many answers came from the cache,
  not which or how old (a disclosure question for B-5 / D-1).
- Over the 139 corpus cases: verdict differential 0, proof 0, graph 0,
  unreported candidates +0/−0 (every corpus suite scans uncached).
  Validation equals the D-09 baseline.

**What B-3 binds.**

- **B-4..B-6, and every later task**: a cached answer is served only by
  `FileOsvCacheStore.get`, from a directory `isCacheDirInsideProject`
  accepted; nothing reads provider answers from the scanned project. A
  change to the stored entry's shape changes `CACHED_ANSWER_FORMAT`.
- **B-5**: a cache diagnostic is not a provider failure and never changes
  the exit code.

#### B-4 additions (task B-4, 2026-10-10)

**Outcome of B-4** (§ 7's B-4 row, decisions 4 and 9). Every package the
project installs reaches the report, as an instance or as an identity
entry naming its exact instance.

- `buildDependencyInventory` (`src/dependencies/dependency-graph.ts`)
  drops no entry that is a package. A versionless entry is a node with no
  version (`DependencyNode.version` is optional); a versionless
  `link: true` entry stays out (its target is the package). A nameless
  entry outside `node_modules` is named by its own manifest, else by the
  one name its linking `node_modules/<name>` entries agree on; otherwise
  it is an `undetermined` entry, reason `lockfile_entry_unidentified`.
  Measured with npm 10.9.0 (six shapes): npm omits `name` when the
  manifest has none, or when the manifest's name, the directory's name
  and the link name all agree. Fixed PRM-34 and RWF-093 (found by B-4: a named, versionless
  `file:` entry was dropped; F1-B had pinned the same drop as a
  limitation).
- Decision 4: `advisoryQueryVersions` adds one query without a version
  for a name with any instance whose version is not established, for
  whatever reason (none declared, a contradiction, an untrusted manifest),
  and every advisory returned is evaluated against every instance of the
  name: `UNKNOWN` (`advisory_version_applicability_indeterminate`) for the
  versionless one. F1-B § 22 and P1-A5 G/H had chosen "no query" for a
  contradicted version; that choice is replaced by decision 4 (flagged for
  the project owner in the pull request). Fixed PRM-64.
- Workspace discovery reads a manifest through the registry's reader and
  records one that exists and cannot be read; the scan reports one nothing
  else names as `installed_manifest_untrusted`. Fixed PRM-66.
- Decision 9: `enumerateInstalledPackages`
  (`src/dependencies/installed-tree.ts`) walks npm's layout under the
  project's and each workspace member's `node_modules`, recursively,
  links followed by realpath, not descending out of the project; the
  scan adds every instance the module-load closure loads. Each canonical
  root the registry, an unidentified lock entry or an unreadable workspace
  manifest does not account for is an entry, reason
  `installed_package_not_in_lockfile`. Not an instance. The walk is bounded
  by 50,000 operations (every listing and every entry examined); a
  truncated walk is `installed_tree_enumeration_truncated`
  (`budget_exceeded`) and a path it cannot read, other than an absent
  one, `installed_tree_unreadable` (`analysis_precondition_unmet`), both on
  stage `workspace_discovery`. Fixed AUD-08.
- Four reason subtypes, no new category, no schema version change (both
  schema enums; as A-3b and B-1 did).
- Foundation invariant `VT-INV-B-inventory-identity` (owners
  `src/dependencies/dependency-graph.test.ts`,
  `src/dependencies/installed-tree.test.ts`,
  `src/dependencies/package-instances.test.ts`,
  `src/cli/scan.b4-inventory-identity.test.ts`). Nineteen mutations, each
  caught by a named test, the `PackageInstance` one a sibling borrow (an
  unloaded nested twin with the listed copy's own name and version).
- **The independent audit CERTIFIED the change** with four non-blocking
  findings: a read error read as an empty directory (fixed:
  `installed_tree_unreadable`), the walk's comment overclaiming what Node
  loads (corrected), the npm naming rule stated falsely (corrected), and a
  nameless local package named by its linking alias (recorded below). The
  walk's cost was bounded by listings only; every examined entry now
  counts.
- **Known limitations.** A nameless `file:` package whose manifest has no
  name is named, queried and selected by the name it is linked under, as
  npm itself does; an advisory for a registry package of that name then
  selects it (a possible extra finding, never a hidden one). The walk
  skips a dot-named directory and an `@`-named directory that is itself a
  package, which npm never writes and Node can load; one the closure
  loads is still reported.
- Over the 139 corpus cases: verdict differential 0, proof 0, graph 0,
  unreported candidates +0/−0 (no corpus case has a versionless or
  nameless lock entry, an unlisted installed package or a broken
  manifest; B-4's behaviour is measured by its own tests). Validation
  equals the D-09 baseline.

**What B-4 binds.**

- **B-5, B-6, and every later task**: an instance with no established
  version is queried without one and evaluated as indeterminate; nothing
  installed is dropped silently, and a gap is an identity entry naming its
  exact instance. Decision 3's exit codes count every B-4 entry as
  undecided. The `installed_version_unavailable` detail names a `--cve`
  filter when one is set; PRM-36's condition (the unfiltered set) is still
  B-5's.

## 6. Decisions for the user

Each is a policy choice the design needs. Each has a recommendation. None
of them blocks the invariants themselves, whose measured cost is zero with
the recommended options.

| # | Decision | Options | Recommendation | Cost of the recommendation |
| --- | --- | --- | --- | --- |
| 1 | A1: non-invoking builtin allowlist | (a) allowlist, each entry proven non-invoking by a real-Node test; (b) strict: every function-valued argument to any unmodeled callee is possibly invoked | **(a)** | maintaining the list; measured: without it RWB-07 loses a correct `NOT_AFFECTED` |
| 2 | A1/A2: how an over-approximated invocation is represented | (a) a new `possible` edge kind: traversed, never part of an `AFFECTED` path; (b) an `unknown` edge that names its potential target; (c) a resolved edge | **(a)**; (b) is the fallback if a domain change is unwelcome (same measured cost); (c) is rejected: it manufactures `AFFECTED` from a path the program might not take | a domain type change and a reachability semantics change (A-2) |
| 3 | AUD-12: exit code of a scan whose findings include `UNKNOWN` | (a) keep 0; (b) a distinct non-zero code for "no AFFECTED, some UNKNOWN"; (c) a `--fail-on-unknown` flag | **(b)** | CI pipelines that treat any non-zero as failure start failing on UNKNOWN; this is the honest reading of "UNKNOWN is first-class" |
| 4 | PRM-64: versionless instances | (a) query OSV without a version, and evaluate every advisory for the name against the instance (all `UNKNOWN` with `installed_version_unavailable`); (b) keep sibling queries and record an `unreportedCandidates` entry saying only sibling-version advisories were evaluated | **(a)** | more `UNKNOWN` findings for versionless workspace members; one extra query per versionless name |
| 5 | PRM-65: OSV pagination | (a) follow `page_token` until exhausted, with a page cap that fails as a provider failure; (b) treat any `next_page_token` as a provider failure | **(a)** | a few more requests for large advisory sets |
| 6 | C-5: `AFFECTED` when a reachable loader mutation could redirect the `require` on the path | (a) the static resolution is not authoritative; `UNKNOWN`; (b) keep `AFFECTED` | **(a)** | `AFFECTED → UNKNOWN` only in programs that mutate the module loader (none in either corpus) |
| 7 | C2: tsconfig `paths`/`baseUrl` | (a) Node resolution; a divergence with `paths` makes the closure incomplete for that specifier; (b) honor `paths` (right for ts-node/tsx/bundler users, wrong for plain Node); (c) ignore `paths` | **(a)** | `UNKNOWN` for projects that depend on `paths` at runtime through a loader VulnTrace does not see |
| 8 | AUD-06/07: the OSV cache | (a) move it out of the scanned tree (for example `$XDG_CACHE_HOME`), validate every entry with the provider schema, and expire it (default 24 h, configurable); (b) keep it in the tree, validate only | **(a)** | a changed default cache location; a documented TTL |
| 9 | AUD-08: lockfile-only inventory | (a) cross-check the installed tree against the lockfile and record on-disk packages the lockfile does not list as `unreportedCandidates`; (b) disclose the limitation only | **(a)** | a filesystem walk of `node_modules` per scan (bounded by `maxFiles`) |
| 10 | AUD-14: withdrawn advisories | (a) a new `unreportedCandidates` disposition `withdrawn` (schema change); (b) record as `undetermined` with a reason; (c) drop with a diagnostic | **(a)** | a schema version bump |
| 11 | PRM-67: runtime flags | (a) disclose `--import`, `--experimental-loader`, `--conditions` and `NODE_OPTIONS` equivalents in `SUPPORTED_MODEL_EXCLUSIONS` now; (b) also model `--conditions` through configuration | **(a)** now, **(b)** as later coverage work | none for (a) |
| 12 | The lane ordering in § 5 | as proposed, or another split | **as proposed** | — |

### 6.1 Decisions, as decided by the project owner (2026-09-26)

Recorded by task
[`remediation-reconciliation`](tasks/remediation-reconciliation.md). Each
decision below is final; the table above is kept as the design's original
proposal and recommendation, for the record.

1. **Builtin allowlist — accepted, with a stricter entry rule than § 4's
   original text states.** An allowlist entry (ADR 0008 § 4) is admitted
   only if it runs no user code through **any** path on its arguments: it
   does not call, coerce (`valueOf` / `toString` / `Symbol.toPrimitive`),
   read properties or getters of, serialize (`toJSON`), inspect
   (`util.inspect.custom`), or trigger Proxy traps on its arguments — OR
   ADR 0008 § 2's protocol-member rule provably covers the path in
   question. Every entry's real-Node test must pass function, getter,
   `valueOf`, `toString`, `Symbol.toPrimitive`, `toJSON`,
   `util.inspect.custom` and Proxy arguments and confirm none of them runs
   user code. This decision does not change ADR 0008's protocol-member
   rule (§ 2) or its non-invoking-allowlist text (§ 4); it adds an
   admission test on top of them. **ADR 0008's protocol-member rule,
   checked path by path against the seven required test paths** (full
   reasoning in ADR 0008's appended decision record):

   | Path | Covered by § 2's protocol-member enumeration? |
   | --- | --- |
   | function (direct call) | Not applicable — this is the base non-invoking requirement itself, not a coercion/inspection path |
   | getter (a plain, non-protocol-named accessor) | **Not covered.** § 2 enumerates only named members/symbols; a generic getter under an arbitrary name is outside that list |
   | `valueOf` | **Covered** — named explicitly in § 2; § 4 states the protocol-member rule covers the coercion these builtins do |
   | `toString` | **Covered** — named explicitly |
   | `Symbol.toPrimitive` | **Covered** — named explicitly |
   | `toJSON` | **Covered** — named explicitly |
   | `util.inspect.custom` | **Not covered.** Absent from both § 2's enumeration and § 4's exception list |
   | Proxy traps | **Partially covered.** A trap firing through access to one of the six named protocol members is covered transitively; a trap firing on an arbitrary property, or `has`/`ownKeys`/`getOwnPropertyDescriptor` during enumeration, is not |

   A decision record is appended to ADR 0008 recording this exactly; ADR
   0008's body is unchanged.

2. **"Possible" edge kind — accepted, as designed (§ 1 option (a)).** Task
   **A-1** (ADR 0008 § 8) gains an acceptance criterion: it must also
   amend `docs/SOUNDNESS-CONTRACT.md` and the invariant map to state that
   an `AFFECTED` path consists of resolved edges only; a `possible` edge
   counts as reachable for family-C completeness (the code behind it is
   searched, and its own unknown edges count) but can never be part of an
   `AFFECTED` path; a target reached only through `possible` edges is
   `UNKNOWN`. `docs/SOUNDNESS-CONTRACT.md` itself is not amended by this
   task — that is A-1's work, once implemented. A decision record is
   appended to ADR 0008 recording this acceptance criterion; ADR 0008's
   § 8 table is not rewritten.

3. **AUD-12 exit codes — decided differently from the design's
   recommendation.** Exit 0 only when no candidate is `AFFECTED` and every
   candidate is decided (`NOT_AFFECTED`, or a determinate not-applicable
   disposition). Exit 1 when at least one candidate is `AFFECTED`. A new,
   distinct exit code when nothing is `AFFECTED` but at least one
   candidate is undecided (any `UNKNOWN` finding, or any unreported
   candidate whose disposition is indeterminate). A command-line flag
   restores the lenient behaviour (exit 0 whenever nothing is `AFFECTED`).
   The JSON output always carries a summary of counts by verdict and
   disposition. Existing error exit codes keep their meaning. Task **B-5**
   (§ 7 below), which owns `AUD-12`, is updated with this exact scheme in
   place of the original recommendation's "(b) a distinct non-zero code
   for no AFFECTED, some UNKNOWN".
4. **PRM-64 versionless instances — accepted as recommended.** Query OSV
   without a version for a versionless instance, and evaluate every
   advisory for the name against it (all `UNKNOWN` with
   `installed_version_unavailable`). Already the text task **B-4** (§ 7)
   describes; no further edit needed.
5. **PRM-65 OSV pagination — accepted as recommended.** Follow
   `page_token` until exhausted, with a page cap that fails as a provider
   error. Already the text task **B-1** (§ 7) describes; no further edit
   needed.
6. **C-5 `AFFECTED` under a reachable loader mutation — accepted as
   recommended.** A reachable `loader_hook_mutation` on the path makes a
   static `require` resolution non-authoritative for `AFFECTED`; the
   finding becomes `UNKNOWN`. This is exactly ADR 0010 § 7's own proposal
   for task C-5; no ADR text changes, and no decision record is appended
   to ADR 0010 for this item.
7. **C2 tsconfig `paths`/`baseUrl` — accepted as recommended.** Node
   resolution is authoritative; a divergence with a tsconfig `paths`
   mapping makes the closure incomplete for that specifier. This is
   exactly ADR 0010 § 1's C2 invariant and § 8's task C-1; no ADR text
   changes, and no decision record is appended to ADR 0010 for this item.
8. **AUD-06/07 OSV cache — accepted as recommended.** Moved out of the
   scanned tree (for example `$XDG_CACHE_HOME`), every entry validated
   against the provider schema, default 24-hour expiry, configurable.
   Already the text task **B-3** (§ 7) describes; no further edit needed.
9. **AUD-08 lockfile-only inventory — accepted as recommended.**
   Cross-check the installed tree against the lockfile; an on-disk
   package the lockfile does not list becomes an `unreportedCandidates`
   entry. Already the text task **B-4** (§ 7) describes; no further edit
   needed.
10. **AUD-14 withdrawn advisories — accepted as recommended.** A new
    `unreportedCandidates` disposition `withdrawn`, with an output schema
    version bump. Already the text task **B-1** (§ 7) describes; no
    further edit needed.
11. **PRM-67 runtime flags — accepted as recommended.** Disclose
    `--import`, `--experimental-loader`, `--conditions` and their
    `NODE_OPTIONS` equivalents in `SUPPORTED_MODEL_EXCLUSIONS` now; model
    `--conditions` through configuration as later coverage work, not part
    of this remediation. Already the text task **D-1** (§ 7) describes; no
    further edit needed.
12. **Schedule — changed.** The project owner runs one task at a time.
    § 5's two-slot schedule is superseded by § 5a's single sequential
    schedule, below. § 5's text and reasoning are kept, dated superseded,
    because the new schedule reuses its prevalence, criticality and
    file-overlap reasoning to produce one order.

## 7. Lanes B and D: point-fix tasks

Each task is one branch, with its own task file. Acceptance for each is
"the named reproduction flips, with a failing-first test" (AGENTS.md
section G).

| Task | Findings | Files | What changes |
| --- | --- | --- | --- |
| **B-1** provider completeness | PRM-65, AUD-10, AUD-11, AUD-14 | `src/vulnerabilities/osv-provider.ts`, `osv-normalizer.ts`, `src/cli/scan.ts` | follow `page_token` (decision 5); a malformed or id-less record becomes an `unreportedCandidates` entry (`undetermined`, `analysis_precondition_unmet`) instead of a diagnostic or a failed report; honour `withdrawn` (decision 10) |
| **B-2** version applicability | AUD-05, AUD-09 | `src/vulnerabilities/version-matching.ts`, `osv-normalizer.ts` | compare SEMVER ranges with prerelease semantics, never `semver.coerce`; a non-SEMVER range type (GIT, ECOSYSTEM) or an `affected` entry with no ranges and no versions is `indeterminate`, never `not_applicable` |
| **B-3** cache | AUD-06, AUD-07, PRM-35 | `src/cache/osv-cache.ts`, `src/cli/scan.ts` | decision 8; a cache write failure is a diagnostic, never exit 4 |
| **B-4** inventory and identity drops | PRM-34, PRM-64, PRM-66, AUD-08 | `src/dependencies/dependency-graph.ts`, `package-lock.ts`, `package-instances.ts`, `workspaces.ts`, `src/cli/scan.ts` | a nameless non-`node_modules` lock entry takes its name from the linking `node_modules/<name>` entry or its own manifest, and otherwise becomes an identity `unreportedCandidates` entry instead of `continue`; decision 4; a malformed workspace manifest is recorded even when versionless; decision 9 |
| **B-5** CLI and output | AUD-12, PRM-36, PRM-110, PRM-111 | `src/cli/run.ts`, `scan.ts`, `html-report.ts` | **decision 3, decided 2026-09-26 (§ 6.1 item 3), in place of the original recommendation:** exit 0 only when nothing is `AFFECTED` and every candidate is decided; exit 1 when at least one candidate is `AFFECTED`; a new, distinct exit code when nothing is `AFFECTED` but at least one candidate is undecided (any `UNKNOWN` finding, or an indeterminate unreported candidate); a flag restores the lenient exit-0-whenever-nothing-AFFECTED behaviour; the JSON output always carries a summary of counts by verdict and disposition; existing error exit codes keep their meaning; reject an empty `--cve`, and report when a filter matched nothing; compute the "no advisory discovered" condition from the unfiltered set; the HTML summary falls back to the first `unknownReasons` entry |
| **B-6** rule/package mismatch reason | AUD-15 | `src/analysis/verdict.ts` (after V) | the reason names the mismatch, not a family-B-shaped absence |
| **D-1** disclosure | PRM-67, AUD-16 | `src/domain/evidence.ts`, `README.md`, `src/cli/html-report.ts` (after B-5) | decision 11; correct the README and HTML sentences the audit identified (for example NOT_AFFECTED rendered as "advisory does not apply", and "no installed dependency matched"). The HTML family C sentence ("the resolved, attributed vulnerable target has no call path…") needs no text change: it is false today only for a phantom target, and V-1 removes that case |

## 8. What this plan does not decide

- It does not register the findings in `tests/validation/FINDINGS.md` or
  `docs/OPEN-DEBTS.md`; a later task does, and should cite this plan.
- It does not change the proof families or add a fourth one
  (SOUNDNESS-CONTRACT § 6). Lane V restores family C's own "resolved,
  attributed target" wording; it does not redefine it.
- It does not schedule RWF-002 (OPEN-DEBTS D-06). Each ADR states how its
  new `UNKNOWN`s interact with target-relevant completeness.

## 9. How the numbers were measured

Scratch clones of `62b52b9`, one per lane, outside the repository. Each
received a crude patch implementing its lane's invariant (the prototypes
are described in each ADR's § 5, and are deliberately cruder than the
designs). For each clone and for an unmodified baseline clone:

1. `npx vitest run --config vitest.adversarial.config.ts` and
   `npx vitest run --config vitest.validation.config.ts` (live OSV, the
   network the suite always uses). The runners' own
   `ID EXPECTED ACTUAL RESULT` tables were diffed case by case.
2. The validation runner, in the scratch clone only, appended every finding
   (case, advisory, package instance, verdict) to a JSONL file. The dumps
   were diffed by (case, advisory, instance). This catches movement in
   findings the case table does not select.
3. Every targeted reproduction from the two sweeps was re-run through the
   real `runScanCommand` against the prototype, with its loud-fixture
   assertion and both controls.
4. Wall time: per-case times from the validation runner, with each suite run
   alone (an earlier concurrent run inflated lane C's times and cut RWB-09a
   off at the runner's 30 s timeout; the re-run alone and without the limit
   is the one reported).

The first implementation task of each lane repeats steps 1–3 on the real
implementation and reports any movement case by case.

**Added by task `BL-029` (2026-09-28).** Steps 1 and 2 are now one
committed tool, `node scripts/differential.mjs` (usage:
[`WORKFLOW.md`](WORKFLOW.md) § 3). It diffs the runners' case tables and
every finding by case, advisory and instance as above, and adds the call
graph, so a lane task runs it instead of patching a scratch clone. Step 3
(the targeted reproductions) is unchanged. The prototype numbers above
were measured by the method as written, not by the tool.

## 10. Where task order and status are tracked (added 2026-09-27)

Added by task
[`task-0-workflow-bootstrap`](tasks/task-0-workflow-bootstrap.md). From
this date, the **order** and **status** of every task in this plan are
tracked in [`docs/tasks/BACKLOG.md`](tasks/BACKLOG.md), together with the
tasks that are not part of the remediation. § 5a's order is carried into
the backlog unchanged; a later change of order is made there, with its
reason. This plan stays authoritative for each task's **specification**
(§ 5a, § 7, the "A-0 additions to lane-A acceptance", and the ADRs' § 8
tables), for the finding matrix (§ 2) and for the project owner's
decisions (§ 6.1). The status lines inside § 5a (for example "Status:
**done**") are kept as a record and are not updated further.
