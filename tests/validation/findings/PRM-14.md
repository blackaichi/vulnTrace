| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-14 | `vuln-lib` (synthetic fixture) | Loose equality (`==`/`!=`) is evaluated as if it were strict, pruning a branch real Node does not prune | false NOT_AFFECTED — see below | **Fixed** (A-5a) — see below |

## PRM-14 — Loose equality (`==`/`!=`) is evaluated as if it were strict, pruning a branch real Node does not prune

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** B
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

`evaluateConstantBoolean` folds `1 == "1"` the same as `1 === 1`, pruning the branch containing `lib.parse("x")` as dead code, although loose equality across types makes the branch live. Family C certifies the call unreachable; Node executes it.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-14`) and § 4 (`loose-equality`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task A-5a, 2026-10-04): Fixed.** `evaluateConstantBoolean`
folds `==` and `!=` only for two literals of the same type, where loose
equality is strict equality; strict (in)equality is folded as before. A
pruned branch's sites now carry the no-edge proof `provably_dead_branch`
(ADR 0008 § 2's `ProvablyDeadBranch`), which replaces the unproven
`constant_folded_branch` account. Reproduced against real Node in
`tests/oracle/a5a-resolution-authority.test.ts` (`fold.*`): `1 == "1"`,
`1 != "1"` and `0 == ""` were false `NOT_AFFECTED` on the base and are
`AFFECTED` on the branch. `1 === 2` and `"a" == "b"` stay pruned
(`NOT_AFFECTED`, precision guards). Measured on the way: `literalValue`
reads TypeScript's normalized numeric text (`010` → `8`, `1_000` →
`1000`), so strict folding of numbers is exact.

---

