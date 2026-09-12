# Fixture: package-entry (P1-A3)

The permanent fixture for **P1-A3 — package entry semantics: npm aliases,
scoped packages, `package.json` `exports` and subpaths**. Asserted by
`src/analysis/verdict.package-entry.integration.test.ts` and
`src/code-intelligence/package-entry.differential-oracle.test.ts`, with real
Node ground truth in `verify.cjs`.

## What this family is, and what it is not

The question is **which public surface of which installed instance** an
advisory target is anchored at.

P1-A2/RWF-030 established that only a package's *authoritative public entry*
may answer for it — never a same-named sibling. It resolved that entry by
probing the real module resolver with two specifiers: the advisory's own
name, and the instance's **absolute install path**.

That second probe turns out to be unsound for any package that declares
`exports`, and the reason is a real divergence in Node's own semantics:

```json
{ "main": "./legacy.js", "exports": { ".": "./modern.js" } }
```

```
require("expmain-lib")                      -> modern.js   (exports wins)
require("/abs/.../node_modules/expmain-lib") -> legacy.js   (a PATH request
                                                             never consults
                                                             exports)
```

`legacy.js` is not part of the package's public surface under any importer,
yet the install-path probe admitted it as an authoritative entry — restoring
through a different door exactly the thing RWF-030 closed: a file that merely
*exists* inside the package answering for what the package publishes.

The second gap was **subpaths**. An advisory naming `pkg/parse` was matched
against installed instances by the whole string `"pkg/parse"`, which is never
any instance's package name, so it matched nothing and fell through to an
independent, instance-blind re-resolution — which then fed a *phantom* target
into the reachability search and could certify a negative about a target
whose identity was never established.

Both are recorded as **RWF-031** in `tests/validation/FINDINGS.md`.

Two neighbouring problems this is deliberately **not**:

- **Target-side forwarding** (P1-A1/RWF-029, `fixtures/target-side-reexport`):
  given a starting file and a name, which literal specifier does that value
  come from. P1-A3 re-uses that relation **unchanged** and only changes
  *where it starts* — `subpathfwd-lib` below is that relation anchored at a
  subpath's own entry.
- **Which file may answer at all** (P1-A2/RWF-030,
  `fixtures/authoritative-public-entry`). P1-A3 widens *what counts as* a
  public entry without widening *how much* may answer: every shape here that
  cannot establish a public surface refuses (UNKNOWN).

## Both failure directions, one family

Measured by swapping merged main's `verdict.ts` into this branch and running
this fixture's own suite (see FINDINGS.md RWF-031 for the exact numbers):

- **false AFFECTED** — `expmainsafe-lib` (a superseded, reachable, dangerous
  `main` answered for a package whose public `vulnerable` is safe and
  uncalled) and `badexports-lib` (an invalid `exports` target fell back to a
  sibling that exports the advisory's literal name).
- **false NOT_AFFECTED** — `subpathfwd-lib/api` and `twin-lib/api`: a subpath
  advisory was never anchored at the finding's own instance, so a phantom
  target received a complete negative proof while real `node` proves the
  callable **is** executed. Runtime-reachable, and the worst class.

## The matrix

Each installed package under `node_modules/` isolates one shape; each `src/*`
is a consumer entrypoint scanned on its own.

| Package | Shape | Ground truth |
| --- | --- | --- |
| `expmain-lib` | `exports "."` vs `main` | public entry is `modern.js`, and it **is** called |
| `expmainsafe-lib` | same, public safe / superseded `main` dangerous **and reachable** | `pkg.vulnerable` is `modernSafe`, never called |
| `shorthand-lib` | `"exports": "./out/index.js"` string shorthand, with a root `index.js` sibling | public entry is `out/index.js` |
| `subpath-lib` | `"."` and `"./parse"` as distinct surfaces, plus an unexported `lib/internal.js` | only `./parse` is called; `lib/internal` is not importable |
| `subpathonly-lib` | `"main": false`, only `./get` and `./set` — **no `"."`** | the package root throws `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `cond-lib` | conditional `import`/`require` | `.cjs` consumer loads `cjs.cjs`, `.mjs` consumer loads `esm.mjs` |
| `condsafe-lib` | conditional, **inactive** branch dangerous | the CJS consumer never loads `esm.mjs` |
| `wildcard-lib` | `"./features/*"` pattern subpaths | `features/alpha` resolves; `features/missing` and the root do not |
| `@scope/pkg`, `@other/pkg` | scoped roots and subpaths, same basename under two scopes | different packages, different callables |
| `twin-lib`, `twin-alias` | npm ALIAS twin: both manifests say `"name": "twin-lib"`, same version, two install paths | only the alias instance's public entry is called |
| `encap-lib` | `exports` encapsulation; internal `lib/vulnerable.js` is loaded and called | `encap-lib/lib/vulnerable` is not importable |
| `mainonly-lib` | `main` only, with a root `index.js` that `main` points away from | public entry is `lib/index.js` |
| `badexports-lib` | `exports` target that does not exist; a sibling does | the package root is unresolvable |
| `escape-lib` | `exports` target escaping the package root | unresolvable |
| `subpathfwd-lib` | subpath authority → explicit forwarding → implementation | `./api`'s `vulnerable` **is** `impl.js`'s |
| `renamed-lib` | public name forwards to a different internal name | `pkg.vulnerable` **is** `impl.internalName` |
| `unreach-lib` | exactly-resolved public target that is simply not called | the negative control |

## Ground truth

`verify.cjs` runs under real `node`, out of process, and asserts every
expectation above **by callable identity and resolved file**, not by name:
which file each specifier resolves to (or which error code it throws), which
callables are identical to which, and how many times each is actually
executed by each consumer. VulnTrace itself never executes target code
(AGENTS.md); this oracle is test-only.

```
node fixtures/package-entry/verify.cjs
```

`package-entry.differential-oracle.test.ts` is the second, narrower oracle:
for every shape above it compares `require.resolve` in a real `node` child
process against `resolveAuthoritativePackageEntries`, and requires exact
agreement — including on every refusal. That is the evidence for the claim
that VulnTrace adds no package-resolution semantics of its own.

## Hermeticity

Every package here is a hand-written hermetic fixture: no `npm install`, no
vendored real package, no network. `twin-alias` is the alias *shape* (a
manifest name that differs from its install directory), written directly
rather than produced by npm, exactly as `fixtures/alias` already does.
