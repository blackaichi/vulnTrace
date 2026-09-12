# fixtures/workspaces — P1-A4 workspace / monorepo matrix

A hermetic npm-workspace monorepo. Every package here is hand-written and
vendored; nothing is installed, and no package manager runs.

`verify.cjs` is the **runtime oracle**: real `node`, out of process,
asserting what each package actually publishes, which canonical root each
public surface belongs to, which of two same-name/same-version copies each
consumer actually executes, and which requests real Node refuses. Every
expectation in the P1-A4 suites is derived from it. VulnTrace itself never
executes target code (AGENTS.md); the oracle is test-only.

## The one thing P1-A4 adds

A package that lives in the repository rather than under `node_modules` can
now **have an identity**. That is the whole change. Every question asked of
it afterwards — which public entry answers, whether forwarding applies,
whether a sibling may answer — is untouched P1-A1/A2/A3 machinery that
simply had no exact `PackageInstance` to run against before.

Identity is the **canonical root**, never the name or version:

| | |
| --- | --- |
| `packages/twinlib` vs `node_modules/twinlib` | identical `name` AND `version`, different implementations — **two packages** |
| `packages/dupa` vs `packages/dupb` | both declare `"name": "dup"` — **two packages**, and `require("dup")` resolves to neither |
| `node_modules/lib` → `packages/lib` | symlink and physical path — **one package** (Node caches by realpath; the oracle asserts one `require.cache` entry) |

## Layout

```
package.json                      workspaces: ["packages/*"]
node_modules/
  lib, safelib, fwdlib, ...       symlinks into packages/ (what an install materializes)
  @scope/lib                      symlink -> packages/scopedlib
  twinlib/                        a REAL installed copy, NOT a link
  nestedlib/                      root-level copy, shadowed from packages/app
packages/
  app/                            the consumer; has its own node_modules/nestedlib
  lib/                            plain `main`; vulnerable at the public entry
  safelib/                        entry publishes `safe`; sibling.js exports `vulnerable`
  fwdlib/                         entry forwards `vulnerable` -> impl.js#internal
  exportslib/                     exports "." and "./api"; superseded `main`
  expmainlib/                     exports "." (safe) supersedes a dangerous `main`
  subpathonlylib/                 exports "./api" only — no "."
  scopedlib/                      name "@scope/lib"; directory ≠ name
  twinlib/                        workspace twin of node_modules/twinlib
  dupa/, dupb/                    both named "dup"
filelib/, linklib/                file:/link: targets — NOT workspace members
```

## What each package pins

- **lib** — the basic case: exact workspace instance → authoritative entry
  → target, with a concrete path.
- **safelib** — the safe control. The sibling exports the advisory's name
  and is a real file in the same package; it publishes nothing, so it
  answers for nothing. RWF-030 is not weakened by workspace layout. (It
  declares no `exports`, so a deep import of the sibling *does* resolve —
  which is precisely why its mere existence must not establish authority.)
- **fwdlib** — RWF-029's forwarding relation, anchored at a workspace
  entry. No workspace-specific forwarding semantics exist.
- **exportslib** — `"."` and `"./api"` stay distinct public surfaces, and
  the superseded `main` is unreachable through the name.
- **expmainlib** — the false-AFFECTED case: `legacy.js` exports the
  advisory's literal name and is genuinely loaded, but no importer can
  reach it through the package name.
- **subpathonlylib** — a root entry must never be invented. `index.js`
  exists and exports `vulnerable`; real Node still refuses the root
  surface, so the advisory refuses too.
- **scopedlib** — the manifest name (`@scope/lib`) and the directory
  (`packages/scopedlib`) deliberately disagree. The root is identity; the
  name is metadata, and neither may be derived from the other.
- **twinlib** — workspace vs installed copy: no target or evidence mixing.
- **nestedlib** — the consumer's own context decides, not the project
  root's. `packages/app` resolves its nested copy; the repo root resolves
  the other.
- **dupa/dupb** — an invalid workspace configuration. Both refuse,
  symmetrically; a winner picked by enumeration order would be the defect.
- **filelib/linklib** — outside every workspace pattern. P1-A4 claims them
  deliberately **not**: the `file:`/`link:` word in a manifest grants no
  authority, and these roots remain the pre-existing dependency-graph
  provenance path's business.

## Running it

```
node fixtures/workspaces/verify.cjs
```

Prints the list of checks it asserted. The integration suite runs it as its
final test.
