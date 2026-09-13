# `multi-instance` — several physical installs of one package name (P1-A5)

A hermetic fixture whose whole purpose is that **the same package name
resolves to different physical directories depending on who asks**, and
that two of those directories are identical in name *and* version.

Used by `src/dependencies/package-instances.differential-oracle.test.ts`,
which asks real `node` (out of process, resolution only — nothing here is
ever executed) which copy it would load, and requires VulnTrace's instance
enumeration to name exactly that copy, exactly once.

## Layout and what each shape is for

| Path | Declares | Shape |
|---|---|---|
| `node_modules/twinlib` | `twinlib@1.0.0` | hoisted twin |
| `packages/app/node_modules/twinlib` | `twinlib@1.0.0` | nested twin — **same name, same version, different directory**; `packages/app` really resolves this one and the root really resolves the other |
| `node_modules/reallib` | `reallib@1.0.0` | the real package |
| `node_modules/aliaslib` | `reallib@1.0.0` | npm alias (`"aliaslib": "npm:reallib@1.0.0"`) — install *handle* and declared *identity* differ |
| `node_modules/@scope/dup` | `@scope/dup@1.0.0` | scoped, installed |
| `packages/scopeddup` | `@scope/dup@1.0.0` | scoped duplicate, workspace copy of the same scoped name |
| `packages/privlib` | `privlib`, **no version** | private workspace package; reached through the `node_modules/privlib` symlink |
| `packages/app` | `app@1.0.0` | the consumer whose nested `node_modules` makes the twin split real |

`node_modules/app`, `node_modules/privlib` and `node_modules/scopeddup` are
**symlinks** into `packages/`, as npm writes for workspace members. They are
not separate instances: Node resolves and caches by realpath, so each must
converge with its target to one `PackageInstance`.

## Why no `dist/` directories

The repository's `.gitignore` has a `dist/` rule that matches at any depth,
which silently excluded fixture files once before (see
`src/testing/fixtures-are-committed.test.ts`). Everything here lives at the
package root or under `packages/`.
