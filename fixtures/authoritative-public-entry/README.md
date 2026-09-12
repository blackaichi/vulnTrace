# Fixture: authoritative-public-entry (P1-A2 / RWF-030)

The permanent fixture for **P1-A2 — authoritative public-entry target
resolution**. Asserted by
`src/analysis/verdict.authoritative-public-entry.integration.test.ts`, with
real Node ground truth in `verify.cjs`.

## What this family is, and what it is not

The question is **which file is allowed to answer for a package**.

Before P1-A2, advisory target attribution asked *every* graph-discovered
file of the installed instance, independently, whether it exported the
advisory's literal name. Nothing in that loop asked which file the package
actually publishes, so package MEMBERSHIP became sufficient for target
identity when it is only ever necessary:

```js
// pkg/index.js -- the public entry; what the package really publishes
var impl = require("./impl");
var other = require("./other");
module.exports = { vulnerable: impl.safeImpl, runOther: other.vulnerable };

// pkg/other.js -- an unrelated sibling that exports the SAME name
exports.vulnerable = function dangerous(input) { ... };
```

Under real `node`, `pkg.vulnerable` **is** `impl.safeImpl`. A rule
targeting `pkg#vulnerable` bound to `other.js` instead.

Two neighbouring problems it is deliberately **not**:

- **Target-side forwarding** (P1-A1/RWF-029,
  `fixtures/target-side-reexport`): given a starting file and a name, which
  literal specifier does that value come from. P1-A2 re-uses that relation
  **unchanged** and changes only *where it starts*. Confounding the two is
  exactly how a sibling scan survives a forwarding fix — in the old
  pipeline the forwarding chase ran only as a fallback *after* the sibling
  scan had already found something, so a sibling shadowed it entirely.
- **Consumer-side re-export** (RWF-004a/b): a call site following a value
  through a package's re-exports. That is the runtime following a value;
  this is an advisory naming a package.

## Both failure directions, one cause

The sibling scan was not only an over-reporting defect. Because a found
sibling returned *before* P1-A1's forwarding chase could run, it produced
both:

- **false AFFECTED** — a dangerous, reachable sibling answered for a
  package whose public `vulnerable` is safe and uncalled (`publicsafe-lib`);
- **false NOT_AFFECTED** — an unreachable sibling shadowed the genuinely
  reached public implementation, and the finding got a *negative proof*
  about a callable the advisory never named (`twinpub-lib`, both twins).

## The matrix

Each installed package under `node_modules/` isolates one shape; each
`src/*` is a consumer entrypoint scanned on its own. Almost every package
carries a same-named sibling on purpose — the sibling is the attack.

| Package | Shape | Expected target |
|---|---|---|
| `publicsafe-lib` | **THE canonical case** — entry publishes `impl.safeImpl` as `vulnerable`; `other.js` exports a dangerous `vulnerable` under the public name `runOther` | `impl.js`'s `safeImpl` → NOT_AFFECTED |
| `publicvuln-lib` | reverse control — entry really does publish the dangerous impl, with a same-named SAFE sibling | `impl.js`'s `dangerousImpl` → AFFECTED |
| `directpub-lib` | direct public export; the entry IS the implementation file | `index.js`'s own `vulnerableImpl` → AFFECTED |
| `missing-lib` | entry publishes no `vulnerable` at all; a sibling does | **UNRESOLVED / UNKNOWN** |
| `multisibling-lib` | entry forwards to `impl.js`; **three** siblings export the same name | `impl.js`'s `internalName`, order-independently |
| `renamesafe-lib` | public rename onto a safe impl, dangerous same-named sibling, target never called | `impl.js`'s `safeInternal` → NOT_AFFECTED |
| `unreachvuln-lib` | entry publishes the dangerous impl EXACTLY; consumer never calls it | exact resolution, then a genuine negative proof |
| `dupwrite-lib` | two writes to `exports.vulnerable`; last is safe | the LAST write's `safeImpl` |
| `dupreverse-lib` | mirror — last write is dangerous | the LAST write's `dangerousImpl` |
| `condpublic-lib` | conditional public export write | **refused** — UNKNOWN, never recovered from the sibling |
| `dynpublic-lib` | computed public export NAME (`exports[key] = ...`) | **refused** — UNKNOWN |
| `mainfield-lib` | `"main": "lib/entry.js"`, plus a loaded, reachable root `index.js` exporting a same-named decoy | `lib/impl.js`'s `realImpl` — entry identity comes from package metadata, never the filename `index.js` |
| `deep-lib` | consumer deep-imports `deep-lib/deep` and calls its `vulnerable`; the entry publishes none | **UNKNOWN** — see the boundary note below |
| `crosspub-lib` | entry forwards the advisory's name into `outside-lib` | **refused** — advisory ownership is not re-pointed (P1-A1's rule) |
| `twinpub-lib` | same name **and** version installed twice (top-level, and nested under `wrap-lib`), each entry publishing a different callable | each instance answered only from its own entry |
| `esmpub-lib` | ESM `export { internalName as vulnerable } from "./impl.js"`, same-named sibling in `other.js` | `impl.js`'s `internalName` |

## Boundaries this fixture deliberately pins as UNKNOWN

- **Deep imports** (`deep-lib`). A consumer may bypass the public entry
  entirely. An advisory naming the public `pkg#vulnerable` is a different
  claim from "some file in `pkg` exports that name", and deciding when the
  two coincide is subpath-resolution semantics, which P1-A2 is scoped not
  to build. It fails closed.
- **`package.json` `exports`/subpath advisories.** Not implemented here.
  The existing resolver's semantics are used as-is for the default entry;
  no subpath semantics were added.
- **Cross-package forwarding** (`crosspub-lib`). Unchanged from P1-A1:
  answering `crosspub-lib`'s advisory with `outside-lib`'s implementation
  would silently re-interpret whose vulnerability it is.

## Ground truth

`node verify.cjs` asserts, under real Node and out-of-process, what each
package really publishes from its public entry — **by callable identity,
not by name** — that the canonical case's public target is never executed
while its dangerous sibling is, that the duplicate-write cases publish the
current rather than the stale value in both directions, and that the two
name- and version-identical twins publish different callables.

VulnTrace itself never executes target code (AGENTS.md); the oracle is
test-only, and is run out-of-process by the integration suite.
