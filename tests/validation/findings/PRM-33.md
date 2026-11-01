| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-33 | `vuln-lib` (synthetic fixture), tsconfig | Under `module: commonjs`, TypeScript's node10 module resolution is used at runtime and ignores the package's `exports` map | false NOT_AFFECTED — see below | **Fixed** (C-1) — see below |

## PRM-33 — Under `module: commonjs`, TypeScript's node10 module resolution is used at runtime and ignores the package's `exports` map

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A
**Proof family affected:** A
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** C — capability flow and resolution

With a project `tsconfig.json` specifying `module: commonjs`, `module-resolver.ts`'s `noDts` resolution falls back to legacy main-field/node10 resolution rather than the package's real conditional `exports` map, resolving to `legacy.js` instead of the exports-declared file Node actually loads. The vulnerable code is then outside the model's view and family A certifies it absent. Without the tsconfig, the same fixture correctly resolves and gives AFFECTED.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-33`) and § 4 (`tsconfig-commonjs-ignores-exports`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task C-1, 2026-10-09): Fixed.** Module resolution no
longer reads the project's tsconfig (ADR 0010 invariant C2):
`module-resolver.ts` resolves every specifier under one fixed set of
options, `NodeResolutionOptions` (`module` and `moduleResolution` NodeNext,
`allowJs`), branded with one producer, and a Foundation census
(`src/testing/runtime-resolution-census.ts`, invariant
`VT-INV-C-runtime-resolution`) checks that every production call into
TypeScript's module resolution receives them.

Measured on the base (`ab8b278`), before the fix, against real `node`
v22.11.0: the reproduction is a family-A false `NOT_AFFECTED`
(`tests/oracle/c1-runtime-resolution.test.ts`,
`prm33.module-commonjs.exports-require` and
`prm33.module-resolution-node10.exports-require`); after the fix both are
`AFFECTED`, as real Node calls the target. The defect was wider than this
record states: of ADR 0010 § 1's 40 `module` × `moduleResolution`
tsconfigs, 22 resolved the package to `legacy.js` from a `.js` importer
-- every `node10` row, every `bundler` row, and an unset
`moduleResolution` under a non-node `module`
(`src/code-intelligence/module-resolver.runtime-resolution.test.ts`);
only the `node16` / `nodenext` rows were right. A `.cjs` / `.mjs` importer
was already resolved through `exports` on the base, because its file
extension gives TypeScript an explicit format (C-1's independent audit,
note 7, measured with `ts.resolveModuleName`): the defect was for `.js`
and `.ts` importers, whose format node10 leaves undetermined.

Correction to this record's mechanism (AGENTS.md § C): it says
"`module-resolver.ts`'s `noDts` resolution falls back to legacy
main-field/node10 resolution". In the reproduction the package ships no
declaration file, so the `noDts` re-resolution is never reached: the
first `ts.resolveModuleName`, under the project's own node10 options,
returns `legacy.js`. The fault was the options, not the `noDts` step.

---

