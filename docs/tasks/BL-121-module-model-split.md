# BL-121 — Split `module-model.ts` by concern, as a pure move

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-121
- **Branch**: `bl-121-module-model-split`
- **Base SHA**: `a337f82d9714a3f5b224bcf828e5a46727419e80` (BL-120's merge, PR #126)
- **Commits**: <!-- filled in by the last commit (READY_FOR_REVIEW) -->
- **Superseded by**: —

## Specification

The row `BL-121` of [`BACKLOG.md`](BACKLOG.md) § 1, one of the improvement
tasks the project owner placed first on 2026-10-27 (task `BL-116`,
decision 3). Its note (the last section of this file) asks for
`src/code-intelligence/module-model.ts` to be split by concern, as a pure
move, proven by: the graph, proof and verdict differentials all zero; the
same test files and test counts; `git diff --color-moved` showing only
moves. The independent audit checks that the move is pure.

## Premises to verify (AGENTS.md § D)

Measured on the base, `a337f82`:

1. The file's size and shape: 15,275 lines, 258 functions, 29 exports.
2. Its concerns are the six the note names: the export write set,
   completion and abruptness, own-object routes, prototype tampering,
   export bindings, entrypoint roots.
3. A pure move cannot change behaviour: no top-level statement of the
   file runs code another statement defines at module-evaluation time, so
   the order in which the new files evaluate cannot matter; every
   module-level `let` is written only by functions that can stay in its
   file (an importer cannot assign an imported binding).
4. Nothing outside the file depends on where a declaration sits, beyond
   the import path: no `vi.mock` or spy of the module, no gate or census
   keyed on the file path for a declaration that moves.
5. "Edited by 7 of the 17 implementation pull requests before BL-116":
   the reason for the task, not relied on by it.

## Boundaries

Do not touch: any statement's text (body, comment, signature, `export`
keyword); any importer of `module-model.js`, which keeps every public
name it has; any test's assertion, any gate, any threshold. Records
(`tests/validation/findings/`, ADRs, task files, audits) that name
`module-model.ts` stay as they are: they describe the file at their
commit.

Allowed beyond the move: each new file's imports, its `export { … }` list
of the names other files take from it, and a header comment;
`module-model.ts`'s re-exports and a header mapping the concerns to their
files; live comments elsewhere (source, tests, scripts) that the move
makes false, because they place a moved declaration in `module-model.ts`.

STOP conditions: any differential not zero; any change in test files or
test counts; a statement that cannot move without an edit.

## Acceptance criteria

- [ ] Every top-level statement of the base `module-model.ts` other than
      its imports is in exactly one of the new files, byte-identical with
      its leading comments, in the base order within its file; nothing
      else is added but imports, export lists and file headers
      (`scripts/bl121-pure-move-check.mjs`).
- [ ] `module-model.ts` exports exactly the 29 names it exported, each
      still a value or a type as before.
- [ ] The value-import graph of the split files is acyclic, and none
      takes a value from `module-model.ts`.
- [ ] `git diff --color-moved` marks every changed line of the module
      model as moved, except import, export-list and header lines.
- [ ] The graph, proof and verdict differentials
      (`node scripts/differential.mjs`) are all zero.
- [ ] Every suite runs the same test files and the same number of tests
      as on the base.
- [ ] The full gate set (`node scripts/gates.mjs`) passes, with
      `test:validation`'s known failures unchanged (OPEN-DEBTS D-09).
- [ ] The independent audit certifies the move pure.

## Gates and report

The differentials are expected to be zero on every case; the validation
baseline is unchanged. The report adds the per-suite test-file and test
counts on the base and on the branch, and the pure-move check's output.

## Account

<!-- Filled in while working. -->

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

15,275 lines, 258 functions, 29 of them exported; edited by 7 of the 17 implementation pull requests before BL-116. Its concerns: the export write set, completion and abruptness, own-object routes, prototype tampering, export bindings, entrypoint roots. Proven a pure move: the graph, proof and verdict differentials all zero, the same test files and counts, `git diff --color-moved` showing only moves. The audit checks that the move is pure
