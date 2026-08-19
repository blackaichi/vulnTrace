# RWB-07 — ini (entrypoint-unreached; `OTHER` in the reachability-pattern vocabulary)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-07`.

- **Package:** `ini@1.3.5`
- **Advisory:** GHSA-qqgx-2p2h-9c37 / CVE-2020-7788 (prototype pollution, CWE-1321) — re-verified live at fixture-creation time via `https://api.osv.dev/v1/vulns/GHSA-qqgx-2p2h-9c37`, unchanged from the design doc
- **Vulnerable versions:** `<1.3.6`
- **Patched versions:** `>=1.3.6`
- **Vulnerable symbol:** the named export `parse` — confirmed by reading the real installed `node_modules/ini/ini.js` line 1: `exports.parse = exports.decode = decode` (`parse`/`decode` are two names for the same underlying function; `stringify`/`encode` are likewise aliased to a separate function).
- **Application entrypoint:** `src/config.js`, symbol `loadModernConfig` (using the `{file, symbol}` entrypoint form, so only `loadModernConfig` — not every export of `src/config.js` — counts as a reachability source, per `docs/SDD.md`'s `EntrypointConfigSchema`/VT-205)
- **Expected verdict:** `NOT_AFFECTED`
- **Why not reachable:** `loadLegacyIniConfig()`, defined in the same file, has a real, live call to the real vulnerable `ini.parse()` — a naive "does this file contain a call to the vulnerable function" check would (wrongly) flag it. But because the entrypoint is configured with `symbol: loadModernConfig`, `loadLegacyIniConfig` is not itself an entrypoint source, is never called by `loadModernConfig`, and is never called by anything else in this file — it is unreachable from the configured entrypoint despite being real, live, unconditional code.
- **Reason this differs from RWB-05/RWB-06:** this is the only one of the three `NOT_AFFECTED` cases where the vulnerable function is both imported *and* actually invoked somewhere in the source tree — correctness here depends entirely on entrypoint-driven call graph reachability (`docs/SDD.md § 19-20`), not on import/export analysis (`RWB-05`) or whole-module non-use (`RWB-06`).
- **Advisory source:** `https://api.osv.dev/v1/vulns/GHSA-qqgx-2p2h-9c37`
- **Vulnerable source location:** real installed `ini@1.3.5`, `ini.js`
- **Reproducibility:** `package.json`/`package-lock.json` pin the exact vulnerable version; `node_modules/ini/` is pruned to `package.json` + `ini.js` only (README/LICENSE dropped), verified via a direct `node -e` smoke test (`typeof ini.parse === typeof ini.decode === "function"`, `ini.parse === ini.decode`) before writing the application source.
