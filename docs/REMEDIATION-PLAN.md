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
