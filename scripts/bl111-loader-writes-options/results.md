# BL-111 — closure-wide rules for RWF-156, measured

Task [`BL-111`](../../docs/tasks/BL-111-loader-writes-builtins.md). Base
`71c62e0` (BL-110's merge), Node v22.11.0. The inventory these rules answer
is [`inventory.md`](inventory.md). Each rule is a patch against the base,
applied only to measure it (`git apply scripts/bl111-loader-writes-options/<tier>.patch`).

In every tier, a loaded file for which `fileMayRedirectLoader` is true
makes the whole module-load closure incomplete (`loader_hook_mutation`).
A `with` statement counts in every tier, because a bare name written in
its body may be a builtin's member.

| Patch | Rule |
| --- | --- |
| `A.patch` | **(A)** any store the escape row counts as an escape: an assignment, a declaration store or a `for…of` head onto an object not proven the program's own (`invocationSiteOf(…).kind === "escaping_assignment"`), or a call of `defineProperty` / `defineProperties` / `setPrototypeOf` / `__defineGetter__` / `__defineSetter__` / `assign` / `set` by name |
| `B.patch` | **(B)** only the stores the inventory shows can reach the loader, onto a target not proven the program's own (`isProvenFreshObject`): a define call (data or accessor, any name), `setPrototypeOf`, `__defineGetter__` / `__defineSetter__`, `assign` / `set`, an assignment under `__proto__` or `constructor`, and an assignment under a computed key (which may be either) |
| `Bliteral.patch` | **(B′)** (B) without the computed-key assignments and without `assign` / `set`: every name is spelled. **Unsound**: `o[k] = C` with `k === "constructor"` at run time, or `Object.assign(Array.prototype, { constructor: C })`, replaces the species unseen |

## Results

| | base | (A) | (B) | (B′) |
| --- | ---: | ---: | ---: | ---: |
| RWF-156's oracle records (6, real Node calls the target): `UNKNOWN` | 0 | **6** | **6** | **6** |
| BL-096's `sound.*` controls keeping their proof (of the 4 that keep it on the base) | 4 | 0 | 0 | 4 |
| `node_modules` files the rule fires on (of 3,838) | — | 2,370 (61.8 %) | 1,312 (34.2 %) | 496 (12.9 %) |
| packages with such a file (of 450) | — | 342 (76.0 %) | 294 (65.3 %) | 119 (26.4 %) |
| corpus graph differential (139 cases) | — | 0 | 0 | 0 |
| corpus proof differential | — | 5 findings | 4 findings | 0 |
| corpus verdict differential | — | 5 changed, 0 into `NOT_AFFECTED` | 4 changed, 0 into `NOT_AFFECTED` | 0 |
| validation `NOT_AFFECTED` proofs lost (of the 4 the base passes) | — | **2** (`RWB-07` ini, `RWB-11b` url-parse) | **2** (the same) | 0 |

The verdicts that moved, all `NOT_AFFECTED` → `UNKNOWN`:
- **(A):** `ADV2-081`, `ADV2-082`, `RWB-07`, `RWB-11a`, `RWB-11b` (`RWB-11a`'s selected verdict is `AFFECTED`, so the suite view does not move);
- **(B):** `ADV2-085`, `RWB-07`, `RWB-11a`, `RWB-11b`.

`ini` and `url-parse` store under computed keys onto objects they did not
create. That is exactly a parser that may write `__proto__` or
`constructor` when fed such keys (`ini`'s own advisory is prototype
pollution).

The four BL-096 controls (A) and (B) lose are the ones that tamper with a
builtin prototype under a symbol key (`Array.prototype[Symbol.iterator] =
…`). Real Node never hands the list on there, but the store is one the
rule must count. (B′) keeps them only because it ignores computed keys.

The `source` reads (`tests/oracle/bl111-loader-inherited-reads.*`) are
`UNKNOWN` on the base and under every tier: an `import()` already widens the
closure.

## Reproducing

```bash
git apply scripts/bl111-loader-writes-options/B.patch
npx vitest run --config vitest.oracle.config.ts tests/oracle/bl096-module-paths-read-only.test.ts
npm run build && node scripts/bl111-loader-writes-options/census.mjs node_modules
node scripts/differential.mjs --base 71c62e0
git checkout -- src
```

Under a patch, a failing open-soundness-defect record is a case whose
verdict moved to `UNKNOWN`, and a failing control is a proof the rule gives
up.
