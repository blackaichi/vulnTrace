| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| RWF-025b | any CommonJS file whose re-export provenance crosses a broad assignment-target traversal | The same broad assignment-target traversal as RWF-025, in CommonJS re-export provenance | **Precision only** — P2: lost re-export attribution, `UNKNOWN`, never a false `NOT_AFFECTED` (the section's Severity line) | **Fixed** (RWF-025b) — see below |

## RWF-025b — The same broad assignment-target traversal, in CommonJS re-export provenance

**Severity:** P2 / PRECISION ONLY (lost CommonJS re-export attribution;
`UNKNOWN`, never a false `NOT_AFFECTED`)
**Status:** **Fixed.** Reported by an independent audit as an analogous
traversal to RWF-025's, and independently reproduced here on `ebecc57`
(current merged main, RWF-028 included) before any edit. The audit's
precision-only classification was NOT taken on trust — it was re-derived
from the consumers and then measured end to end; see *Direction* below.

### The defect

`commonjs-reexports.ts`'s `collectFacts` records every name a file WRITES
TO in `CommonJsFacts.reassignedNames`. That set is this file's
authoritative NEGATIVE provenance (RWF-013b): `classifyLocalBinding`
consults it FIRST, before any question about declaration form, and refuses
every name in it. A refused name can carry no CommonJS re-export origin,
no alias chain, and no function attribution anywhere in the file.

It was filled by a `markAssigned` whose last line was:

```ts
ts.forEachChild(target, markAssigned);
```

— the exact shape RWF-025 removed from `module-model.ts`, answering the
same question for a different relation. An assignment target's syntax tree
holds two independent kinds of thing: the **destinations** written to, and
the **expressions merely evaluated** to work out which destinations those
are. The blind child walk could not tell them apart, so a bare reference in
an evaluated-only position was recorded as a write:

```js
({ [keyFor(alias)]: seen } = REGISTRY);   // rebinds `seen`; READS `alias`
REGISTRY[keyFor(alias)] = true;           // rebinds NOTHING; READS `alias`
({ seen = keyFor(alias) } = REGISTRY);    // rebinds `seen`; READS `alias`
```

`CommonJsFacts` is cached per `ts.SourceFile`, so ONE such statement —
anywhere in the file, semantically unrelated to any export — withdrew a
real re-export origin **file-wide**:

```js
var vulnerable = require("./lib").vulnerable;
REGISTRY[keyFor(vulnerable)] = true;       // <- the only thing that changed
exports.vulnerable = vulnerable;           // origin lost: no `./lib` hop
```

Reproduced on merged main through the real pipeline in
`fixtures/commonjs-reexport-computed-key-reassignment-provenance/` (whose
README carries the `node`-measured ground truth): the facade's `vulnerable`
IS `lib.js`'s `vulnerable`, `src/index.cjs` calls it, and the scan came
back `UNKNOWN`.

### Direction — precision-only, independently verified

The audit's classification holds, and for a structural reason rather than
an incidental one:

1. The defect only ever ADDS a name to `reassignedNames`, and every
   consumer of that set REFUSES on membership. It can withdraw attribution;
   it can never manufacture any.
2. An export nothing can attribute is an unresolved target.
   `mapExportsToFunctions` skips it, `resolveCommonJsReExport` returns no
   node, and `call-graph.ts` records the failed hop as an explicit
   `unknown(unresolved_target)` edge.
3. A Family C `confirmedUnreachableTarget` proof requires a COMPLETE
   subgraph. An unknown edge on the path FORECLOSES `NOT_AFFECTED` rather
   than enabling it — which is precisely RWF-013's and RWF-011's design.
4. RWF-021's root behavior cannot convert the loss into a negative proof
   either: withdrawn export attribution subtracts a reachability ROOT, and
   RWF-021 exists to keep that from being read as unreachability. Its
   controls are re-run unchanged.

The correction therefore restores resolution the file always justified; it
withdraws no edge, so it cannot complete a subgraph by subtraction. The
measured verdict differential across the fixture suite and the canonical
validation baseline is **one row**, `UNKNOWN → AFFECTED`, with
`UNKNOWN → NOT_AFFECTED = 0` and `AFFECTED → NOT_AFFECTED = 0`.

No ADV2 case was added: per the adversarial policy those record
soundness-critical defects, and this is not one. The evidence here is the
focused matrix, the end-to-end fixture, and the corpus measurement.

### The fix

`markAssigned` now descends through ASSIGNMENT-TARGET STRUCTURE only —
identifier, object/array destructuring pattern, spread, default, and the
property/element-access forms that mutate an object rather than rebind a
name — and hands every evaluated-only position (a computed key, an
element-access index and object expression, a destructuring default) to a
second traversal, `markAssignmentsInsideEvaluatedExpression`, which
descends only to FIND assignment and update OPERATIONS and collects names
only from their targets. A bare identifier is never collected there;
`alias = other` records `alias` and not `other`, and `keyFor(alias)`
records nothing.

Collapsing the two in EITHER direction is a defect, and both directions are
pinned: the read-only rows fail on base, and the real-write rows fail
against a naive fix that simply ignores evaluated subexpressions. The
fixture's third entrypoint exists for the second direction — the facade
writes `REGISTRY[(rebound = require("./lib").reboundReplacement)] = true`,
a genuine reassignment spelled inside exactly the element-access index the
fix stops walking blindly. Losing it would re-open RWF-013 by attributing
`fixture-lib#rebound` to a function the package does not export.

This is deliberately the same semantic split as RWF-025's
`markLocallyReassigned` / `markAssignmentsInsideEvaluatedExpression` in
`module-model.ts`. The two are NOT shared code: they collect into different
models over different reach rules (see the limitation below), and neither
owns the other's scope. They are kept semantically identical about what a
target rebinds, and `commonjs-reexports.reassignment-target-provenance.test.ts`
carries a twin-comparison block asserting they do not diverge on the
observable they share.

### Corpus

Two scans (`scripts/rwf-025b-corpus.mjs`), each recomputing
`reassignedNames` twice over the same visit driver — once with the old
broad traversal, once with the new split — and diffing:

| | fixtures | vendored `node_modules` |
| --- | --- | --- |
| files scanned / parsed | 254 / 254 | 4,550 / 4,550 |
| syntactic assignment targets | 432 | 153,646 |
| non-identifier targets | 353 | 78,044 |
| targets containing identifier references | 353 | 77,296 |
| files with ≥1 poison candidate under the old traversal | 9 | 643 |
| poison names under the old traversal | 26 | 2,808 |
| files containing CommonJS export/`require` logic | 240 | 2,073 |
| poison files that also contain CommonJS export logic | 9 | 488 |
| names NEWLY recorded by the new traversal | **0** | **0** |

The last row holds for every shape, not just the ones these corpora happen
to contain. An earlier draft of this entry claimed one exception — that
`getHolder((alias = other)).x = 1` was newly recorded, since `markAssigned`
used to return early on a `PropertyAccessExpression` target without
inspecting its receiver. That claim was wrong, and the independent audit
measured it on both sides: `alias` is recorded as a write on BASE and on
BRANCH alike.

The two arrive at it by different routes, which is why reading
`markAssigned` alone was misleading. On base the write is reached by
`collectFacts`'s own whole-file `visit` driver, which recurses through
every node — the left-hand side of the assignment included — and handles
the nested `alias = other` as an assignment in its own right, whichever
enclosing traversal declined to look at it. On the branch it is reached
BOTH that way and explicitly, through
`markAssignmentsInsideEvaluatedExpression` on the receiver. The new
traversal therefore introduces no widening for this shape, and none for
any other: every name it records, base records too.

What changes is only the other direction. Bare references in evaluated
positions — a computed key, an element-access index, a property-access
receiver, a destructuring default — stop being counted as writes, while
every real nested assignment and update in those same positions keeps
being counted. Observed reassignment tracking on the branch is thus a
strict subset of base's, and the names it drops are exactly the false ones.

One asymmetry is resolved in passing: base recorded `alias[k] = 1` as a
write to `alias` while already treating `alias.x = 1` as a read. The
branch makes property MUTATION consistently not a rebinding of the object
binding, whichever way the property is spelled.

The remaining counts are SYNTACTIC poison candidates — names the old traversal
would have recorded and the new one does not. They are not a claim that 643
third-party files changed verdict; verdict movement is measured by the
fixture suite and the validation baseline, and was one row.

### Remaining limitations (deliberately not fixed here)

- **Reassignment is keyed by identifier TEXT, whole-file.**
  `CommonJsFacts` does not resolve symbols, so a write to a same-named
  INNER binding still marks the outer name, and any re-declaration of a
  name refuses it on `declarationCounts` independently of reassignment.
  RWF-025b neither widens nor narrows that: it is conservative in the safe
  direction (it only ever REFUSES attribution) and fixing it means a
  symbol-resolved binding model this task is scoped not to build. Pinned in
  the matrix's scope block so the inherited behavior is documented by
  execution rather than assumed.
- **No reach restriction.** Unlike RWF-025's twin, this model counts a
  write inside a function body as a write, because `CommonJsFacts` is
  whole-file by design. That is the one axis on which the two traversals
  intentionally differ, and it is preserved rather than harmonised — the
  evaluated-subexpression walk here does not stop at a function boundary.
- **The evaluated walk is redundant with `collectFacts`'s own recursion.**
  `visit` already reaches every node it reaches, so no currently-observable
  behavior depends on it. It is kept so that the target walk is complete ON
  ITS OWN, rather than relying on a second, independently-evolving walk to
  compensate for the names it deliberately declines to collect.

