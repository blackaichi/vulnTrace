| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-20 | `vuln-lib` (synthetic fixture) | `bindCallee` resolves a trailing method chain (`x.y()`) to the receiver `x` itself, discarding which method was called | false NOT_AFFECTED — see below | **Fixed** (A-6) — see below |

## PRM-20 — `bindCallee` resolves a trailing method chain (`x.y()`) to the receiver `x` itself, discarding which method was called

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** C — capability flow and resolution

A trailing property chain (`api.parse()`, `lib.api.parse()`) is resolved to an edge on the already-bound receiver (`api`, `lib.api`) rather than the specific member, on the stated premise that the chain "is intentionally not consulted". Family C then certifies the real target `parse` unreachable.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-20`) and § 4 (`named-binding-trailing-chain`)`. Not fixed here; this section records the finding only, per this task's boundaries.

**Pinned test:** `symbol-binder.test.ts` ("ignores a trailing method chain") expects exactly this as its recorded result; AGENTS.md § G forbids pinning it as expected going forward.

**Correction (2026-09-26, task `remediation-reconciliation`):** the `Fix lane` line above states lane C. `docs/REMEDIATION-PLAN.md` § 2.2 assigns this finding to **lane A** (call graph resolution authority, ADR 0008's A2, task **A-6**), which is authoritative for lane assignment — the plan was measured, this field was partly inferred (`REMEDIATION-PLAN.md` § 2, introduction). The `Fix lane` line is left as originally written, per this register's append-only discipline; follow the plan.

**Note (2026-09-28, task `A-1`):** the same truncation now also reaches
the three sites A-1 accounts for, because they resolve their callee
through `bindCallee` too: an `extends` base (`class S extends
lib.safe.Inner {}`), a tag (`` lib.safe.Inner`x` ``) and a decorator
(`@lib.safe.Inner class X {}`) -- each a family-C false `NOT_AFFECTED`,
measured by A-1's independent audit on the base and the branch. A-6's fix
to `bindCallee` covers them with no separate work.


**Status update (task A-6, 2026-10-05): Fixed.** `bindCallee`
(`symbol-binder.ts`) now binds a callee only when the binding and the
chain's leading members name one export and NO member is read after it
(ADR 0008 invariant A2, "an exact export with the whole member chain
consumed"). Any other chain past a package export binds to
`not_an_import`, and the call graph's later authorities either prove the
member (task A-5b's receiver authority, for a static method of an
imported class) or end in an unknown edge. `SymbolBindingResolved` no
longer carries `unconsumedChain`, so a resolved binding cannot hold a
chain. Two answers consume a longer chain: a builtin's member path (the
builtin table's key, unchanged), and a single trailing `.call` /
`.apply`, a new result kind (`resolved_function_method`) that only a
call site accepts -- see RWF-075 for the conditions it needed.

All three spellings ADR 0008 names, and every site that resolves a callee
through the binder -- a call, a tag, a decorator, a `new`, an `extends`
base, a VT-214 alias (`resolveAliasedValue`, which `classifyNew` and the
alias paths also read) -- were a false `NOT_AFFECTED` on the base
`9292cb3` and are `UNKNOWN` after, against real Node:
`tests/oracle/a6-binder-resolution-authority.test.ts` (`trailing.*`,
`site.*`, `alias.*`). `lib.parse.bind(null)("x")` was `AFFECTED` through
an edge that said the `bind` call invokes `parse` (a fabricated edge);
it is `UNKNOWN`. Graph level: `call-graph.binder-chain.test.ts`; binder:
`symbol-binder.test.ts`, whose pinned test ("ignores a trailing method
chain on an already-bound named import") now asserts `not_an_import`.

The fix also falsified the premise of a control:
`unsupported-construct.test.ts` "does not label a call whose receiver is
locally bound and resolvable" used `helper.execute()` on an imported
object literal, "resolvable" only through this truncation (an edge to the
`helper` export, then `unresolved_target`). It now ends in
`unsupported_receiver_binding` -- both non-widening; the category moves
from `identity_unresolved` to `unmodeled_construct`, which is what the
gap is -- and the control's resolvable side is an imported class's static
method, which an authority does resolve.
---

