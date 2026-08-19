# RWB-02 — minimist (WRAPPER)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-02`.

- **Package:** `minimist@1.2.5`
- **Advisory:** GHSA-xvch-5gv4-984h / CVE-2021-44906 (prototype pollution, CWE-1321) — not the older CVE-2020-7598, which 1.2.5 already fixes with a literal `__proto__` string check
- **Vulnerable versions:** `1.0.0–<1.2.6` (re-verified live at fixture-creation time via `https://api.osv.dev/v1/vulns/GHSA-xvch-5gv4-984h` — unchanged from the design doc)
- **Patched versions:** `>=1.2.6`
- **Vulnerable symbol:** the default exported function (`module.exports = function (args, opts) {...}`), which internally calls `setKey()`. Confirmed by reading the real installed `node_modules/minimist/index.js`: `setKey` guards the literal string `'__proto__'` but not `constructor`/`prototype`, so a `--constructor.prototype.x=y` argv key bypasses the guard.
- **Application entrypoint:** `src/cli.js`, symbol `main`
- **Expected verdict:** `AFFECTED`
- **Expected reachable path:** `src/cli.js` `main()` → `parseArgs()` (app-authored wrapper, same file) → `require("minimist")` default export → `node_modules/minimist/index.js` (the function containing `setKey()`).
- **Reason:** `parseArgs()` forwards `process.argv` straight into `minimist()` with no filtering; `main()` calls `parseArgs()` unconditionally. A human analyst reading this file has no ambiguity: this is a real, reachable call to minimist's vulnerable parser, one same-file hop removed from the entrypoint.
- **Advisory source:** `https://api.osv.dev/v1/vulns/GHSA-xvch-5gv4-984h`
- **Vulnerable source location:** real `minimist@1.2.5` package, `index.js` (packed/installed and read directly at fixture-creation time); fix commit `https://github.com/minimistjs/minimist/commit/c2b981977fa834b223b408cfb860f933c9811e4d.patch`
- **Reproducibility:** `package.json`/`package-lock.json` pin the exact vulnerable version; `node_modules/minimist/` is pruned to `index.js` + `package.json` only (the `test/`/`example/` files aren't needed for resolution).
