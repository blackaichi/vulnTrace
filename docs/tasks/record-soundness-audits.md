# record-soundness-audits — Record the soundness audits in the repository

## Status

- **Status**: in-progress
- **Branch**: record-soundness-audits
- **Base SHA**: d42c6ba9d6dc46c79e5b69cd40212c1021832825
- **Commits**: (filled in when done)

## Project context

Three read-only investigations reproduced defects end to end against real
Node at commits `ea5d25b` (independent audit) and `62b52b9` (both
premise-sweep rounds): an independent audit (`AUD-01`…`AUD-16`) and two
rounds of a comment-premise sweep (`PRM-12`…`PRM-116`, with `PRM-01`…`PRM-10`
KNOWN aliases of `AUD` findings and `PRM-11` a new surface of `RWF-047`).
None of these findings is in `tests/validation/FINDINGS.md` yet, so
`docs/SCORECARD.md` cannot see them, and the README's "never a false
`NOT_AFFECTED`, never a silently dropped finding" guarantee is false on
`main` as things stand. This task is documentation only: register every
reproduced finding, correct two stale/false pieces of prose the audits
found, and make the project's public guarantees describe the measured
state.

Authoritative sections governing this task: `AGENTS.md` § C (documents are
claims to verify), § D (premise verification), § J (report format);
`tests/validation/FINDINGS.md`'s own `## Status` note on the classifier
(`scripts/scorecard-sources.mjs`'s `readFindingsRegister`); `docs/OPEN-DEBTS.md`
§ 3 (P1-B entry criteria, criterion 3 already recorded false by `D-16`)
and § 4 (P1-B initial direction).

**Premise checked and found stale:** the base SHA given for this task
(`62b52b9`) was main's tip when the two premise-sweep rounds were
written, but `main` advanced to `d42c6ba9d6dc46c79e5b69cd40212c1021832825`
(the `scorecard-status-classifier` follow-up, itself documentation/tooling
only) before this branch was created. That commit added missing
status-table rows for `RWF-023`…`RWF-041`, `RWF-048` and `RWF-049`, and a
`RWF-046b` pointer section — exactly the kind of "section with no row"
repair Step 2 of this task's prompt otherwise asks for. It did not touch
`RWF-026`, `RWF-045`, `RWF-046a`, `RWF-047` or `RWF-048 § 4f`'s prose, so
every specific correction and finding this task registers is unaffected;
only line numbers shifted. This branch is created from `d42c6ba`, not
`62b52b9`, per `AGENTS.md` § H ("branch from merged `main` only").

**Premise checked and found true:** `main` at `d42c6ba` contains the
scorecard classifier work (`generate-scorecard.mjs` fails on a
section/row mismatch; `src/testing/open-soundness-defect.ts` uses the
shared classifier).

## Task

### Problem

Roughly 70 reproduced defects (false `NOT_AFFECTED`, false `AFFECTED`,
silent drops, false reasons, a scan abort and a false disclosure
statement) exist on `main` and are undocumented. Several pieces of
committed prose are false premises the audits disproved. The README's
soundness guarantee and two cache-behavior sentences are false as written.

### Why it matters

Soundness is the top priority (`AGENTS.md` § E). `NOT_AFFECTED` requires
positive proof from exactly one proof family; every "false NOT_AFFECTED"
finding here means that proof was accepted without being valid. Recording
these findings does not fix them — it makes the soundness contract's
current violation visible and measurable, which `OPEN-DEBTS.md` § 3
criterion 5 requires ("every [debt] named, with why it is not a blocker").

### What to do

Committed verbatim under `docs/audits/`, with a short header (date, commit
audited, method, "findings registered in tests/validation/FINDINGS.md")
prepended to each: the independent audit, premise-sweep round 1, and
premise-sweep round 2. Every reproduced finding gets a status-table row
(Status: Open) and a `## <ID>` section in `tests/validation/FINDINGS.md`.
Two unnumbered mechanisms from round 1 are assigned `PRM-37` (tagged
template, no edge) and `PRM-38` (implicit protocol invocations — coercion,
thenable, iterator; round 2's `PRM-112`/`PRM-113` cover
`Symbol.hasInstance`/`Symbol.asyncIterator` separately). `RWF-026`'s
MAY-execute abrupt-operand gap is registered as `RWF-050`, status Open,
UNCLASSIFIED. `PRM-11` is appended to `RWF-047`, not given a new ID.
Two stale/false pieces of prose are corrected by appended text: `RWF-048`
§ 4f's "a non-identifier key resolves in NO position anywhere in the
engine" (false for string-literal keys), and the `RWF-046`/`RWF-046a`
mentions that "RWF-045 remains open" (RWF-045 has since merged).
`docs/OPEN-DEBTS.md` gets a new `D-17` entry for the audit programme, an
addendum to § 3 criterion 3 naming the new finding families, and a note
that P1-B capability work touching call-graph edges, export attribution
or receiver modeling is blocked until the soundness remediation this
audit motivates has closed. `README.md` gets a factual "Current status"
notice beside the soundness guarantee, and its two AUD-16-disproved cache
sentences ("gitignored", "never reused") corrected.
`docs/SOUNDNESS-CONTRACT.md` gets a short "Implementation status" note; the
contract itself is unchanged. `docs/SCORECARD.md` is regenerated, never
hand-edited.

## Boundaries

### Do not touch

`src/`, `tests/` (except `tests/validation/FINDINGS.md`), `fixtures/`,
`scripts/`, `schemas/`, `docs/adr/`, `docs/REMEDIATION-PLAN.md`, any
worktree but this branch's own. No fix is implemented; no existing test
is changed.

### STOP conditions

The classifier rejecting an ID format or status value (do not change the
classifier to make it pass); a report's text contradicting itself about a
finding's status or ID; an existing `FINDINGS.md` section already covering
a finding under another ID (report the duplicate, do not merge).

## Acceptance criteria

- [ ] Task file committed first, marked done at the end
- [ ] Three reports committed verbatim under `docs/audits/` with headers;
      every damaged passage marked `[text damaged in source]` and listed
- [ ] `PRM-37`/`PRM-38` assigned and stated; the `RWF-026` gap registered
      as `RWF-050`, UNCLASSIFIED
- [ ] Every listed finding (`AUD-01`…`16`; `PRM-12`…`38` FALSE; `PRM-60`…
      `67`; `PRM-101`…`116`) has a status row and a section with the
      required fields; no `AUD`/`PRM` ID renumbered
- [ ] `PRM-11` recorded under `RWF-047`, not as a new ID
- [ ] The three pinned tests (`symbol-binder.test.ts`,
      `verdict.negative-proof.test.ts` case 10b, `call-graph.test.ts`
      VT-213) are recorded on their findings, unchanged
- [ ] `RWF-048` § 4f and the stale `RWF-045` mentions corrected by
      appended text
- [ ] `OPEN-DEBTS.md`: new `D-17`; criterion 3 addendum; P1-B capability
      work stated blocked
- [ ] README guarantee carries a factual current-status notice; the two
      false cache sentences corrected
- [ ] `SOUNDNESS-CONTRACT.md` has the status note, contract unchanged
- [ ] Scorecard regenerated, not hand-edited
- [ ] Only permitted files changed; differentials zero; gates green;
      validation at the documented known failures
- [ ] Pushed; no PR; no merge; clean commit metadata

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Documentation only: all
three analyzer differentials (graph, proof, verdict) must be zero.
Validation must land on the documented known failures (`OPEN-DEBTS.md`
D-09), compared case by case.

## Report

In the format of `AGENTS.md` section J, in exactly that order.
