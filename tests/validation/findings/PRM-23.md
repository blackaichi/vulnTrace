| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-23 | `vuln-lib` (synthetic fixture) | A truncated module-load closure (`traversal_truncated`) does not block families B/C, missing a closure-widening hook outside the truncated file set | false NOT_AFFECTED — see below | **Fixed** (V-2) — see below |

## PRM-23 — A truncated module-load closure (`traversal_truncated`) does not block families B/C, missing a closure-widening hook outside the truncated file set

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** C (a closure that is a strict subset of the true reachable set is treated as though it were the whole one)
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** V — verdict corroboration

`traversal_truncated` is documented to block only family A, on the premise that "a truncated closure is accompanied by a truncated graph and the correct guard engages anyway". With `analysis.limits.maxFiles` set low relative to project size, a `require` hook installed in a file outside the truncated set (which patches a sibling file to load `vuln-lib` instead) is missed, and family C still certifies the real target unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-23`) and § 4 (`closure-truncation-hides-hook`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Pinned test:** `verdict.negative-proof.test.ts` "case 10b" restates the false premise in its own comment as the expected result; AGENTS.md § G forbids pinning it as expected going forward.

**Status update (task V-2, 2026-10-08): Fixed.** A closure that recorded
`traversal_truncated` now withdraws families B and C, as every other
closure incompleteness reason does (ADR 0011 predicate 1):
`callGraphNegativeProofBlockers` reports every reason the closure
recorded, and `invalidatesCallGraphNegativeProof`, whose one exclusion
this was, is deleted. A family-C candidate is `UNKNOWN`
(`traversal_truncated`, `budget_exceeded`). Family B was already blocked:
its corroboration requires `closure.complete` and answers first, so a
withdrawn family B reports `package_instance_absence_uncorroborated`, as
before.

Measured state on the base (`b7daa95`), before the fix: the defect was
live at `buildFinding` -- a real, attributed, unreached target under a
closure carrying only `traversal_truncated`, with `graphTruncated:
false`, was family-C `NOT_AFFECTED` (`verdict.negative-proof.test.ts`
case 10b, rewritten; the F4 family-C row
`closure_incomplete_traversal_truncated`, which was a CONTROL asserting
survival). The round-1 end-to-end reproduction no longer reached
`NOT_AFFECTED`: re-measured against real Node
(`tests/oracle/v2-traversal-truncated.test.ts`), it was `UNKNOWN` on the
base for two reasons that came after the round-1 report. The call graph
walks the hook and, since lane A, withdraws family C on it (the round-1
hook's call of the original `Module.prototype.require` is
`module_internal_load`; a `require.cache` write is `protocol_value`). And
task V-1's family-C closure corroboration (ADR 0011, Amendment V-1)
withdraws it when re-export-only modules are loaded and never evaluated
(`loaded_module_not_evaluated`); in production that guard covered a
truncated closure by a counting argument -- the closure truncates only
after loading exactly `maxFiles` files, so a passing check meant a graph of
at least `maxFiles` files, marked truncated because `scan.ts` passes both
walks the same limit. V-2 makes predicate 1 hold by itself, so the guard no
longer rests on how `scan.ts` wires the two limits. The real-Node case
`truncated.reexport-barrel.inert-hook` moves its reason from
`loaded_module_not_evaluated` to `traversal_truncated`; no verdict
moves: over the 139 corpus cases the graph, proof and verdict
differentials are all 0 (no corpus case truncates its closure; a zero
corpus differential is not evidence of soundness, OPEN-DEBTS D-12).

The premise this falsified -- VT-307e's "a truncated closure is
accompanied by a truncated graph ... (verified directly)" -- is corrected
at `callGraphNegativeProofBlockers`, `buildFinding`'s guard and
`domain/evidence.ts`'s family table.

---

