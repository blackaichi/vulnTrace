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

### Premises, as verified

The five premises above were measured on the base, `03449a1`, with real
Node v22.11.0, before any change. Two of the decision record's statements
were true only in part (premises 1 and 2) and one was false (premise 4);
each is handled as the deviations below say.

### Measurements

**1. The boundary's edge, against real Node v22.11.0** (oracle harness;
kept as `tests/oracle/bl113-trust-boundary.*`). Each case is RWF-156's
mechanism; "called" is real Node's ground truth; the analyzer's answer is
the same on the base and the branch (no analyzer change).

| change | object | called | analyzer |
| --- | --- | --- | --- |
| `Array.prototype.constructor = C` (C's species a Proxy) | intrinsic prototype | yes | `NOT_AFFECTED` (B, 3 unknown edges): RWF-156 |
| `Object.defineProperty(Array, Symbol.species, …)` | a constructor's own property | yes | `NOT_AFFECTED` (B, 5): **RWF-161** |
| `paths` setter on `Object.prototype`, in the entry | intrinsic prototype | yes | `NOT_AFFECTED` (B, 5): RWF-156 |
| the same setter on `require("module").prototype` | Node's `Module.prototype` | yes | `UNKNOWN` |
| the same on `Object.getPrototypeOf(module)` | Node's `Module.prototype` | yes | `UNKNOWN` |
| the same on `module.constructor.prototype` | Node's `Module.prototype` | yes | `UNKNOWN` |

**2. Do BL-075, BL-081, BL-091 and BL-110's rules become redundant under
the boundary?** Method: a read-only sweep (a fresh-context subagent, with
file:line evidence) of the code that decides each rule, and of every
oracle case's store target in those tasks' suites, classified as an
intrinsic prototype, another builtin object, both, or neither. Result: no
whole rule exists only for a built-in prototype change (BL-081's core
escape rule ignores the target; BL-091's rules are about other builtin
objects). Three parts of rules do, in their code and in every case that
tests them:

- BL-075, RWF-112: `C instanceof E` is not inert for a plain-object `E`
  (`module-model.syntax.ts`, `isOwnBaseCallable`); all five `rwf112.*`
  cases change `Object.prototype`. For a derived-class or async-function
  `E`, a route outside the boundary is not established.
- BL-081: iterating an array literal or a string adds an unknown edge
  (`escape-row.ts`, `storeReadsUnseen`); the only reason is a replaced
  `Array.prototype[Symbol.iterator]`; its cost is `cost.for-of-primitives`.
- BL-110: most of the escape side of the `module.paths` allow-list
  (spread, conversions, non-mutating methods, `for…of`;
  `loader-constructs.ts`, `listPositionReason`), every case of which
  tampers `Array.prototype` or `Object.prototype`.

| suite | cases | intrinsic prototype only | other builtin | both | neither |
| --- | ---: | ---: | ---: | ---: | ---: |
| `bl075-builtin-reader-trust` | 21 | 7 | 10 | 0 | 4 |
| `bl081-builtin-replaced-without-name` | 102 | 3 | 83 | 1 | 15 |
| `bl091-builtin-store-reaudit` | 37 | 0 | 28 | 0 | 9 |
| `bl096-module-paths-read-only` (BL-110's) | 61 | 42 | 0 | 0 | 19 |

No rule was withdrawn (the decision record). Narrowing the three parts is
backlog `BL-124`: BL-081's and BL-110's guard only a `NOT_AFFECTED`;
BL-075's guards an attribution, which the boundary does not condition.

**3. Other open findings against the boundary** (the same sweep). Every
reproduced form changes a built-in prototype: RWF-102, RWF-113. Some
forms do: RWF-110, RWF-111, RWF-120, RWF-121 (the last by the class its
code names, not as reproduced). Incidental: RWF-074, RWF-157. The
boundary narrows only what a `NOT_AFFECTED` claims, and these are
attribution or `AFFECTED` records, so none moves (backlog `BL-123`, after
`BL-122`).

### Deviations from the specification

- **The boundary's objects are the ECMAScript intrinsic prototypes**, the
  narrower reading of the decision's "Node's builtin prototypes". It
  claims more, not less: Node's own `Module.prototype` is modeled
  (measurement 1); `URL.prototype`, `Buffer.prototype` and
  `EventEmitter.prototype` are named as not covered and put to the owner
  in `BL-122`.
- **The boundary narrows only what a `NOT_AFFECTED` claims**, as the
  decision record says, and the contract now states it ("What it is
  not"). Whether it should also condition edges, attributions and
  `AFFECTED` paths is put to the owner in `BL-122` (audit round 1, F2).
- **The records were in `bl096-module-paths-read-only` and
  `bl114-require-esm-inherited-source`** (twelve), not in
  `bl111-loader-inherited-reads` (none), as the decision record said.
- **The disclosure reaches the HTML report only**, as every exclusion
  does; the JSON result carries none (lane D's `D-1`). A text entry, so
  no output-schema question arose.
- **A register status and a record kind were added** to move the findings
  without calling them open or fixed: the "documented limitation"
  category (`scripts/scorecard-sources.mjs`) and the trust-boundary case
  (`src/testing/trust-boundary-case.ts`).
- **No row was cancelled.** BL-083 keeps its scope: its forms are
  attribution defects the boundary does not condition; a realm premise
  the boundary does not touch is recorded on RWF-113. BL-082, BL-090 and
  BL-115 are unchanged, each with its reason in its note.
- **IDs.** `node scripts/next-id.mjs` printed RWF-901 and BL-123, past
  BL-119's task file mentions of the synthetic `RWF-900` and of example
  ids (`RWF-161`, `BL-122`). RWF-901 lies in the range the script's own
  header reserves for synthetic test ids, so this task took RWF-161 and
  BL-122 to BL-125; backlog `BL-125` records the script's behaviour.

### Independent audit

- **Round 0:** not applicable: the task fixes no reproduced defect and
  adds no analyzer rule.
- **Round 1** (fresh context; the task file, ADR 0010's four sections,
  the seven findings, the diff): **`BLOCKED`**. It confirmed that the
  contract stays within the decision, that all twelve converted cases
  change an intrinsic prototype, RWF-161 against real Node, and the
  records' drift and status checks. Eight findings, all introduced by
  this change and in scope, all fixed:
  - F1: a "documented limitation" cell could say part is still open, or
    cite a section that states no boundary. Fixed: the `INCOMPLETE_FIX`
    words refuse it; only `TRUST_BOUNDARY_SECTIONS` may be cited, each
    checked against the contract; every limitation needs a trust-boundary
    case. Tests: `findings-status.test.ts` (the auditor's three inputs,
    the section check), `trust-boundary-case.test.ts` ("every documented
    limitation is reproduced").
  - F2: the records applied the boundary to attributions and an
    `AFFECTED` (RWF-113, RWF-111, RWF-121, RWF-102; BL-083, BL-090,
    BL-123). Fixed: reworded; BL-083's title restored; the contract
    states that the boundary narrows only a `NOT_AFFECTED`; the question
    goes to `BL-122`.
  - F3: this Account was empty. Fixed: this section.
  - F4: Node's other builtin prototypes were not named. Fixed: named in
    § 1's not-covered list and in `BL-122`; a deviation above.
  - F5: the disclosure called every change "prototype pollution". Fixed:
    the contract and the disclosure say any change, including a polyfill,
    a shim or a freeze; for the owner under "Needs human review".
  - F6: D-17's limitation bullet was unchecked. Fixed: its ids in code
    spans, asserted equal to the register's limitations
    (`open-debts-summary.test.ts`).
  - F7: an `evidence.ts` comment said such changes are not modeled.
    Fixed: "modeled only in part".
  - F8: RWF-161's list of constructors with an own `Symbol.species` was
    incomplete. Fixed: RWF-161 and `BL-122` list all six, unmeasured.

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

**The project owner accepted option (C), the trust boundary, on 2026-10-27** (ADR 0010, "Decision record — BL-111", recorded by BL-116). Moved after BL-121 by the owner's order of that day. Scope, as the decision record states it: the SOUNDNESS-CONTRACT § 1 amendment; the disclosure; RWF-156, RWF-158 and RWF-160 moved to the documented limitation; their open-soundness-defect records kept as the boundary's documented cases; `BL-082`, `BL-083`, `BL-090` and `BL-115` re-examined. The boundary's reach beyond builtin prototypes is not decided: bring the contract text to the owner first if it reaches further. The option (B) implementation this row described before the decision is in ADR 0010's "Proposed decision — BL-111" and "Note — task BL-114"
