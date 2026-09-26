# VulnTrace Soundness Contract

**Authoritative.** What each verdict means, what a `NOT_AFFECTED` must
carry to be allowed to exist, and what the proof is relative to. Where an
older document disagrees about any of this, this file is current.

Companion documents: [`ARCHITECTURE.md`](ARCHITECTURE.md) (identity,
uncertainty, caches, workflows), [`SCORECARD.md`](SCORECARD.md) (measured
state), [`OPEN-DEBTS.md`](OPEN-DEBTS.md) (what is knowingly unfinished).

> **Implementation status.** This contract is unchanged by this note.
> The current implementation **violates it in recorded ways**: three
> read-only audits reproduced dozens of false `NOT_AFFECTED` verdicts
> and silently dropped findings against real Node on `main`, none of
> them corpus differentials. See [`OPEN-DEBTS.md`](OPEN-DEBTS.md) D-17
> for the count by failure class and
> [`../tests/validation/FINDINGS.md`](../tests/validation/FINDINGS.md)
> for the full, reproduced register.

---

## 1. The verdict contract

There are exactly **three** verdicts. The vocabulary is closed, enforced by
the domain type (`src/domain/verdict.ts`) and, at the output boundary, by
`schemas/result.schema.json`.

### `AFFECTED`

Requires **both**:

- an **authoritative target** — the advisory's symbol resolved to a concrete
  node inside the exact `PackageInstance` the finding is about, through the
  package's real public entry (see [`ARCHITECTURE.md` § 7](ARCHITECTURE.md));
- **concrete reachable evidence** — an actual call path from a configured
  entrypoint to that node, reported as the path itself.

An `AFFECTED` carries no `unknownReasons`. Attaching uncertainty to a
finding that has a reproduced path would invite "how sure are we about this
`AFFECTED`?", a question this analyzer does not answer.

### `NOT_AFFECTED`

`NOT_AFFECTED` is a **positive claim**, not the absence of a positive one.
It requires **positive analytical proof from exactly one approved proof
family** — A, B or C, defined in § 3.

"The analyzer found nothing" is not a proof. An unproven `NOT_AFFECTED` is
exactly the false negative this project exists not to produce, and the
schema rejects one.

### `UNKNOWN`

Produced when the analytical preconditions a verdict requires were not
established. It is a **first-class result**
([ADR-0002](adr/0002-unknown-first-class.md)), not an error, not a failure
mode, and not a soft `NOT_AFFECTED`.

Every `UNKNOWN` carries structured, categorised reasons from the closed
vocabulary in [`ARCHITECTURE.md` § 6.1](ARCHITECTURE.md), so that "what was
missing" is machine-readable rather than prose.

### What is deliberately absent

There is **no heuristic "probably safe"**, no confidence score that can
stand in for a proof, and no fourth verdict. A result that cannot be
proved is `UNKNOWN`, and the cost of that is precision — which is third in
the priority order, behind soundness and explainability
([`ARCHITECTURE.md` § 2](ARCHITECTURE.md)).

## 2. `ModuleLoadClosure`

The closure answers a question the call graph does not: **what could be
loaded** from the configured entrypoints, as opposed to what is called.

```ts
interface ModuleLoadClosure {
  rootFiles: readonly string[];               // the entrypoint FILES it is rooted at
  loadedFiles: readonly string[];
  loadedPackageInstances: readonly PackageInstanceId[];
  complete: boolean;
  incompleteness: readonly ClosureIncompleteness[];
}
```

Its semantics, precisely:

- **It is independent of the `CallGraph`.** Neither is derived from the
  other. "The call graph never bound a call into this package" is a
  statement about what *resolved*, and it systematically under-reports
  loading — every open export-resolution gap makes a genuinely loaded
  package look untouched. The closure is a structurally different and
  strictly stronger statement.
- **Roots are whole FILES.** A `{file, symbol}` entrypoint still roots the
  closure at the whole file, because loading a file executes its top-level
  code regardless of which export is the configured call-reachability
  source. The symbol narrowing applies on the call side only.
- **The strict gate uses `KnownPackageRoots`.** A loaded file with no
  `node_modules` segment of its own — a workspace member, a `file:`
  dependency, any linked install — is attributed to its owning instance
  **only** if that physical root is genuinely a dependency-graph install
  location. "Has a `package.json`" and "lies outside the project root" are
  *not* sufficient; that was an earlier, unsound approach.
- **Empty entrypoints are not gate-eligible.** A root-less closure proves
  nothing, and no proof may be built on one. "Not loadable" is always "not
  loadable *from these roots*".
- **Loader and capability uncertainty fails closed.** A `DynamicCallReason`
  the classifier does not recognise is treated as possible loading, never
  as safe. Reaching a traversal bound marks the closure **incomplete**, never
  silently partial.
- **Exact canonical installed path determines the instance.** Closure
  membership is by `PackageInstanceId`, so a package name appearing in the
  closure says nothing about a *different* installed copy of that name.

An **absent** closure is never read as a satisfied guard. No closure means
no family-A proof — owned by `src/analysis/verdict.f2-proof-guards.test.ts`
and `src/analysis/verdict.module-load-absence.test.ts`, with the real-Node
differential oracle `src/analysis/module-load-closure.differential-oracle.test.ts`
catching construct families nobody has thought of yet.

## 3. The three negative-proof families

A `NOT_AFFECTED` carries exactly one of these. They are **not
interchangeable**: each rests on a different premise, and two of them have
premises that contradict each other.

### Family A — `confirmedAbsentFromModuleLoadClosure`

> The exact authoritative `PackageInstance` is **absent from a complete,
> gate-eligible `ModuleLoadClosure`**.

Nothing the entrypoints load can reach this instance's code at all.

**Evidence emitted:**

| Field | Meaning |
| --- | --- |
| `packageInstance` | The exact canonical install **location** proved absent. Never a name, a version, or a `name@version`. |
| `entrypointRoots` | The configured entrypoint files the claim is relative to. Non-empty by construction. |
| `closureComplete: true` | Recorded explicitly because completeness is the entire load-bearing precondition. Against an incomplete closure, absence proves nothing at all. |

**What it does not claim.** It proves *package-load* absence only. It says
nothing about which symbols inside a package that *is* loaded are
reachable, so it can never justify a verdict for a loaded instance. It is
absence under VulnTrace's declared supported module-loading model
(`SUPPORTED_MODEL_EXCLUSIONS` in `src/domain/evidence.ts` is the single
source of what that model leaves out), never a claim of universal runtime
impossibility.

### Family B — `confirmedAbsentInstance`

> The exact instance is **absent from the call graph**, *corroborated by a
> complete `ModuleLoadClosure`* that also does not contain it.

Reached when the call graph discovered some **other** instance of the same
package name, so family A's own domain (no instance discovered at all) does
not apply.

**Evidence emitted:**

| Field | Meaning |
| --- | --- |
| `packageInstance` | The exact canonical install location never traversed. |
| `entrypointRoots` | The roots the proof is relative to. |
| `graphTruncated: false` | The call graph's traversal did not hit a resource limit. **This is not the same claim as "the call graph is complete".** |
| `moduleLoadClosureComplete: true` | The load-bearing half. Never omitted, never defaulted. |

**Why the corroboration is mandatory.** A non-truncated call graph is not a
complete one. The call graph's discovery never follows a re-export
*declaration* (`export * from "pkg"`) as an edge, so a package instance
reached solely through a re-export chain can be genuinely loaded and called
while remaining entirely absent from a merely-non-truncated graph. This was
reproduced as a real false `NOT_AFFECTED`, and it is why
`graphTruncated === false` alone is not sufficient.

### Family C — `confirmedUnreachableTarget`

> The authoritative target is **unreachable within a completely enumerated
> reachable subgraph**.

Unlike A and B, this says nothing about whether the package is present or
loaded — it may well be both. It says the specific symbol is never called.

**Evidence emitted:**

| Field | Meaning |
| --- | --- |
| `target` | `{module, export}`, restated so the evidence stands alone. |
| `entrypointRoots` | The roots the search started from. |
| `reachableSubgraphComplete: true` | The set of nodes reachable from the entrypoint source node over resolved edges was enumerated **to exhaustion** AND contained **no unresolved edge anywhere in it**. |

Both halves of that last field are load-bearing, and both are captured by
the one flag because `analyzeReachability` returns `unreachable` only when
both hold: it drains its queue *and* returns `unknown` instead if it met
even one unresolved edge along the way. This is why it is not merely "the
search finished" — a search that meets a dynamic construct also finishes,
and proves nothing.

**Two further preconditions are enforced by `buildFinding` before this
proof is ever constructed**, and are therefore not restated as fields on
the evidence object:

| Precondition | What it rules out |
| --- | --- |
| `graphTruncated === false` | Call-graph construction hit a configured resource limit (`analysis.limits`), so the untraversed region might have contained the very path being searched for. A truncated graph returns `UNKNOWN` and withdraws every proof that depends on graph completeness (VT-202). |
| Entrypoint reachability roots fully derived | If a configured entrypoint's root could not be materialized, the subgraph was searched from an incomplete set of roots — "searched to exhaustion" would be true and useless. This returns `UNKNOWN` with `entrypoint_root_incomplete` (P0-Z). |

`graphTruncated === false` says only that the traversal did not hit a
resource limit. **It is not a claim that the call graph is complete** — the
same distinction family B's own field draws — and family C does not need
one: nodes outside the enumerated reachable subgraph are never inspected
and are irrelevant to the conclusion.

### No misleading whole-program completeness

Families B and C both once emitted a field named `callGraphComplete`. It
asserted a property of the **whole** call graph that neither proof ever
established and neither needs, and an API consumer reading
`callGraphComplete: true` could reasonably act on a stronger claim than the
analyzer makes.

Both were renamed to name exactly, and only, what is actually established
(`moduleLoadClosureComplete`, `reachableSubgraphComplete`). **No field in
any proof asserts whole-program call-graph completeness, because no proof
establishes it.** Nodes outside the enumerated region — including their
unresolved edges — are never inspected and are irrelevant to family C's
conclusion.

## 4. VT-CONTRACTs

| Contract | Statement | Deterministic owner(s) |
| --- | --- | --- |
| **VT-CONTRACT-01** | A `NOT_AFFECTED` carries **exactly one** of A / B / C — never zero, never two. | `src/analysis/verdict.negative-proof.test.ts` (analyzer-side), `src/cli/result-schema.negative-proof.test.ts` (structurally, at the output boundary) |
| **VT-CONTRACT-02** | Family C requires `reachableSubgraphComplete: true` and **does not claim global call-graph completeness**. | `src/cli/result-schema.negative-proof.test.ts` (the serialized shape), `src/analysis/verdict.negative-proof.test.ts` (the analyzer side) |
| **VT-CONTRACT-03** | Proof-relevant inputs are bound into one branded, frozen `AnalysisProofContext`; a foreign, stale, thawed or unbranded context withdraws every proof. | `src/analysis/verdict.analysis-context.test.ts` (the contract), `src/cli/scan.analysis-context.test.ts` (at the production boundary — that `cli/scan.ts` really does build exactly one per scan) |

VT-CONTRACT-01 is enforced at **serialization**, not only in the analyzer:
`schemas/result.schema.json` accepts a `NOT_AFFECTED` only with exactly one
proof object and rejects any proof object on an `AFFECTED` or `UNKNOWN`. A
future producer therefore cannot emit two proofs even if the analyzer would
not.

The owners named above are the ones the invariant ownership map names, and
the Foundation gate executes all of them. The authoritative,
machine-readable list of every Foundation invariant and its owners is
`src/testing/foundation-invariants.ts` — it is not restated here, because a
hand-copied table of it is exactly the drift that map exists to prevent.
Counts are in [`SCORECARD.md` § 1](SCORECARD.md).

Other suites exercise the same ground (`verdict.family-c-evidence.test.ts`,
`verdict.family-b-soundness.test.ts` and others). They are deliberately not
listed as owners: the map avoids duplicate oracles, so each invariant names
the test whose failure is an unambiguous report that *that* invariant
broke.

## 5. `AnalysisProofContext` — what is actually frozen

**Read this section literally.** The context is *not* transitively
immutable, and describing it as immutable would misrepresent the guarantee
a reader is relying on.

`createAnalysisProofContext` binds the proof-relevant inputs into one
branded object. After it returns:

| Input | Snapshotted? | Frozen? |
| --- | --- | --- |
| `projectRoot`, `graphTruncated` | primitives | effectively yes |
| `entrypoints` (the array) | **copied** | **yes** |
| `entrypoints[i]` (the objects) | shared identity | **no** |
| `moduleLoadClosure` | same object | **no** |
| `graph` | same object | **no** |
| `knownPackageRoots` (a `Map`) | same object | **no** |

So the accurate statement is: **the wrapper is frozen, and the entrypoint
array container is snapshotted and frozen, but several referenced proof
inputs — and the entrypoint objects themselves — are neither snapshotted
nor transitively frozen.** The context binds the **identities** of live
objects; it does not certify immutable proof facts.

**What the contract does deliver.** Eight distinct attacks fail closed to
`UNKNOWN` with no proof object: a foreign closure, a foreign graph,
entrypoints-and-closure swapped together, a stale same-project context over
a different root set, a mutated `graphTruncated`, an unbranded object cast
into the parameter, and a thawed spread of a real context.

**What it does not deliver.** Post-binding mutation through a **retained
alias to a referenced input** is possible and does change the answer. F4's
audit demonstrated it through the caller's own `moduleLoadClosure`
variable — never touching the context object at all — by emptying
`incompleteness` and setting `complete = true`, turning an `UNKNOWN` into a
family-C `NOT_AFFECTED`. The same class of write was demonstrated through
the `graph` alias and through an `entrypoints[i]` object.

**Why it is nonetheless unreachable in production today.** This is a
*lifetime* argument, not a "no attacker" argument:

- there is exactly **one** production caller of
  `createAnalysisProofContext` (`src/cli/scan.ts`);
- after that line, no production code references `moduleLoadClosure`,
  `graph` or `knownPackageRoots` again;
- no production code anywhere writes to a `ModuleLoadClosure` field;
- graph edges are pushed only during `buildCallGraph`'s own construction,
  before any context exists;
- `knownPackageRoots` is never mutated after it is built;
- nothing caches or persists a graph or a closure.

**Judgment (independent F4 audit): non-blocking hardening debt.** Mutable
aliases exist and mutating them moves a verdict; current production
ownership and lifetime retain no writer after binding, and no production
mutation path was found; but the invariant rests on that lifetime rather
than on anything structural — `readonly` is erased at runtime and
`Object.freeze` is shallow.

**This is a hardening debt, not a guaranteed immutable snapshot**, and it
is tracked as such in [`OPEN-DEBTS.md`](OPEN-DEBTS.md). It is also the
reason no reachability result is cached
([`ARCHITECTURE.md` § 9](ARCHITECTURE.md)): a reachability key would have
to include every one of those inputs by value, and it cannot while they are
live references.

## 6. Adding a negative proof family

**Don't, casually.** Three families is not a shortage. Each one is a
licence to answer `NOT_AFFECTED`, and a family with a subtly wrong
precondition is a false-negative generator that will look correct on every
fixture someone thought to write.

A fourth family requires **all** of:

1. **Explicit preconditions**, stated as the things that must be *positively
   established* — not as the absence of a counterexample.
2. **Machine-checkable evidence**, emitted as its own typed object with its
   own fields, so a consumer can tell it apart from the other families
   without parsing prose.
3. **Fail-closed uncertainty mapping.** Every way the precondition can fail
   to hold must map to a specific uncertainty reason, and the default must
   be the conservative branch.
4. **Proof-context binding.** The proof must be relative to one
   `AnalysisProofContext` and withdraw itself when the context is foreign,
   stale or thawed (VT-CONTRACT-03).
5. **Mutation tests.** Every prerequisite must be shown to be load-bearing
   by removing it and demonstrating the verdict moves —
   `unsafe_survival === 0` in `src/analysis/verdict.f4-proof-mutation.test.ts`.
6. **An independent soundness audit**, by someone who did not write it,
   whose explicit job is to reproduce a false `NOT_AFFECTED`.

Plus everything in the ordinary capability checklist
([`ARCHITECTURE.md` § 13](ARCHITECTURE.md)), plus a new entry in the
invariant ownership map.

**No family D is added in F7**, and none is designed here.

## 7. Worked examples

Generated by `src/testing/docs-contract.test.ts`, which scans a real
project with the real analyzer, validates the output against
`schemas/result.schema.json`, and byte-compares it to what appears below —
so these cannot drift from what the tool actually emits, and cannot contain
a field the schema does not accept. Only the temporary project root and
elapsed milliseconds are normalized; instance paths survive verbatim,
because collapsing them is exactly how an example would stop demonstrating
instance exactness.

All three scan the same shape: an app with one dependency, `vuln-lib@1.0.0`,
against one advisory naming its `danger` export. Only the entrypoint's own
source differs.

### 7.1 `AFFECTED` — a concrete path to the vulnerable export

```js
const { danger } = require("vuln-lib");
function main(x) {
  return danger(x);
}
module.exports = { main };
```

<!-- example:affected -->

```json
{
  "schemaVersion": "0.6",
  "scan": {
    "id": "00000000-0000-0000-0000-000000000000",
    "project": "<project>"
  },
  "findings": [
    {
      "vulnerability": "GHSA-f7-0001",
      "package": "vuln-lib",
      "verdict": "AFFECTED",
      "version": "1.0.0",
      "packageInstance": "node_modules/vuln-lib",
      "confidence": 1,
      "target": {
        "module": "vuln-lib",
        "symbol": "danger",
        "kind": "function",
        "confidence": 1
      },
      "evidence": {
        "path": [
          "<project>/src/index.js:2",
          "<project>/node_modules/vuln-lib/index.js:1"
        ],
        "reasons": [
          "vulnerable symbol resolved",
          "symbol reachable from application entrypoint"
        ]
      }
    }
  ],
  "coverage": {
    "files": 2,
    "modulesResolved": 1,
    "modulesUnresolved": 0,
    "functions": 3,
    "callsResolved": 2,
    "callsDynamic": 0
  },
  "diagnostics": [],
  "unreportedCandidates": [],
  "timings": {
    "parsingMs": 0,
    "resolutionMs": 0,
    "graphConstructionMs": 0,
    "reachabilityMs": 0,
    "providerMs": 0,
    "cacheHits": 0,
    "cacheMisses": 0,
    "totalMs": 0
  }
}
```

<!-- /example:affected -->

### 7.2 `NOT_AFFECTED` — loaded, called, and still proved unreachable

The instance **is** loaded and **is** called — on its safe export. This is
family C's premise, and it is the family worth showing: family A's premise
is that nothing loads the package, which reads as "the tool found nothing"
to someone skimming, while this exhibits a positive unreachability proof
over a target that was genuinely resolved.

```js
const { safe } = require("vuln-lib");
function main(x) {
  return safe(x);
}
module.exports = { main };
```

<!-- example:not-affected -->

```json
{
  "schemaVersion": "0.6",
  "scan": {
    "id": "00000000-0000-0000-0000-000000000000",
    "project": "<project>"
  },
  "findings": [
    {
      "vulnerability": "GHSA-f7-0001",
      "package": "vuln-lib",
      "verdict": "NOT_AFFECTED",
      "version": "1.0.0",
      "packageInstance": "node_modules/vuln-lib",
      "target": {
        "module": "vuln-lib",
        "symbol": "danger",
        "kind": "function",
        "confidence": 1
      },
      "evidence": {
        "path": [],
        "reasons": [
          "vulnerable symbol confirmed unreachable from all analyzed entrypoints"
        ],
        "confirmedUnreachableTarget": {
          "target": {
            "module": "vuln-lib",
            "export": "danger"
          },
          "entrypointRoots": [
            "<project>/src/index.js"
          ],
          "reachableSubgraphComplete": true
        }
      }
    }
  ],
  "coverage": {
    "files": 2,
    "modulesResolved": 1,
    "modulesUnresolved": 0,
    "functions": 3,
    "callsResolved": 2,
    "callsDynamic": 0
  },
  "diagnostics": [],
  "unreportedCandidates": [],
  "timings": {
    "parsingMs": 0,
    "resolutionMs": 0,
    "graphConstructionMs": 0,
    "reachabilityMs": 0,
    "providerMs": 0,
    "cacheHits": 0,
    "cacheMisses": 0,
    "totalMs": 0
  }
}
```

<!-- /example:not-affected -->

Note what the proof names: the family's own evidence object, the exact
target, and the `entrypointRoots` the claim is relative to. A
`NOT_AFFECTED` without those is not a `NOT_AFFECTED`.

### 7.3 `UNKNOWN` — a dynamic dispatch in the way

A computed member access sits between the entrypoint and the package, so no
path is established **and** no negative proof completes.

```js
const lib = require("vuln-lib");
function main(name, x) {
  return lib[name](x);
}
module.exports = { main };
```

<!-- example:unknown -->

```json
{
  "schemaVersion": "0.6",
  "scan": {
    "id": "00000000-0000-0000-0000-000000000000",
    "project": "<project>"
  },
  "findings": [
    {
      "vulnerability": "GHSA-f7-0001",
      "package": "vuln-lib",
      "verdict": "UNKNOWN",
      "version": "1.0.0",
      "packageInstance": "node_modules/vuln-lib",
      "target": {
        "module": "vuln-lib",
        "symbol": "danger",
        "kind": "function",
        "confidence": 1
      },
      "evidence": {
        "path": [],
        "reasons": [
          "dynamic_member_access at <project>/src/index.js#main@2:1"
        ]
      },
      "unknownReasons": [
        {
          "category": "value_uncertainty",
          "reason": "dynamic_member_access",
          "count": 1
        }
      ]
    }
  ],
  "coverage": {
    "files": 2,
    "modulesResolved": 0,
    "modulesUnresolved": 0,
    "functions": 3,
    "callsResolved": 1,
    "callsDynamic": 1
  },
  "diagnostics": [
    {
      "source": "call-graph",
      "message": "dynamic_member_access at <project>/src/index.js#main@2:1"
    }
  ],
  "unreportedCandidates": [],
  "timings": {
    "parsingMs": 0,
    "resolutionMs": 0,
    "graphConstructionMs": 0,
    "reachabilityMs": 0,
    "providerMs": 0,
    "cacheHits": 0,
    "cacheMisses": 0,
    "totalMs": 0
  }
}
```

<!-- /example:unknown -->

The reasons are structured and categorised. This is what makes "how much of
our `UNKNOWN` surface is a coverage gap we could close?" a question a
machine can answer — the measurement in [`SCORECARD.md` § 7](SCORECARD.md).
