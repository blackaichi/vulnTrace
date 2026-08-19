# RWB-06 — node-forge (UNREACHED_DEPENDENCY)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-06`.

**Re-verified immediately before fixture creation** (recently published advisory, per the design doc's explicit instruction): the OSV record (`https://api.osv.dev/v1/vulns/GHSA-2328-f5f3-gj25`) was re-fetched live and is unchanged from the design doc — same vulnerable range (`<1.4.0`), same patched version (`1.4.0`), same mechanism.

- **Package:** `node-forge@1.3.3`
- **Advisory:** GHSA-2328-f5f3-gj25 / CVE-2026-33896 (RFC 5280 `basicConstraints` enforcement bypass, CWE-295)
- **Vulnerable versions:** `<1.4.0`
- **Patched versions:** `>=1.4.0`
- **Vulnerable symbol:** `pki.verifyCertificateChain(caStore, chain, options)`, `lib/x509.js` — confirmed present at that name (`grep -n "verifyCertificateChain" lib/x509.js` → line 2882) in the real installed package.
- **Application entrypoint:** `src/index.js`
- **Expected verdict:** `NOT_AFFECTED`
- **Why not reachable:** `node-forge` is a real, verifiably installed dependency (`package.json`, `package-lock.json`, full `node_modules/node-forge/` committed) but is never `require()`'d or imported anywhere in `src/`. There is no import edge into it at all from any configured entrypoint.
- **Resolution note:** `node-forge`'s real `lib/index.js` is `module.exports = require('./forge')` — a re-export whose target object gains its named properties (including `pki`) only through further `require()` side effects VulnTrace does not statically chase (see `src/code-intelligence/module-model.ts`'s documented re-export-chasing limitation). This means the rule's `pki` target is expected to resolve to an unresolved/phantom node rather than a concrete graph node. That does **not** block the expected `NOT_AFFECTED` verdict here: unlike `RWF-001` (where the *same kind* of resolution gap caused `UNKNOWN` because the package genuinely *was* imported and called, leaving real ambiguity about whether the specific export was reached), this fixture's application code never references `node-forge` at all — the reachability search from the entrypoint is fully exhausted with zero blockers (no dynamic calls, no unresolved requires anywhere in `src/`), so the "unreachable, no blockers" path applies regardless of the target's own resolution outcome.
- **Advisory source:** `https://github.com/digitalbazaar/forge/security/advisories/GHSA-2328-f5f3-gj25`, `https://nvd.nist.gov/vuln/detail/CVE-2026-33896`
- **Vulnerable source location:** real installed `node-forge@1.3.3`, `lib/x509.js`
- **Reproducibility:** `package.json`/`package-lock.json` pin the exact vulnerable version; `node_modules/node-forge/` is committed **in full** (not pruned) — the entire point of this case is that a real, complete, ordinary install is present and simply unused, so file completeness is part of what makes the case realistic rather than contrived.
