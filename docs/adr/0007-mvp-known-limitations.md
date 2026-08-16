# ADR 0007 — MVP Known Limitations (Deferred Scope)

## Context

All 30 tasks are complete. Several sub-scope decisions and honest
architectural simplifications were made along the way and recorded in
individual task completion reports and code comments, but not
consolidated anywhere a future contributor would find them without
reading every commit. This ADR is that consolidation, made at MVP
release (TASK-030).

## Decision

Ship the MVP with the following known limitations, each deliberately
scoped out rather than accidentally missed. None of them compromise the
core verdict guarantee (AFFECTED/NOT_AFFECTED/UNKNOWN, never a false
NOT_AFFECTED) — they narrow *coverage*, not *correctness*.

### Fixture categories (TASK-024)

SDD § 31 lists 11 required fixture categories; TASK-024's own
acceptance criteria named only 7 (direct ESM, CommonJS, alias,
destructuring, transitive, unreachable, dynamic). `typescript-paths`,
`exports`, `conditional-exports`, and `multiple-versions` remain the
pre-existing placeholder directories under `fixtures/`, not yet built
out into complete, asserted-on projects.

### Multiple/nested package versions (TASK-024, TASK-028)

`checkReachability()` (`src/analysis/verdict.ts`) resolves a rule's
`target.module` from the scanned project's own `package.json`. This
works correctly for a hoisted transitive dependency (the common case —
see the `transitive` fixture) but not for a *non-hoisted*, nested
install of the same package at a different version. The call graph
itself resolves nested installs correctly during traversal; only this
independent re-resolution for rule-target lookup doesn't yet search
across multiple installed versions. Deferred alongside the
`multiple-versions` fixture above.

### CommonJS `exports.foo = <renamed identifier>` (TASK-014/017)

`exports.foo = someOtherlyNamedFunction;` (where the assigned value's
own name differs from the property name) is not specially reconciled —
only the common `exports.foo = function foo() {}` /
`exports.foo = foo;` (same name) forms are. Documented originally in
the TASK-015 completion report.

### Re-exports are not chased (TASK-018)

`export { x } from "./y";` is recorded in the module model but not
followed to `./y`'s own definition of `x` when building the call graph
— a re-exported symbol is not currently attributable to its ultimate
implementation.

### Path-traversal hardening is scoped to entrypoints (TASK-028)

`analysis.entrypoints` and package.json `main`/`bin` resolution are
hardened against escaping the project root (a real, exploitable gap
found and fixed in TASK-028). `rules.files` and `--config` are not —
they are lower-risk (operator-facing, and reading an arbitrary YAML
file as data carries far less exposure than statically parsing an
arbitrary file as source), and legitimately benefit from supporting
absolute paths (e.g. an organization-wide shared rules file kept
outside any given project).

### Resource limits bound overshoot, not an exact cutoff (TASK-028)

`buildCallGraph`'s `maxFiles`/`maxGraphNodes`/`maxAnalysisSeconds`
enforcement can overshoot by up to one already-in-progress file's own
import count before the next check runs. Turns unbounded growth into
bounded growth; does not guarantee an exact stop.

### Performance instrumentation approximates parsing time (TASK-029)

`timings.parsingMs` is derived (`graphConstructionMs - resolutionMs`),
not independently measured — parsing and resolution are interleaved
within a single call-graph traversal with no existing seam to isolate
parsing alone. `resolutionMs` and `reachabilityMs` also overlap
slightly: `buildFinding`'s own incidental module-resolution calls (for
rule-target lookup) are counted in both.

### Provider/network failure is fatal for the whole scan (TASK-022)

A vulnerability-provider failure (e.g. OSV unreachable) aborts the
entire scan (exit code 4) rather than continuing with a partial
dependency set. This is a deliberate MVP choice — proceeding without
that data risks a result being misread as complete when it is not —
not an oversight. A future `--continue-on-provider-error` mode, if
wanted, is separate follow-up work.

## Rationale

Every item above was a scoped decision made against an explicit task's
own acceptance criteria, not a missed requirement. Consolidating them
here — rather than leaving them scattered across commit messages and
code comments — makes the MVP's actual coverage boundary discoverable
without spelunking through history.

## Consequence

- None of these limitations allow a false `NOT_AFFECTED` or silently
  drop a finding; each one, when hit, either narrows what could be
  analyzed (with a diagnostic explaining why — see TASK-026) or falls
  back to `UNKNOWN`.
- Each item above is a reasonable, self-contained starting point for a
  future task if real usage shows it matters in practice.
