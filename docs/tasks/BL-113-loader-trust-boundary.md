# BL-113 — Implement BL-111's decision: the trust boundary over the runtime's built-in prototypes (RWF-156, RWF-158, RWF-160)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-113
- **Branch**: `bl-113-loader-trust-boundary`
- **Base SHA**: `03449a179829099fc4d11d6d94f871dc832668b6` (BL-121's merge, PR #127)
- **Commits**: <!-- filled in by the last commit (READY_FOR_REVIEW) -->
- **Superseded by**: —

## Specification

ADR 0010, "Decision record — BL-111: Node's own loader through a
replaceable builtin (project owner, 2026-10-27)": option (C), the trust
boundary. Its "What it changes, and who does it" list is this task's
scope:

1. amend SOUNDNESS-CONTRACT § 1 with the boundary's text;
2. disclose the boundary through the scope disclosure
   (`SUPPORTED_MODEL_EXCLUSIONS`, `src/domain/evidence.ts`); more than a
   text entry is an output-schema question for the owner;
3. move RWF-156, RWF-158 and RWF-160 to the boundary's documented
   limitation, by appended status notes;
4. decide how their open-soundness-defect records are kept: as the
   boundary's documented cases, never as a pinned expected verdict;
5. re-examine `BL-082`, `BL-083`, `BL-090` and `BL-115` against the
   boundary: a row whose only premise is a changed builtin prototype is
   re-scoped or cancelled, with its reason;
6. measure, not assume, whether a rule of BL-075, BL-081, BL-091 or
   BL-110 becomes redundant under the boundary; withdraw none.

Not decided by the record, and not decided here: the boundary's reach
beyond builtin prototypes (globals, builtin module exports, a builtin
constructor's own properties); which Node releases the contract covers
(`BL-115`).

## Premises to verify (AGENTS.md § D)

Measured on the base, `03449a1`, with real Node v22.11.0:

1. **`SUPPORTED_MODEL_EXCLUSIONS` is "the scope disclosure the result
   already carries".** In part. It is the single source of the declared
   model's exclusions (`src/domain/evidence.ts:326`) and the HTML report
   renders it (`src/cli/html-report.ts`, `renderScope`). The JSON result
   and `schemas/result.schema.json` carry no exclusion at all, for any
   entry. A text entry therefore discloses the boundary exactly where
   every other exclusion is disclosed; a JSON disclosure is the existing
   gap lane D's `D-1` owns, not this task's.
2. **The open-soundness-defect records are
   `tests/oracle/bl111-loader-inherited-reads.*` and
   `tests/oracle/bl114-require-esm-inherited-source.*`.** In part.
   `bl111-loader-inherited-reads` holds no such record (its `source`
   cases are `UNKNOWN` with the analyzer). The records are twelve: six
   RWF-156 cases in `tests/oracle/bl096-module-paths-read-only.cases.ts`
   (`audit2.*`, `audit3.species-constructor-store`, `audit4.*`) and six in
   `bl114-require-esm-inherited-source.cases.ts` (RWF-156 one, RWF-158
   two, RWF-160 three).
3. **"Documented limitation" is a status the register can hold.** No.
   The findings status vocabulary is closed (`FINDINGS_STATUS_VOCABULARY`,
   `scripts/scorecard-sources.mjs`): `open`, `partlyOpen`, `fixed`. A
   new value needs a category that cannot overstate closure, and the
   consumers of the categories follow (the scorecard's § 8,
   `open-soundness-defect.ts`, `open-debts-summary.test.ts`).
4. **The boundary, as worded ("no loaded file changes Node's builtin
   prototypes"), covers RWF-156's class.** Not wholly. A probe on the
   base, which this task keeps as an oracle case:
   `Object.defineProperty(Array, Symbol.species, { get() { … } })` changes the `Array` constructor's own
   property, not `Array.prototype`, and Node's loader's
   `ArrayPrototypeSlice` honours it: real Node calls the target, the
   analyzer answers `NOT_AFFECTED` (family B). It is outside the decided
   reach, so it stays an open defect (registered by this task), and it is
   an input to the reach decision.
5. **Node's own prototypes.** Probe: a `paths` setter on `Module.prototype`
   (reached as `require("module").prototype`, `Object.getPrototypeOf(module)`
   or `module.constructor.prototype`) is `UNKNOWN` with the analyzer; the
   same setter on `Object.prototype` is RWF-156's `NOT_AFFECTED`. So
   Node's own loader objects are modeled, and a boundary worded over the
   ECMAScript intrinsic prototypes changes no verdict on them.

## Boundaries

Do not touch: any analyzer rule (decision record: no rule of BL-075,
BL-081, BL-091 or BL-110 is withdrawn); the JSON output schema; the
boundary's reach beyond builtin prototypes.

STOP conditions (`NEEDS_DECISION`): the contract text needs to reach
beyond the built-in prototype objects; disclosing the boundary needs more
than a text entry; a verdict moves.

## Acceptance criteria

- [ ] SOUNDNESS-CONTRACT § 1 states the boundary: what a `NOT_AFFECTED`
      assumes, the objects it covers (the ECMAScript intrinsic prototype
      objects) and what it does not cover, with the decision it comes
      from.
- [ ] `SUPPORTED_MODEL_EXCLUSIONS` carries the boundary as one text
      entry, and a named test fails when the entry is removed or drifts
      from the contract's wording.
- [ ] The register has a status value for a documented limitation whose
      category is never counted as fixed nor as open, and the scorecard
      reports it on its own.
- [ ] RWF-156, RWF-158 and RWF-160 carry appended status notes and the
      documented-limitation status.
- [ ] Their twelve open-soundness-defect records are kept as documented
      boundary cases: real Node's ground truth still asserted, the
      analyzer's exact result still compared (drift fails), the sound
      verdict outside the boundary stated, and no wrong verdict pinned as
      expected.
- [ ] `BL-082`, `BL-083`, `BL-090` and `BL-115` are re-examined, each
      with its reason recorded in its row's note.
- [ ] The redundancy of BL-075, BL-081, BL-091 and BL-110's rules under
      the boundary is measured and reported; no rule is withdrawn.
- [ ] The live route outside the boundary (premise 4) is registered: a
      finding, an open-soundness-defect record and a backlog row.
- [ ] Graph, proof and verdict differentials are all zero.

## Gates and report

The full set of AGENTS.md § I. Expected differentials: zero on all three
(no analyzer change). Validation baseline unchanged (OPEN-DEBTS D-09).

## Account

<!-- Filled in while working. -->

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

**The project owner accepted option (C), the trust boundary, on 2026-10-27** (ADR 0010, "Decision record — BL-111", recorded by BL-116). Moved after BL-121 by the owner's order of that day. Scope, as the decision record states it: the SOUNDNESS-CONTRACT § 1 amendment; the disclosure; RWF-156, RWF-158 and RWF-160 moved to the documented limitation; their open-soundness-defect records kept as the boundary's documented cases; `BL-082`, `BL-083`, `BL-090` and `BL-115` re-examined. The boundary's reach beyond builtin prototypes is not decided: bring the contract text to the owner first if it reaches further. The option (B) implementation this row described before the decision is in ADR 0010's "Proposed decision — BL-111" and "Note — task BL-114"
