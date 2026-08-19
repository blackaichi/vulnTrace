# RWB-05 — qs (UNUSED_API)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-05`.

- **Package:** `qs@6.10.1`
- **Advisory:** GHSA-hrpp-h998-j3pp / CVE-2022-24999 (prototype pollution / DoS, CWE-1321) — re-verified live at fixture-creation time via `https://api.osv.dev/v1/vulns/GHSA-hrpp-h998-j3pp`, unchanged from the design doc
- **Vulnerable versions:** `6.10.0–<6.10.3`
- **Patched versions:** `>=6.10.3`
- **Vulnerable symbol:** the named export `parse` — confirmed by reading the real installed `node_modules/qs/lib/index.js`:
  ```js
  module.exports = { formats: formats, parse: parse, stringify: stringify };
  ```
  `parse` and `stringify` are two independent named exports of the same module.
- **Application entrypoint:** `src/serialize-filters.js`
- **Expected verdict:** `NOT_AFFECTED`
- **Why not reachable:** `qs.parse` (the vulnerable export) is never referenced anywhere in this fixture's source — only `qs.stringify` (a distinct, unrelated, unaffected export) is imported and called. There is no call graph edge, direct or indirect, from the entrypoint to `parse`.
- **Advisory source:** `https://api.osv.dev/v1/vulns/GHSA-hrpp-h998-j3pp`
- **Vulnerable source location:** real installed `qs@6.10.1`, `lib/index.js`, `lib/parse.js`
- **Reproducibility:** `package.json`/`package-lock.json` pin the exact vulnerable version; `node_modules/qs/` itself is pruned to `package.json` + `lib/` only (test/docs/dist dropped). `qs@6.10.1`'s own real transitive dependencies (`side-channel`, `get-intrinsic`, `call-bound`, and similar ponyfill-style helper packages — ~1.6 MB total, unpruned, exactly as a real `npm install` produces) are committed as-is, verified functionally equivalent via a direct `node -e` smoke test (`qs.stringify({a:1,b:2})` → `"a=1&b=2"`, `typeof qs.parse === "function"`) before writing the application source.
