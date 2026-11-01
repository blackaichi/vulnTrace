| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-26 | `vuln-lib` (synthetic fixture) | Export-to-function mapping takes the first same-named match in file-scan order, not the declaration the export site binds to | false NOT_AFFECTED — see below | **Fixed** (E-1) — see below |

## PRM-26 — Export-to-function mapping takes the first same-named match in file-scan order, not the declaration the export site binds to

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A (explicitly labeled class A in the report)
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

`index.functions.find(fn => fn.name === localKey)` returns the first function sharing a name in file-scan order, so `class H { run(x){...} }` (a decoy method named `run`) out-answers the real exported `function run(x){ return danger(x); }`. Family C certifies the real implementation unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-26`) and § 4 (`export-map-first-match-class-method`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task E-1, 2026-10-13): Fixed.** Re-measured against
real Node before the fix: four shapes were live false `NOT_AFFECTED`s (a
class method, a nested function, an `o.run = function` property and, in an
ES module, a class method named like the export before the real
declaration). `mapExportsToFunctions` now resolves an export's local through
the one declaration it binds to at the export's own site
(`exportLocalCallableLocation`, built on V-3's `lexicalDeclarationOf`),
never by `fn.name`; the name-lookup census's `open` PRM-26 entries are
deleted. All four assert `AFFECTED` in `tests/oracle/e1-export-write-set.test.ts` (`prm26.*`). Measured on
real `node_modules` (`scripts/e1-export-write-set-corpus.mjs`): 107 exports
move to a different function, each spot-checked one a decoy the name
`find` had taken (acorn's `parse`, minimatch's `braceExpand`, zod's
`array`, babel's `parse`, debug's `enabled`).

---

