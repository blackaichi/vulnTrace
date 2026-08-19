# RWB-04 — url-parse (CONSTRUCTOR)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-04`.

- **Package:** `url-parse@1.4.4`
- **Advisory:** GHSA-8v38-pw62-9cw2 / CVE-2022-0639 (improper input validation, CWE-639) — re-verified live at fixture-creation time via `https://api.osv.dev/v1/vulns/GHSA-8v38-pw62-9cw2`, unchanged from the design doc
- **Vulnerable versions:** `1.0.0–<1.5.7`
- **Patched versions:** `>=1.5.7`
- **Vulnerable symbol:** the `Url` constructor function itself, `module.exports = Url` — confirmed by reading real installed `node_modules/url-parse/index.js`: `function Url(address, location, parser) {...}` (line 162) runs the entire rule-based parse synchronously in the constructor body; no separate `.parse()` call exists or is needed.
- **Live reproduction:** the mismatch was directly reproduced against the real, pruned, installed package before writing any application source:
  ```
  $ node -e "const Url=require('url-parse'); const p=new Url('http://@/127.0.0.1'); console.log(p.hostname, p.href)"
  hostname: ""   href: http:///127.0.0.1
  ```
  (an empty `hostname` with a malformed `href` retaining the intended target — the exact class of parser confusion the advisory describes.)
- **Application entrypoint:** `src/webhook-validator.js`, symbol `isAllowedWebhook`
- **Expected verdict:** `AFFECTED`
- **Expected reachable path:** `src/webhook-validator.js` `isAllowedWebhook()` → `new Url(rawUrl)` → `node_modules/url-parse/index.js`'s `Url` constructor body (the vulnerable parse rules run here, unconditionally, as part of construction).
- **Reason:** `isAllowedWebhook()` constructs a `Url` directly from caller-supplied `rawUrl` with no other indirection. VulnTrace's scope is reachability of the vulnerable constructor, not exploit-outcome verification — the fixture demonstrates unconditional, direct construction with attacker-influenced input, which is sufficient and unambiguous regardless of what a specific downstream allowlist check later does with the (potentially malformed) result.
- **Advisory source:** `https://nvd.nist.gov/vuln/detail/CVE-2022-0639`, fix commit `https://github.com/unshiftio/url-parse/commit/ef45a1355375a8244063793a19059b4f62fc8788`
- **Vulnerable source location:** real installed `url-parse@1.4.4`, `index.js` (constructor body, lines ~162-220)
- **Reproducibility:** `package.json`/`package-lock.json` pin the exact vulnerable version; `node_modules/url-parse/` is pruned to `package.json` + `index.js` only (README/LICENSE/`dist/` dropped, not needed for `require()` resolution), verified functionally equivalent by the live reproduction above running against the pruned tree.
