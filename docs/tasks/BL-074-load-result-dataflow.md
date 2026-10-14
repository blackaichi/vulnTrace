# BL-074 — A load's result that may be an export object of this file, through any dataflow

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-074 (with BL-076 folded in)
- **Branch**: `bl-074-load-result-dataflow`
- **Base SHA**: `c22b090c70f34ac27fd8cd54d4e6e52890542c63` (E-2's merge, PR #103)
- **Commits**:
  - `docs(tasks): BL-074 task file — a load's result that may be an export object of this file, through any dataflow`
  - `test(BL-074): a load's result through any dataflow, against real Node — RWF-103, RWF-106`
  - `fix(BL-074): a load that may hand back an export object of this file is censused wherever it flows — RWF-103, RWF-106`
  - (this commit) `docs(BL-074): records — RWF-103 and RWF-106 fixed, RWF-107..109 found, ADR 0009 decision record (option (b)), plan § 5a, debts, backlog, progress, scorecard`
- **Superseded by**: —

## Project context

Lane E (ADR 0009 § 1; `docs/REMEDIATION-PLAN.md` § 5a). E-1 built the
export write set (`exportWriteSet`, `applyExportWriteSet` in
`src/code-intelligence/module-model.ts`); E-2 made the CommonJS forwarding
hop consult it. Two findings, both P0, live false `NOT_AFFECTED`s
pre-existing on the base, share one cause and wait on one decision
(`tests/validation/FINDINGS.md`):

- **RWF-103** (found by E-1's audit, round 3): a load whose module can hand
  this file's own exports object back (a cycle, `module.parent.exports`)
  reaches a member write through dataflow the census does not follow
  (`get().run = …`, `[require("./other")][0].run = …`,
  `set(require("./other"))`, …).
- **RWF-106** (found by E-2's audit): after `module.exports =
  require("./safe")`, every load of `./safe` returns the forwarded object;
  the same flows write onto it, and the hop still forwards the name.

E-1 withdraws a name written through a load's result only on syntactic
routes (`baseMayBeLoaded`); a load that may load this very file
(`mayLoadThisFile`, textual) is censused as an alias of the exports object
wherever it flows. Every other flow of every other load is uncensused.

**The decision.** The project owner was offered (a) a per-file rule (any
load result that escapes the syntactic routes withdraws the file, or
refuses every forward of it) or (b) a module-graph-aware rule (only a load
that can reach back to this file, reach the forwarded module, or is
unresolved, counts), with (b) recommended, and gave the go without
choosing. As BL-063 and BL-064 did, this task takes the recommended
option, says so in its pull request, and records it as a decision record
in ADR 0009. (b) is what ADR 0009 § 4 already states for the write set ("a
cyclic `require` that cannot reach back … does not split the write set"),
applied to the census.

### Premises verified before this file was written (AGENTS.md § D)

Measured on the base `c22b090` with the real-Node oracle harness
(`tests/oracle/bl074-load-result-dataflow.cases.ts`, Node v22):

1. **RWF-103 reproduces, and is wider than recorded.** The seven recorded
   live spellings are `NOT_AFFECTED` while real Node calls `parse`; so are
   three more: a two-hop cycle (`far.js` → `mid.js` → `./index`), a member
   of a load (`set(require("./holder").self)`, `holder.js`:
   `exports.self = require("./index")`), and the loader registry with no
   static path back (`parent.js`: `module.exports =
   module.parent.exports`). The recorded masked spellings
   (`Object.assign(require("./other"), …)`, an IIFE parameter) are
   `UNKNOWN` on the base.
2. **RWF-106 reproduces, and is wider than recorded.** The eight recorded
   spellings are `NOT_AFFECTED` while real Node calls `parse`; so is a load
   of a module that itself forwards `./safe` (`patch(require("./alias"))`).
3. **The precision controls hold on the base**: the same flows through a
   load that cannot reach back (`./plain`, a module loading only
   `vuln-lib`, `vuln-lib` itself, a sibling other than the forwarded one)
   are `NOT_AFFECTED`, and real Node never calls `parse`. A load of a module
   whose own load is computed (`dyn.js`) is already `UNKNOWN` (its
   module-load closure is incomplete).
4. **The model has no resolver.** `buildModuleModel(index)` is built per
   file from one `SourceIndex`; resolution is asynchronous
   (`ModuleResolver.resolve`). A module-graph-aware rule therefore needs
   graph context computed before the model is built, by the consumers that
   hold a resolver.
5. **An un-enumerable write set already refuses every forward**:
   `applyExportWriteSet` replaces every CommonJS binding, the whole-module
   re-export included, by a withdrawn one with no origin, and
   `commonJsExportForwardingHop` refuses a binding with no origin. RWF-106
   therefore needs no hop change.
6. **`SourceIndex.imports` holds every literal `require` anywhere in a
   file** (deferred ones too) and every ESM import; the closure-widening
   scan (`findClosureWideningConstructs`) reports every dynamic require,
   `import()`, `eval`, `Function`, `vm`, `module.require`, `Module._load`
   and loader-capability escape.

## Task

### Problem

A load's result that may be one of this file's export objects -- its
original exports object, or the object a whole-module write installed --
reaches a write the census never sees whenever it flows anywhere other
than a member chain or a binding.

### Why it matters

Soundness: nineteen live false `NOT_AFFECTED`s measured (family C).
Defect class C (multi-valued provenance collapsed: a load's result treated
as certainly another module's object).

### What to do

1. **Reproduce first**: the oracle suite
   `tests/oracle/bl074-load-result-dataflow` (loud fixture, both controls,
   real-Node ground truth), failing on the base; unit tests of the census
   and of the reach graph.
2. **The census** (`module-model.ts`). A load call -- the ambient
   `require`, `module.require`, `require.main.require`,
   `module.constructor._load`, an only-called alias, and `require.call` /
   `.apply` / `.bind(…)(…)` -- *may yield an export object* when it may
   load this file (`mayLoadThisFile`, unchanged) or when the graph context
   says its specifier may reach back. Such a load's value, and every value
   read from it through members, must be **confined**: used only as a
   member chain's base (a write there already withdraws the name), a
   member call's receiver, a callee, an inert use, or held by a binding
   whose every reference is confined. Anything else -- an argument, a
   return, an array or object element, a spread, `for-of`, a destructuring
   source other than a declaration's -- makes the file un-enumerable.
3. **The graph context** (`src/code-intelligence/load-reach.ts`). Per scan,
   with the resolver: for a file F, the targets are F and every module a
   whole-module write of F installs as a load (`module.exports =
   require("./safe")`); a whole-module write of any other non-fresh value
   makes every load of F count. A literal specifier may reach back when it
   is unresolved or declaration-only, is a registry builtin (`module`,
   `process`, `vm`, `inspector`, `repl`, `worker_threads`), or resolves to a
   module whose static load closure (every literal `require` and import,
   re-export sources) contains a target or is tainted: a member that
   cannot be parsed, a closure-widening construct, a load call other than a
   literal `require`, a registry builtin, or a registry reference
   (`module.parent`/`children`/`constructor`, a `module` hand-off,
   `require.cache`, `require.main`, a non-inert `process`, `process`
   through the global object). Past a file bound, the answer is "may reach".
   A load the context does not know (a computed specifier, no context at
   all) may reach: without graph context the census is the per-file rule
   (a), which keeps every consumer fail-closed.
4. **The consumers** that build a model on the verdict path pass the
   context: the call graph (`call-graph.ts`), target attribution and the
   entrypoint roots (`verdict.ts`). `export-forwarding.ts` is unchanged.
5. **Measure**: the three differentials (`node scripts/differential.mjs`),
   the validation baseline, a per-task corpus script
   (`scripts/bl074-load-result-dataflow-corpus.mjs`) over `node_modules`
   and the corpora: attributions lost under (b), and under (a) for
   comparison; the operation counts of the reach graph.
6. **Records**: FINDINGS (RWF-103 and RWF-106 found wider and fixed),
   ADR 0009 (decision record: option (b)), plan § 5a, OPEN-DEBTS, backlog
   (BL-074, BL-076 folded), progress, scorecard.

## Boundaries

### Do not touch

- Writes by other modules (E-4), entrypoint root requirements beyond
  passing the context (E-3), ESM→CJS interop (E-5).
- RWF-104 (BL-075, a separate decision), RWF-102 (BL-073).
- A dynamic `import()` of this file from this file (E-1's accepted bound).
- E-1's decisions (`decide`, the identity walk), the cutoff and the
  completion grammar; `export-forwarding.ts`.
- Other tasks' worktrees.

### STOP conditions

- A verdict that moves into `NOT_AFFECTED` anywhere in the differential.
- A consumer on the verdict path that cannot be given the context without
  a change to its contract.
- A precision cost on the corpora that approaches the per-file rule's (the
  decision's premise would then be false: report `NEEDS_DECISION`).

## Acceptance criteria

- [ ] RWF-103's ten live spellings and RWF-106's nine are `UNKNOWN` against
      real Node's ground truth, and failed on the base.
- [ ] The precision controls keep `NOT_AFFECTED`; the measured cost case is
      `UNKNOWN`.
- [ ] Without graph context, a non-self load that escapes withdraws the file
      (unit test); with it, a load that cannot reach back does not.
- [ ] The reach graph answers "may reach" for an unresolved load, a registry
      builtin, a tainted closure, and past its bound (unit tests).
- [ ] Each mutation of the new authority is caught by a named test.
- [ ] Differentials reported separately; no verdict into `NOT_AFFECTED`;
      validation baseline unchanged (five known failures, OPEN-DEBTS D-09).
- [ ] The reach graph's work is counted and bounded (a structural
      performance test).
- [ ] Records updated; scorecard regenerated.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. `npm run test:validation`
compared case by case with OPEN-DEBTS D-09's five known failures.

## Report

In the format of `AGENTS.md` § J. Report the decision taken (option (b))
as a deviation the project owner confirms by merging.

## Corrections and outcome (appended by the last commit)

- **A premise of "What to do" step 2 was false.** It lists "a member
  call's receiver, a callee" among the confined uses. What such a call
  RETURNS may be this file's exports object (`module.exports = () =>
  require("./index")`; `require("./other").valueOf()`): RWF-107, found by
  the independent audit, masked end to end. Following every call result
  costs 35 of 967 corpus attributions instead of 3 and turns the RWF-094 /
  BL-064 oracle suites' negative controls `UNKNOWN`, a precision decision
  for the owner: left open, pinned by an open-soundness-defect record,
  backlog `BL-078`.
- **The step 3 taint list was widened and narrowed during the task.**
  Widened: a caller's stack frame (`fn.caller`, `prepareStackTrace`,
  `getThis`, `getFunction`; audit finding 4) and any use of a global-object
  binding that reads a code-evaluating, registry or self-named member, a
  computed member, or hands the object on. Narrowed, each with its argument
  in `load-reach.ts`: `loader_capability_escape` (every capability it
  follows is already the registry scan's) and `Function("return this")()`
  bound to a name (lodash's global idiom; without it VAL-001 moved
  `AFFECTED` → `UNKNOWN`).
- **Confinement gained two rules:** an assignment's own value is followed
  (audit finding 1: `set(a = require(…))`, `a = b = require(…)`, six live
  false `NOT_AFFECTED`s, pre-existing); an own-property write
  (`exports.b = require("./b")`) is confined only in a file that never
  reads its export objects back (`exportObjectsAreWriteOnly`), which kept
  the RWF-050 / RWF-094 fixtures' controls `NOT_AFFECTED`.
- **The independent audit** blocked in round 1 (findings 1–4). Findings 1
  and 4 are fixed here; 2 is RWF-107 (above); 3 is RWF-108 (live,
  pre-existing, at E-4's boundary, backlog `BL-079`). Round 2 blocked on a
  sloppy function's `this` as the global object
  (`g().process.mainModule`, live, pre-existing) and on frame names
  spelled other than as a literal member (`Reflect.get(fn, "caller")`,
  `const { caller } = fn`, `defineProperty(Error, "prepareStackTrace")`):
  both closed by tainting a closure member that spells a registry- or
  frame-reaching member name anywhere (`REGISTRY_REACHING_MEMBER_NAMES`).
  A key computed at run time spells none: RWF-109 (masked, backlog
  `BL-080`). Round 3 blocked on four live spellings of that global object
  (two destructuring-assignment keys, a concatenated and a template key;
  RWF-109's "masked" was false for them): closed at the root, a sloppy
  function's `this` is possibly the global object (`thisMayBeGlobalObject`),
  and object-literal key positions are name-tainted; RWF-109 is narrowed to
  a caller's frame read through a run-time key, measured masked. Round 4
  was interrupted before any probe ran; from reading the code it found
  that a directive is recognised by its raw text (`"use\x20strict"` is no
  directive, confirmed in real Node), fixed. A fresh reviewer re-ran
  round 4 and blocked on three live spellings: a `this` captured by a
  strict arrow, a class heritage clause or a class computed key inside the
  sloppy function. Only the BINDING function decides `this`
  (`thisBindingFunction`), fixed; and a frame reached by enumerating keys
  (`Object.getOwnPropertyDescriptors(g)`) widens RWF-109 (masked).
- **Performance.** The reach graph first parsed every file again (and
  each closure member a third time), which made the call graph about 1.5x
  slower on the lodash fixture and tripped vitest's worker RPC timeout in
  `npm run test:foundation` (all tests passing; the base passed cleanly).
  `LoadReachGraph.indexOf` now parses each file once per scan and the call
  graph shares it: lodash 2.37 s against the base's 2.30 s, and both gates
  exit 0.
- **RWF-103's premise corrected:** the per-file rule withdraws 32.4% of
  `node_modules` attributions, not "nearly every TypeScript-emitted file".
