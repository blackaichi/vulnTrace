# BL-096 — the options for `module.paths`'s read-only exemptions, measured

Task [`BL-096`](../../docs/tasks/BL-096-module-paths-read-only-exemptions.md).
Base `904d032` (BL-109's merge). Node v22.11.0, the `node` the oracle
harness runs. Nothing here is committed analyzer code: each option is a
patch against the base, applied only to measure it
(`git apply scripts/bl096-module-paths-options/<patch>`).

| Patch | Option |
| --- | --- |
| `a-closure-conditioned.patch` | **(a)** every use of the list that trusts Node's builtins (a method call, `for…of`, a member read but `length`, a conversion, a property key, `await`, the right of `instanceof`) is exempt only while no file of the closure may write a builtin: a store the escape row counts as an escape (`invocationSiteOf(…).kind === "escaping_assignment"`), a call of `defineProperty` / `defineProperties` / `setPrototypeOf` / `assign` / `set` / `__defineGetter__` / `__defineSetter__` by name, or a `with` statement (`fileMayWriteBuiltin`, applied after the closure is read, in `module-load-closure.ts`); the left of `instanceof` (RWF-154) fails closed unconditionally |
| `b0-fail-closed-as-worded.patch` | **(b0)** option (b) as the backlog row worded it: every use fails closed but an element read and `length` |
| `b1-fail-closed-measured.patch` | **(b1)** option (b) corrected by the probe, as a list of the uses that fail closed: the method calls, `for…of`, the member reads but `length`, the conversions, a property key, `await` and `instanceof` fail closed, and every other use stays exempt; meant as every use failing closed but `length` and the operators real Node never converts the list with (`===`, `!==`, `typeof`, `void`, `!`, the right of `in`, `==` / `!=` with `null`, `for…in`, a test, `??`, `&&`, `\|\|`) |
| `b2-allow-list.patch` | **(b2)** the same exempt uses as an allow-list over the use: for every expression that is the list, its syntactic parent decides; exempt only `length`, `for…in`, an operand of `===` / `!==` / `typeof` / `void` / `!` / the right of `in` / `==` or `!=` against `null`, a test, a `switch` or `case` value, a discarded value, the initializer of a plain unexported `const` whose declared name itself resolves to the list (revised after the audit's round 2, RWF-157); an `ambiguous` member named `paths`, or under a computed key into a `Module` instance or an `ambiguous` value, is the list too (round 3); a parent that only selects the value (parentheses, a type assertion, a conditional's branches, `\|\|` / `??`, the right of `&&` or a comma) is classified by its own parent; every other parent fails closed (`listUseReason`) |

## 1. What real Node hands to user code

A probe (`probe.mjs`, 275 cases, and `probe2.mjs`, 11; each a fresh
CommonJS file run in its own `node`) installed functions that record every value they receive, and checked
whether a use of `module.paths` hands the list itself to user code
(`this` or an argument), under each tamper:

- **Every method** of `MODULE_PATHS_READ_METHODS` (16), replaced as a data
  property or as an accessor. `concat`, `flat` and `slice` also hand it on
  through a `constructor` accessor (species), and `concat` through a
  `Symbol.isConcatSpreadable` getter and through a Proxy as
  `Array.prototype`'s [[Prototype]].
- **`for…of` and spread**, through a replaced or accessor
  `Symbol.iterator`. `next` of `values()` / `keys()` / `entries()` never
  sees the list.
- **A conversion**: a template, `+`, `-`, unary `+` / `-` / `~`, `++` /
  `--` (before a `const` alias throws), `<`, `==` with a primitive, `+=`,
  the left of `in`, a property key (`o[list]`, `{ [list]: v }`, a class
  member's name), an outer array converted or used as a key
  (`[list] + ""`), through a replaced
  `join` / `toString`, a `Symbol.toPrimitive`, `Object.prototype.valueOf`,
  or a Proxy parent.
- **A member read the list does not own**: a named member, an index past
  its end, a method read as a value, through a getter on
  `Array.prototype` / `Object.prototype` or a Proxy parent.
- **`await list`**, through a `then` getter or method (read synchronously).
- **`instanceof`**: the right operand through an inherited
  `Symbol.hasInstance` getter; the left operand **with no builtin
  replaced**, to the program's own `static [Symbol.hasInstance]`
  (RWF-154).
- **No tamper at all**: the list held in an array literal or a shorthand
  property and mutated on the spot (`[list][0].shift()`, PRM-105;
  `({ p }).p.shift()`, RWF-155), a `const` that may hold `require` or the
  list (`c ? require : module.paths`, RWF-157), and PRM-22's name collision.
  Found by the independent audit, rounds 1 and 2.
- **No use of the list at all** (RWF-156, round 2): index setters or a
  `paths` setter on `Object.prototype`, or a Proxy as `Array.prototype`'s
  [[Prototype]], receive the lookup state from Node's own loader
  (`Module._resolveLookupPaths`'s `unshift`, `Module.prototype.load`'s
  `this.paths = …`), and so does a plain store of
  `Array.prototype.constructor` whose species is a Proxy (round 3), and an
  `extensions` or `cache` setter on `Object.prototype`, which
  `makeRequireFunction`'s plain stores hand the loader's registries to
  (round 4). The
  probes check only whether `module.paths` itself
  is handed on, so by construction they cannot see this copy.

Never, under any tamper tried: `length`, an own index, `for…in`, `===`,
`!==`, `typeof`, `void`, `!`, the right of `in`, `== null`, `==` with an
object, `switch`, `if`, `??`. The oracle's `sound.*` cases confirm these
end to end. This is a measurement over the tampers tried, not a proof over
the specification.

## 2. The corpus census (`census.mjs`)

Over this repository's `node_modules` and npm's own (3,838 `.js` / `.cjs` /
`.mjs` files, 450 packages; two over 2 MB skipped):

- **0 files** spell a use of a `Module` instance's lookup list
  (`module.paths`, `require.main.paths`, `process.mainModule.paths`,
  `module.parent.paths`, `module.children[i].paths`, as a dotted member;
  a raw text search for `.paths` on those receivers finds none either). BL-092 measured the same on
  the 2,318 files of its day. The precision either option gives up is not
  measurable on real code here: it is the synthetic controls below.
- **1,485 files** (38.7 %) in **314 of 450 packages** (69.8 %) have at
  least one store the escape row counts as an escape: a lower bound on how
  often option (a)'s precondition fails (builtin calls and the other store
  forms are not counted). A closure loading any one of them gives up (a)'s
  exemptions.

## 3. The BL-096 oracle cases (`tests/oracle/bl096-module-paths-read-only.*`)

`NA` = `NOT_AFFECTED`, `UNK` = `UNKNOWN`. Every `NA` where Node calls the
target is a false `NOT_AFFECTED`.

| case | Node calls | base | (a) | (b0) | (b1) | (b2) |
| --- | --- | --- | --- | --- | --- | --- |
| `rwf136.includes-replaced` | yes | NA | UNK | UNK | UNK | UNK |
| `rwf136.iterator-replaced` | yes | NA | UNK | UNK | UNK | UNK |
| `rwf136.join-replaced-template` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.includes-spelled` | yes | UNK | UNK | UNK | UNK | UNK |
| `measured.tamper-in-sibling-file` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.tamper-in-entry` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.tamper-unspelled-prototype` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.method-accessor` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.slice-constructor-getter` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.named-member-getter` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.non-own-index-getter` | yes | NA | UNK | **NA** | UNK | UNK |
| `measured.proxy-parent-index` | yes | NA | UNK | **NA** | UNK | UNK |
| `measured.to-primitive-plus` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.in-left-to-string` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.property-key-to-string` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.await-then-getter` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.instanceof-right-has-instance-getter` | yes | NA | UNK | UNK | UNK | UNK |
| `measured.aliased-define-property` | yes | NA | **NA** | UNK | UNK | UNK |
| `measured.reflect-apply-define-property` | yes | NA | **NA** | UNK | UNK | UNK |
| `measured.instanceof-has-instance` | yes | NA | UNK | UNK | UNK | UNK |
| `audit.spread-iterator-replaced` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.spread-conditional-branch` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.increment-const-alias` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.array-literal-converted` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.array-literal-key` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.array-element-shift` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.array-for-each-shift` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.shorthand-property-shift` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit.property-assignment-shift` | yes | UNK | UNK | UNK | UNK | UNK |
| `audit2.alias-conditional-other-capability` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit2.alias-logical-other-capability` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit2.alias-conditional-spread` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit2.alias-name-collision` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit2.computed-key-in-array` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit2.index-setters-loader-unshift` | yes | NA | **NA** | **NA** | **NA** | **NA** |
| `audit2.proxy-parent-set-trap` | yes | NA | **NA** | **NA** | **NA** | **NA** |
| `audit2.paths-setter-in-entry` | yes | NA | **NA** | **NA** | **NA** | **NA** |
| `audit3.cache-entry-template` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.cache-entry-spread` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.cache-entry-alias-literal-key` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.constructor-cache-template` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.deep-alias-chain-template` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.deep-list-alias-spread` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.cache-entry-array-shift` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.deep-alias-array-shift` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.cache-entry-shorthand-shift` | yes | NA | **NA** | **NA** | **NA** | UNK |
| `audit3.species-constructor-store` | yes | NA | **NA** | **NA** | **NA** | **NA** |
| `audit4.extensions-setter-registry` | yes | NA | **NA** | **NA** | **NA** | **NA** |
| `audit4.cache-setter-registry` | yes | NA | **NA** | **NA** | **NA** | **NA** |
| `sound.for-in-iterator-replaced` | no | NA | NA | NA | NA | NA |
| `sound.length-and-own-index-proxy-parent` | no | NA | UNK | NA | UNK | UNK |
| `sound.strict-equality-typeof-not` | no | NA | NA | NA | NA | NA |
| `sound.loose-null-switch-if-nullish` | no | NA | NA | NA | NA | NA |
| `sound.void-in-right-selections` | no | NA | NA | NA | NA | NA |
| `precision.alias-read-methods` | no | NA | NA | UNK | UNK | UNK |
| `precision.for-of` | no | NA | NA | UNK | UNK | UNK |
| `precision.template` | no | NA | NA | UNK | UNK | UNK |
| `precision.instanceof-plain-class` | no | NA | UNK | UNK | UNK | UNK |
| `precision.computed-element` | no | NA | NA | NA | UNK | UNK |
| `precision.cache-entry-exports-read` | no | NA | NA | NA | NA | NA |
| `precision.unrelated-store` | no | NA | UNK | UNK | UNK | UNK |

| | base | (a) | (b0) | (b1) | (b2) |
| --- | ---: | ---: | ---: | ---: | ---: |
| false `NOT_AFFECTED`, uses of the list (of 43 Node calls) | 41 | 24 | 24 | 22 | 0 |
| false `NOT_AFFECTED`, RWF-156: no use of the list (of 6) | 6 | 6 | 6 | 6 | 6 |
| proofs kept (of 12 Node does not call) | 12 | 9 | 7 | 5 | 5 |

(a)'s misses are two builtin stores its precondition does not see (an
aliased `Object.defineProperty`, and `Reflect.apply` of it) and the eight
audit cases, which no exemption of the base covers. A better
detector sees the first through the call graph's builtin identity; no
detector short of the escape row's whole relation sees every route a
builtin is handed to and called through, and that relation is not
certified (ADR 0008, BL-094's proposed decision). (b0)'s misses are the
inherited lookups an element read past the end makes, and the audit's
eight. (b1)'s misses are the audit's eight: spread, `++` on a `const`
alias, an outer array converted or used as a key, and the list in an array
literal or a shorthand property. A list of the uses that fail closed
leaves every use it does not name exempt. (b2) inverts it. Its first form
also exempted a `const` alias that may hold another capability (RWF-157),
so it is revised. It also read only a `module_paths` resolution, and the
round-3 `ambiguous` routes (`require.cache[k].paths`, a chain past the
depth budget) got the base's exemptions, so it is revised again. No option
sees RWF-156, which needs a closure-wide fact (backlog `BL-111`).

## 4. The other suites, each prototype applied

| Suite | (a) | (b1) | (b2) |
| --- | --- | --- | --- |
| `npm test` (6,708 tests) | 0 failures | **4** precision controls: ADR 0010 § 4's control 11 (`module.paths.slice()` / `includes()`, `module-load-closure.test.ts`) and BL-092's three (`loader-constructs.bl092.test.ts`: read-only methods; an element read and `length`; iteration) | the same **4** |
| `test:oracle` outside BL-096 (1,356 tests) | 0 failures | **1** precision control: BL-092's `precision.read-only-uses` (an element read and `for…of`) | the same **1** |

(b0) differs from (b1) only on element reads; it was measured on the
BL-096 cases alone.

## 5. The corpus differentials

`node scripts/differential.mjs --base 904d032`, each prototype applied to
the working tree, over the validation and both adversarial corpora (139
cases; the base side cached, and collected again when the corpus's
`FINDINGS.md` changed):

| | graph | proof | verdict |
| --- | --- | --- | --- |
| (a) | 0 of 139 cases changed | 0 findings | 0 changed, 0 into `NOT_AFFECTED`, 0 added, 0 removed |
| (b1) | 0 of 139 cases changed | 0 findings | 0 changed, 0 into `NOT_AFFECTED`, 0 added, 0 removed |
| (b2) | 0 of 139 cases changed | 0 findings | 0 changed, 0 into `NOT_AFFECTED`, 0 added, 0 removed |

Zero by the census: no corpus case uses the lookup list read-only (the
two adversarial cases that use it, `adv2-056` and `adv2-057`, mutate it,
which fails closed under every option). A zero differential is not
evidence of soundness (OPEN-DEBTS D-12): § 3 is.

## 6. Reproducing the table

Apply a patch and run the committed suite:

```bash
git apply scripts/bl096-module-paths-options/b2-allow-list.patch
npx vitest run --config vitest.oracle.config.ts tests/oracle/bl096-module-paths-read-only.test.ts
git checkout -- src
```

On the base every case passes. Under a patch, an open-soundness-defect
record that fails is a case whose verdict moved (to the `UNKNOWN` it
expects). A record still failing because its observation drifted but whose
verdict is `NOT_AFFECTED` is a miss. A control that fails is a proof the
option gives up.
