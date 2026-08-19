# RWB-01 — trim-newlines (DIRECT)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-01`.

- **Package:** `trim-newlines@3.0.0`
- **Advisory:** GHSA-7p7h-4mm5-852v / CVE-2021-33623 (ReDoS, CWE-400)
- **Vulnerable versions:** `<3.0.1`, `4.0.0` (re-verified live at fixture-creation time via `https://api.osv.dev/v1/vulns/GHSA-7p7h-4mm5-852v` — unchanged from the design doc)
- **Patched versions:** `3.0.1`, `4.0.1`
- **Vulnerable symbol:** the named export `end` (`module.exports.end`), confirmed by reading the real installed `node_modules/trim-newlines/index.js`:
  ```js
  module.exports = string => string.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
  module.exports.start = string => string.replace(/^[\r\n]+/, '');
  module.exports.end = string => string.replace(/[\r\n]+$/, '');
  ```
- **Application entrypoint:** `src/index.js`
- **Expected verdict:** `AFFECTED`
- **Expected reachable path:** `src/index.js:5` (`normalize()`) → `require("trim-newlines")` → `.end` named export → `node_modules/trim-newlines/index.js` (the `.end` assignment).
- **Reason:** `normalize()` calls `trimNewlines.end(userInput)` directly and unconditionally — no wrapper, no aliasing, no dead code. A human analyst reading this file has no ambiguity: this is a real, reachable call to the exact function GHSA-7p7h-4mm5-852v names as vulnerable.
- **Advisory source:** `https://api.osv.dev/v1/vulns/GHSA-7p7h-4mm5-852v`
- **Vulnerable source location:** real `trim-newlines@3.0.0` package, `index.js` (packed and read directly at fixture-creation time)
- **Reproducibility:** `package.json`/`package-lock.json` pin the exact vulnerable version; `node_modules/trim-newlines/` is committed in full (5 files, ~4 KB unpacked — no pruning needed).
