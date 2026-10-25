# BL-109 — An own `join` on an array is run by `Array.prototype.toString` on coercion: a protocol member (RWF-151)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-109
- **Branch**: `bl-109-join-protocol-member`
- **Base SHA**: `b256b6d2d515d3a4e5de09bb7335204c8a8150cc` (BL-094's merge, PR #116)
- **Commits**: —
- **Superseded by**: —

## Project context

Lane A, ADR 0008 § 2's protocol-member row (task A-4; the project owner's
decision of 2026-10-04 that added the iterator's `next`, `return` and
`throw`). The row accounts a member the runtime may invoke with no call in
the program -- a coercion, `await`, an iteration, `JSON.stringify` -- at its
DEFINITION, by its key (`src/code-intelligence/protocol-members.ts`,
`PROTOCOL_NAMES`): a possible edge from the owner that evaluates it.

`tests/validation/FINDINGS.md` RWF-151 (P0, a live false `NOT_AFFECTED`,
pre-existing; found by task BL-094's independent audit): coercing an
object whose chain reaches `Array.prototype.toString` calls the object's
own `join`, and `join` is not in the list, so neither a store
(`const a = []; a.join = f; String(a)`) nor a definition
(`{ __proto__: [], join: f }`) gets an edge.

The backlog row's fix direction: `join` is a protocol member, with its
precision measured; and the list is checked against every implicit
invocation the specification makes from an operation with no call in the
program, each confirmed against real Node. Adding a name to the list as
amended may need the project owner's confirmation (ADR 0008, "Decision
record — iterator methods and unreadable keys").

### Premises (AGENTS.md § D) — to measure before relying on them

- RWF-151's reproductions are live false `NOT_AFFECTED`s on the base, in
  the stored and the defined form, and through the admitted builtin
  positions (`Math.max`, `String`).
- `join` is not in `PROTOCOL_NAMES`.
- Which other names a builtin calls on its receiver from such an
  operation: not known; measured by this task, over every prototype Node
  exposes.

## Task

### Problem

A builtin reached by an implicit invocation may call a further member of
its receiver BY NAME. The protocol-member row knows the names the
operation itself invokes (`toString`, `valueOf`, `then`, …), not the ones
an inherited builtin it reaches invokes.

### Why it matters

Soundness: a live false `NOT_AFFECTED` (family C), the critical failure.
Defect class B (AGENTS.md § F): the binding is right, but the analyzer
assumes a coercion runs no program code where real Node calls the
receiver's `join`.

### What to do

1. **Tests first**: oracle cases against real Node, with task A-4's loud
   fixture and controls, failing on the base; the stored and defined
   forms, the trusted (admitted) builtin coercions, and guards for the
   shapes that already fail closed.
2. **Inventory**: a script that measures, against real Node, every member
   a builtin calls on its receiver by name from a coercion, an iteration,
   `await`, `JSON.stringify` and the admitted builtin positions, over every
   prototype and object Node's globals and builtin modules expose.
3. **The fix** in `protocol-members.ts`, for what the inventory confirms,
   with its precision measured.
4. **Mechanical admission** (ADR 0008's allowlist admission ruling) sees
   every hook the inventory finds: the builtin probe gains the argument
   kinds.
5. Unit tests pinning each rule; mutations each caught by a named test.
6. Differentials (graph, proof, verdict); validation against OPEN-DEBTS
   D-09.
7. Records: FINDINGS, ADR 0008, OPEN-DEBTS, backlog, progress, scorecard.
8. Independent audit (WORKFLOW § 1.5).

## Boundaries

### Do not touch

- RWF-070 (`constructor` / `Symbol.species` reached by `await`): recorded
  separately, for the project owner.
- The escape row's freshness proofs (`isProvenFreshObject`) and BL-094's
  pending decision (BL-107).
- Other worktrees and branches.

### STOP conditions

- The fix needs a name or a rule ADR 0008 § 2 does not have, whose
  precision cost is a product decision (`NEEDS_DECISION`).
- A corpus verdict moves away from its expected value.
- An independent-audit finding outside the protocol-member row.

## Acceptance criteria

- [ ] Every case in `tests/oracle/bl109-implicit-receiver-methods.cases.ts`
      answers its `expected` verdict with real Node's ground truth, and every
      case whose `base` differs from its `expected` failed on the base.
- [ ] The inventory is a committed script, and its result is recorded.
- [ ] Each rule is pinned by a named unit test, and each mutation of it is
      caught by one.
- [ ] The builtin probe builds every receiver hook the inventory confirms,
      and the admission test passes with them.
- [ ] The graph, proof and verdict differentials are reported separately; no
      corpus case moves away from its expected verdict.
- [ ] RWF-151 is recorded as fixed.
- [ ] The independent audit certifies the change, or its findings are
      handled per WORKFLOW § 1.5.

## Gates

The full set in `AGENTS.md` § I, unrelaxed, run once on the final HEAD with
`node scripts/gates.mjs`. `npm run test:validation`'s baseline is OPEN-DEBTS
D-09's six known failures.

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5).
