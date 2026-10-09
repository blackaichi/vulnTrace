# C-1 — Runtime resolution mode independent of tsconfig

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: C-1
- **Branch**: c-1-runtime-resolution-mode
- **Base SHA**: ab8b278c3ea112e575802e2ad2b5dec12b8c91f6
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

First task of lane C of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 12),
after lane V closed with [`V-4`](V-4-proof-input-types.md) (PR #89,
merged 2026-10-09). It has no dependency; § 5a pulls it forward to follow
V because a TypeScript project with `module: commonjs` is ordinary code.

The specification is
[ADR 0010](../adr/0010-capability-flow-and-runtime-resolution.md):
invariant **C2** (§ 1), its mechanically checkable form (the resolution-mode
table: `module ∈ {commonjs, es2015, es2020, es2022, esnext, node16,
nodenext, preserve}` × `moduleResolution ∈ {unset, node10, node16,
nodenext, bundler}`), § 2's "resolution-mode table test, plus one real-Node
fixture per row where the answer differs" and the
`VT-INV-C-runtime-resolution` registration, § 3's fail-closed rule (a C2
disagreement between tsconfig and Node is `unresolved_module`, category
`identity_unresolved`), § 6's reopened TASK-013 / VT-304 decision, and
§ 8's C-1 row: scope `module-resolver.ts`, `ts-project.ts`; flips PRM-33;
changes "`module-resolver.test.ts` cases that assert node10 behaviour under
a tsconfig; `ts-project.test.ts` default-options assertions". The project
owner's decision 7 (REMEDIATION-PLAN § 6.1): Node resolution is
authoritative; a divergence with a tsconfig `paths` mapping makes the
closure incomplete for that specifier.

What binds C-1 from earlier tasks (REMEDIATION-PLAN § 5a): "V-4
additions" — a new or moved family-B or family-C proof goes through
`corroborateClosure`. C-1 adds no proof; it changes which file a
specifier resolves to, upstream of every family.

Closes PRM-33 (`tests/validation/FINDINGS.md`;
[`docs/audits/2026-09-premise-sweep-round-1.md`](../audits/2026-09-premise-sweep-round-1.md)
§ 3 and § 4, `tsconfig-commonjs-ignores-exports`).

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True** (code read): `createModuleResolver` hands
  `project.rawCompilerOptions` — the project's parsed tsconfig, or
  `DEFAULT_JS_PROJECT_RAW_OPTIONS` (NodeNext) when there is none —
  unchanged to `ts.getImpliedNodeFormatForFile` and `ts.resolveModuleName`
  (`module-resolver.ts`). It is the only production resolver
  (`scan.ts`, `proof-mutation.ts` and corpus scripts construct it);
  `call-graph.ts` reads only the `jsx` option from the raw options.
- **True** (measured, TypeScript 5.9.3, Node v22.11.0, scratch probe
  outside the repository): PRM-33 reproduces. With
  `{"module":"commonjs"}`, a package with `main: ./legacy.js` and
  `exports: {".": {"require": "./cjs/impl.cjs"}}` resolves to `legacy.js`;
  real `node` loads `impl.cjs`; Node-only options (NodeNext, `allowJs`,
  nothing from the tsconfig) give `impl.cjs`.
- **False** (measured), ADR 0010 § 5: "adversarial scenarios 0 / 122
  verdicts changed" under the prototype's "NodeNext runtime resolution".
  TypeScript applies `paths` and `baseUrl` under NodeNext too, so forcing
  NodeNext alone leaves C2's second sentence unimplemented. Measured with
  C2 as written (scratch prototype, reverted;
  `node scripts/differential.mjs` over all 139 corpus cases): 3 verdicts
  change, ADV-023, ADV2-015 and ADV2-016, all `AFFECTED` → `UNKNOWN`
  (`unresolved_module`), 0 into `NOT_AFFECTED`, 0 findings removed, the
  validation baseline unchanged. Real `node` throws `MODULE_NOT_FOUND` on
  their aliased imports (`@lib/wrapper.js`, `lib/wrapper`).
- **New defect** (measured): a tsconfig `paths` entry or a bare `baseUrl`
  that shadows an installed package makes the analyzer follow the local
  file while real `node` loads `node_modules/<pkg>`, under every
  `moduleResolution`, NodeNext included. Not PRM-33 (which is the mode),
  not yet recorded: registered by this task as RWF-083.
- **True** (measured): under Node-only options, the `types`, `node`,
  `default` and `browser` conditions and the declaration → `noDtsResolution`
  re-resolution all name the file real `node` v22.11.0 loads.
- **Gap in scope** (code read): the declaration-only sibling fallback
  (`attemptSiblingRuntimeFile`) returns `package.json`'s `main` without
  reading `exports`; Node never consults `main` for a package that declares
  `exports`. Inside `module-resolver.ts` and C2's first sentence.
- **Out of scope, recorded** (measured): the `module-sync` condition.
  Node v22.11.0 ignores it (loads the `require` target, as TypeScript
  does); Node ≥ 22.12 honours it. Which file loads depends on the Node
  version, which the analyzer does not know: a runtime-flag-class question
  for lane D's disclosure, registered as a finding, not changed here.

### The project owner's decision (2026-10-09)

Asked with the measurement above: **strict C2**. Runtime resolution never
reads the tsconfig; a `paths` / `baseUrl` mapping that disagrees with
Node's answer makes that specifier `unresolved_module`. The three
adversarial cases' expected verdicts are corrected to `UNKNOWN`: an
`AFFECTED` path through them needs a resolution real Node never performs,
the same reasoning decision 6 (task C-5) applies to a redirected
`require`. The false § 5 measurement is recorded as a finding (RWF-084).

## Task

### Problem

`module-resolver.ts` decides which file a specifier loads with the
project's own compiler options. Under `module: commonjs` (or
`moduleResolution` unset / `node10` / `classic` / `bundler`) that is not
Node's algorithm: node10 ignores `exports`, bundler accepts extensionless
ESM imports, and every mode applies `paths` / `baseUrl`, which Node never
reads. The module-load closure and the call graph then follow a file Node
does not load, and family A certifies the target absent (PRM-33).

### Why it matters

Soundness: PRM-33 is a family-A false `NOT_AFFECTED`, and RWF-083 is one
under any `moduleResolution`. Defect class B (AGENTS.md § F): the binding
(the specifier) is right; the value assumed for it (the loaded file) is
not what real `node` produces.

### What to do

1. **Tests first**, shown failing on the base:
   - real-Node oracle cases (`tests/oracle/c1-runtime-resolution.*`): PRM-33
     under `module: commonjs`; RWF-083 (`paths` and `baseUrl` shadowing an
     installed package); loud fixtures, both controls;
   - the C2 resolution-mode table (40 tsconfigs) over the PRM-33 package,
     every row resolving to the file real `node` loads;
   - resolver unit cases: a mapping that disagrees with Node is
     `unresolved`; a mapping that agrees is resolved; the sibling fallback
     is not taken for a package that declares `exports`.
2. **The fix**, in `module-resolver.ts` (and `ts-project.ts`'s comments
   and defaults whose premise changes): one fixed set of Node runtime
   resolution options, independent of the tsconfig; a `paths` / `baseUrl`
   cross-check that turns a disagreement into `unresolved`; the sibling
   fallback refused for a package with `exports`.
3. **Foundation invariant** `VT-INV-C-runtime-resolution`
   (`src/testing/foundation-invariants.ts`).
4. **Pinned tests corrected**, each with the reason: the `module-resolver`
   path-mapping unit test, the `typescript-paths` fixture-suite case and
   README, ADV-023 / ADV2-015 / ADV2-016 (`expected.json`, regenerated
   `REPORT.md`).
5. **Records**: FINDINGS (PRM-33 fixed; RWF-083; RWF-084; the
   `module-sync` finding), ADR 0010 (decision record, status), OPEN-DEBTS,
   REMEDIATION-PLAN § 5a "C-1 additions", backlog, progress, scorecard.

## Boundaries

### Do not touch

- `loader-constructs.ts`, `local-aliases.ts`: C-2..C-4.
- `verdict.ts`: C-5 and lane V's owners.
- the corroboration types and cast census (V-4).
- `tests/validation/` expected verdicts and the D-09 known failures.
- another task's worktree (`rwf-046-require-binding-authority`).

### STOP conditions

- A verdict moves into `NOT_AFFECTED` anywhere in the differential.
- A validation case changes verdict.
- Any corpus verdict moves other than the three the owner decided.
- Real Node and Node-only TypeScript resolution disagree on a shape the
  table or the oracle cases cover (C2 would then need more than options).

## Acceptance criteria

- [ ] PRM-33's oracle case is `AFFECTED` (real `node` calls the target);
      `NOT_AFFECTED` on the base.
- [ ] RWF-083's cases are not `NOT_AFFECTED`; `NOT_AFFECTED` on the base.
- [ ] Every row of the 40-row C2 table resolves the PRM-33 package to the
      file real `node` loads, and the options handed to
      `ts.resolveModuleName` are NodeNext for every row.
- [ ] A `paths` / `baseUrl` mapping that disagrees with Node yields
      `unresolved` with a reason naming both answers; one that agrees stays
      resolved.
- [ ] The sibling fallback is not taken for a package that declares
      `exports`.
- [ ] `VT-INV-C-runtime-resolution` is registered with named owners.
- [ ] The differential moves exactly ADV-023, ADV2-015, ADV2-016
      (`AFFECTED` → `UNKNOWN`), 0 into `NOT_AFFECTED`; validation equals the
      D-09 baseline case by case.
- [ ] Every corrected pinned test states why the old answer was wrong.
- [ ] Records updated; scorecard regenerated; every gate green.
- [ ] Independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: the three
adversarial verdict changes above and no other; validation exactly the
five D-09 known failures (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`,
`VAL-003`).

## Report

In the format of `AGENTS.md` § J.
