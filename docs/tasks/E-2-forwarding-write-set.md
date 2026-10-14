# E-2 — Forwarding hops consult the write set

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: E-2
- **Branch**: `e-2-forwarding-write-set`
- **Base SHA**: `4bb6c86a864484ac8178262a775685d63e75cc19` (E-1's merge, PR #102)
- **Commits**: filled in by the last commit
- **Superseded by**: —

## Project context

Second task of lane E (`docs/REMEDIATION-PLAN.md` § 5a, order 21;
ADR 0009 § 8's E-2 row: "forwarding hops consult the write set
(final-object writes only)", `export-forwarding.ts`, the `call-graph.ts`
consumer unchanged). ADR 0009 § 1 ends: "The same determination gates the
forwarding hop and the entrypoint root requirement." E-1 built that
determination (`exportWriteSet`, `applyExportWriteSet` in
`src/code-intelligence/module-model.ts`); plan § 5a "What E-1 binds"
requires E-2 to consume it, never to re-derive an export's write from one
spelling.

The finding the row names is PRM-61 (FINDINGS; reproduction in
`docs/audits/2026-09-premise-sweep-round-2.md` § 5): the CommonJS hop
(`commonJsExportForwardingHop`) takes the first own binding of a name and
otherwise forwards the whole-module re-export, so a write the hop does not
see can leave it pointing at a value Node no longer publishes.

### Premises verified before the task file was written (AGENTS.md § D)

Measured on the base `4bb6c86` with the real-Node oracle harness (a
throwaway probe of 48 shapes over E-1's loud fixture, plus model-level
dumps of `buildModuleModel` and `exportForwardingHops`):

1. **PRM-61's two reproduced shapes no longer reproduce.** E-1's
   write-set collapse (`applyExportWriteSet`) already leaves at most one
   named binding per name on the decided path and drops a stale-object
   write: `exports.run = require("./safe").run; module.exports =
   require("./danger");` is `UNKNOWN` (was `NOT_AFFECTED`), and the
   false-`AFFECTED` order is `UNKNOWN`; `module.exports =
   require("./danger"); exports.run = require("./safe").run;` is a correct
   `AFFECTED`. The ADR row's premise ("PRM-61 both shapes … flip") is
   therefore stale: E-1 closed them through the model the hop reads, not
   through the hop. Recorded as a status update to PRM-61, with these
   shapes kept as regression cases.
2. **The hop still does not consult the write set, and that is a live
   defect (RWF-105).** When this file has NO named binding for a name but
   its write set withdraws the name (`ExportWriteSet.withdrawn`: a
   destructuring, `for-of`, compound or `delete` write, an alias of the
   final object, `Object.assign`/`defineProperty`/`Reflect.set`, a
   deferred write), the hop falls through to the whole-module re-export and
   forwards the name to the re-exported module -- whose object this file
   just wrote. Five live false `NOT_AFFECTED`s (`[module.exports.run] =
   […]`, `({ run: module.exports.run } = …)`, `for (module.exports.run of
   …)`, `const e = module.exports; e.run = …`, `module.exports.run ||= …`,
   each after `module.exports = require("./safe")`) and one false
   `AFFECTED` (`module.exports = require("./danger"); Object.assign(
   module.exports, { run: require("./safe").run })`, a fabricated
   edge into `danger.js`). Six more spellings are `UNKNOWN` only through
   the call graph's `escaped_value` backstop.
3. **Every plain `=` write has a binding.** `void (…)`, a comma, a block,
   a label, a loop body, a nested assignment and a chained assignment each
   yield a (withdrawn) named binding, which the hop already refuses on; the
   gap is exactly the withdrawn names with no binding.
4. **The undecided whole-module path** (BL-064's RWF-100 withdrawal)
   leaves duplicate named bindings uncollapsed, but every one measured is
   withdrawn, so the hop's first-match `find` is harmless there today --
   by a property of the model the hop does not check.
5. **The ESM hop** reads `export { x } from "y"`, an immutable binding no
   CommonJS write set reaches; nothing to consult.

## Task

### Problem

`commonJsExportForwardingHop` answers "which other module's export does
`exportName` forward to?" from `model.exports` alone. The whole-module
fallback (`module.exports = require("./lib")` forwards every name) is
taken for any name with no own binding, although E-1's write set may say
this file writes that name onto the very object it forwards.

### Why it matters

Soundness: a live false `NOT_AFFECTED` (family C) and a fabricated edge
(false `AFFECTED`). Defect class C (multi-valued provenance collapsed: the
forwarded object's property is treated as holding the far module's value
alone) on the producer side of lane E's invariant.

### What to do

1. Reproduce first: an oracle suite `tests/oracle/e2-forwarding-write-set`
   (loud fixture, both controls, real-Node ground truth) with RWF-105's
   shapes, PRM-61's shapes as regression cases, and precision controls (a
   stale `exports`/`this` write, a write of another name); unit tests in
   `export-forwarding.test.ts`. Show the RWF-105 cases failing on the base.
2. E-1's `applyExportWriteSet` records, on the surviving whole-module
   re-export binding, the names the write set withdraws
   (`ExportBinding.forwardingWithdrawnNames`); every path that keeps a
   whole-module re-export origin goes through it.
3. `commonJsExportForwardingHop` refuses the whole-module forward for a
   withdrawn name, and refuses when the record is absent (fail-closed); the
   own-binding branch consults every own binding of the name, not the
   first, and refuses unless they agree.
4. Measure: the three differentials (`node scripts/differential.mjs`), the
   validation baseline, and the forwarding shapes' precision on the
   corpora.
5. Records: FINDINGS (RWF-105 found and fixed; PRM-61 status update),
   ADR 0009 (a note on E-2's row: what was closed where), plan § 5a,
   OPEN-DEBTS, backlog, progress, scorecard.

## Boundaries

### Do not touch

- `entrypointRootCandidates`'s requirement logic (E-3); `commonjs-reexports.ts`
  origins, writes by OTHER modules and `symbol-binder.ts` (E-4); ESM→CJS
  default interop (E-5); the `call-graph.ts` and `verdict.ts` consumers
  (ADR 0009 § 8: "consumer unchanged").
- E-1's decisions (`decide`, the identity walk), the cutoff and the
  completion grammar.
- RWF-103 / RWF-104 (BL-074, BL-075: awaiting the owner's decision).
- Other tasks' worktrees.

### STOP conditions

- A fix that needs a consumer change in `call-graph.ts` or `verdict.ts`.
- A verdict that moves into `NOT_AFFECTED` anywhere in the differential.
- A precision cost beyond the withdrawn names on whole-module re-exports.

## Acceptance criteria

- [ ] RWF-105's five false `NOT_AFFECTED` shapes and its false `AFFECTED`
      shape are `UNKNOWN` against real Node's ground truth, and failed on
      the base.
- [ ] PRM-61's shapes are pinned as regression cases at their sound
      verdicts.
- [ ] The precision controls (a stale `exports` or module-scope `this`
      write after the replacement; a different name withdrawn) keep their
      verdicts.
- [ ] The hop refuses when the write-set record is absent, and when own
      bindings of a name disagree (unit tests).
- [ ] Each mutation of the new authority is caught by a named test.
- [ ] The two ADR 0009 § 8 forwarding tests stay green (as BL-064 left them).
- [ ] Differentials reported separately; no verdict into `NOT_AFFECTED`;
      validation baseline unchanged (five known failures, OPEN-DEBTS D-09).
- [ ] Records updated; scorecard regenerated.

## Gates

The full set in `AGENTS.md` section I, unrelaxed, plus
`npm run test:validation` (local) compared case by case with OPEN-DEBTS
D-09, and `node scripts/differential.mjs` against the base.

## Report

In the format of `AGENTS.md` section J, in that order.
