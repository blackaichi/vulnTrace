---
name: task-audit
description: Brief and run the independent fresh-context audit of a VulnTrace task — WORKFLOW § 1.5 (round 0 on the case list before the fix, then at most two rounds on the diff; findings as reproductions; CERTIFIED or BLOCKED; spilled versus never-spilled findings). Use when the task's backlog row says Audit required.
---

# Brief an independent audit (WORKFLOW § 1.5)

Applies `docs/WORKFLOW.md` § 1.5. That section is the rule; this file is
how to brief the auditor, and decides nothing it leaves open (task
`BL-120`).

## Launching it

The auditor has a **fresh context and no implementation history**. Launch
a new agent (the Agent tool, `subagent_type: general-purpose`), never a
fork: a fork inherits this conversation, which is exactly the history the
audit must not have. Give it files to read, not your conclusions.

## Round 0 — the case list, before the fix

For a task with `Audit: required` that fixes a reproduced defect or adds
a rule, once its failing-first cases and their controls fail on the base
and before the fix. Give it:

- the task file;
- the findings the task closes (`tests/validation/findings/<ID>.md`);
- the case list (the oracle cases' files under `tests/oracle/`).

Ask one question only: which forms, routes or values of the same class do
these cases miss? Its answers in scope become cases before the fix; the
others are registered (WORKFLOW § 2). Round 0 does not count toward the
limit.

## Rounds 1 and 2 — the diff

Give it:

- the task file;
- the ADR and `docs/REMEDIATION-PLAN.md` sections the task implements;
- the findings the task closes;
- the diff: `git diff <base SHA>...HEAD`, written to a file it reads.

The brief, in these words or close to them:

> Try to break this change. Do not rerun the test suites. Check: the
> exact authority source of every new or changed attribution; the three
> defect classes of `AGENTS.md` § F (A wrong binding identity, B wrong
> runtime-value semantics, C multi-valued provenance collapsed); whether
> anything fails closed to `UNKNOWN` as it must, and whether the change can
> manufacture a negative proof; `PackageInstance` identity (a sibling
> borrow, not merely a lost edge); the differentials, the mutations and
> the performance structure; whether the documentation overclaims.
>
> A finding that claims a wrong verdict, a fabricated edge or a silently
> dropped finding comes as a reproduction: the project's files; the
> ground-truth command (real `node`); the marker real Node calls or does
> not call; the analyzer's answer on the branch, and on the base if you
> ran it. A finding without one is reported as unconfirmed.
>
> Answer `CERTIFIED`, or `BLOCKED` with the findings.

## After each round

- An unconfirmed finding is reproduced by you before acting on it, as an
  oracle case (`src/testing/oracle/`, `tests/oracle/`).
- `BLOCKED` in scope: fix with a failing-first case, re-validate only
  what the fix can affect with `node scripts/gates.mjs --only <names>`
  (a PARTIAL run), and run the next round.
- `BLOCKED` out of scope or needing a decision: set the task `BLOCKED`,
  report, and stop.
- A round cut short without a verdict is run again and does not count.

## After round 2

No third round unless the owner asks. Every finding still open is:

- **spilled** when it reproduces on the base as well as on the branch:
  a findings record, an open-soundness-defect record
  (`src/testing/open-soundness-defect.ts`) when it is a live false
  `NOT_AFFECTED` or a silently dropped finding, and a backlog row (`P0`
  for those two). The task can then be `READY_FOR_REVIEW`;
- **never spilled** when the change introduced it (on the branch, not on
  the base): fixed in the task or the change withdrawn; otherwise the
  task is `BLOCKED`.

Round 2's fixes are not audited again; each has its own failing-first
case, and the pull request names them under "Needs human review". When
both rounds find instances of one class, the spilled row says so and
recommends a class-level design.

## Recording it

The rounds, verdicts and findings go into the task file's "Account" and
the pull request's "Independent audit" section; each spilled finding with
its backlog row, and the last round's verdict as it was.
