# BL-126 — Implement the owner's BL-122 decision: the trust boundary over every built-in object (RWF-161, RWF-162, RWF-163)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-126
- **Branch**: `bl-126-trust-boundary-reach-impl`
- **Base SHA**: `85195065dac5c173da8dd075d8566744cec2c5a8` (BL-129's merge, PR #131)
- **Commits**: (filled in by the last commit)
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

- [ ] SOUNDNESS-CONTRACT § 1 states the boundary over every built-in
      object, "a change" not narrowed, `NOT_AFFECTED` only, and Node's
      loader objects inside the claim by name.
- [ ] The disclosure (`SUPPORTED_MODEL_EXCLUSIONS`) carries it, quoted
      verbatim by the contract and held there by its test; the
      "loader monkey-patching" exclusion is restated to loader objects;
      the HTML report's note agrees.
- [ ] RWF-161, RWF-162 and RWF-163 are documented limitations by
      appended status notes and status cells of `LIMITATION_CELL`'s shape.
- [ ] Their 14 records are trust-boundary cases, each with a control that
      is the same program without the change, where real Node does not
      call the target; none is pinned as an expected verdict.
- [ ] ADR 0010 has the decision record; OPEN-DEBTS D-17's summary lists,
      the backlog's § 2 rows, progress and the scorecard are updated.

## Gates and report

No verdict, proof or graph moves (no analyzer rule changes): the three
differentials are expected to be 0. The validation baseline is unchanged.

## Account

(Filled in while working.)
