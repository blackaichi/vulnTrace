| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-63 | `vuln-lib` (synthetic fixture) | Several ways of replacing/mutating `module.exports` (bracket member write, module-alias write, `Object.assign(module.exports, …)`) are not recognized as export writes | false NOT_AFFECTED (for the uncompensated shapes) — see below | **Fixed** (E-1) — see below |

## PRM-63 — Several ways of replacing/mutating `module.exports` (bracket member write, module-alias write, `Object.assign(module.exports, …)`) are not recognized as export writes

**Status:** Open
**Failure class:** false NOT_AFFECTED (for the uncompensated shapes)
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

`module["exports"] = …`, `module[k] = …`, `Object.assign(module, …)` and `Reflect.set(module, "exports", …)` are all compensated: the closure's `loader_capability_escape` flag correctly withdraws to UNKNOWN. But `module["exports"].run = …`, `module.exports["run"] = …` (the PRM-30 mechanism through a bracket), `const m = module; m.exports = …` (the PRM-32 mechanism through an alias), and `Object.assign(module.exports, { run })` are not compensated and give family C over the real `danger` export.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-63 FALSE")`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task E-1, 2026-10-13): Fixed.** Re-measured: nine shapes
were live (`module["exports"].run =`, `const m = module; m.exports =`,
`const e = exports; e.run =`, module-scope `this.run =`, `&&=`, a
destructuring target, `exports` handed to a helper, `const api =
module.exports; api.run =`, a self-`require` member write), and two more
found while building the census (a write through the whole-module
binding, `main.run = …` after `module.exports = main`; and an export method
handing its `this` to a helper that writes it). `Object.assign`,
`defineProperty`, `Reflect.set` and `Object.freeze` were already
`UNKNOWN`. Every reference the file makes to its export objects is now
classified by the closed `ExportWriteKind` union (ADR 0009 § 2); a form
outside it withdraws every name of the file. `tests/oracle/e1-export-write-set.test.ts` (`prm63.*`, `e1.*`),
`src/code-intelligence/module-model.export-write-set.test.ts`.

E-1's independent audit (BLOCKED on the first version) measured eight
further live shapes of this finding, every one pre-existing on the base:
a self-load reaching the exports object through an assignment, a helper's
return, `||`, or a base constructor's return under a derived class's field
(`this` is what `super()` returned); `module.parent.children` (treated as
an inert member read); a class's `Symbol.hasInstance` run by
`exports instanceof C`; a patched `Object.prototype.valueOf` run by
`exports == 1`; and an own `toString` run by a template literal. Four more
were wrong at the model and masked only by the call graph's
`own_export_call` backstop (`exports.__proto__ =`, `__defineGetter__`,
`require("module")._load(__filename)`, and a write onto a frozen
whole-module object from another module). All are fixed in E-1: a load
that may load this file is an alias of its exports object, censused
wherever it flows (`mayLoadThisFile`); `module` members are an allow-list;
a loose comparison, a template literal and `instanceof` of a non-builtin
are no inert uses; writes to builtin prototypes, `__proto__` writes on an
export object or an alias of one, `__defineGetter__`/`__defineSetter__`,
`process.mainModule` and the `module` builtin are un-enumerable; and a
write on a final export object this file does not create as a plain one
(a call's result, another module's object, a literal with an accessor of
the name or a `__proto__:`, a class that `extends` or has a static
accessor of the name, a function's `name`/`length`) attributes nothing.
`tests/oracle/e1-export-write-set.test.ts` (`audit.*`).

E-1's audit, second round (BLOCKED), measured nine more live shapes, one
group a regression of the first round's fix: narrowing self-load member
writes to the loads `mayLoadThisFile` accepts reopened a member write
through ANY other load's result, which may be this file's exports object
handed back (`require("./other").run =` with `other.js` re-exporting
`./index` or `module.parent.exports`, a member chain off a load, a
`package.json` `imports` alias, a package whose name differs from its
directory); the other two groups were pre-existing on the base: a builtin
reader the file itself replaces (`Object.keys = …; Object.keys(exports)`),
and `process.mainModule` reached through an alias of `process` or through
the global object. All nine were `NOT_AFFECTED` on the base and are
`UNKNOWN` now: a member write through any load's result, directly, through
a binding declared, assigned or destructured from one, or through a chain
of members, withdraws the name (`baseMayBeLoaded`); the reader allow-lists
hold only in a file that patches no builtin (`fileMayPatchBuiltins`); a
`process` value is inert only when tested or used through an allow-listed
member (`processValueIsInert`). `tests/oracle/e1-export-write-set.test.ts`
(`reaudit.*`). Its fourth group, prototype accessors reached without an
ambient `X.prototype`, is registered as RWF-102.

E-1's audit, third round (BLOCKED): two rules the second round added were
wrong and are fixed in E-1 -- `process`'s `EventEmitter` methods return
`process` itself (`process.on(…).mainModule`), so they are inert only when
their result is discarded or tested; and the new alias summaries were
super-linear (acorn 5 s instead of 0.8 s) and one overflowed the stack on
a 3,000-alias chain, now memoized per declaration and bounded at depth 64,
failing closed. The round's other findings were pre-existing on the base
and are registered as RWF-103 and RWF-104: closing them inside one file's
census is a precision decision for the project owner.

---

