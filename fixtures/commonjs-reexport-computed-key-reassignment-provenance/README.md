# commonjs-reexport-computed-key-reassignment-provenance (RWF-025b)

A CommonJS facade whose re-export attribution was withdrawn by a statement
that never wrote to the exported binding at all.

## The defect

`commonjs-reexports.ts`'s `collectFacts` records every name the file WRITES
TO in `reassignedNames` — the authoritative NEGATIVE provenance of RWF-013b.
`classifyLocalBinding` consults it first and refuses any name in it, so a
name recorded there can carry no re-export origin, no alias chain and no
function attribution anywhere in the file.

It was filled by:

```ts
function markAssigned(target: ts.Node): void {
  if (ts.isIdentifier(target)) { reassignedNames.add(target.text); return; }
  if (ts.isPropertyAccessExpression(target)) return;
  ts.forEachChild(target, markAssigned);   // <- the defect
}
```

The `forEachChild` fallback recorded EVERY identifier under an assignment
target. An assignment target's AST also contains expressions that are
merely EVALUATED while the target is resolved — a computed key, an
element-access index, a destructuring default — and those write nothing.
`node_modules/fixture-lib/index.js` contains two of them:

```js
({ [keyFor(vulnerable)]: seen } = REGISTRY);   // rebinds `seen`
REGISTRY[keyFor(vulnerable)] = true;          // rebinds nothing
```

Both only READ `vulnerable`, and both recorded it as reassigned. Because
the fact set is cached per SOURCE FILE, this one piece of unrelated
telemetry bookkeeping withdrew the `./lib` re-export origin for
`exports.vulnerable` across the whole facade.

## Runtime ground truth (measured with real `node`)

| fact | value |
| --- | --- |
| `require("fixture-lib").vulnerable === lib.vulnerable` | `true` |
| `require("fixture-lib").safe === lib.safe` | `true` |
| `require("fixture-lib").rebound === lib.reboundOriginal` | `false` |
| `require("fixture-lib").rebound === lib.reboundReplacement` | `true` |
| `require("./src/index.cjs")("x")` | `"vulnerable:x"` |

So `fixture-lib#vulnerable` IS `lib.js`'s `vulnerable`, and `src/index.cjs`
calls it. The truthful verdict for the `vulnerable` target from that
entrypoint is **AFFECTED**.

## Direction of the defect — precision-only

Before RWF-025b the scan returned **UNKNOWN**, not a false NOT_AFFECTED,
and that is structural rather than incidental:

- the poison only ever ADDS a name to `reassignedNames`, and every
  consumer of that set REFUSES on membership. It can remove attribution;
  it can never manufacture any;
- an export nothing can attribute is an unresolved target. `call-graph.ts`
  records the failed hop as an explicit `unknown(unresolved_target)` edge
  (see `resolveCommonJsReExport` / `resolveCommonJsImportBinding`), which
  is an incompleteness marker;
- a Family C `confirmedUnreachableTarget` proof requires a COMPLETE
  subgraph, so an unknown edge on the path forecloses NOT_AFFECTED rather
  than enabling it.

The correction therefore moves this fixture UNKNOWN → AFFECTED. It cannot
move anything toward NOT_AFFECTED by withdrawing an edge, because it
withdraws none — it only restores resolution the file always justified.

## Entrypoints

| entrypoint | target | before | after | why |
| --- | --- | --- | --- | --- |
| `src/index.cjs` | `vulnerable` | UNKNOWN | AFFECTED | the defect itself |
| `src/safe-only.cjs` | `unused` | NOT_AFFECTED | NOT_AFFECTED | valid Family C, untouched — `unused` is never part of the bookkeeping |
| `src/rebound-only.cjs` | `rebound` | UNKNOWN | UNKNOWN | a GENUINE reassignment, written inside an evaluated position; refusal must survive |

The third row is the one that keeps the fix honest: the write is spelled
`REGISTRY[(rebound = require("./lib").reboundReplacement)] = true`, inside
exactly the element-access index position the fix stops walking blindly.
A fix that simply ignored evaluated subexpressions would lose it and start
attributing `fixture-lib#rebound` to a function the package does not
export — the RWF-013 defect, reintroduced.
