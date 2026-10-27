# BL-114 — BL-111's loader inventory, by Node release

Task [`BL-114`](../../docs/tasks/BL-114-loader-inventory-node-releases.md).
BL-111's inventory ([`inventory.md`](../bl111-loader-writes-options/inventory.md))
is a claim about Node v22.11.0. This repeats it on CI's releases (Node 20
and 26, `.github/workflows/ci.yml`) and on the other LTS lines (22, 24),
and bounds each live route by release. Base `3cfe09d` (BL-111's merge).

## Releases measured

Official `linux-x64` builds from `nodejs.org/dist`, each checked against
the release's `SHASUMS256.txt`.

| release | why |
| --- | --- |
| v22.11.0 | BL-111's (installed locally) |
| v20.20.2 | CI's `node-version: 20` (the line's latest) |
| v26.12.1 | CI's `node-version: 26` (the line's latest) |
| v22.23.4, v24.22.1 | the other LTS lines' latest |
| v20.19.0, v22.12.0 | the first releases with `require()` of an ES module unflagged |
| v24.0.0, v26.0.0 | each line's first release |
| v24.11.1, v24.12.0 | the edge on v24, found by bisection (`v24.16.0`, `v24.13.1`, `v24.12.0` probed) |

## What changed: the routes, by release

`EVIL` means the store chose what loaded. Each cell is real Node
(`gadgets.cjs`, `gadgets-releases.cjs`).

| route | v20.19.0, v20.20.2 | v22.11.0 | v22.12.0 | v22.23.4 | v24.0.0 to v24.11.1 | v24.12.0, v24.22.1 | v26.0.0, v26.12.1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E3: `Object.prototype.source`, then `import()` (BL-111's) | EVIL | EVIL | EVIL | EVIL | EVIL | GOOD | GOOD |
| R1: `Object.prototype.source`, then `require()` of an ES module with a static ES dependency | EVIL | throws `ERR_REQUIRE_ESM` | EVIL | EVIL | EVIL | GOOD | GOOD |
| R2: the same with a static CommonJS dependency | replaced (the stored text compiled as CommonJS, and throws) | throws `ERR_REQUIRE_ESM` | replaced | replaced | replaced | GOOD | GOOD |
| R3: the same with no dependency | GOOD | throws | GOOD | GOOD | GOOD | GOOD | GOOD |
| G1b: getters for `data` / `path` answering `false`, then a bare `require` in a module with no package scope | EVIL | GOOD | GOOD | GOOD | GOOD | GOOD | GOOD |
| G2b: `Object.prototype.conditions = new Set([...])`, then `require.resolve(x, { paths })` | GOOD | GOOD | GOOD | EVIL | EVIL | EVIL | EVIL |
| G3: `Object.prototype.paths = [dir]`, then a module loaded after it requires a bare name | GOOD | GOOD | GOOD | EVIL | EVIL | EVIL | EVIL |

Every cell was measured on every release of its column (`gadgets.cjs`
and `gadgets-releases.cjs` on all eleven). The bisection between v24.0.0
and v24.22.1 measured R1 only. G3 was bisected on v22: v22.13.1 and
v22.14.0 GOOD, v22.15.0, v22.15.1 and v22.20.0 EVIL, so it opens at
v22.15.0 (G3 was added after BL-114's independent audit found it). G1, a plain data store of `data` and
`path`, throws on every release, and G2, `conditions` as an array, throws
or is ignored.

### Why, from the loaders' own source

`process.binding("natives")` of each release (see `run.mjs`).

- **E3, R1, R2.** `defaultLoad` / `defaultLoadSync` (`esm/load.js`)
  destructure `format` and `source` from their context, so an inherited
  `source` is taken as the module's text. The ES module loader builds that
  context as a plain literal, `{ format, importAttributes }`:
  - v20.20.2: `#createModuleJob`, `esm/loader.js:560`;
  - v22.23.4: `getModuleJobForRequire`, `:498`, and `#createModuleJob`, `:633`;
  - v24.11.1: `getModuleJobForRequire`, `:480`.

  v24.12.0 builds `{ format, importAttributes, __proto__: null }` in
  `#getOrCreateModuleJobAfterResolve` (`:563`), and v26.12.1 does too
  (`:559`). The required file itself is read by the CommonJS loader, which
  is why R3 is `GOOD` everywhere.
- **G1b.** v20's `trySelf` (`cjs/loader.js:589`):
  `const { data: pkg, path: pkgPath } = packageJsonReader.readPackageScope(parentPath)`.
  `readPackageScope` returns `false` at a `node_modules` boundary
  (`package_json_reader.js:161`), and destructuring `false` reads
  `Boolean.prototype`, then `Object.prototype`. A fake package named like
  the request resolves the request in `path`. From v22 the reader is
  native, and the read is gone.
- **G3.** `Module.prototype.load` sets the lookup list with
  `this.paths = Module._nodeModulePaths(…)` up to v22.14.0
  (`cjs/loader.js:1279`; v20.20.2 `:1262`) and with `this.paths ??= …`
  from v22.15.0 (`:1455`; v24.11.1 `:1477`, v26.12.1 `:1680`). A new
  `Module` owns no `paths`, so `??=` keeps an inherited list.
- **G2b.** v22.23.4 and later read `options.conditions` in
  `Module._resolveFilename`. A `require.resolve` options object is the
  caller's literal, so it inherits.

## The inventory: inherited accesses, compared with v22.11.0's

The probe of `inventory.md` (3,023 to 3,486 recording accessors, none
failed), with the workload extended by `--require-esm`. Hits are compared
by operation, prototype, name, receiver type and loader function, with
line numbers dropped. Distinct accesses: v22.11.0 34, v20.20.2 32,
v22.23.4 26, v24.22.1 24, v26.12.1 24.

New on the measured releases, and what each is:

| access | releases | what it is |
| --- | --- | --- |
| `get`/`set Object.prototype source` @ `defaultLoadSync` | v20.20.2, v22.23.4 | R1 |
| `get Object.prototype data`, `path` <boolean> @ `trySelf` | v20.20.2 | G1b |
| `get Object.prototype conditions` @ `_resolveFilename` | v22.23.4, v24.22.1, v26.12.1 | G2b |
| `get Object.prototype paths` @ `Module.load` | v22.23.4, v24.22.1, v26.12.1 | `this.paths ??= …`: G3, a plain data store is enough (RWF-160). BL-114 first described it as the property RWF-156's setter already reaches; its independent audit showed that wrong |
| `set Array.prototype 0` @ `ModuleJobSync` / `syncLink` | v20.20.2, v22.23.4, v24.22.1, v26.12.1 | the ES module job's request array, written as BL-111's `ModuleJob._link` was (RWF-156's index-setter class) |
| `get Array.prototype 0`, `1` @ `package_json_reader.read` | v20.20.2 | v20's JavaScript package.json reader indexes an array it builds: an index getter (RWF-156's class) |
| `get Object.prototype WATCH_REPORT_DEPENDENCIES`, `buffer` | v20 to v26 | an environment flag and an fs option: not a load redirect |

Gone since v22.11.0: the `fs/promises` reads (`encoding`, `signal`,
`then`), BL-111's E2 and E4 routes, which only made a load throw. From
v24.12.0 the async `defaultLoad`'s `source` read is gone as well (E3).

On v20.20.2 the probe's own accessors make `import()` throw ("Invalid
property descriptor. Cannot both specify accessors and a value or
writable attribute"; the recorded names include `get`, `set`, `value` and
`writable`), so the probe saw no `import()` accesses there. Which of
v20's descriptors inherits them was not traced. The gadgets measured E3
on v20 directly.

## With the analyzer

In BL-092's decoy setup (`tests/oracle/bl114-require-esm-inherited-source.*`),
the analyzer answers the same on every release (it does not know the
deployed one):

| case | analyzer | real Node calls the target |
| --- | --- | --- |
| `require-esm.source-string`, `require-esm.source-unspelled-prototype` (R1) | `NOT_AFFECTED`, family B | v20, v22.12+, v24.0.0 to v24.11.1 — **RWF-158** |
| `try-self.scope-getters` (G1b) | `NOT_AFFECTED`, family B | v20 — RWF-156 |
| `inherited-paths.data-store`, `.unspelled-prototype`, `.define` (G3) | `NOT_AFFECTED`, family B | v22.15.0 and later, v24, v26 — **RWF-160** |
| `require(require.resolve("vuln-lib/index.js", { paths: [<app>] }))` (G2b's load, no store) | `UNKNOWN` | every release: the analyzer leaves a load through `require.resolve` with options unresolved, so G2b is not live with it |

`tests/oracle/bl111-loader-inherited-reads.*` (E3) is `UNKNOWN` on every
release. Its ground truth now follows the release (RWF-159).

### Against BL-111's prototype rules

`git apply scripts/bl111-loader-writes-options/<tier>.patch`, then
BL-114's records under v20.20.2 and v26.12.1:

| case | (A) | (B) | (B′) |
| --- | --- | --- | --- |
| `require-esm.source-*` (RWF-158) | still `NOT_AFFECTED` | still `NOT_AFFECTED` | still `NOT_AFFECTED` |
| `try-self.scope-getters` (RWF-156) | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| `inherited-paths.data-store`, `.unspelled-prototype` (RWF-160) | `UNKNOWN` | still `NOT_AFFECTED` | still `NOT_AFFECTED` |
| `inherited-paths.define` (RWF-160) | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |

No option BL-111 prototyped sees RWF-158. The stored value is a primitive
under a spelled name: (A) counts no primitive store, and (B) and (B′)
count none of a spelled name other than `__proto__` / `constructor`.
RWF-160's plain store is an array under a spelled name. (A) counts it,
because it is not a primitive; (B) and (B′) do not. G1b's getters and
RWF-160's define form are define calls, which every option counts.

## Limits

- Linux x64 only. Odd lines (21, 23, 25) and v20 before v20.19.0 are not
  measured. `tests/oracle/node-release-routes.ts` throws on such a
  release rather than assume.
- Between two measured releases of a line the behaviour is assumed not to
  change, except on v24, which was bisected for R1. E3 and the G routes
  were measured at v24.0.0, v24.11.1, v24.12.0 and v24.22.1 only.
- The workload is BL-111's plus `require()` of an ES module. Not reached:
  loader hooks (`module.register`), workers, `--import`, `import.meta.resolve`,
  and `process.getBuiltinModule`.
- G1 (plain data stores of `data` and `path`) makes unrelated loads throw.
  Only the accessor form (G1b) redirects.
- The other `??=` defaults in the loaders were checked after G3. The
  loaders of v20.20.2, v22.23.4 and v26.12.1 have these defaults:
  `this.filename` / `this.paths` (`cjs/loader`), `module.filename` /
  `module.paths` (`esm/translators`) and `this.module.async`
  (`esm/module_job`, a `ModuleWrap`).
  - A new `Module` owns `filename` on v22.23.4 and v26.12.1, so
    `Object.prototype.filename` does not move a later relative `require`
    (measured).
  - It does not own `paths`: G3, RWF-160.

## Reproducing

```bash
node scripts/bl114-loader-inventory-releases/run.mjs <out-dir> <node-binary>...
# e.g. the five: v22.11.0 (the baseline), v20.20.2, v22.23.4, v24.22.1, v26.12.1
PATH=<release>/bin:$PATH npx vitest run --config vitest.oracle.config.ts \
  tests/oracle/bl114-require-esm-inherited-source.test.ts \
  tests/oracle/bl111-loader-inherited-reads.test.ts
```
