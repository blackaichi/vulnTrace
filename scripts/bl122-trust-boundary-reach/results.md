# BL-122 — the trust boundary's reach, measured

Task [`BL-122`](../../docs/tasks/BL-122-trust-boundary-reach.md). Base
`58a5f32` (BL-113's merge); the option measurements ran against
`c7e8852`, the base plus this task's first inventory and oracle cases (no
change to `src/`). Real Node v22.11.0 unless a release is named.

## 1. What Node's own loaders touch, outside the intrinsic prototypes

`probe-reach.cjs` replaces every configurable member of four kinds of
builtin object with a recording wrapper, then runs three load workloads
(`make-fixture.cjs`) and records each apart:

- `cjs`: `main`, `exports` with a subpath, JSON, a relative load,
  `require.resolve`;
- `require-esm`: `require()` of an ES module importing a CommonJS package
  with `exports`, an ES module package and a relative module (it throws on
  v22.11.0, after the resolver has run);
- `import`: the same through `import()`.

The first version ran `cjs` only; BL-122's independent audit (rounds 1
and 2) found that the ES module loader reads through members the
CommonJS loader does not, and the probe was extended.
`run-releases.mjs` repeats it per release, and its full table, every
member by workload and release, is
[`reach-releases.md`](reach-releases.md):

```bash
node scripts/bl122-trust-boundary-reach/run-releases.mjs <out-dir> \
  /data/tools/nodeinst/bin/node /data/tools/node-releases/node-v*/bin/node
```

Kinds: O1 a builtin constructor's own properties (and `%TypedArray%`'s);
O2 Node's own builtin prototypes and constructors (`URL`,
`URLSearchParams`, `Buffer`, `EventEmitter.prototype`); O3 a builtin
module's exports object (every `builtinModules` entry but `module`, which
is Node's loader object, already modeled); O4 a namespace (`JSON`,
`Math`, `Reflect`, `Atomics`, `Intl`, `console`), `process` and
`globalThis`'s own members. `process` and `console` are also the
`process` and `console` builtins' exports objects
(`require("process") === process`): the probe wraps `console` first as a
namespace and `process` first as a builtin module, and labels them so.

What each workload touches, in summary (13 releases, v20.19.0 to
v26.12.1; "some" = on some releases only, see the full table):

| kind | `cjs` | `require-esm` (adds) | `import` (adds) |
| --- | --- | --- | --- |
| O1 | `Array[Symbol.species]` | `Object.create`, `Promise.resolve` (some) | `Promise[Symbol.species]`, `Object.defineProperty` (some) |
| O2 | `URL.prototype` `hostname`, `href`, `pathname`, `protocol`, `toString`; `Buffer.isEncoding` | `URL.prototype` `hash`, `search` (get and set); `Buffer.allocUnsafe`; `Buffer.prototype.toString`, `utf8Slice` (some) | `Buffer.from`, `allocUnsafeSlow`; `EventEmitter.prototype` `emit`, `on`, `once`, `removeListener`, `listenerCount` |
| O3 | `fs.readFileSync`, `realpathSync`; `path`'s `resolve`, `dirname`, `join`, `normalize`, `basename`, `isAbsolute`, `toNamespacedPath`, `posix`, `sep` (some); `process.mainModule` | `fs.openSync`, `readSync`, `closeSync`; `path.extname` (some); `process.env`, `nextTick` and `emitWarning` (some); `util/types.isArrayBufferView`, `isPromise` (some) | `fs/promises.readFile`; `events.init`; `domain.active`; `process._events`, `domain` |
| O4 | nothing | `JSON.parse` (some); `globalThis.String`, and `Array`, `Promise`, `RegExp`, `Set`, `eval` (some) | (as `require-esm`) |

A member not touched is not touched by these workloads: ESM hooks,
workers, `--import` and `import.meta.resolve` were not run (BL-111's and
BL-114's open items). A touched member is a candidate route, not a
measured one; § 2 says which were measured end to end.

## 2. End to end (`tests/oracle/bl122-trust-boundary-reach.*`)

Every member below makes real Node call the target (for
`fs.readFileSync`, the decoy runs the affected instance's source under
the decoy's own module identity), and the analyzer answers
`NOT_AFFECTED` (family B) on the base, on v22.11.0, v20.20.2 and
v26.12.1 (the `require()` of an ES module forms: where the release runs
it):

| kind | finding | forms |
| --- | --- | --- |
| O1 | RWF-161 | `Object.defineProperty(Array, Symbol.species, …)` (BL-113's case); on `[].constructor` |
| O2 | RWF-162 | a `pathname` getter on `URL.prototype` (BL-113's case); on `Object.getPrototypeOf(new URL(…))` |
| O3 | RWF-163 | `path.resolve` assigned, defined, through `path/posix`, from a sibling module, and before `require()` of an ES module; `fs.realpathSync` assigned, through `Reflect.set`, through a parameter; `fs.readFileSync` assigned; `fs.openSync` before `require()` of an ES module |

The `require()` of an ES module routes, per release
(`require-esm-route.mjs`: replace the member, `require()` an ES module
importing `vuln-lib/index.js`; "called" is the affected instance, "decoy"
the decoy, "throws" the load):

| release | `fs.realpathSync` | `path.resolve` | `fs.openSync` | none |
| --- | --- | --- | --- | --- |
| v20.19.0, v20.20.2 | called | called | called | decoy |
| v22.11.0 | throws | throws | throws | throws |
| v22.12.0, v22.14.0, v22.15.0, v22.23.4 | called | called | called | decoy |
| v24.0.0, v24.11.1, v24.12.0, v24.22.1 | called | called | called | decoy |
| v26.0.0 | throws | called | called | decoy |
| v26.12.1 | called | called | called | decoy |

**Not measured end to end:** every other touched member. `import()`'s
members are not live false `NOT_AFFECTED`s today, because the analyzer
widens the closure on `import()` and answers `UNKNOWN`; the
`require-esm` members other than `path.resolve` and `fs.openSync`
(`fs.readSync`, `Buffer.allocUnsafe`, the `URL.prototype` setters,
`process.env`, `JSON.parse`, the globals called) are candidates whose
effect on a load was not tried. `Buffer.isEncoding` and
`process.mainModule` choose no load (an encoding check; `require.main`).

## 3. Closure-wide rules, measured (`scripts/measure-options.mjs`)

| Patch | Rule |
| --- | --- |
| `RA.patch` | BL-111's `A.patch`, unchanged: any store the escape row counts as an escape, and a call of `defineProperty` / `defineProperties` / `setPrototypeOf` / `__defineGetter__` / `__defineSetter__` / `assign` / `set` by name, widens the closure. Not sound as prototyped (BL-111's audit: storing builtins recognised by name) |
| `RS.patch` | a store (assignment, or one of those calls) whose receiver is SPELLED as one of the kinds: `require("<builtin>")`, a local bound to a builtin module, a global constructor name, `URL.prototype` / `URLSearchParams.prototype` / `Buffer.prototype`, a builtin module's `.prototype` or `.posix`. **Unsound by construction** |

```bash
node scripts/measure-options.mjs --base c7e8852 \
  --census scripts/bl122-trust-boundary-reach/census.mjs --cleanup \
  scripts/bl122-trust-boundary-reach/RA.patch scripts/bl122-trust-boundary-reach/RS.patch
```

| | base | RA | RS |
| --- | ---: | ---: | ---: |
| oracle tests passed / run | 1454 / 1454 | 1406 / 1454 | 1440 / 1454 |
| open records flipped to admissible | — | 11 | 11 |
| controls lost | — | 37 | 3 |
| `node_modules` files flagged (of 2,525) | — | 1,585 (62.8 %) | 23 (0.9 %) |
| packages flagged (of 208) | — | 161 (77.4 %) | 14 (6.7 %) |
| graph differential | — | 0 | 0 |
| proof differential (findings) | — | 5 | 0 |
| verdict differential (into `NOT_AFFECTED`) | — | 5 (0) | 0 (0) |
| validation `NOT_AFFECTED` proofs lost (of 4) | — | 2 (`RWB-07`, `RWB-11b`) | 0 |
| adversarial `NOT_AFFECTED` proofs lost (of 16) | — | 0 | 0 |

- **The 11 records flipped** are the same under both: BL-122's seven
  RWF-163 forms (the three unspelled forms and the ES module form of § 2
  were added after this run), RWF-161's and RWF-162's BL-113 cases, and two RWF-144 records
  (`bl097-wrapper-arguments-frame`: an `Error.prepareStackTrace` hook,
  a store onto the `Error` constructor's own property).
- **RA's 37 controls** are BL-111's (A) losses again: the BL-096
  `sound.*` controls, the trust boundary's own cases, A-3a's, BL-091's,
  BL-095's, BL-105's and BL-109's guards, and BL-122's two identity
  controls. Its verdict moves are BL-111's (`ADV2-081`, `ADV2-082`,
  `RWB-07`, `RWB-11a`, `RWB-11b`).
- **RS's 3 controls**: BL-122's two identity wrappers (a replacement that
  redirects nothing, which a closure-wide rule cannot tell from one that
  does) and A-3a's `assigned.Error.prepareStackTrace`.
- **RS's 23 files** are V8 stack-trace hooks (`Error.prepareStackTrace` /
  `Error.stackTraceLimit` in `callsites`, `stackback`, vitest, vite,
  rollup, typescript-eslint, `@babel/types`, prettier, which also has a
  minified `String.lastIndex = …`) and `natural-compare`
  (`String.naturalCompare = …`). No `fs` or `path` patcher is
  among this repository's dependencies; graceful-fs-style patching does
  not occur in the census roots.

**RS misses the unspelled forms.** With `RS.patch` applied, the seven
spelled RWF-163 forms answer `UNKNOWN`, and the three unspelled forms of
§ 2 (through a parameter, `[].constructor`, `Object.getPrototypeOf(new
URL(…))`) still answer `NOT_AFFECTED` while real Node calls the target.
With `RA.patch`, all ten answer `UNKNOWN`. A sound rule for any of the
four kinds must see a store through any receiver the analyzer has not
proven the program's own, which is RA's class: the analyzer cannot tell
a parameter holding `require("fs")` from any other object it did not
create.

## Reproducing

```bash
git apply scripts/bl122-trust-boundary-reach/RS.patch   # or RA.patch
npx vitest run --config vitest.oracle.config.ts tests/oracle/bl122-trust-boundary-reach.test.ts
git checkout -- src
```

Under a patch, a failing open-soundness-defect record is a case whose
verdict moved to `UNKNOWN`, and a failing control is a proof the rule
gives up.
