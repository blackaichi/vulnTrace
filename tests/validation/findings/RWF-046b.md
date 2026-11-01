| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| RWF-046b | any file destructuring a require with a COMPUTED, NUMERIC or STRING-LITERAL property key, or with a default, or reassigning a destructured require binding. Zero occurrences in the current corpus | `source-index.ts`'s `extractRequireBindings` derives the imported name as `ts.isIdentifier(propertyName) ? propertyName.text : element.name.text` — so any key that is not an `Identifier` falls through to the binding's LOCAL name and publishes it as the export name. Separately it never checked `element.initializer`, so a defaulted element resolved to one target despite two possible runtime values. The same local-text-as-export-name class as RWF-046a, reached by a different route, and the FOURTH site of that class after RWF-043, RWF-045 and RWF-046 | **Soundness, fabricating direction. PRE-EXISTING on `main`** — measured on `b9bb81b` by the scoped re-audit of RWF-046a, not by the corpus differential. `const { [k]: run }`, `const { ["run"]: run }` and `const { 0: run }` all resolve to `pkg#run` by local text; `const { "run": execute }` resolves to `pkg#execute`, a DIFFERENT REAL EXPORT of the same package, which nothing downstream could detect as wrong; `let { run } = require("pkg"); run = null` keeps stale provenance | **Fixed (RWF-046a)** — closed by the same shape boundary; recorded separately because it was on `main` and RWF-046a's introduced array case was not |

## RWF-046b — Pointer: the pre-existing destructured-require shapes closed by RWF-046a

Appended by task `scorecard-status-classifier`, so that every row of the
status table resolves to a section. It adds no finding, and it changes
nothing that RWF-046a records.

RWF-046b's status row already existed. Its defect is described, measured
and closed inside **RWF-046a**, under **"The base was not clean — five
further defects, each closed here"**. Those are the destructured-require
shapes that were **pre-existing on `main`**: computed, numeric and
string-literal property keys, a defaulted element, and reassignment of a
destructured require binding. The scoped re-audit measured them on
`b9bb81b`. RWF-046a's shape boundary closed them, and they were recorded
separately from RWF-046a's own array case because they were on `main` and
that case was not. Read RWF-046a for the reproductions, the measurements
and the closure.

---

