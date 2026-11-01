# BL-121 — Split `module-model.ts` by concern, as a pure move

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-121
- **Branch**: `bl-121-module-model-split`
- **Base SHA**: `a337f82d9714a3f5b224bcf828e5a46727419e80` (BL-120's merge, PR #126)
- **Commits**:
  - `docs(tasks): BL-121 task file — split module-model.ts by concern`
  - `refactor(BL-121): split module-model.ts by concern, as a pure move`
  - `docs(BL-121): live comments that place moved code in module-model.ts`
  - (this commit) `docs(BL-121): records — account, backlog, progress`
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

- [x] Every top-level statement of the base `module-model.ts` other than
      its imports is in exactly one of the new files, byte-identical with
      its leading comments, in the base order within its file; nothing
      else is added but imports, export lists and file headers
      (`scripts/bl121-pure-move-check.mjs`).
- [x] `module-model.ts` exports exactly the 29 names it exported, each
      still a value or a type as before.
- [x] The value-import graph of the split files is acyclic, and none
      takes a value from `module-model.ts`.
- [x] `git diff --color-moved` marks every changed line of the module
      model as moved, except import, export-list and header lines.
- [x] The graph, proof and verdict differentials
      (`node scripts/differential.mjs`) are all zero.
- [x] Every suite runs the same test files and the same number of tests
      as on the base.
- [x] The full gate set (`node scripts/gates.mjs`) passes, with
      `test:validation`'s known failures unchanged (OPEN-DEBTS D-09).
- [x] The independent audit certifies the move pure.

## Gates and report

The differentials are expected to be zero on every case; the validation
baseline is unchanged. The report adds the per-suite test-file and test
counts on the base and on the branch, and the pure-move check's output.

## Account

### Premises, as measured on `a337f82`

1. **Partly false, in a way that changes nothing:** the file is 15,274
   lines (`wc -l`; the note's 15,275 counts one more), with 258 function
   declarations and 29 exports, as the note says.
2. **True.** The six concerns are there, and finer ones inside them: the
   export write set splits into its reference vocabulary and classifier,
   the final-object account, own-object routes with their route keys,
   export-object methods, prototype tampering, the alias summaries,
   load-result escape (task BL-074) and the loader registry; completion
   and abruptness into module scope, the competing-write window and its
   sites, completion, the evaluation cutoff, local callables, abruptness
   and class heritage; then export provenance, export bindings and
   entrypoint roots.
3. **True.** A TypeScript-checker census of the 367 top-level statements
   found three module-evaluation-time reads of another declaration, all
   between adjacent constants that stay in one file
   (`FUNCTION_INTRINSIC_NAMES` → `OBJECT_INTRINSIC_NAMES`,
   `VALUE_OR_HOLDER_READERS` → `VALUE_READERS`, `HOLDER_READERS`). Each
   of the nine module-level `let` counters is written only in its own new
   file: `aliasSummaryWalks` is written by both `reachesGlobalObject` and
   `bindingMayHoldLoad`, which is why the alias summaries are one file.
4. **True, with one path-keyed record.** No test mocks or spies on the
   module or reads its source by path. The name-lookup census
   (`src/testing/name-lookup-census.ts`) keys two entries to
   `module-model.ts` + `findExportedClassMembers`; that function stays in
   `module-model.ts`, so the census is unchanged. `scripts/` read the
   model through `dist/code-intelligence/module-model.js`, which keeps
   every public name.

### The split

- **Grouping.** The statement-level strongly connected components of
  the value-reference graph are seven, the largest the abruptness
  cluster (10 functions, with `statementHeaderCannotCompleteNormally`)
  and the completion cluster (9, with `chainCompletesNormally` from the
  competing-write section). Every other file-level cycle a contiguous
  split would have had came from 32 shared helpers, which go to
  `module-model.syntax.ts` and `module-model.module-scope.ts`. The
  result: 22 files whose value-import graph is acyclic; they take only
  types from `module-model.ts`.
- **What `module-model.ts` keeps:** the public types, `toImportBinding`,
  `buildModuleModel`, and the export map (`mapExportsToFunctions` with
  its private helpers, `findExportedClassMembers`). It re-exports the
  other 20 public names, and has a header that maps each concern to its
  file, for a record written before the split.
- **Unchanged text.** Each new file lists the names other files take
  from it in an `export { … }` list at its end, so no declaration line
  gains an `export`. Each statement moved with its full text, leading
  comments included; Prettier changed nothing in moved text.
- **Comments elsewhere.** 24 live comments (source, tests) placed a
  moved declaration in `module-model.ts`; each now names its file (20 in
  the first pass, four more from audit round 1, F1). Records — findings,
  ADRs, task files, audits, fixture READMEs — keep their text.
- **Not edited, deliberately (moved text):** `LocalCallable`'s comment
  says "this whole file", meaning the old file; `ExportBinding`'s
  `{@link isDefinitelyReachedExportAssignment}` no longer resolves in its
  file. A pure move edits no moved statement; the header map names where
  each now lives.

### Measurements, on the branch against `a337f82`

- `node scripts/bl121-pure-move-check.mjs`: 367 statements, 23 files,
  367 found, once each, byte-identical, in base order; `module-model.ts`
  exports the same 29 names, each still a value or a type; no
  value-import cycle; no value import from `module-model.ts`. Three
  mutations (an edited body, an added statement, a cycle-closing import)
  each fail it.
- `git diff --color-moved=plain` over the module-model files: 29,738
  lines marked moved; not marked: one removed line (`type
  IndexedFunction,`, from the old import block) and 694 added lines, all
  imports, export lists and file headers.
- The comment commit: each of its 15 files prints the same code with
  comments removed (the TypeScript printer) before and after.
- Per suite, `vitest list` on the base and on the branch: identical file
  lists and test-name lists — `npm test` 248 files / 6,870 tests,
  `test:foundation` 56 / 2,445, `test:performance` 1 / 3,
  `test:adversarial` 2 / 124, `test:binding-grammar` 2 / 296,
  `test:oracle` 47 / 1,435, `test:validation` 2 / 23.
- `node scripts/differential.mjs` (in the gate run): the graph, proof and
  verdict differentials are all 0 over 139 measured cases, none
  unmeasured. `test:validation` fails exactly OPEN-DEBTS D-09's six
  cases, each with D-09's verdict.

### Independent audit

Round 1 (fresh context; the task file, AGENTS.md § E–G and the diff):
**CERTIFIED**, with two documentation findings, both fixed and folded
into their commits:

- F1 (low): four live comments (`source-index.ts` once,
  `commonjs-reexports.ts` three times) still placed in `module-model.ts`
  code that now lives in the split files.
- F2 (info): the move commit's message left out the export map's private
  helpers among what `module-model.ts` keeps.

Reported unconfirmed, not acted on: the pure-move check compares
statement text and export names, not what each import binds to. The
auditor checked binding identity separately (the 16,842 identifiers of
the moved statements resolve to the same declarations as on the base),
and ran the model's public functions on 381 fixture files on both
sides: byte-identical output, identical operation counters.

No round 0: the task fixes no defect and adds no rule. No round 2: round
1 certified, and its fixes are comments and a commit message.

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

15,275 lines, 258 functions, 29 of them exported; edited by 7 of the 17 implementation pull requests before BL-116. Its concerns: the export write set, completion and abruptness, own-object routes, prototype tampering, export bindings, entrypoint roots. Proven a pure move: the graph, proof and verdict differentials all zero, the same test files and counts, `git diff --color-moved` showing only moves. The audit checks that the move is pure
