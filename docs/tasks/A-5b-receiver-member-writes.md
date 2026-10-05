# A-5b — Resolution authority, call-graph side: VT-208 receivers, with a whole-graph member-write check

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: A-5b
- **Branch**: a-5b-receiver-member-writes
- **Base SHA**: 431aebc69193096bd1e8320a0974f0f825a3df8f
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Seventh task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 6),
after [`A-5a`](A-5a-resolution-authority.md) (PR #83, merged
2026-10-05). Backlog row `A-5` was split on 2026-10-04 by the project
owner into A-5a and **A-5b** (this task: PRM-18, VT-208 receivers), which
together carry every criterion of that row.

The specification is
[ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
invariant A2 ("a **resolved** edge exists only when an authority from a
closed set has proved that the callee denotes exactly one function at
that site on every execution: … a receiver bound once to a `new`
expression of a class with no member writes …"), § 4's static-member
exception ("`Lib.staticMethod()` … keep the checker's resolution when the
class binding is stable and nothing in scope writes the member"), § 6's
reopened VT-208 / VT-216 row and § 8's A-5 row. REMEDIATION-PLAN § 5a,
"A-5 split", records the project owner's decision and the shapes measured
for this task.

Finding closed: PRM-18.

### The decision (project owner, 2026-10-04)

Recorded in the A-5a task file and REMEDIATION-PLAN § 5a; it binds this
task. Keep ADR 0008 § 4's static-member exception and A2's
`const x = new C()` receiver authority, but withdraw a resolved method
edge when ANY walked file may write that member (an assignment, a dynamic
key, a reflective mutator such as `Object.defineProperty` or
`Object.assign`). Also require a chain of plain class declarations, with
no field or accessor shadowing the method in any class of the chain, and
no constructor `return`.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **Measured (real Node v22.11.0, the oracle harness, 23 cases in
  `tests/oracle/a5b-receiver-member-writes.cases.ts`).** 10 are a false
  `NOT_AFFECTED` on the base:
  - the five shapes of REMEDIATION-PLAN § 5a: a `let` receiver reassigned
    by a deferred write; `this.go()` in a base method overridden by the
    instantiated subclass; `inst.run = …` before `inst.run()`; a
    base-class field shadowing a subclass method; a static method
    overwritten from a third file;
  - a constructor that returns another object (the shape § 5a could not
    measure: it is measured here, and is a false `NOT_AFFECTED`);
  - a field and a method of the same name in one class;
  - `Safe = Danger` before `Safe.run()`;
  - `inst.__proto__ = Danger.prototype`;
  - `with (inst) { run = … }`.
- **Measured.** Eight more shapes are `UNKNOWN` on the base for another
  reason: the replacement function escapes into a builtin, or is stored
  under a key that may be a protocol member, and gets A-3a's or A-4's
  edge. They are `Base = Other` before `class Sub extends Base`,
  `Object.setPrototypeOf`, `Object.defineProperty`, an aliased
  `defineProperty`, `Object.assign`, `Reflect.set`, a dynamic key and
  `__defineGetter__`. They are kept as regression guards. Five precision
  guards are `AFFECTED`: a `const` bound to `new`, a static method on a
  stable class, an inherited method, a class required from another file,
  and a write to a member of another name.
- **Measured: what VT-208 resolves today is wider than the plan's
  shapes.** `resolveInstanceMethod` (`call-graph.ts`) asks the checker
  for the apparent type of ANY receiver it reaches: `this`, a parameter,
  an element access (`this[CACHE].get()` in `lru-cache` resolves to
  `LRUCache#get`), a call result. With it stubbed to nothing, the
  differential tool over all 139 corpus cases shows:
  - graph 8 cases, 139 resolved edges becoming unknown (RWB-03, RWB-09a
    and RWB-09b hold most of them);
  - verdict 5: ADV-021, ADV2-020, ADV2-021 and ADV2-022 `AFFECTED` →
    `UNKNOWN`; ADV2-041 `NOT_AFFECTED` → `UNKNOWN`;
  - no validation verdict moves.

  The five adversarial cases are the shapes this task's authority keeps:
  a `const` bound to `new` of an imported class, a static method of an
  imported class, and an inherited method through an imported local
  subclass. They must not move.
- **Measured.** The real scan (`cli/scan.ts`) always passes the project
  to `buildCallGraph`; only unit tests omit it.
- **Assumed, not measured: the whole-graph scan's cost.** One more walk
  of each prepared file, only when a method edge was resolved. This task
  measures it structurally (index builds per graph).

## Task

### Problem

`resolveInstanceMethod` (VT-208, VT-216) takes the TypeScript checker's
static type of a method call's receiver as the receiver's runtime value.
The static type is a declaration-time claim: a reassigned binding, `this`
in an overridable method, an own field, a constructor `return`, a member
written anywhere, or a replaced prototype all make the runtime call reach
a function the type does not name. Family C then certifies the real
callee unreachable.

### Why it matters

Soundness first: each of the 10 failing shapes is a false `NOT_AFFECTED`.
Defect classes:

- **B, wrong runtime-value semantics:** a static type stands for a value;
  an instance's own field, its prototype, its constructor's return are
  ignored.
- **C, multi-valued provenance collapsed to one:** a `let` receiver, a
  `this` receiver and a member written anywhere hold more than one value.
- **A, wrong binding identity:** a reassigned class name, matched as the
  declaration it no longer denotes.

### What to do

1. **Reproductions first.** The 23 cases above in
   `tests/oracle/a5b-receiver-member-writes.*`, with loud fixtures, both
   controls and real-Node ground truth. The 10 failing on the base are
   shown failing there.
2. **The receiver authority** (`call-graph.ts`, replacing
   `resolveInstanceMethod` and its type checker). A method call
   `R.m(...)` gets a resolved edge only when:
   - **static**: `R` binds, through the graph's own class authority (the
     lexical `class` binding, or an exact import whose export is a class:
     the authority `new R()` and A-1's implicit `super` already use), to a
     class, and `m` is found as a static method on that class's chain;
   - **instance**: `R` is a name whose lexical binding is a `const`
     declaration initialized by `new C(...)` (through named-bindings'
     stability-checked alias hops), `C` binds through the same class
     authority, and `m` is found as an instance method on `C`'s chain.

   Every other receiver (`this`, `super`, a parameter, a `let` or `var`,
   an element access, a call result, an inline `new C()`) keeps the
   unknown edge it had before VT-208.
3. **The chain** (the decision's structural half). From the class up to
   its root, every class is a `class` declaration (not an expression),
   carries no decorator on itself or any member, and has no constructor
   that `return`s; every `extends` names a class through the same class
   authority (no builtin, function constructor, call or unattributable
   base). `m` must be read from it unambiguously: refused when a class of
   the chain has a member with a computed name the analyzer cannot read,
   two implementations of `m`, or an accessor of the name before the
   method is found. For an instance call, a field of the name (including
   a TypeScript parameter property) in ANY class of the chain refuses: it
   is an own property of the instance. For a static call, a static field
   or accessor of the name found before the method refuses. Overload
   signatures, `abstract` members and `declare` fields have no runtime
   presence and are skipped.
4. **The whole-graph member-write check** (the decision's other half). A
   method edge resolved this way is recorded with its member name. After
   the walk, every prepared file is scanned once, and the edge is
   withdrawn to an unknown edge (new reason `receiver_member_written`,
   `value_uncertainty`, non-widening, naming the withdrawn target) when
   any file may write that member:
   - an assignment in any form `named-bindings.ts`'s member scanner
     already sees (compound, `++`, `delete`, destructuring and `for…of`
     targets), and a key it cannot read (any member);
   - `__proto__` written (any member: the whole chain changes);
   - a `with` statement (any member);
   - a reflective mutator: `Object.defineProperty`, `defineProperties`,
     `assign`, `setPrototypeOf`, `Reflect.set`, `defineProperty`,
     `deleteProperty`, `setPrototypeOf`, `__defineGetter__`,
     `__defineSetter__`, read by name whatever the receiver. A direct call
     whose key is a literal writes that key; a call whose key is not
     readable, any other use of the mutator (an alias, a destructuring, a
     value passed on) writes any member. `Object` and `Reflect` used as a
     value, or read with a dynamic key, write any member.
5. **Mutations**: each refusal and each recognized write form removed in
   turn is caught by a named test.
6. **Measure**: the differential tool over all corpus cases; validation
   case by case against OPEN-DEBTS D-09.
7. **Records**: FINDINGS (PRM-18 closed; anything new registered), plan
   § 5a, ADR 0008 § 6's VT-208 row status, OPEN-DEBTS, backlog, progress,
   scorecard.

## Boundaries

### Do not touch

- VT-214's object-literal member check and A-5a's receiver-bound
  builtins, which use the same member scanner file-locally; trailing
  chains and import names for string or computed keys (A-6); export
  attribution (lane E); the loader classifier (`loader-constructs.ts`).
- ADR 0008 § 2's other structural gates (the branded
  `resolvedEdge(authority, target)`, binding-grammar A2 rows,
  `VT-INV-A2-resolution-authority`): backlog `BL-047`.
- `.github/workflows/ci.yml`, the proof families, `buildFinding`.
- The locked `rwf-046-require-binding-authority` worktree.

### STOP conditions

- A verdict moves to a WRONG answer on any corpus case or reproduction
  (`STOPPED_ON_FINDING`). A move to `UNKNOWN` is reported precision cost;
  a move of ADV-021, ADV2-020, ADV2-021, ADV2-022 or ADV2-041 is a STOP,
  since the authority is meant to keep each.
- A non-additive output-schema change becomes necessary
  (`NEEDS_DECISION`).
- The independent audit blocks on something outside this scope.

## Acceptance criteria

- [ ] Every reproduction wrong on the base fails there and has its sound
      verdict on the branch; the regression guards and precision guards
      keep theirs.
- [ ] `resolveInstanceMethod` and the checker-based receiver resolution
      are gone; a method edge is resolved only through the static or
      instance authority of "What to do" 2, over a chain meeting 3.
- [ ] Each refusal of 2 and 3 is shown by a named graph-level test.
- [ ] A resolved method edge is withdrawn to `receiver_member_written`
      when any prepared file writes the member, for each write form of 4,
      each by a named graph-level test.
- [ ] Each mutation of the refusals and write forms is caught by a named
      test.
- [ ] ADV-021, ADV2-020, ADV2-021, ADV2-022 and ADV2-041 keep their
      verdicts.
- [ ] The whole-graph scan costs one index build per prepared file per
      graph, at most, and none when no method edge was resolved: a
      structural test.
- [ ] Graph, proof and verdict differentials reported separately, every
      moved case listed; the full validation (against OPEN-DEBTS D-09)
      and the full adversarial results reported.
- [ ] FINDINGS, plan, ADR 0008, debts, backlog, progress and scorecard
      updated.
- [ ] An independent audit returned `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: the verdict
differential is zero on the corpora, or only moves to `UNKNOWN`, which are
reported as precision cost. The known validation failures (OPEN-DEBTS
D-09) are unchanged.

## Report

In the format of `AGENTS.md` § J. Also report: the edges VT-208 resolved
that the authority no longer resolves (`this`, element-access and
call-result receivers), as graph differential; every correct `AFFECTED`
turned into `UNKNOWN`.
