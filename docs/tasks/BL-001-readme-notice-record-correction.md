# BL-001 — Correct the false "no README notice" record

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-001
- **Branch**: bl-001-readme-notice-correction
- **Base SHA**: ace013910303c29b80b7cfe732702dc459c9c59f
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

`docs/tasks/BACKLOG.md`'s BL-001 row (added by task `task-0-workflow-bootstrap`,
sourced from "discovered in TASK-0") reads: "README soundness status
notice: until the remediation closes, treat `NOT_AFFECTED` as `UNKNOWN`",
with the note "The workflow prompt assumed this notice exists; it does
not. README's Status section says Foundation is closed and does not
mention OPEN-DEBTS D-17."

That premise is false, verified against the code (AGENTS.md § C, § D).
`README.md:80-88`, on `main` since commit `ae82d33`
("docs(README): factual current-status notice; correct two disproved
cache sentences", 2026-09-26, one day before `task-0-workflow-bootstrap`
started), already carries the notice:

> **Current status (not ready for production use).** ... Until the
> soundness remediation this work motivates has closed, **treat every
> `NOT_AFFECTED` this analyzer reports as `UNKNOWN`.**

with a link to `docs/OPEN-DEBTS.md` D-17. `task-0-workflow-bootstrap`'s
own task file (`docs/tasks/task-0-workflow-bootstrap.md`, "Premise
verification" section) asserts the same false claim: "**False.**
`README.md` has no such notice." Both are wrong on the same point.

One part of the surrounding claim is true and still stands: README's
`## Status` section (`README.md:102-108`) says "Foundation is closed" and
does not itself mention D-17 or the notice above it — a reader who jumps
straight to `## Status` does not see the caveat.

This is a documentation-only correction. No analyzer behaviour changes;
no verdict, proof or finding-accounting path is touched.

## Task

### Problem

Two committed records — the BL-001 backlog row and
`task-0-workflow-bootstrap`'s premise-verification note — assert that
`README.md` has no soundness-status notice. It has had one since before
either record was written. Left uncorrected, a later reader (human or
agent) trusts the record instead of the file and either re-adds a
duplicate notice or wastes time looking for a gap that is not there.

### Why it matters

Priority: explainability / project hygiene, not soundness — no verdict,
proof or finding-accounting path is touched, so this is not a defect
class A/B/C item (AGENTS.md § F). It cannot produce a false
`NOT_AFFECTED`. It is registered per AGENTS.md § C: "Before you rely on a
documented claim ..., verify it against the code ... If the document is
wrong, the correction is itself a finding. Report it."

### What to do

1. Register the false record as a finding in
   `tests/validation/FINDINGS.md`: a status-table row `RWF-053` (next
   free ID) and a `##` section, modelled on RWF-052's format (a record
   that states something false about the repository's own documentation).
2. Correct `docs/tasks/BACKLOG.md`'s BL-001 row: it cannot claim the
   notice needs writing. Rewrite its Notes to state what is actually
   missing (the `## Status` section does not point to the notice above
   it) and mark the row `MERGED` once this task closes it, per the
   backlog's own bookkeeping rule.
3. Append a dated **Corrections** section to
   `docs/tasks/task-0-workflow-bootstrap.md` (it is `READY_FOR_REVIEW`
   / executed, so its original text is not rewritten — `docs/tasks/README.md`,
   "Once executed, a task file is not rewritten"), naming what was wrong,
   what was measured instead, and pointing to RWF-053.
4. Correct `docs/progress.md`'s "Known limitations" section, which
   currently repeats the same false claim ("The README does not say this
   yet (backlog `BL-001`)").
5. Close the actual, narrower gap: edit `README.md`'s `## Status` section
   so it points to the existing notice / D-17, instead of reading as an
   unqualified "Foundation is closed". Do not duplicate the notice; add a
   pointer.
6. Regenerate the scorecard if `node scripts/generate-scorecard.mjs
   --check` reports drift.

## Boundaries

### Do not touch

- The existing notice text at `README.md:80-88` — it is correct; only add
  a pointer to it from `## Status`, do not rewrite or move it.
- `docs/tasks/task-0-workflow-bootstrap.md`'s original body text (append
  only).
- Any other backlog row, task file, ADR, or `docs/OPEN-DEBTS.md` entry.
- Any `src/` file — this task touches documentation and records only.
- The locked worktree `.claude/worktrees/rwf-046-require-binding-authority`
  and its branch.

### STOP conditions

- If `README.md`'s notice or `## Status` section has changed since this
  task file's premise section was measured (re-check
  `git log -p -- README.md` before editing), stop and re-verify before
  writing.
- If regenerating the scorecard shows an unrelated drift (not caused by
  this task's edits), stop and report rather than absorb it silently.

## Acceptance criteria

- [ ] `tests/validation/FINDINGS.md` has a new `RWF-053` status-table row
      and `##` section describing the false "no README notice" claim in
      both the BL-001 backlog row and `task-0-workflow-bootstrap.md`.
- [ ] `docs/tasks/BACKLOG.md`'s BL-001 row no longer asserts the notice is
      missing; it is set to `MERGED` with corrected notes, and the
      previous task's row (`TASK-0`) is unaffected (already `MERGED` from
      TASK-0's own bookkeeping — verify, do not re-set).
- [ ] `docs/tasks/task-0-workflow-bootstrap.md` has an appended, dated
      Corrections section; its original body is untouched.
- [ ] `docs/progress.md` no longer states that the README notice does not
      exist.
- [ ] `README.md`'s `## Status` section points a reader to the existing
      notice / D-17 instead of reading as an unqualified "closed".
- [ ] `node scripts/check-docs.mjs` and
      `node scripts/generate-scorecard.mjs --check` pass.
- [ ] All gates in AGENTS.md § I pass (see Gates below).

## Gates

The full set in `AGENTS.md` § I, unrelaxed. This task changes no analyzer
behaviour, so no graph/proof/verdict differential applies (nothing to
diff against `main`); the report states this explicitly rather than
fabricating zero-valued differentials. `npm run test:validation`'s
baseline (OPEN-DEBTS D-09: `RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`,
`VAL-003`) is expected unchanged, since nothing under `src/` is touched.

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5), in exactly
that order.
