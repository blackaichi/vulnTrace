# RWB-09 — semver (MULTI_INSTANCE)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-09`.

- **Package:** `semver`, installed as **two distinct real instances** — `semver@7.5.2` (patched, direct dependency name `semver`) and `semver@7.5.1` (vulnerable, installed under the npm-aliased dependency name `semver-vulnerable`: `"semver-vulnerable": "npm:semver@7.5.1"`)
- **Advisory:** GHSA-c2qf-rxjj-qqgw / CVE-2022-25883 (ReDoS in `Range` parsing, CWE-1333) — re-verified live at fixture-creation time via `https://api.osv.dev/v1/vulns/GHSA-c2qf-rxjj-qqgw`, unchanged from the design doc
- **Vulnerable versions:** `7.0.0–<7.5.2` (also earlier 6.x/5.x lines, not used here)
- **Patched versions:** `>=7.5.2`
- **Vulnerable symbol:** the `Range` class (`classes/range.js`), exported as a named property: `module.exports = { Range, ... }` — confirmed by reading both real installed packages' `index.js`.
- **Identity confirmation (the crux of this case):** both installed packages declare `"name": "semver"` in their own `package.json`, and the real, npm-generated `package-lock.json` explicitly records `"name": "semver"` for the `semver-vulnerable` entry — confirmed by inspection: `node_modules/semver-vulnerable/package.json` and `node_modules/semver/package.json` both say `"name": "semver"`, only the folder/require-specifier differs. This is genuine npm alias behavior, not something fabricated for this fixture.
- **Live reproduction:** both instances install and function correctly as independent, real `Range` classes:
  ```
  $ node -e "console.log(new (require('semver').Range)('^1.0.0').test('1.2.3'))"      // true, patched
  $ node -e "console.log(new (require('semver-vulnerable').Range)('^1.0.0').test('1.2.3'))"  // true, vulnerable
  ```
- **Application entrypoint:** `src/version-check.js` (both `isCompatible` and `isLegacyCompatible` exports are valid reachability sources)
- **Expected verdicts — TWO independent findings, same `vulnerability`/`package`, different `version`:**
  - `version: "7.5.1"` (reached via `isLegacyCompatible()` → `legacySemver.Range`) → **AFFECTED**
  - `version: "7.5.2"` (reached via `isCompatible()` → `semver.Range`) → **NOT_AFFECTED** (patched implementation, outside the vulnerable range, even though the same rule and the same class name apply)
- **Reason:** the rule (`package.name: semver`) matches both real installed instances by real package identity. Correctness here depends entirely on VulnTrace resolving *per-instance* — the same mechanism `VT-212` ("PackageInstance selection authority in verdict resolution") was fixed to handle — rather than collapsing "semver" to one package-name-level answer. Whether VulnTrace's dependency graph actually derives package identity from the real `package.json`/`package-lock.json` `name` field (as it should, matching real npm semantics) rather than the require specifier text (`semver-vulnerable`) is exactly what this case exists to observe; this document does not assume the outcome. See `tests/validation/FINDINGS.md` for the actual result.
- **Advisory source:** `https://api.osv.dev/v1/vulns/GHSA-c2qf-rxjj-qqgw`
- **Vulnerable source location:** real installed `semver@7.5.1`, `classes/range.js`, `internal/re.js`
- **Reproducibility:** `package.json`/`package-lock.json` pin both exact versions via a real `npm install` (confirmed live against the real registry tarballs for both `7.5.1` and `7.5.2`). `node_modules/semver/` and `node_modules/semver-vulnerable/` are kept **unpruned** (280 KB each) since `classes/range.js` requires many sibling internal files (`internal/re.js`, `internal/debug.js`, etc.) and pruning risk was judged not worth the modest size savings for this case.
- **Fixture-construction honesty note:** as documented in the design doc, no currently-installable real dependency graph was found that organically double-installs a vulnerable pre-7.5.2 `semver` today (the ecosystem has long since bumped past it) — this fixture uses npm aliasing to construct a real, reproducible multi-instance scenario rather than reproducing an observed real-world dependency conflict. Both installed packages are 100% real; only the *scenario* (two versions coexisting) is engineered rather than found in the wild.
