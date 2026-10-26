# BL-111 — what Node's own loader reads and writes by inheritance (Node v22.11.0)

Task [`BL-111`](../../docs/tasks/BL-111-loader-writes-builtins.md).
Everything here is measured on Node v22.11.0, the only `node` installed
where the task ran. CI runs Node 20 and 26, whose loaders differ, so this
is a claim about v22.11.0.

## Method

1. **The loader's own source.** `process.binding("natives")` exposes the
   JavaScript of Node's internal modules. The 25 files of
   `internal/modules/**`, `internal/fs/utils`, `internal/url`, `path`,
   `internal/process/pre_execution` and `internal/main/run_main_module`
   give 1,002 candidate property names: every `.name`, quoted key and
   `name:` in them, plus the indices 0–49.
2. **A dynamic probe** (`probe-inherited.cjs`, the project built by
   `setup.sh`). For each candidate name and each well-known symbol, it
   installs a recording getter and setter on `Object.prototype`,
   `Array.prototype` and `Function.prototype`, wherever the prototype does
   not own the name: 3,023 accessors. The descriptors have no prototype,
   because an inherited `value` / `writable` accessor would otherwise make
   every later definition throw. The probe then runs:
   - a relative require, a bare require with `main`, one without `main`,
     an `exports`-map require and a subpath require;
   - a JSON require, `require.resolve` with `paths`, and an ES module
     `import()`.

   An access whose caller frame is in `node:internal/modules`,
   `node:internal/fs` or `node:path` is recorded with that frame.
3. **A static review** of the species-honouring primordials the loader
   calls (`ArrayPrototypeSlice`, `ArrayPrototypeFilter`, `ArrayPrototypeMap`
   honour `Symbol.species` through the array's `constructor`).
4. **Attacks against real Node** (`gadgets.cjs`): a plain data property
   per candidate read, to see whether it changes what is loaded.
5. **End to end with the analyzer**, in BL-092's decoy setup:
   `tests/oracle/bl096-module-paths-read-only.*` (RWF-156's six records)
   and `tests/oracle/bl111-loader-inherited-reads.*`.

## What the loader does by inheritance

| class | where (v22.11.0) | what a module installs | live end to end |
| --- | --- | --- | --- |
| **writes** onto a `Module` it creates | `new Module`: `id`, `path`, `filename`, `loaded`, `children` (loader:298–305); `Module.load`: `paths` (1304); `_resolveFilename`'s fake parent: `paths` (1186); `createRequire`: `paths` (1735) | a setter on `Object.prototype` | yes: `audit2.paths-setter-in-entry` |
| **writes** onto a `require` function it creates | `makeRequireFunction`: `resolve`, `paths`, `extensions`, `cache` (helpers:154–172) | a setter on `Function.prototype` | yes: `audit4.extensions-setter-registry`, `audit4.cache-setter-registry` |
| **writes** into arrays it builds | `_resolveLookupPaths`: `ArrayPrototypeUnshiftApply` (936); ESM `ModuleJob._link` (module_job:140–141) | an index setter on `Object.prototype` / `Array.prototype`, or a Proxy as `Array.prototype`'s [[Prototype]] | yes: `audit2.index-setters-loader-unshift`, `audit2.proxy-parent-set-trap` |
| **species**: arrays built with the receiver's `constructor` | `ArrayPrototypeSlice(modulePaths)` (935, 1799); `ArrayPrototypeFilter` over extension lists (661, 672, 680); ESM `ArrayPrototypeMap` (resolve:954) | a store of `Array.prototype.constructor` (a plain data store) or an `Array[Symbol.species]` definition | yes: `audit3.species-constructor-store` |
| **reads** of a data property, ES module load | `defaultLoad`: the context's `source` (esm/load:94) | `Object.prototype.source = <module text>` (a plain string) | in real Node yes: the stored text is evaluated in place of the file (`gadgets.cjs` E3). With the analyzer, `UNKNOWN` (`inherited-read.source-*`), because an `import()` already widens the closure. On v22.11.0 an ES module is loaded after a store only by `import()`; static imports load before any module body runs. |
| **reads** of a data property, conversions | `Symbol.toPrimitive` on URLs (package_json_reader:132–135, esm/resolve:246, 406–408, 813, 1003; cjs loader:1265) | a function on `Object.prototype[Symbol.toPrimitive]` | no redirect found: the conversions feed a regex check and a URL constructor, and the attempt threw `Invalid URL` (E1, E5), which is a denial of service |
| **reads** of a data property, fs options | `getOptions`: `encoding`, `signal` (fs/utils:330–339); `readFileHandle` | `Object.prototype.encoding = "buffer"` | no redirect: the load throws (E4), which is a denial of service |
| **reads**, promises | `then` on awaited values (esm/load:44, fs/promises) | `Object.prototype.then` | no redirect found (E2) |

Not reached by the workload, so not measured: the ESM loader hooks
(`module.register`), workers, `--import` preloads, `require(esm)` (not in
v22.11.0; unflagged from v22.12 and in CI's Node 26), and
`import.meta.resolve`.

## What follows for a closure-wide rule

- A rule over the accessor and [[Prototype]] stores alone is too narrow.
  The species route is a plain data store of `constructor`, and the ESM
  `source` route is a plain *primitive* store, which the escape row does
  not count (`isPrimitiveSyntax`).
- On v22.11.0 every **live** route for a statically followed CommonJS load
  is one of these:
  - a setter, an index setter or a Proxy on a builtin prototype, all
    reached by a define call or a [[Prototype]] change;
  - a `constructor` or species store.

  The data reads found either need an ES module load after the store
  (`import()`, already widening the closure) or only make the load throw.
- The list is a property of v22.11.0's loader source. Node rewrites that
  source between releases (the package.json reader moved to C++ in v22),
  so no list of names closes the class across versions. BL-081 rejected
  keying the escape row by member name for the same reason.
