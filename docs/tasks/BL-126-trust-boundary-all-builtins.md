# BL-126 — Implement the owner's BL-122 decision: the trust boundary over every built-in object (RWF-161, RWF-162, RWF-163)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-126
- **Branch**: `bl-126-trust-boundary-reach-impl`
- **Base SHA**: `85195065dac5c173da8dd075d8566744cec2c5a8` (BL-129's merge, PR #131)
- **Commits**:
  - `docs(tasks): BL-126 task file — trust boundary over every builtin`
  - `feat(BL-126): the trust boundary over every built-in object`
  - `test(BL-126): RWF-161/162/163 as trust-boundary cases; true controls`
  - (this commit) `docs(BL-126): records; RWF-165 spilled from the audit, round 1`
- **Superseded by**: —

## Specification

- ADR 0010, "Proposed decision — BL-122: the trust boundary's reach",
  its options and its closing paragraph ("If a (W-…) option is accepted,
  backlog `BL-126` amends SOUNDNESS-CONTRACT § 1,
  `BUILTIN_PROTOTYPE_TRUST_BOUNDARY` and its test, moves RWF-161, RWF-162
  and RWF-163 to the documented limitation and their records to
  trust-boundary cases, and restates the exclusion above"), with "Note —
  task BL-128" correcting its inventory (RWF-164).
- **The project owner's decision (2026-11-03)**, as recorded in
  [`BL-129`](BL-129-loader-member-tries.md)'s Corrections: **(W-all)** —
  the boundary covers every builtin object (the four kinds O1–O4 and the
  intrinsic prototypes); SOUNDNESS-CONTRACT § 1's **"a change" is not
  narrowed**; the boundary conditions **`NOT_AFFECTED` only**. This task
  records it in ADR 0010 as a decision record (BL-129's Corrections,
  "BL-126 records the decision in ADR 0010").
- The ADR's requirement that **Node's loader objects stay modeled and
  inside the claim** under every (W-…) option, said explicitly in the
  amended text: the `module` builtin's exports object, `Module`,
  `Module.prototype`, `require` and its registries.
- The precedent for the mechanics is task
  [`BL-113`](BL-113-loader-trust-boundary.md): the contract section and
  its disclosure, held together by `src/domain/evidence.trust-boundary.test.ts`;
  documented-limitation status cells (`scripts/scorecard-sources.mjs`,
  `LIMITATION_CELL`); trust-boundary cases with a control
  (`src/testing/trust-boundary-case.ts`).

## Premises to verify (AGENTS.md § D)

1. **The decision is (W-all), not narrowed, `NOT_AFFECTED` only.** Read
   in BL-129's task file (Corrections, 2026-11-03) and the progress file
   on `85195065`; it is not yet in ADR 0010.
2. **The 14 live records are each a change to an object (W-all)
   covers.** `tests/oracle/bl113-trust-boundary.cases.ts`'s
   `outside.array-species-own` (O1) and `outside.url-prototype-pathname`
   (O2), and `tests/oracle/bl122-trust-boundary-reach.cases.ts`'s twelve
   (`o1.*`, `o2.*`, ten `o3.*` on `path`'s and `fs`'s exports objects).
   To check by reading each case's store.
3. **Node's loader objects are already modeled** where the ADR keeps
   them inside the claim. BL-113 measured a `paths` setter on
   `Module.prototype` by three routes as `UNKNOWN`
   (`bl113-trust-boundary.cases.ts`, `modeled.*`). That is no claim that
   every loader-object route is handled (open findings such as RWF-139,
   RWF-140, RWF-155 and RWF-157 are loader-object defects that stay open).
4. **The existing controls are "the same program without the change".**
   For `o3.*` they are identity wrappers (`control.o3-*-identity`): under
   (W-all) with "a change" not narrowed an identity wrapper is itself a
   change, so it is not the program without the change. To add controls
   that read the member without storing it.
5. **"A builtin object" reaches the objects the runtime holds in the
   four kinds** (`process.env`, `process.argv`, `path.posix`). The ADR
   names the four kinds; "(W-all) … covers every touched member,
   measured or not" includes `process.env`, whose contents the ES module
   loader reads (BL-128 results § 2: `WATCH_REPORT_DEPENDENCIES`, under
   `--watch`). Taken as covered: the reading that claims less (§ D, fail
   closed); narrowing is `BL-131`'s question. Stated for the owner.
6. **No other open finding is a live false `NOT_AFFECTED` the boundary
   now covers** beyond `BL-123`'s list (RWF-110, RWF-120). To check the
   open register.

## Boundaries

- No analyzer change in `src/` beyond the disclosure's text and the HTML
  report's note on it; no rule withdrawn (a change the analyzer sees
  still withdraws every proof it did).
- Not `BL-123` (the other findings' coverage per form), `BL-127` (fail
  closed on a visible store), `BL-131` (narrowing "a change") or
  `BL-115` (releases).
- STOP conditions: a premise that changes the decision's scope; a live
  record that (W-all) does not cover; wording that needs the owner (a
  narrowing of "a change", a loader object put outside the claim).

## Acceptance criteria

- [x] SOUNDNESS-CONTRACT § 1 states the boundary over every built-in
      object, "a change" not narrowed, `NOT_AFFECTED` only, and Node's
      loader objects inside the claim by name.
- [x] The disclosure (`SUPPORTED_MODEL_EXCLUSIONS`) carries it, quoted
      verbatim by the contract and held there by its test; the
      "loader monkey-patching" exclusion is restated to loader objects;
      the HTML report's note agrees.
- [x] RWF-161, RWF-162 and RWF-163 are documented limitations by
      appended status notes and status cells of `LIMITATION_CELL`'s shape.
- [x] Their 14 records are trust-boundary cases, each with a control that
      is the same program without the change, where real Node does not
      call the target; none is pinned as an expected verdict.
- [x] ADR 0010 has the decision record; OPEN-DEBTS D-17's summary lists,
      the backlog's § 2 rows, progress and the scorecard are updated.

## Gates and report

No verdict, proof or graph moves (no analyzer rule changes): the three
differentials are expected to be 0. The validation baseline is unchanged.

## Account

**Premises, as verified** (on the base `85195065`, real Node v22.11.0):

1. The decision: as stated, from BL-129's Corrections; recorded in ADR
   0010, "Decision record — BL-122" (its "Why" marked as the recorder's
   summary, audit round 1, I1).
2. Held. Each of the 14 records changes `Array[Symbol.species]` (O1),
   `URL.prototype` (O2), or a member of the `path` / `fs` exports object
   (O3); none also changes a loader object (both audit rounds checked;
   `require("path/posix") === require("path")` and the like in real Node).
3. In part. The `Module.prototype` routes are `UNKNOWN`, but a loader
   object reached through `process.mainModule.children` is not handled:
   **RWF-165**, reproduced by the audit (round 1, B1) and by this task as
   open-soundness-defect records (`tests/oracle/bl126-main-module-children.*`),
   spilled (pre-existing: no analyzer rule changed) to `BL-132` (P0). The
   texts that said loader objects are "modelled" now say they are analyzed
   as loader capabilities and a missed route is an open defect.
4. Held: the identity controls are a change under (W-all), so eight
   controls were added that run the program without the change (the
   member read, never stored; or nothing changed). Each asserts that real
   Node does not call the target.
5. Taken as covered, and flagged for the owner in the contract and the ADR
   ("Read by BL-126"). The list of kinds was made exhaustive (audit round
   1, B2): a module's `exports` object, an ES namespace object and
   `import.meta` are not built-in objects.
6. Not quite: besides RWF-110 and RWF-120, RWF-143's reproduced false
   `NOT_AFFECTED` rests on a change to a built-in object (audit round 2,
   L-a); added to `BL-123`'s note and the ADR record.

**Mutations** (each applied alone; each caught by a named test):
RWF-163's status cell reverted to Open (`bl122-trust-boundary-reach.test.ts`,
every `o3.*`); the boundary dropped from `SUPPORTED_MODEL_EXCLUSIONS`
(`evidence.trust-boundary.test.ts`, "exactly once"); "a change" narrowed to
"a function member" ("names every kind … and any change to one", and the
verbatim quote); the loader-object exception removed ("keeps Node's module
loader objects inside the declared model"); a boundary case's control
pointed at a case where real Node calls the target (`o3.fs-readfile-assign`).

**Independent audit.** Round 0 not applicable (no defect fixed, no rule
added). Round 1: `BLOCKED` — B1 (loader-object texts overclaimed; RWF-165
spilled), B2 (the objects' list not exhaustive), B3 (the HTML note said
"outside every claim"), L1–L5, I1, I2; all fixed or registered. Round 2:
`BLOCKED` — M1, introduced by this change: the HTML note and two
`evidence.ts` comments said a change the analyzer sees withdraws the
proof, which a visible `fs.realpathSync` replacement contradicts; fixed,
with a failing-first assertion in `src/cli/html-report.test.ts`. Its Low
findings: L-a (RWF-143, above), L-b (`progress.md`), L-c (two contract
statements held by `evidence.trust-boundary.test.ts`), L-d ("byte-identical"
corrected to "analyzer rules unchanged"); fixed. Round 2's fixes are not
audited again (WORKFLOW § 1.5). Three further live forms of RWF-165 the
round-2 auditor measured are in `BL-132`'s note, not yet cases.

**Deviations.** `node scripts/next-id.mjs RWF` printed RWF-904 (backlog
`BL-125`); the register's next id was RWF-165. `BL-132` is placed in § 1
right after this task, as a spilled P0.
