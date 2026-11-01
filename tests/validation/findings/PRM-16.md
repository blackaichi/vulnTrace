| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-16 | `vuln-lib` (synthetic fixture) | A same-file caller is treated as the unique call site of an exported higher-order parameter, even with cross-file callers | false NOT_AFFECTED — see below | **Fixed** (A-5a) — see below |

## PRM-16 — A same-file caller is treated as the unique call site of an exported higher-order parameter, even with cross-file callers

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

VT-210's higher-order resolution accepts a same-file call site as authoritative for a parameter's value even when the enclosing function is exported (and so has importers whose call sites are unaccounted for). `lib.each(lib.parse, "x")` resolves `fn` from an unrelated same-file call, certifying `lib.parse` unreachable inside `each`'s body.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-16`) and § 4 (`higher-order-cross-file-callers`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task A-5a, 2026-10-04): Fixed.** VT-210 now refuses
unless the call sites it reads are all the call sites. Three conditions
refuse:

- the function carries an `export` modifier;
- any identifier in a value position in the file that may denote the
  function (every one spelled like it, except those the lexical model
  binds to a different declaration) is not the callee of one of its
  counted call sites. That covers an export by name, an alias, `.call` /
  `.apply`, `new`, a tag, a decorator and a reassignment;
- the file contains a JSX site. A JSX element calls its factory with no
  identifier at the site, which is REMEDIATION-PLAN § 5a's "A-3b
  additions" constraint on A-5.

Reproduced against real Node in
`tests/oracle/a5a-resolution-authority.test.ts`:

- `vt210.exported-commonjs` and `vt210.exported-esm` were false
  `NOT_AFFECTED` on the base and are `UNKNOWN` on the branch;
- the alias and `.call` shapes were already `UNKNOWN` on the base and are
  kept as guards.

Every refusal is also a named unit test
(`call-graph.resolution-authority.test.ts`).

---

