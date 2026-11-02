# BL-128 — where Node's loaders touch BL-122's members

Task [`BL-128`](../../docs/tasks/BL-128-loader-member-routes.md). Base
`f4408fe` (BL-122's merge). No change to `src/`. Real Node v22.11.0 and
the twelve releases under `/data/tools/node-releases` (v20.19.0 to
v26.12.1).

**What this is not.** No member below was tried end to end: no change to
a member was run in BL-092's decoy setup, and no analyzer verdict was
recorded for one. The classification says what the loader does with each
member's value at its call site, which bounds what a change to it could
reach. Trying the candidates end to end is backlog `BL-129`.

## 1. BL-122's inventory, corrected (RWF-164)

`probe-reach.cjs` computed its workload's paths (`path.join`,
`url.pathToFileURL`, `URL.prototype.href`), stringified its results
(`String(…)`) and chained `.then` on `import()`'s promise while recording
was on, so its table counted the probe's own calls as the loaders'. With
that work moved outside the recording window, eight rows of
`../bl122-trust-boundary-reach/reach-releases.md` are gone on every
release, and no other row changed:

| removed row | why it was there |
| --- | --- |
| `cjs`, `require-esm`, `import` · `require("path").join()` | the probe's `path.join(fixture, …)` |
| `require-esm`, `import` · `require("path").normalize()` | called by that `path.join`; the `cjs` row stays (`Module._findPath`) |
| `import` · `require("url").pathToFileURL()` | the probe's `pathToFileURL(…)` |
| `require-esm`, `import` · `globalThis.String()` | the probe's `String(result.default)` |

`URL.prototype.href` and `Promise[Symbol.species]`, which the probe also
touched, stay: the loaders touch them too. The distinct members are 52,
not 55 (43, not 45, without `import()`).

## 2. Call sites

`callsites.cjs` wraps each candidate with a recorder that keeps, per call,
the two stack frames outside itself, and runs BL-122's `require-esm` and
`import` workloads (`make-fixture.cjs`). It changes no value. The callers
below are its output on all thirteen releases (`require-esm` throws on
v22.11.0); the CommonJS loader's own call sites are read from Node's
source (`internal/modules/cjs/loader`, v22.11.0 and v22.23.4).

### (a) The value is a path, a URL or a source the loader loads

A change here could choose the file a load reads or the source it runs.
Each is a candidate route, untried.

| kind | member | caller: what the value becomes |
| --- | --- | --- |
| O2 | `URL.prototype` `href`, `pathname`, `toString` | `defaultResolve`, `finalizeResolution`, `resolvePackageTargetString`, `getPackageScopeConfig`, `getSourceSync` / `getSource`: the resolved URL, the package scope and the URL read |
| O2 | `URL.prototype` `search`, `hash` setters | `finalizeResolution`: called on the URL it returns, after the realpath |
| O2 | `Buffer.allocUnsafe` (`require-esm`; `import` from v22.23.4) | `readFileSync` → `getSourceSync`: the buffer an ES module's source is read into |
| O2 | `Buffer.allocUnsafeSlow` (`import`, to v24.0.0) | `fs/promises` `readFileHandle` → `getSource`: the same, asynchronously |
| O3 | `fs.readSync` | `readFileSync` → `getSourceSync`: reads an ES module's source into that buffer |
| O3 | `fs/promises.readFile` (`import`, to v24.0.0) | `getSource`: an ES module's source |
| O3 | `path.dirname` | `Module.load` (a module's `node_modules` lookup list), `_resolveLookupPaths` (a relative request's directory), `Module._compile` (`__dirname`), `getTraversalStartDirectory` |
| O3 | `path.toNamespacedPath` | `stat` in `Module._findPath`, `openSync`, `realpathSync`: whether a candidate file exists, and the file opened |
| O3 | `path.posix` | `pathToFileURL` in `finalizeResolution`: the `posix.resolve` the resolved URL is built with |
| O3 | `path.sep` | `findParentPackageJSON`: the directories walked to find a package scope |
| O3 | `path.isAbsolute` | `Module._findPath`, `cjsPreparseModuleExports`: whether the lookup list is used |
| O3 | `path.basename` | `findLongestRegisteredExtension`: which `Module._extensions` handler loads the file |

### (b) `cjs-module-lexer` only

When an ES module imports a CommonJS module, Node lexes the CommonJS
source for its export names and reexports. Every O4 member the
inventory lists is called there, and only there:

| kind | member | caller |
| --- | --- | --- |
| O4 | `JSON.parse`, `globalThis.eval` | `decode`: the string literal of a `require("…")` reexport |
| O4 | `globalThis.Array`, `globalThis.Set`; O1 `Object.create` | `resetState`: the lexer's state, its export and reexport sets |
| O4 | `globalThis.Promise`, `globalThis.RegExp`; O1 `Promise.resolve` | the lexer module's own initialisation |

`cjsPreparseModuleExports` resolves each reexport and reads its source
for its names; from Node's source it does not run it. Whether a lexed
reexport can choose what runs is untried.

### (c) The value reaches no choice of file or source

| kind | member | caller: what the value becomes |
| --- | --- | --- |
| O2 | `URL.prototype` `protocol`, `hostname` getters | `fileURLToPath`, `isURL`, `throwIfUnsupportedURLScheme`, `getPathFromURLPosix`: checks |
| O2 | `Buffer.isEncoding` | `assertEncoding`: a check |
| O2 | `Buffer.prototype.toString`, `utf8Slice` | `detectModuleFormat`: whether an ambiguous `.js` file is parsed as an ES module (a format, not a file) |
| O2 | `EventEmitter.prototype.emit` (`import`) | a `FileHandle`'s `close` event |
| O3 | `fs.closeSync` | `readFileSync`: given the descriptor only |
| O3 | `path.normalize` | `Module._findPath`: whether a relative request leaves its directory |
| O3 | `path.extname` (`require-esm`, to v22.14.0) | `cjsPreparseModuleExports`: a reexport's format, for its names |
| O3 | `process.env` | `getModuleJobForRequire`, `#createModuleJob`: `WATCH_REPORT_DEPENDENCIES` only (`--watch`) |
| O3 | `process.emitWarning`, `process.nextTick` | `emitExperimentalWarning`: the experimental-feature warning |
| O3 | `util/types.isArrayBufferView`, `isPromise` | `assertBufferSource`; the module job graph |

### (d) Call site not recorded

`callsites.cjs` does not record these, so they are not classified here:
`Array[Symbol.species]` (RWF-161, reproduced by BL-113 and BL-122),
`Promise[Symbol.species]` and `Object.defineProperty` (`import`; the
latter on v24.0.0 only), `process._exiting` (v22.12.0), `process._events`
and `process.domain` (wrapped, but no call recorded on these runs),
`events.init` and `domain.active` (`import`, to v24.0.0), and
`process.mainModule` (BL-122's results § 2: `require.main`).

## 3. For ADR 0010's options

- **(W-loader)** leaves the globals inside the claim. The only global calls
  of Node's loaders, on these workloads and releases, are `cjs-module-lexer`'s
  (§ 2 (b)). If a lexed reexport cannot choose what runs, (W-loader) leaves
  no global route here; that is read from Node's source, not tried.
- **(R)** must close every live route of the four kinds. § 2 (a) lists the
  O1, O2 and O3 candidates BL-122 did not reproduce; each is a possible
  open defect until tried.
- Neither changes BL-122's measured routes (RWF-161, RWF-162, RWF-163).

## Reproducing

```bash
node scripts/bl122-trust-boundary-reach/run-releases.mjs <out-dir> \
  /data/tools/node-releases/node-v20.*/bin/node /data/tools/nodeinst/bin/node \
  /data/tools/node-releases/node-v2[246].*/bin/node
node scripts/bl128-loader-member-routes/callsites.cjs <fixture-dir> require-esm
node scripts/bl128-loader-member-routes/callsites.cjs <fixture-dir> import
```

The first command's table, in version order, is `reach-releases.md`.
