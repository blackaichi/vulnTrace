# Binding-form grammar sweep

Every JavaScript **binding form** against every **authority mechanism**
that can attribute a call to a target.

```bash
npm run test:binding-grammar
```

## Why this exists

Four consecutive audits found the same defect class: **a local
identifier's text reaching an authoritative attribution.**

| | what reached an attribution by spelling |
| --- | --- |
| RWF-043 | the same-name function matcher |
| RWF-045 | the destructured source, selected by text |
| RWF-046 | require provenance, from a file-wide name-keyed import table |
| RWF-046a | `propertyName ?? name` applied to an ARRAY element, so `const [, run] = require("pkg")` resolved to `pkg#run` |

RWF-046a was **introduced by the fix for RWF-046** and passed every gate.
It was found only because somebody enumerated the binding grammar by
hand. That enumeration existed in no committed file, so the next shape
nobody thought of would have had to be found the same way.

This is that enumeration, committed, so a shape nobody thought of fails
a test instead of surviving to an audit.

## The shape of the instrument

| file | what it is |
| --- | --- |
| `matrix.ts` | the grammar (rows), the mechanisms (columns), and the oracle. **Data, not prose** — the precedent is `src/testing/foundation-invariants.ts`. A new binding form is a row; a new mechanism is a column; neither is a new test file. |
| `disagreements.ts` | the cells where current behaviour differs from what should happen, grouped into families and classified A / B / C / honest-UNKNOWN |
| `harness.ts` | the loud fixture packages and the observation format |
| `binding-grammar.test.ts` | the driver, the instrument controls, and the report generator |
| `REPORT.md` | generated; do not edit |

The driver asserts the **full cross-product** is accounted for, so
adding a row without thinking about all eight mechanisms fails the suite
rather than quietly covering seven eighths of the grammar.

## What a cell may assert

Exactly two things, and the types make the third unrepresentable:

- an **EXACT** target, spelled `<module path>#<declaration name>` — one
  string naming the exact export, the exact install (two twins of one
  package are two different paths) and the exact declaration;
- **UNKNOWN** under a **named reason** from `domain/uncertainty.ts`'s
  six-category taxonomy.

"Does not crash" and "returns something" cannot be written. Neither can
the harness's own `no-edge` / `ambiguous` / `no-probe` degeneracies:
those exist as *observations*, so a cell whose probe vanished says so
instead of reading as a refusal, and an invariant asserts no expectation
is ever written as one.

## How the expectations were authored

From **JavaScript semantics**, never from the analyzer's output. Each
row declares its own determinacy — whether the language itself proves
the reference denotes exactly one value — and each column declares what
its container actually holds. `expectationFor` composes those two facts
and nothing else.

An oracle derived from the implementation cannot disagree with it, and a
matrix that cannot disagree finds nothing.

## The loud-fixture rule

**Every fixture package exports every name any cell binds**, including
`probeTarget`, `run`, `sibling`, `rest`, `key`, `KEY` and the numeric
keys `"0"`, `"1"`, `"2"`.

This is not cosmetic. Against a package that does *not* export the name,
a fabricated attribution degrades to `unresolved_target` and reads as an
honest UNKNOWN — which is exactly how the RWF-046 array hole hid behind
green tests. With the name present, the fabrication **resolves** and the
cell fails loudly.

The suite's **instrument controls** prove this positively: each baited
spelling is asserted to be a real, reachable export, and two installs of
one package are asserted to be two distinct observations. If a control
fails, no "no fabrication here" cell in the matrix may be believed. The
numeric control earned its keep on the first run — it caught that
`module.exports = { "1": f }` is not indexed as an export at all, which
would have made every positional bait silent.

## Disagreements

A cell that disagrees with current behaviour keeps **the correct
expectation**. The wrong answer is never promoted into the expectation
column; it is recorded separately in `disagreements.ts` as `observed`,
with a classification:

- **A** — wrong binding identity (text reaching an attribution). A live
  soundness defect.
- **B** — correct binding, wrong runtime-value semantics.
- **C** — multi-valued provenance collapsed to one value.
- **honest-unknown** — a sound refusal of a shape whose answer the
  engine could in principle name.

Both directions are pinned, so the suite stays a usable gate: an
agreeing cell that regresses fails, and a disagreeing cell that drifts —
including one that gets *fixed* — fails too, which is the signal to
delete its row.

### What an entry may never silence

An entry is a **silencer**: it turns a failing cell into a passing one.
That makes it the one mechanism by which this instrument could be
turned against itself. If a change re-introduced the RWF-046a defect,
the cheapest way to green CI would be an entry saying "observed:
`EXACT node_modules/pkg/index.js#run`" — and the suite built to catch
that defect would now certify it.

So an entry may record **exactly one** kind of divergence:

> expected an EXACT target, observed a **refusal**.

Two layers enforce it (`guard.ts`, proven by `guard.test.ts`):

1. **Type level.** `KnownDisagreement.observed` is a
   `RefusalObservation` — `{ kind: "unknown"; reason: string }`. There
   is no member of that type that names a module and a declaration, so
   the wrong entry is unrepresentable, not merely discouraged.
2. **Runtime.** `classifyCellOutcome` checks the fabrication case
   **before it reads the table at all**, so an observed EXACT that is
   not the expected one fails whatever `disagreements.ts` says. A type
   constrains source code and says nothing about a value arriving
   through a cast or a JSON load; this layer does.

Also unconditionally fatal: a degenerate observation (no edge, several
edges, no probe), a recorded cell that now agrees, a recorded refusal
whose reason has drifted, and an unclassified refusal.

### Half-verified cells

Some cells are exercised in the **refusal direction only**: they state
the right answer and would still catch a regression into a wrong exact
target, but they have never been observed passing, because the
selection they perform resolves nowhere in the engine. The matrix marks
those forms with `refusalOnlyVerified` and `REPORT.md` prints them with
a `†`, under their own section. Do not read them as fully verified.

This is a deliberate departure from `tests/adversarial/v1|v2`, which let
a disagreeing scenario simply fail. Those suites are a research record
read by a human; this one is an instrument meant to catch the *next*
defect, and a suite that is already red cannot report a new failure.
`disagreements.ts` states the departure and its reasoning in full.
