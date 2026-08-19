# RWB-03 — fast-xml-parser (METHOD)

Real-world benchmark case, design: `docs/REAL-WORLD-BENCHMARK-V0.1.md § RWB-03`.

**Re-verified immediately before fixture creation** (recently published advisory, per the design doc's explicit instruction): the OSV record (`https://api.osv.dev/v1/vulns/GHSA-37qj-frw5-hhjh`) was re-fetched live and is unchanged from the design doc — same vulnerable range (`>=5.0.9, <5.3.4`), same patched version (`5.3.4`), same PoC.

- **Package:** `fast-xml-parser@5.3.3`
- **Advisory:** GHSA-37qj-frw5-hhjh / CVE-2026-25128 (uncaught `RangeError` DoS, CWE-20/CWE-248)
- **Vulnerable versions:** `>=5.0.9, <5.3.4`
- **Patched versions:** `>=5.3.4`
- **Vulnerable symbol:** `XMLParser.parse()` instance method. Confirmed by reading the real installed CJS bundle `node_modules/fast-xml-parser/lib/fxp.cjs` (the package's real `require()` entrypoint per its `exports.require` map): `fromCodePoint` appears twice (the `num_dec`/`num_hex` numeric-entity handlers named in the advisory), and `XMLParser` is a real, defined export (`t.d(e,{XMLBuilder:...,XMLParser:()=>tt,XMLValidator:...})`).
- **Live reproduction:** the vulnerability was directly reproduced against the real, pruned, installed package before writing any application source:
  ```
  $ node -e "const {XMLParser}=require('fast-xml-parser'); new XMLParser({processEntities:true,htmlEntities:true}).parse('<root>&#9999999;</root>')"
  RangeError: Invalid code point 9999999
  ```
- **Application entrypoint:** `src/feed-reader.js`, symbol `parseFeed`
- **Expected verdict:** `AFFECTED`
- **Expected reachable path:** `src/feed-reader.js` `parseFeed()` → `new XMLParser({...})` (constructor call) → `.parse(xmlText)` instance method call on the constructed value → `node_modules/fast-xml-parser/lib/fxp.cjs`'s `XMLParser.parse` method.
- **Reason:** `parseFeed()` unconditionally constructs an `XMLParser` with `htmlEntities: true` (the exact option the advisory's own PoC uses) and calls `.parse()` on it with caller-supplied XML text. A human analyst reading this file has no ambiguity: this is a real, reachable call to the vulnerable instance method.
- **Rule note:** per this repo's established `VulnerableSymbolRule` convention for `kind: method` (see `tests/adversarial/v2/fixtures/adv2-020-instance-method/rules.yml`), `target.export` names the **method itself** (`parse`), not the class — the class is identified only by which file/module it's exported from, and instance/method-call resolution (VT-208/VT-216) is what actually attributes a `.parse()` call to this class's method.
- **Advisory source:** `https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-37qj-frw5-hhjh`, `https://nvd.nist.gov/vuln/detail/CVE-2026-25128`
- **Vulnerable source location:** real installed `fast-xml-parser@5.3.3`, `lib/fxp.cjs` (the shipped CJS bundle actually loaded by `require()`)
- **Reproducibility:** `package.json`/`package-lock.json` pin the exact vulnerable version; `node_modules/fast-xml-parser/` is pruned to `package.json` + `lib/fxp.cjs` only (724 KB → 44 KB), verified functionally equivalent by the live reproduction above running against the pruned tree.
