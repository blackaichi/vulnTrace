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
