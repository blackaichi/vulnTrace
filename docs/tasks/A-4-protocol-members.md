# A-4 — Protocol members; accessor bodies as their own owners

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: A-4
- **Branch**: a-4-protocol-members
- **Base SHA**: 49487801f039e756879132761959f5e767bef7b9
- **Commits**:
  - `b15c815` docs(tasks): A-4 task file — protocol members, accessor bodies
  - `6d6ae38` test(A-4): real-Node reproductions — protocol members, accessor bodies
  - `055a55d` fix(A-4): protocol members and accessor bodies as their own owners
  - (this commit) docs(A-4): records — findings, ADR decision record, debts, plan § 5a, contract, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Fifth task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 5),
after [`A-3b`](A-3b-own-exports-jsx.md) (PR #81, merged 2026-10-02).

The specification is
[ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
§ 2's protocol-member row ("a method or function-valued property named
`toString`, `valueOf`, `toJSON`, `then`, or computed `Symbol.iterator`,
`Symbol.asyncIterator`, `Symbol.hasInstance`, `Symbol.toPrimitive`,
`Symbol.dispose`, `Symbol.asyncDispose` | *possible*, from the owner that
evaluates the definition"), § 3's fail-closed default, and Amendment A-0
part B as accepted with two conditions ("Decision record — Amendment A-0":
an accessor is its own owner, reached from its defining owner by a
possible edge, never no edge). The acceptance lines are REMEDIATION-PLAN
§ 5a's "A-0 additions" (A-4), "A-2 additions" (producer obligations, for
the `possible` edges this task emits) and "A-3a additions" (A-4: re-probe
the builtin positions a protocol hook kept off the allowlist).

Findings closed: PRM-38, PRM-112, PRM-113, PRM-118; RWF-068 (registered
and closed by this task).

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured.** No protocol-member definition and no accessor has an
  invocation account. The census classifies `MethodDeclaration`,
  `PropertyAssignment`, `ShorthandPropertyAssignment`,
  `PropertyDeclaration`, `GetAccessor`, `SetAccessor` and the
  protocol-named part of `BinaryExpression` as `pending` (A-4);
  `invocationSiteOf` returns `undefined` for all of them.
- **Measured.** `walkFile` pushes an owner only for `isFunctionLike`
  nodes, which excludes accessors, so a call in an accessor body is
  attributed to the enclosing owner (PRM-118). The A-1/A-3 sites inside an
  accessor body are hung from the definer withdrawn to unknown
  (`deferredToAccessor`).
- **Measured (real Node v22.11.0, the oracle harness).** 27 reproductions
  (`tests/oracle/a4-protocol-members.test.ts`), each wrong on the base:
  22 false `NOT_AFFECTED` (coercion through a template, `+`, unary `+`;
  an object-literal, class, instance-field, computed-key and stored
  `toString` / `valueOf` / `Symbol.toPrimitive`; a stored opaque value; a
  dynamic-key store; `await` and an async `return` of a thenable; a
  `then` getter returning a function; `for…of`, spread, destructuring,
  `yield*` over `[Symbol.iterator]`; `instanceof` and
  `[Symbol.hasInstance]`; `for await` and `[Symbol.asyncIterator]`; the
  iterator's own `next` and `return`), and 5 `AFFECTED` through an
  accessor body (four where real Node never runs it -- fabricated; one
  getter read directly -- the right verdict on a path that does not
  exist).
- **Measured, new: RWF-068.** Every consumer of an iterator calls the
  `next` (and on early exit `return`, on delegation `throw`) method of the
  object `[Symbol.iterator]()` returns. ADR 0008 § 2's closed list does
  not name them, so with the list as written an iterator class
  (`[Symbol.iterator]() { return this; } next() {…}`) or a literal
  iterator stays a false `NOT_AFFECTED`.
- **Measured.** No receiver-bound builtin earns a no-edge proof (the
  builtin table has only `global:` and `module:` keys), so the
  well-known symbols invoked only by a builtin method on a receiver
  (`Symbol.replace`, `match`, `search`, `split`, `matchAll`, `species`)
  are accounted at that call's unknown edge.
- **Measured (prototype in this working tree, the differential tool,
  139 cases).** With both decisions below: graph 14 cases changed, proof
  1 (RWB-05, already `UNKNOWN`, gains 5 `protocol_value` reasons), verdict
  0. RWB-09a/b included.
- **Assumed, not measured: the cost to real projects.** A reachable
  `o[k] = v` with an unreadable key and an unattributable value blocks
  families B and C for its region.

### Decisions (project owner, 2026-10-04)

Asked before the task file was written (`docs/WORKFLOW.md` § 7):

1. **Iterator methods: add them.** `next`, `return` and `throw` join ADR
   0008 § 2's protocol names. Recorded in ADR 0008 as an appended decision
   record; RWF-068 is registered and closed by this task.
2. **A value the graph cannot attribute, stored under a key it cannot
   read: fail closed now.** `o[k] = v`, `{ [k]: v }`, a class field
   `[k] = v` with `v` unattributable get an unknown `protocol_value` edge.

## Task

### Problem

The runtime invokes protocol members with no call expression anywhere:
coercion, `await`, iteration, `instanceof`, `using`, `JSON.stringify`.
The graph sees none of it, and family C certifies the members' bodies
unreachable (PRM-38, PRM-112, PRM-113, RWF-068). An accessor body is
walked as if it ran when its definition is evaluated, which fabricates a
resolved path for a getter nobody reads (PRM-118).

### Why it matters

Soundness first: each is a reproduced false `NOT_AFFECTED` or a
fabricated edge (`AGENTS.md` § E). Defect class B (the analyzer assumes a
definition is never invoked, and an accessor runs at definition) and C (a
computed key that may hold several keys is read as one).

### What to do

1. **Reproductions first** (`tests/oracle/a4-protocol-members.*`), failing
   on the base: the 27 cases above.
2. **Protocol keys** (`src/code-intelligence/protocol-members.ts`): a key
   is `protocol`, `other` (proven: a literal not in the list, a number, a
   private name, another well-known symbol through the ambient `Symbol`,
   `Symbol(…)` / `Symbol.for(…)`, through stable `const`s) or `unread`
   (may be one). Definitions: a method; a property, shorthand or field
   whose value may carry code; an assignment storing into a member under
   such a key; a destructuring or `for…of` store writing such a member.
3. **Site kinds** (`invocation-sites.ts`): `protocol_member` and
   `accessor`; census entries become sites, no `pending` entry names A-4.
4. **Accessor nodes** (`source-index.ts`, `call-graph.ts`): every getter
   and setter with a body is a node of kind `accessor`, indexed apart from
   `functions` and named `get <key>` / `set <key>` so no name or
   function-location lookup can bind to it. The walk pushes it for its
   parameters and body; its name and decorators stay with the definition.
   `evaluatingOwnerOf` answers the accessor's node; `deferredToAccessor`
   is deleted.
5. **Accounts** (`call-graph.ts`): a possible edge from the owner that
   evaluates the definition -- to the method, to the accessor, to each
   attributable function a value carries; an unknown `protocol_value` edge
   for a value that cannot be attributed; for a getter under a protocol
   key, its returned values too, from its own node. New reason
   `protocol_value` (`unmodeled_construct`, non-widening), both schema
   enums; no seventh category.
6. **The A-0 cases**: `S2.class-instance.*`, `S2.class-static.*` become
   `UNKNOWN` (records deleted); `S2.literal.*` stay `AFFECTED` or
   `UNKNOWN`.
7. **Builtin re-probe** (the "A-3a additions"): `JSON.parse` #0,
   `String`, `Number`, `parseInt`, `parseFloat`, `encodeURIComponent`, the
   `Math` functions, `new Error` / `new Date` #0, `Error`, `events`'
   `EventEmitter`: add each position to the table, admitted only where the
   mechanical admission test passes; report each with its hooks.
8. **A-2's producer obligations** for both site kinds: the walked-file
   check; one production-`buildFinding` reproduction per site kind.
9. **Measure**: the differential tool over all corpus cases; validation
   case by case against OPEN-DEBTS D-09; RWB-09a/b explicitly.
10. **Records**: FINDINGS (PRM-38, PRM-112, PRM-113, PRM-118 closed;
    RWF-068 registered and closed), ADR 0008 decision record, REMEDIATION-
    PLAN § 5a, OPEN-DEBTS, backlog, progress, scorecard.

## Boundaries

### Do not touch

- VT-208, VT-210, VT-213, VT-214, `==` folding (A-5); the binder (A-6);
  export attribution (lane E); the loader classifier (lane C, BL-040,
  BL-043); the escape row's rules (A-3a), except where an accessor's node
  changes what a comment says.
- RWF-059's instance-field initializer attribution (BL-036).
- `.github/workflows/ci.yml`, the proof families, `buildFinding`.
- The locked `rwf-046-require-binding-authority` worktree.

### STOP conditions

- A verdict moves to a WRONG answer on any corpus case or reproduction
  (`STOPPED_ON_FINDING`). A move to `UNKNOWN` is the reported precision
  cost.
- A non-additive output-schema change becomes necessary
  (`NEEDS_DECISION`).
- The independent audit blocks on something outside this scope.

## Acceptance criteria

- [ ] Every reproduction fails on the base and is `UNKNOWN` on the
      branch; none is `NOT_AFFECTED` or `AFFECTED`.
- [ ] `S2.class-instance.*` and `S2.class-static.*` are `UNKNOWN`, their
      records deleted; `S2.literal.*` stay `AFFECTED` or `UNKNOWN`.
- [ ] A getter or setter (object literal or class, instance or static)
      is its own owner, reached from its defining owner by a possible
      edge; no accessor gets no edge.
- [ ] The census has no `pending` entry naming A-4; every new site kind
      has a handler and a census example.
- [ ] A-2's producer obligations hold for every `possible` edge this
      task emits (walked-file check; one production-`buildFinding`
      reproduction per site kind).
- [ ] No seventh uncertainty category; `protocol_value` is classified
      for widening and category, and is in both schema enums.
- [ ] Each A-3a-listed builtin position is re-probed; each admitted one
      passes the mechanical admission test; the report lists each with its
      hooks, oracle cases and restored verdicts.
- [ ] Graph, proof and verdict differentials reported separately, every
      moved case listed; RWB-09a/b, the full validation (against
      OPEN-DEBTS D-09) and the full adversarial results reported; each
      correct `AFFECTED` turned into `UNKNOWN` listed for A-7.
- [ ] Each mutation of the new rules is caught by a named test.
- [ ] ADR 0008 records decision 1; RWF-068 is registered.
- [ ] An independent audit returned `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: verdict differential
0 over the 139 corpus cases before the builtin re-probe (measured on the
prototype); RWB-07 possibly restored to `NOT_AFFECTED` by `JSON.parse`'s
admission (it is then no longer a known failure, and D-09 is updated); the
other known validation failures (OPEN-DEBTS D-09) unchanged.

## Report

In the format of `AGENTS.md` § J. Also report: the two decisions; the
builtin re-probe table; every correct `AFFECTED` turned into `UNKNOWN`
(for A-7).

## Corrections (2026-10-04)

Appended during the task; the text above is unchanged.

1. **"What to do" 7 listed `events`' `EventEmitter`** among the positions
   to admit. Its first position passed the mechanical admission test but
   is NOT admitted: its `captureRejections` option is validated with an
   error message that inspects a null-prototype value, running its
   `util.inspect.custom` method, a hook the admission ruling forbids and
   the probe never builds (found by the independent audit; RWF-069, which
   the A-3a `path.*` admissions share, backlog `BL-045`).
2. **"What to do" 2: `Symbol.for(…)` is proven `other`.** False:
   `Symbol.for("nodejs.util.inspect.custom")` is `util.inspect.custom`. A
   `Symbol.for(…)` key is `unread`; only `Symbol(…)` is `other`.
3. **Premise: the well-known symbols invoked only by a builtin method on
   a receiver include `Symbol.species`.** False: `await` reaches a
   promise's `constructor` and `[Symbol.species]` through
   SpeciesConstructor with no call in the program. Registered as RWF-070
   (backlog `BL-046`, P1, the project owner's decision on the list),
   recorded as an open-soundness-defect case.
4. **"What to do" 4: the accessor's name "no identifier can spell", so no
   name match binds it.** False: a string export key can
   (`module.exports["get x"]`), and the entrypoint-root lookup bound it, a
   fabricated root (the audit). Every lookup of graph nodes by name in
   `src/analysis/verdict.ts` now excludes accessor nodes (`isNamedNode`).
5. **Not in "What to do": an ES module's exports.** A namespace object's
   properties are its exports (`${ns}`, `await ns`), so an exported
   function, variable or export specifier under a protocol name is a
   protocol definition (`moduleExportDefinitionOf`; the audit, inside
   PRM-38's own wording). Exports are LIVE bindings: one the file writes
   again (an assignment, or a second declaration of the name, `var`
   included), or declares by destructuring, gets an unknown edge (the
   re-audits).
6. **Not in "What to do": RWF-023's owner walk.** `runsWhenEnclosingOwnerRuns`
   treats a pushed accessor as the owner of a class defined in its body,
   whose computed keys it evaluates; the RWF-023 deferral controls now
   admit `UNKNOWN` behind the fixture's getter and setter, and nothing
   else.
7. **Gates, "verdict differential 0 … before the builtin re-probe".**
   Measured after it: verdict 1 (`RWB-07`, into its expected verdict).

## Outcome (2026-10-04)

**Acceptance criteria**: all **yes** (the audit verdict below).

- Reproductions (`tests/oracle/a4-protocol-members.test.ts`): 43 cases
  plus 1 open-soundness-defect record (RWF-070). 42 fail on the base (36
  false `NOT_AFFECTED`, 6 `AFFECTED` through an accessor body or name);
  the 43rd, `registered-symbol.event-emitter-option`, is a regression
  guard from the audit (`UNKNOWN` on the base, a false `NOT_AFFECTED` on
  this task's first version). All are `UNKNOWN` on the branch.
- `S2.class-instance.*` and `S2.class-static.*` are `UNKNOWN`, their
  records deleted; `S2.literal.*` are `UNKNOWN` (allowed: `AFFECTED` or
  `UNKNOWN`).
- The census has no `pending` kind; site kinds `protocol_member`,
  `accessor`; reason `protocol_value` (`unmodeled_construct`,
  non-widening), both schema enums.
- A-2 obligations: the walked-file check runs on every oracle and corpus
  case; production-`buildFinding` reproductions for both site kinds
  (`src/analysis/verdict.possible-edge.test.ts`).
- **Builtin re-probe** (each position: the hooks the probe saw fire;
  condition (b) generated per hook; non-retaining):

  | Position | Hooks | Admitted |
  | --- | --- | --- |
  | `JSON.parse` #0 | `toString`, `toPrimitive`, `proxy:get` | yes (restores `RWB-07`) |
  | `JSON.stringify` #0 | getter, `toJSON`, `proxy:get` / `ownKeys` / `getOwnPropertyDescriptor` | yes |
  | `String` #0, `parseFloat` #0, `encodeURIComponent` #0, `Error` #0 (call and `new`) | `toString`, `toPrimitive`, `proxy:get` | yes |
  | `Number` #0, `parseInt` #1, `new Date` #0 | `toString`, `valueOf`, `toPrimitive`, `proxy:get` | yes |
  | `parseInt` #0 | `toString`, `toPrimitive`, `proxy:get` | yes |
  | the 34 `Math` functions, every argument position | `toString`, `valueOf`, `toPrimitive`, `proxy:get` | yes |
  | `new events.EventEmitter` #0 | `proxy:get` (probe); `util.inspect.custom` through a structured argument (audit) | **no** |
  | `new Error` #1, `Object.assign` sources, `Object.entries` #0 | retain what they are handed | no |

  A subclass of `Error` with no constructor still forwards into an
  unknown edge (its second position is never admitted).
- Correct `AFFECTED` results turned `UNKNOWN` (for A-7): `S2.literal.*`
  and the direct getter read `accessor.literal-getter.read`. No corpus
  case.
- Mutations: 18, 17 caught by a named test; one equivalent
  (merging accessor nodes into the function lookup: no lookup of that map
  can reach an accessor declaration today; the separate map is defense in
  depth).
- Differentials (139 cases): graph 21 cases (nodes +25, sites +303/−88:
  accessor nodes and protocol edges added, admitted builtin calls'
  unknown edges removed), proof 2, verdict 1 (`RWB-07` `UNKNOWN` →
  `NOT_AFFECTED`, its expected verdict). RWB-09a/b: graph changed
  (12 accessor nodes each), verdicts unchanged. Validation: five known
  failures (OPEN-DEBTS D-09), `RWB-07` no longer one.
- Independent audit: `BLOCKED` (four findings: two in scope, fixed and
  reproduced; two pre-existing, registered as RWF-069 and RWF-070), then
  `BLOCKED` again (an exported protocol-named binding written after its
  declaration, or declared by destructuring, is a live binding the first
  fix missed: six shapes, fixed and reproduced as
  `namespace.live-binding.*`), then `BLOCKED` a third time (a `var`
  redeclaration writes the binding with no assignment expression: four
  shapes, fixed by counting a second declaration of the name as a write,
  reproduced), then `CERTIFIED`. Its last round named two pre-existing
  false `NOT_AFFECTED` shapes the escape and protocol rows inherit from
  open findings, now noted on them: a stale imported live binding
  (PRM-62, lane E) and a module reached only through `export *` (PRM-101,
  V-1).

**Discovered**: RWF-068 (fixed), RWF-069 (`BL-045`, P2), RWF-070
(`BL-046`, P1).
