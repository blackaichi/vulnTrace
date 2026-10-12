# BL-063 — The module-evaluation cutoff is MAY for expressions too

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-063
- **Branch**: bl-063-may-execute-operand-cutoff
- **Base SHA**: fdd4136819ebe4eb7298a7cade9cce59f4a957bf
- **Commits**: —
- **Superseded by**: —

## Project context

Discovered in [`RWF-050-repro`](RWF-050-repro-may-execute-operand.md)
(PR #97, merged 2026-10-12), which reproduced RWF-050 against real Node
and classified it: a live false `NOT_AFFECTED` with a complete family C
proof, defect class C, P0, lane E (ADR 0009 § 1 clause 3). Ordered before
`E-1` (backlog § 1). Specification: this file, the backlog row, and
[`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a, "RWF-050-repro
additions" ("What RWF-050-repro binds").

**ADR 0009 § 8 decision.** E-1's precision acceptance lists every
RWF-013 … RWF-028 "keeps authority" control as "must stay green",
including the MAY rows this task must invert (FINDINGS RWF-050,
correction 3). The project owner said "go" without choosing between the
announced options. This task takes the recommended option **(a)**:
it amends ADR 0009 § 8 in this pull request, by a decision record, so
that E-1's precision acceptance names those controls as they stand after
`BL-063`. The amendment is called out for review in the report and the
pull request, and can be dropped (option (b)) without touching the fix.

### Premises, to check against `main` at the base SHA (`AGENTS.md` § D)

- `mayEndModuleEvaluation` (`src/code-intelligence/module-model.ts`)
  answers a MAY question for statements (it walks statement containers,
  so `if (FLAG) bail();` is a cutoff) but consults RWF-026's MUST relation
  (`necessarilyEvaluatesAbruptly`) for expressions. To be read.
- 13 MAY spellings are live false `NOT_AFFECTED`s, pinned as
  open-soundness-defect records in
  `tests/oracle/rwf050-may-execute-operand.*`. To be re-run.
- A prototype of the fix fails 48 unit tests, all "keeps authority"
  controls for MAY positions, with two `break`-guarded loop shapes and
  one nested instance-field row as exceptions (FINDINGS RWF-050,
  "Mutation"). To be re-measured; not assumed.

## Task

### Problem

A definitely-abrupt call (`isDefinitelyAbruptCall`: an exact,
non-reassigned local callee that can only throw) that MAY be evaluated at
module time, such as `FLAG && bail();`, is not a module-evaluation
cutoff. A later export write therefore stays authoritative, though real
Node can stop before it.

### Why it matters

Soundness: a false `NOT_AFFECTED` with a complete family C proof. Defect
class C: the export holds the early write's value on the loads where the
operand fires, and the analyzer keeps only the later write.

### What to do

1. Failing first: turn the 13 RWF-050 records into assertions of
   `UNKNOWN` and add oracle cases for the other MAY positions the new rule
   reaches (class-definition-time and `new` spellings), plus precision
   controls that must keep `NOT_AFFECTED` (a call in a function body, an
   instance field initializer, a caught call). Show them failing on the
   base.
2. The fix, `module-model.ts` only: any module-time evaluation of a call
   or construction `isDefinitelyAbruptCall` proves, outside a function
   body and an instance field initializer, and not caught within its
   top-level statement, is a cutoff. RWF-026's MUST relation stays as it
   is.
3. Invert the MAY "keeps authority" rows of the RWF-016 … RWF-028 suites
   in the same change, with real-Node grounding for each new claim. Keep
   the `break`-guarded loop rows only by a rule justified against real
   Node; otherwise record them as a precision cost, never as a claim that
   Node reaches the call.
4. Records: FINDINGS RWF-050 status update (fixed) and corrections to the
   RWF-026 `REFUSED` doc comment and ADV2-086's fixture comment, ADR 0009
   § 8 decision record (option (a)), REMEDIATION-PLAN § 5a "BL-063
   additions", OPEN-DEBTS D-17, backlog § 2, progress, scorecard.

## Boundaries

### Do not touch

- any production file other than `src/code-intelligence/module-model.ts`;
- which calls are proven abrupt (`isDefinitelyAbruptCall`'s identity
  proof): this task changes only *where* a proven call counts;
- E-1's write set and observation-point rule (lane E);
- another task's worktree.

### STOP conditions

- the fix moves a verdict that is not a RWF-050 shape toward
  `NOT_AFFECTED`, or moves any `AFFECTED`;
- a "keeps authority" row cannot be classified against real Node;
- the performance smoke needs a threshold change.

## Acceptance criteria

- [ ] Every RWF-050 open-soundness-defect record is deleted and its case
      asserts `UNKNOWN`, with real Node calling the target
- [ ] New MAY spellings beyond the 13 and precision controls are oracle
      cases with loud fixtures, both controls and real-Node ground truth
- [ ] Each new test fails on the base commit and passes after the fix
- [ ] Every inverted "keeps authority" row is grounded against real Node
      or recorded as a precision cost; none asserts a wrong verdict
- [ ] A mutation that removes the new rule is caught by a named test
- [ ] Only `module-model.ts` changed under `src/` (besides tests)
- [ ] ADR 0009 § 8 carries a decision record (option (a))
- [ ] Graph, proof and verdict differentials reported separately; no
      verdict moves toward `NOT_AFFECTED`
- [ ] All gates green; validation at exactly the five documented failures

## Gates

The full set in `AGENTS.md` section I, unrelaxed.
`npm run test:validation` at exactly RWB-03, RWB-05, RWB-09b, VAL-002,
VAL-003. `node scripts/differential.mjs` against the base. Regenerate the
scorecard.

## Report

In the format of `AGENTS.md` section J. Item 5 names the ADR 0009 § 8
option taken on the owner's unqualified "go".
