# VulnTrace Real-World Benchmark v0.1 — Design Document

**Status:** Proposed design. No fixtures, cases, or rules described here exist
yet. Nothing in this document has been implemented.

**Relationship to `tests/validation/`:** the three cases already implemented
(`VAL-001`..`VAL-003`, see `docs/VALIDATION-STRATEGY.md`) are the *current*
real-world benchmark. This document designs its next expansion: 10 new
cases, selected specifically to exercise distinct reachability patterns
rather than to maximize CVE fame. If approved, each case becomes a new
`VAL-0xx` entry following the exact lifecycle, oracle-authorship, and
fixture-reproducibility rules already defined in `docs/VALIDATION-STRATEGY.md`
— this document does not redefine that process, only proposes what to feed
into it.

**Research method:** every factual claim below (GHSA/CVE id, affected/patched
version range, vulnerable symbol) was verified against the live OSV API
(`https://api.osv.dev/v1/vulns/<id>`), the npm registry (`npm view`, `npm
pack`/`npm install` against real published versions), and, for the vulnerable
symbol specifically, by reading the actual downloaded source of the real
package version — not reconstructed from memory or advisory prose alone. The
GHSA advisory text was used for the vulnerability *mechanism*; the package's
own real source was used to confirm the exact exported symbol name and (where
found) file location, cross-checked against the advisory's own cited
line/file references where available. Two of the ten advisories used here
(`fast-xml-parser`/CVE-2026-25128 and `node-forge`/CVE-2026-33896) were
published very recently relative to this document's writing — flagged in
§8, "Research uncertainty."

## 1. What this benchmark evaluates

Every case below is deliberately chosen so that **A** ("the installed
package/version is in the advisory's vulnerable range") and **B** ("the
vulnerable behavior is reachable from this application's own code") can
disagree — package-level SCA alone is insufficient to answer the question
this benchmark asks. Concretely:

- 4 cases (`RWB-01`..`RWB-04`) are **AFFECTED**: A is true and B is
  genuinely, verifiably true — a real, traceable call path exists from an
  application entrypoint to the real vulnerable symbol.
- 3 cases (`RWB-05`..`RWB-07`) are **NOT_AFFECTED**: A is true (the
  installed version is squarely in the vulnerable range) but B is false —
  the vulnerable symbol is demonstrably never reached, for three
  structurally different reasons (unused named export, dependency never
  imported at all, and imported-but-unreachable-from-any-configured-
  entrypoint).
- 2 cases (`RWB-08`..`RWB-09`) test **version/instance identity** — the
  same package name resolves to different real code depending on which
  installed instance is reached, which is exactly the class of question a
  whole-project SCA tool (which reports at package-name granularity) cannot
  answer but VulnTrace's per-instance verdict model (`src/domain/target.ts`'s
  `PackageInstance` concept, exercised for real by `VT-212`) is supposed to.
- 1 case (`RWB-10`) is **UNKNOWN**: A is true, and the specific reason B
  cannot be soundly established is stated explicitly, per case.

## 2. Reachability-pattern tag vocabulary note

The task's 10 target patterns and the fixed `reachability_pattern` tag
vocabulary (`DIRECT | WRAPPER | METHOD | CONSTRUCTOR | UNUSED_API |
UNREACHED_DEPENDENCY | MULTI_INSTANCE | UNKNOWN | OTHER`) don't map 1:1 — the
vocabulary has 9 tags for the 10 named patterns. Two patterns
("vulnerable dependency imported but vulnerable API never reached" and
"nested dependency instance") have no dedicated tag and are both tagged
`OTHER` below, distinguished from each other and from the two tags they're
each closest to (`UNREACHED_DEPENDENCY` and `MULTI_INSTANCE` respectively)
in each case's own "why different" field.

---

## 3. The 10 candidate cases

### RWB-01 — `trim-newlines` (DIRECT)

- **npm package:** `trim-newlines`
- **CVE / GHSA:** CVE-2021-33623 / GHSA-7p7h-4mm5-852v
- **Vulnerable versions:** `<3.0.1`, and `4.0.0` (OSV `affected[].ranges`)
- **Patched versions:** `3.0.1`, `4.0.1`
- **Vulnerability type:** ReDoS (CWE-400), unbounded backtracking regex
- **Vulnerable symbol:** the named export `end` — real source (packed
  `trim-newlines@3.0.0`):
  ```js
  module.exports = string => string.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
  module.exports.start = string => string.replace(/^[\r\n]+/, '');
  module.exports.end = string => string.replace(/[\r\n]+$/, '');
  ```
- **Why suitable:** three real, distinct named exports on one module
  (default, `.start`, `.end`); only `.end` is the vulnerable one, and it is
  callable with zero indirection — the cleanest possible baseline for
  "does VulnTrace find a direct call to a specific named export at all."
- **Expected verdict:** AFFECTED
- **Reachability pattern:** DIRECT
- **Application fixture:**
  - installs `trim-newlines@3.0.0`
  - `src/index.js`: `const trimNewlines = require('trim-newlines'); function normalize(userInput) { return trimNewlines.end(userInput); } module.exports = { normalize };`
  - `vulntrace.yml` entrypoint: `src/index.js`
- **Path:** `src/index.js:2 normalize()` → `require('trim-newlines')` →
  `.end` named export → `node_modules/trim-newlines/index.js` (the `.end`
  function itself, containing the vulnerable regex).
- **Expected evidence:** a two-hop chain, entrypoint call site
  (`src/index.js:2`) → vulnerable symbol definition
  (`node_modules/trim-newlines/index.js`, the `.end` assignment line),
  confidence 1.0 (unambiguous named CommonJS export, direct call, no
  aliasing).
- **Source of advisory:** `https://api.osv.dev/v1/vulns/GHSA-7p7h-4mm5-852v`
- **Source of vulnerable code:** `npm pack trim-newlines@3.0.0`, real
  `index.js`
- **Source of version info:** same OSV record; `npm view trim-newlines
  versions --json` confirms `3.0.0/3.0.1/4.0.0/4.0.1` are all real,
  installable versions today.
- **Difficulty:** EASY
- **Dimensions tested:** package identity, version identity, module
  resolution, symbol resolution, call graph, reachability.
- **Why different from the others:** the control baseline — no wrapper, no
  class, no aliasing, no dead code. Every other AFFECTED case adds exactly
  one additional layer of indirection on top of this one.

### RWB-02 — `minimist` (WRAPPER)

- **npm package:** `minimist`
- **CVE / GHSA:** CVE-2021-44906 / GHSA-xvch-5gv4-984h (not the older
  CVE-2020-7598, which 1.2.5 already fixes with a literal `__proto__`
  string check)
- **Vulnerable versions:** `<1.2.6`
- **Patched versions:** `>=1.2.6`
- **Vulnerability type:** Prototype pollution (CWE-1321) via
  `constructor.prototype.<x>=<value>` argv keys, bypassing the existing
  `__proto__`-only guard
- **Vulnerable symbol:** the package's default exported function
  (`module.exports = function (args, opts) {...}` in `index.js`), which
  internally calls `setKey()` (`index.js` lines 69-95 per the advisory,
  confirmed present in packed `minimist@1.2.5`). `setKey` itself is not
  separately exported — the reachable, importable entrypoint is the
  default export, i.e. `minimist(argv)`.
- **Why suitable:** `minimist`'s entire public API is a single function
  call — the natural, extremely common real-world shape is an
  app-authored CLI-args wrapper that forwards `process.argv` into it, one
  indirection layer removed from the vulnerable call itself.
- **Expected verdict:** AFFECTED
- **Reachability pattern:** WRAPPER
- **Application fixture:**
  - installs `minimist@1.2.5`
  - `src/cli.js`: `const minimist = require('minimist'); function parseArgs(argv) { return minimist(argv); } function main() { return parseArgs(process.argv.slice(2)); } module.exports = { main };`
  - `vulntrace.yml` entrypoint: `src/cli.js`, entry function `main`
- **Path:** `src/cli.js` `main()` → `parseArgs()` (app-authored wrapper) →
  `require('minimist')` default export → `node_modules/minimist/index.js`
  (the function containing `setKey()`).
- **Expected evidence:** three-hop chain: `main` → `parseArgs` → minimist's
  default export, each hop a plain function call with no aliasing;
  confidence should remain 1.0 despite the extra hop, since VulnTrace
  already handles same-file call chains (this exercises that the *call
  graph*, not just direct-import matching, is what drives AFFECTED).
- **Source of advisory:** `https://api.osv.dev/v1/vulns/GHSA-xvch-5gv4-984h`
- **Source of vulnerable code:** packed `minimist@1.2.5`, `index.js`; fix
  commit `https://github.com/minimistjs/minimist/commit/c2b981977fa834b223b408cfb860f933c9811e4d.patch`
- **Source of version info:** OSV record; `npm view minimist versions`
  lists `1.2.5`/`1.2.6` as real installable versions.
- **Difficulty:** EASY–MEDIUM
- **Dimensions tested:** package identity, version identity, module
  resolution, symbol resolution, call graph, reachability.
- **Why different from the others:** isolates the "one extra same-file
  hop" variable in isolation from every other complication (no class, no
  cross-package alias, no dead code) — the control case for WRAPPER, the
  same role RWB-01 plays for DIRECT.

### RWB-03 — `fast-xml-parser` (METHOD)

- **npm package:** `fast-xml-parser`
- **CVE / GHSA:** CVE-2026-25128 / GHSA-37qj-frw5-hhjh
- **Vulnerable versions:** `>=5.0.9, <5.3.4`
- **Patched versions:** `>=5.3.4`
- **Vulnerability type:** Uncaught `RangeError` DoS (out-of-range numeric
  HTML entities, e.g. `&#9999999;`, exceed `String.fromCodePoint`'s valid
  range and throw uncaught)
- **Vulnerable symbol:** `XMLParser.parse()` instance method
  (`src/xmlparser/XMLParser.js`), which internally reaches
  `replaceEntitiesValue()` in `src/xmlparser/OrderedObjParser.js` — real
  source, packed `fast-xml-parser@5.3.3`:
  ```js
  "num_dec": { regex: /&#([0-9]{1,7});/g, val: (_, str) => String.fromCodePoint(Number.parseInt(str, 10)) }
  ```
  only reached when the app passes `{ htmlEntities: true }` to the
  `XMLParser` constructor (default is `false`, confirmed in
  `OptionsBuilder.js`).
- **Why suitable:** a real, class-based public API — `new
  XMLParser(options)` then `.parse(xml)` — the first genuine
  instance-method case in this set (as opposed to RWB-01/02's bare
  function exports).
- **Expected verdict:** AFFECTED
- **Reachability pattern:** METHOD
- **Application fixture:**
  - installs `fast-xml-parser@5.3.3`
  - `src/feed-reader.js`: `const { XMLParser } = require('fast-xml-parser'); function parseFeed(xmlText) { const parser = new XMLParser({ htmlEntities: true }); return parser.parse(xmlText); } module.exports = { parseFeed };`
  - `vulntrace.yml` entrypoint: `src/feed-reader.js`, entry function
    `parseFeed`
- **Path:** `src/feed-reader.js` `parseFeed()` → `new XMLParser(...)`
  (constructor call, tests VulnTrace's already-implemented implicit/real
  constructor resolution, `VT-215`/`VT-208`) → `.parse()` instance method
  call on that constructed value → `OrderedObjParser.parseXml()` →
  `replaceEntitiesValue()`.
- **Expected evidence:** entrypoint → constructor call → instance method
  call chain; this is a genuine test of *instance* method resolution
  (must attribute `.parse()` to the specific class `XMLParser`, not
  merely "some method named parse somewhere"), the mechanism `VT-208`/
  `VT-216` built.
- **Note on the `htmlEntities: true` option:** required to trigger this
  specific CWE, and is a realistic app configuration (parsing HTML-entity-
  flavored feed/XML content), not a contrived flag. VulnTrace's actual
  scope is reachability of the vulnerable *symbol* (`.parse()`), not
  argument-value taint analysis — so the fixture states this option
  explicitly for advisory-accuracy, but the AFFECTED verdict rests on
  method-call reachability, consistent with how `VAL-001`
  (`lodash.template`) already treats argument-independent reachability.
- **Source of advisory:** `https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-37qj-frw5-hhjh`,
  `https://nvd.nist.gov/vuln/detail/CVE-2026-25128`
- **Source of vulnerable code:** packed `fast-xml-parser@5.3.3`,
  `src/fxp.js`, `src/xmlparser/XMLParser.js`,
  `src/xmlparser/OrderedObjParser.js`, `src/xmlparser/OptionsBuilder.js`
- **Source of version info:** OSV record `GHSA-37qj-frw5-hhjh`; `npm view
  fast-xml-parser@5.3.4 version` confirms the patched version is real.
- **Difficulty:** MEDIUM
- **Dimensions tested:** package identity, version identity, module
  resolution, symbol resolution (class + instance method), call graph,
  reachability, object/property flow (constructed-instance tracking).
- **Why different from the others:** first case requiring the analyzer to
  track a *constructed instance* across two statements (constructor call,
  then a method call on the resulting local variable) rather than a bare
  function reference — this is exactly the `VT-208` "instance method
  resolution via the type checker" mechanism, now validated against real
  code instead of only the synthetic fixtures that originally drove it.

### RWB-04 — `url-parse` (CONSTRUCTOR)

- **npm package:** `url-parse`
- **CVE / GHSA:** CVE-2022-0639 / GHSA-8v38-pw62-9cw2
- **Vulnerable versions:** `>=1.0.0, <1.5.7`
- **Patched versions:** `>=1.5.7`
- **Vulnerability type:** Improper input validation (CWE-639) — a crafted
  URL with `@` but empty userinfo/hostname (e.g. `http://@/127.0.0.1`)
  parses to a `hostname`/`origin`/`href` inconsistent with what an
  allowlist check against `hostname` would expect, enabling SSRF/auth-
  bypass-class exploitation downstream.
- **Vulnerable symbol:** the `Url` constructor function itself — real
  source, packed `url-parse@1.4.4`, `index.js`: `function Url(address,
  location, parser) {...}` (line 162) runs the entire rule-based parse,
  including the `@`-handling rule, synchronously in the constructor body;
  `module.exports = Url`. There is no separate `.parse()` call — `new
  Url(address)` alone reproduces the bug.
- **Why suitable:** a genuinely constructor-time vulnerability (not a
  method called after construction) — the entire relevant logic executes
  during object construction itself, giving a clean CONSTRUCTOR case
  distinct from RWB-03's METHOD case.
- **Expected verdict:** AFFECTED
- **Reachability pattern:** CONSTRUCTOR
- **Application fixture:**
  - installs `url-parse@1.4.4`
  - `src/webhook-validator.js`:
    ```js
    const Url = require('url-parse');
    const ALLOWED_HOSTS = new Set(['api.internal.example']);
    function isAllowedWebhook(rawUrl) {
      const parsed = new Url(rawUrl);
      return ALLOWED_HOSTS.has(parsed.hostname);
    }
    module.exports = { isAllowedWebhook };
    ```
  - `vulntrace.yml` entrypoint: `src/webhook-validator.js`, entry function
    `isAllowedWebhook`
- **Path:** `src/webhook-validator.js` `isAllowedWebhook()` → `new
  Url(rawUrl)` → `node_modules/url-parse/index.js`'s `Url` constructor
  body (the vulnerable parse rules run here, unconditionally, as part of
  construction).
- **Expected evidence:** single-hop chain: entrypoint constructor-call
  site → the `Url` function definition itself (no further internal hop
  needed, since the vulnerable logic *is* the constructor body) —
  confidence should be high (1.0), since `new Url(...)` unambiguously
  resolves to the package's sole default export.
- **Source of advisory:** `https://nvd.nist.gov/vuln/detail/CVE-2022-0639`,
  fix commit `https://github.com/unshiftio/url-parse/commit/ef45a1355375a8244063793a19059b4f62fc8788`
- **Source of vulnerable code:** packed `url-parse@1.4.4`, `index.js`
  (constructor body, lines ~162-220)
- **Source of version info:** OSV record `GHSA-8v38-pw62-9cw2`; `npm view
  url-parse versions --json` confirms `1.4.4`/`1.5.7` are real.
- **Difficulty:** MEDIUM
- **Dimensions tested:** package identity, version identity, module
  resolution, symbol resolution (must recognize `new Url(...)` as a
  constructor call reaching the package's default-export class/function,
  exactly the target of `VT-215`), call graph, reachability.
- **Why different from the others:** the only case in this set where the
  entire vulnerable behavior is inside a constructor body with zero
  post-construction method call needed — tests that VulnTrace's evidence
  model correctly stops at the constructor call site rather than
  requiring (and failing to find) a nonexistent subsequent method call.

### RWB-05 — `qs` (UNUSED_API)

- **npm package:** `qs`
- **CVE / GHSA:** CVE-2022-24999 / GHSA-hrpp-h998-j3pp
- **Vulnerable versions:** `6.10.0`–`<6.10.3` (also earlier backport
  ranges 6.2.x-6.9.x; this fixture uses the clean 6.10.x range)
- **Patched versions:** `6.10.3` (and per-line backports)
- **Vulnerability type:** Prototype pollution / DoS (CWE-1321) via a
  crafted `__proto__` query-string key
- **Vulnerable symbol:** the named export `parse` — real source, packed
  `qs@6.10.1`, `lib/index.js`: `module.exports = { formats, parse:
  require('./parse'), stringify: require('./stringify') }` — `parse` and
  `stringify` are two independent named exports from the same module.
- **Why suitable:** the cleanest real case of "the module has a vulnerable
  named export and a separate, unrelated safe named export" — directly
  tests whether VulnTrace treats module-level import as "used" (wrong) or
  tracks named-export-level usage (correct).
- **Expected verdict:** NOT_AFFECTED
- **Reachability pattern:** UNUSED_API
- **Application fixture:**
  - installs `qs@6.10.1`
  - `src/serialize-filters.js`: `const qs = require('qs'); function toQueryString(filters) { return qs.stringify(filters); } module.exports = { toQueryString };`
  - `vulntrace.yml` entrypoint: `src/serialize-filters.js`
- **Why not reachable:** `qs.parse` (the vulnerable export) is never
  referenced anywhere in the fixture's source — only `qs.stringify` (a
  distinct, unrelated, unaffected export) is imported and called. There is
  no call graph edge, direct or indirect, from any entrypoint to `parse`.
  A whole-package SCA tool would flag `qs@6.10.1` as vulnerable; a correct
  reachability analysis must not.
- **Expected evidence:** the finding's evidence should show
  `resolveTargetNodes` succeeding (the `parse` export genuinely exists and
  is resolvable in the installed package — this is not an `UNKNOWN`-via-
  unresolved-target case), but the reachability phase finding zero call
  graph paths to it from any configured entrypoint — i.e. a positive,
  confident `NOT_AFFECTED`, not a fallback.
- **Source of advisory:** `https://api.osv.dev/v1/vulns/GHSA-hrpp-h998-j3pp`
- **Source of vulnerable code:** packed `qs@6.10.1`, `lib/index.js`,
  `lib/parse.js`
- **Source of version info:** same OSV record; `npm view qs versions
  --json` confirms `6.10.0`/`6.10.1`/`6.10.2`/`6.10.3` are all real.
- **Difficulty:** EASY–MEDIUM
- **Dimensions tested:** package identity, version identity, module
  resolution, symbol resolution (must distinguish the two named exports),
  call graph (confirming absence of an edge), reachability.
- **Why different from the others:** the first of three structurally
  distinct NOT_AFFECTED reasons in this set (RWB-05/06/07) — this one is
  an **export-level** exclusion: the vulnerable name is never even
  imported, let alone called. Contrast with RWB-06 (whole module never
  imported at all) and RWB-07 (imported, even called, but not from any
  reachable entrypoint).

### RWB-06 — `node-forge` (UNREACHED_DEPENDENCY)

- **npm package:** `node-forge`
- **CVE / GHSA:** CVE-2026-33896 / GHSA-2328-f5f3-gj25
- **Vulnerable versions:** `<1.4.0`
- **Patched versions:** `>=1.4.0`
- **Vulnerability type:** RFC 5280 `basicConstraints` enforcement bypass
  in certificate chain verification (a leaf cert lacking both
  `basicConstraints` and `keyUsage` is wrongly accepted as a valid
  intermediate CA)
- **Vulnerable symbol:** `pki.verifyCertificateChain(caStore, chain,
  options)`, exported from `lib/x509.js`, re-exported via
  `lib/index.js`'s `pki` namespace — confirmed present at that name in
  packed `node-forge@1.3.3` (`grep -n "verifyCertificateChain"
  lib/x509.js` → line 2882).
- **Why suitable:** this is the "package-level SCA vs. reachability"
  thesis in its purest form — `node-forge` is exactly the kind of
  general-purpose crypto/TLS toolkit that ends up in `package.json` for
  one feature and then outlives that feature, or gets pulled in
  transitively and left unused after a refactor.
- **Expected verdict:** NOT_AFFECTED
- **Reachability pattern:** UNREACHED_DEPENDENCY
- **Application fixture:**
  - installs `node-forge@1.3.3` as a direct dependency in `package.json`
  - `src/index.js`: a small module implementing unrelated functionality
    (e.g. a request-header formatter) with **zero** `require('node-forge')`
    or `import ... from 'node-forge'` anywhere in `src/`
  - `vulntrace.yml` entrypoint: `src/index.js`
- **Why not reachable:** the package is genuinely, verifiably present
  (real `package.json` dependency, real `node_modules/node-forge/`
  installed) but never imported anywhere in the application's own source
  — module resolution never even constructs a module-graph node for it
  from any entrypoint. This is the module-resolution-level counterpart to
  RWB-05's export-level exclusion.
- **Expected evidence:** `coverage`/diagnostics should show `node-forge`
  as a known dependency with a matched vulnerability, but zero resolved
  import edges into it from the entrypoint's module graph — a confident
  `NOT_AFFECTED` grounded in "this module is provably never loaded by
  this application," the strongest possible NOT_AFFECTED justification in
  the set.
- **Source of advisory:** `https://github.com/digitalbazaar/forge/security/advisories/GHSA-2328-f5f3-gj25`,
  `https://nvd.nist.gov/vuln/detail/CVE-2026-33896`
- **Source of vulnerable code:** packed `node-forge@1.3.3`, `lib/x509.js`
- **Source of version info:** OSV record `GHSA-2328-f5f3-gj25`; `npm view
  node-forge@1.4.0 version` confirms the patched version is real and is
  the current newest release.
- **Difficulty:** EASY
- **Dimensions tested:** package identity, version identity, module
  resolution (confirming zero edges), reachability.
- **Why different from the others:** the only case where the *entire
  package* — not just one export — is unreached; simplest possible
  NOT_AFFECTED justification, and the most direct real-world illustration
  of why VulnTrace exists (a plain SCA tool cannot distinguish this from
  RWB-01).

### RWB-07 — `ini` (OTHER — imported, called, but never reached from any configured entrypoint)

- **npm package:** `ini`
- **CVE / GHSA:** CVE-2020-7788 / GHSA-qqgx-2p2h-9c37
- **Vulnerable versions:** `<1.3.6`
- **Patched versions:** `>=1.3.6`
- **Vulnerability type:** Prototype pollution (CWE-1321) via `ini.parse`
- **Vulnerable symbol:** real source, packed `ini@1.3.5`, `ini.js` line 1:
  `exports.parse = exports.decode = decode` — `parse` and `decode` are two
  names for the same underlying function (`stringify`/`encode` are
  likewise aliased to a separate function). The fixture uses the `parse`
  name for advisory-accuracy; the alias itself is noted as a bonus
  complication, not the core point of this case.
- **Why suitable:** unlike RWB-05 (export never imported) and RWB-06
  (module never imported), this case imports the module, imports the
  specific vulnerable export by name, and even calls it — from a function
  that itself is never invoked by anything reachable from the
  application's configured entrypoint. This exercises entrypoint-driven
  reachability (`docs/SDD.md § 19` Entrypoints, § 20 Reachability)
  specifically, not import/export resolution.
- **Expected verdict:** NOT_AFFECTED
- **Reachability pattern:** OTHER (call-graph-level unreachable-from-
  entrypoint, distinct from RWB-06's import-level UNREACHED_DEPENDENCY)
- **Application fixture:**
  - installs `ini@1.3.5`
  - `src/config.js`:
    ```js
    const ini = require('ini');
    function loadModernConfig(text) {
      return JSON.parse(text);
    }
    // Legacy INI loader retained for a migration that already completed;
    // no remaining code path calls this function.
    function loadLegacyIniConfig(text) {
      return ini.parse(text);
    }
    module.exports = { loadModernConfig };
    ```
  - `vulntrace.yml` entrypoint: `src/config.js`, entry function
    `loadModernConfig` only — `loadLegacyIniConfig` is defined in the same
    file, genuinely calls `ini.parse`, but is not exported and not called
    by `loadModernConfig` or anything else.
- **Why not reachable:** `loadLegacyIniConfig` has a real, live call to
  the real vulnerable `ini.parse` — a naive "does this file contain a
  call to the vulnerable function" grep would (wrongly) flag it. But no
  configured entrypoint's call graph reaches `loadLegacyIniConfig` at
  all; it is dead code from the analysis's point of view. This is the
  same structural idea as the existing adversarial fixtures
  `adv-008-imported-never-called`/`adv-009-defined-unreachable`
  (`tests/adversarial/v1/`), now validated against a real advisory and
  real package instead of only synthetic code.
- **Expected evidence:** `resolveTargetNodes` should succeed (the target
  is real and resolvable), and the call graph should show
  `loadLegacyIniConfig` as a node with no incoming edges from any
  entrypoint — the diagnostic should be specific enough to show *why* it's
  NOT_AFFECTED (unreached from configured entrypoints), not merely that it
  is.
- **Source of advisory:** `https://api.osv.dev/v1/vulns/GHSA-qqgx-2p2h-9c37`
- **Source of vulnerable code:** packed `ini@1.3.5`, `ini.js`
- **Source of version info:** same OSV record; `npm view ini versions`
  confirms `1.3.5`/`1.3.6` are real.
- **Difficulty:** MEDIUM–HARD
- **Dimensions tested:** package identity, version identity, module
  resolution, symbol resolution, call graph, reachability, entrypoint
  handling (the crux of this case), alias flow (the `parse`/`decode`
  export aliasing is present in the real code and worth preserving as an
  incidental extra signal, though not what the verdict hinges on).
- **Why different from the others:** the only NOT_AFFECTED case where the
  vulnerable function is both imported *and* actually called somewhere in
  the source tree — correctness here depends entirely on entrypoint-
  driven call graph reachability, not on import/export analysis, making
  it the hardest of the three NOT_AFFECTED cases to get right and the
  easiest to get wrong via a naive "is this symbol called anywhere" check.

### RWB-08 — `debug` → `ms` (OTHER — nested/transitive dependency instance, reached via re-export)

- **npm package (installed directly):** `debug`; **actual vulnerable
  package (transitive):** `ms`
- **CVE / GHSA:** CVE-2015-8315 / GHSA-3fx5-fwvr-xrjg
- **Vulnerable versions:** `ms <0.7.1`
- **Patched versions:** `ms >=0.7.1`
- **Vulnerability type:** ReDoS (CWE-1333/400) in `ms`'s string-parsing
  regex
- **Vulnerable symbol:** `ms`'s default exported function
  (`module.exports`), reached **indirectly**: `debug@2.0.0`'s real
  installed source, `node_modules/debug/debug.js:14`: `exports.humanize =
  require('ms');` — `debug` re-exports `ms`'s entire module.exports
  function verbatim as `debug.humanize`. Confirmed reproduced live:
  `npm install debug@2.0.0` resolves `ms@0.6.2` (within the vulnerable
  range) as a transitive dependency, confirmed via
  `node_modules/ms/package.json`.
- **Why suitable:** `ms` never appears in the application's own
  `package.json` — it is pulled in solely because `debug` depends on it.
  The reachable call is through a *different* package's re-export of it
  (`debug.humanize`), not through any direct reference to `ms` at all —
  the vulnerability must be attributed to `ms`, a package the application
  never named, while the call site names only `debug`.
- **Expected verdict:** AFFECTED
- **Reachability pattern:** OTHER (nested dependency instance reached via
  a parent package's re-export — distinct from RWB-09's MULTI_INSTANCE,
  which is about two *different* installed versions of the *same*
  directly-depended-on package name)
- **Application fixture:**
  - installs `debug@2.0.0` as the sole relevant direct dependency (which
    resolves `ms@0.6.2` transitively — vendored/pinned via a real
    `package-lock.json` from an actual `npm install`)
  - `src/rate-limit.js`: `const debug = require('debug')('app:limits'); function parseWindow(userSuppliedDuration) { return debug.humanize(userSuppliedDuration); } module.exports = { parseWindow };`
  - `vulntrace.yml` entrypoint: `src/rate-limit.js`
- **Path:** `src/rate-limit.js` `parseWindow()` → `debug.humanize(...)`
  (a property access on the `debug` module's own exports, not a
  `require('ms')` anywhere in application code) → resolves, via
  `debug`'s own `exports.humanize = require('ms')` re-export, to `ms`'s
  real vulnerable default-export function in
  `node_modules/debug/node_modules/ms/index.js` (or hoisted
  `node_modules/ms/`, depending on the real npm-generated tree).
- **Expected evidence:** the finding must be attributed to package `ms`
  at version `0.6.2` (not `debug`), while the evidence chain's application-
  side call site names only `debug.humanize` — this specifically tests
  whether VulnTrace's evidence model can show "this call, which mentions
  only package X in the source, is actually calling into package Y" and
  get the package/version identity right for the *vulnerability* (`ms`)
  while the call graph's outermost hop is genuinely `debug`.
- **Source of advisory:** `https://api.osv.dev/v1/vulns/GHSA-3fx5-fwvr-xrjg`
- **Source of vulnerable code:** real `npm install debug@2.0.0`,
  `node_modules/debug/debug.js` line 14; real resolved
  `node_modules/ms/package.json` confirming version `0.6.2`
- **Source of version info:** OSV record; live install confirms the real,
  current dependency resolution of `debug@2.0.0` → `ms@0.6.2` still
  occurs today via the registry tarballs
  `https://registry.npmjs.org/ms/-/ms-0.6.2.tgz` and
  `https://registry.npmjs.org/debug/-/debug-2.0.0.tgz`.
- **Difficulty:** HARD
- **Dimensions tested:** package identity (attributing the finding to the
  correct nested package, not the directly-depended-on one), version
  identity, module resolution (nested `node_modules` resolution), symbol
  resolution (following a cross-package re-export chain), call graph,
  reachability, alias flow.
- **Why different from the others:** the only case in this set requiring
  VulnTrace to follow a symbol across a package boundary via re-export
  (`debug.humanize` *is* `ms`'s function, under a different name, exported
  by a different package) — the single hardest module/symbol-resolution
  case proposed here.

### RWB-09 — `semver` (MULTI_INSTANCE)

- **npm package:** `semver`
- **CVE / GHSA:** CVE-2022-25883 / GHSA-c2qf-rxjj-qqgw
- **Vulnerable versions:** `7.0.0`–`<7.5.2` (also earlier 6.x/5.x lines)
- **Patched versions:** `>=7.5.2`
- **Vulnerability type:** ReDoS (CWE-1333) in `Range` parsing regexes
- **Vulnerable symbol:** the `Range` class constructor
  (`classes/range.js`), which builds its parsing regex from
  `internal/re.js` (`COMPARATORTRIM` and related patterns) — confirmed by
  installing real `semver@7.5.1` and reading the shipped source; matches
  the GHSA's own cited file/line references.
- **Why suitable:** directly exercises real-world **package-instance
  identity** — the same package *name*, `semver`, resolved to two
  genuinely different installed versions in one dependency tree, one
  vulnerable and one patched. This is precisely the scenario `VT-212`
  ("PackageInstance selection authority in verdict resolution") was fixed
  to handle correctly; this case validates that fix against a real
  advisory instead of only the synthetic/adversarial fixture that
  originally found the bug.
- **Research finding on realism:** no currently-installable real package
  was found that itself still depends on a pre-7.5.2 `semver` range in a
  way that would naturally produce a non-hoisted double-install today
  (the ecosystem has long since bumped past it). The fixture instead uses
  a verified-working **npm alias** to construct two real installed
  instances deterministically:
  ```json
  "dependencies": {
    "semver": "7.5.2",
    "semver-vulnerable": "npm:semver@7.5.1"
  }
  ```
  Both resolve to genuine, real `semver` package code at those exact
  versions (confirmed via a real `npm install` and inspecting
  `node_modules/semver/package.json` and
  `node_modules/semver-vulnerable/package.json`) — this is a real,
  reproducible multi-instance scenario, but it is constructed via
  aliasing rather than observed from an existing real dependency graph;
  stated explicitly here per the "supported by source inspection, not
  assumption" requirement (see also § 8).
- **Expected verdict:** the benchmark should record **two findings** for
  this one fixture, both correct: `AFFECTED` for the instance reached at
  `7.5.1`, `NOT_AFFECTED` for the instance at `7.5.2` — testing that
  VulnTrace does not conflate the two into a single package-name-level
  answer in either direction.
- **Reachability pattern:** MULTI_INSTANCE
- **Application fixture:**
  - `package.json` dependencies as above (aliased)
  - `src/version-check.js`:
    ```js
    const semver = require('semver');                    // patched, 7.5.2
    const legacySemver = require('semver-vulnerable');    // vulnerable, 7.5.1
    function isCompatible(userRange, version) {
      return new semver.Range(userRange).test(version);
    }
    function isLegacyCompatible(userRange, version) {
      return new legacySemver.Range(userRange).test(version);
    }
    module.exports = { isCompatible, isLegacyCompatible };
    ```
  - `vulntrace.yml` entrypoint: `src/version-check.js`, both functions
    exported as entrypoints
- **Path (AFFECTED instance):** `isLegacyCompatible()` → `new
  legacySemver.Range(userRange)` → `node_modules/semver-vulnerable/`
  (real `semver@7.5.1` code) `classes/range.js` constructor.
  **Path (NOT_AFFECTED instance):** `isCompatible()` → `new
  semver.Range(userRange)` → `node_modules/semver/` (real `semver@7.5.2`
  code) — same constructor, patched implementation, not in the
  vulnerable range.
- **Expected evidence:** two separate findings sharing the same
  `vulnerability` id and `package` name (`semver`) but different resolved
  `version` (`7.5.1` vs `7.5.2`) and different verdicts — the report must
  make clear these are two distinct package instances, not a single
  ambiguous "semver: mixed" result.
- **Source of advisory:** `https://api.osv.dev/v1/vulns/GHSA-c2qf-rxjj-qqgw`
- **Source of vulnerable code:** real `npm install semver@7.5.1`,
  `node_modules/semver/classes/range.js`, `internal/re.js`
- **Source of version info:** OSV record; live installs of both `7.5.1`
  and `7.5.2` confirmed real and current.
- **Difficulty:** HARD
- **Dimensions tested:** package identity, version identity (the core of
  this case), module resolution (npm-alias resolution), symbol
  resolution, call graph, reachability.
- **Why different from the others:** the only case in this set requiring
  two verdicts from one fixture, and the only one testing whether
  VulnTrace's verdict resolution is truly per-*instance* rather than
  per-package-*name* — directly re-validates a previously-fixed real bug
  class (`VT-212`) against a real advisory.

### RWB-10 — `handlebars` (UNKNOWN via unresolvable dynamic dispatch)

- **npm package:** `handlebars`
- **CVE / GHSA:** CVE-2021-23369 / GHSA-f2jv-r9rf-7988
- **Vulnerable versions:** `<4.7.7`
- **Patched versions:** `>=4.7.7`
- **Vulnerability type:** RCE via template compilation (CWE-94) when
  certain compile options are used with untrusted template input
- **Vulnerable symbol:** the exported `compile(input, options, env)`
  function — confirmed present at `lib/handlebars/compiler/compiler.js:510`
  in a real local install of `handlebars@4.7.6`.
- **Why this needs a different design than RWB-01..04's AFFECTED cases:**
  a *direct, unconditional* call to `Handlebars.compile(x)` for any `x` is
  already unambiguously reachable — that would just be another AFFECTED
  case (structurally identical to `VAL-001`/`lodash.template`, already
  implemented), not a genuine UNKNOWN. VulnTrace's actual scope (per
  `docs/SDD.md § 21` "Dynamic JavaScript") is *reachability*, not taint —
  so the right UNKNOWN case is one where the **call graph edge to the
  vulnerable symbol itself** cannot be soundly resolved, not one where the
  argument's data source is merely ambiguous.
- **Expected verdict:** UNKNOWN
- **Reachability pattern:** UNKNOWN
- **Application fixture:**
  - installs `handlebars@4.7.6`
  - `src/template-engine.js`:
    ```js
    const Handlebars = require('handlebars');
    const nunjucks = require('./nunjucks-shim'); // a second, unrelated real compiler
    const engines = { hbs: Handlebars.compile, njk: nunjucks.compile };
    function renderTemplate(engineName, templateSource) {
      const compile = engines[engineName];       // engineName from config, not a literal
      return compile(templateSource);
    }
    module.exports = { renderTemplate };
    ```
  - `vulntrace.yml` entrypoint: `src/template-engine.js`, entry function
    `renderTemplate`; `engineName`'s actual value comes from a config file
    read at runtime (e.g. `config.yml`'s `templateEngine` key), not a
    literal string anywhere in the source
- **What exactly prevents a sound conclusion:** `engines[engineName]` is a
  computed property access on an object literal, keyed by a value with no
  statically-determinable constant (it is read from external
  configuration at runtime). VulnTrace can see that `engines.hbs` is
  `Handlebars.compile` and that `compile(...)` is *called* — but it cannot
  soundly prove whether *this specific call site* ever actually binds
  `compile` to `Handlebars.compile` versus `nunjucks.compile`, because
  that depends on a runtime string it cannot evaluate. This is exactly
  the "dynamic property access" fixture category already required by
  `docs/SDD.md § 31`'s fixture list (item 7) and exercised structurally
  by the existing `adv2-043-env-driven-require`-style adversarial
  scenarios — this case validates the same limitation against a real
  advisory instead of only synthetic code.
- **Why UNKNOWN and not NOT_AFFECTED:** per `AGENTS.md`'s core rule, never
  infer `NOT_AFFECTED` merely because resolution failed — an unresolved
  dynamic dispatch target must fall back to `UNKNOWN`, since a false
  `NOT_AFFECTED` here (if `engineName` happens to be `"hbs"` at runtime,
  which the analyzer cannot rule out) would be exactly the critical
  security failure `docs/VALIDATION-STRATEGY.md § 10` names.
- **Why UNKNOWN and not AFFECTED:** VulnTrace must not guess that the
  dynamic key resolves to the vulnerable branch either — doing so would
  be an unproven, potentially wrong `AFFECTED` on inputs where
  `engineName` is actually `"njk"`.
- **Expected evidence:** a diagnostic explicitly naming the unresolved
  dynamic property access as the reason for `UNKNOWN` (e.g. `reason:
  unresolved_target` or an equivalent dynamic-dispatch diagnostic,
  consistent with how `tests/validation/`'s `RWF-001` cases already
  surface `unresolved_target` reasons) — not a silent/generic UNKNOWN.
- **Source of advisory:** `https://api.osv.dev/v1/vulns/GHSA-f2jv-r9rf-7988`
- **Source of vulnerable code:** real `npm install handlebars@4.7.6`,
  `lib/handlebars/compiler/compiler.js:510`
- **Source of version info:** OSV record; `npm view handlebars@4.7.7
  version` confirms the patched version is real.
- **Difficulty:** HARD
- **Dimensions tested:** package identity, version identity, module
  resolution, symbol resolution, call graph (edge genuinely unresolved),
  reachability, object/property flow (computed key lookup on a registry
  object), callback flow (the resolved function value is invoked
  indirectly through a local variable, not called by name).
- **Why different from the others:** the only case in the set where the
  correct verdict is neither a confident positive nor a confident
  negative — it exists specifically to prove VulnTrace fails safe (to
  `UNKNOWN`, never to a false `NOT_AFFECTED`) exactly when static
  reachability genuinely cannot be established, which is the single most
  important property this whole benchmark exists to check.

---

## 4. Coverage matrix

| ID | Package | Pattern (tag) | AFFECTED / NOT_AFFECTED / UNKNOWN | Difficulty | Dimensions tested |
|---|---|---|---|---|---|
| RWB-01 | trim-newlines | DIRECT | AFFECTED | EASY | package id, version id, module res., symbol res., call graph, reachability |
| RWB-02 | minimist | WRAPPER | AFFECTED | EASY–MEDIUM | + call graph across a same-file wrapper hop |
| RWB-03 | fast-xml-parser | METHOD | AFFECTED | MEDIUM | + object/property flow (constructed instance), instance method resolution |
| RWB-04 | url-parse | CONSTRUCTOR | AFFECTED | MEDIUM | + constructor-call resolution |
| RWB-05 | qs | UNUSED_API | NOT_AFFECTED | EASY–MEDIUM | + named-export-level exclusion |
| RWB-06 | node-forge | UNREACHED_DEPENDENCY | NOT_AFFECTED | EASY | + whole-module-level exclusion |
| RWB-07 | ini | OTHER (unreached-from-entrypoint) | NOT_AFFECTED | MEDIUM–HARD | + entrypoint handling, alias flow |
| RWB-08 | debug → ms | OTHER (nested dependency instance) | AFFECTED | HARD | + nested resolution, cross-package re-export/alias flow |
| RWB-09 | semver (×2 instances) | MULTI_INSTANCE | AFFECTED + NOT_AFFECTED (two findings) | HARD | + per-instance version identity |
| RWB-10 | handlebars | UNKNOWN | UNKNOWN | HARD | + unresolved dynamic dispatch, object/property flow, callback flow |

Every one of the 10 target patterns from the task's goal is covered exactly
once (RWB-07 and RWB-08 share the `OTHER` tag but are structurally distinct,
as detailed in each case's "why different" field).

## 5. Why each case was selected

Summarized per case above in each "why suitable" / "why different from the
others" field; in aggregate, the 10 were chosen to each isolate exactly one
new reachability-analysis capability relative to the simplest baseline
(RWB-01), so that a future failure on any one case points at a specific,
narrow mechanism rather than "something in reachability is broken":
direct call (baseline) → same-file wrapper hop → constructed-instance
method call → constructor-time vulnerability → named-export-level non-use
→ whole-module non-use → entrypoint-reachability non-use → cross-package
re-export following → per-instance version identity → unresolvable dynamic
dispatch.

## 6. Verdict classification

- **AFFECTED:** RWB-01, RWB-02, RWB-03, RWB-04, RWB-08, and one of
  RWB-09's two findings (the `7.5.1` instance).
- **NOT_AFFECTED:** RWB-05, RWB-06, RWB-07, and the other of RWB-09's two
  findings (the `7.5.2` instance).
- **UNKNOWN:** RWB-10.

## 7. Rejected candidates

- **minimist / CVE-2020-7598** — superseded; 1.2.5 already contains a
  literal `__proto__` guard that fully closes this earlier issue, making
  it a confusing choice next to the real, still-open CVE-2021-44906.
- **url-parse / GHSA-46c4-8wrp-j99v (CVE-2020-8124)** — an earlier, vaguer
  "improper validation" advisory without a specific, quotable vulnerable
  code path; CVE-2022-0639 gives a clean, class/constructor-attributable
  mechanism instead.
- **`qs`'s newer `arrayLimit` advisories (2025/2026 lines)** — real, but
  more complicated to isolate to one clean vulnerable symbol than the
  well-established CVE-2022-24999 `parse()` case; rejected in favor of
  the simpler, better-documented one.
- **`ms`'s newer advisory, GHSA-w9mr-4mfr-499f (CVE-2017-20162)** —
  real, but `debug`'s pinned dependency range in the versions usable for
  this fixture never actually resolves into that vulnerable range in
  practice (modern `debug` requires `ms@^2.1.3`, already patched);
  CVE-2015-8315 is the one a real `debug@2.0.0` install genuinely
  reproduces today.
- **`ini`'s `parse`/`decode` aliasing as the case's primary point** —
  considered making export-aliasing itself the star of a case, but chose
  to make RWB-07's primary point entrypoint-reachability instead (a gap
  not otherwise covered in this set) and keep the alias detail as a
  secondary, incidental signal in the same fixture rather than diluting
  the case's focus.
- **A real (non-aliased) MULTI_INSTANCE dependency graph** — actively
  searched for; no currently-installable real package was found that
  still pulls a pre-7.5.2 `semver` transitively in a way that would
  naturally double-install non-hoisted today. Rejected in favor of the
  npm-alias construction, with the caveat stated explicitly in RWB-09 and
  § 8 rather than silently presented as an organically-observed real
  dependency graph.
- **lodash / lodash.template (again)** — already the subject of
  `VAL-001`/`RWF-001` in the current `tests/validation/` suite; reusing
  the same package here would be a duplicate signal rather than new
  coverage, so this benchmark deliberately uses ten different packages.

## 8. Research uncertainty

- **`fast-xml-parser`/CVE-2026-25128 and `node-forge`/CVE-2026-33896** are
  both very recently published relative to this document. Their OSV/NVD
  records were fetched live and cross-checked against real downloaded
  package source, but being newly published, the advisory text or
  affected-range data could still be revised upstream; both should be
  re-fetched and re-verified immediately before any fixture is frozen for
  implementation, not assumed stable from this document alone.
- **`fast-xml-parser`'s alternate trigger path:** research did not fully
  trace whether `docTypeEntities`/`lastEntities` (populated from in-
  document `DOCTYPE` declarations) could trigger the same `RangeError`
  independent of the `htmlEntities: true` option used in RWB-03's
  fixture. The `htmlEntities: true` path is the one the GHSA's own PoC
  uses and is fully confirmed; the alternate path is noted here as an
  open question, not a claim.
- **RWB-09's realism:** as stated in the case itself, no real,
  currently-installable dependency graph was found that organically
  produces a non-hoisted double-install of `semver` at two different
  vulnerable/patched versions today. The proposed fixture uses npm
  aliasing to construct a real (not fabricated at the code level, but
  deliberately engineered at the dependency-graph level) multi-instance
  scenario. This should be described accurately in the eventual
  `cases.json` `reason` field as a constructed scenario testing a real
  mechanism, not as an observed real-world dependency conflict.
- **RWB-08's exact installed path for `ms`:** whether `ms@0.6.2` ends up
  at `node_modules/debug/node_modules/ms/` or hoisted to top-level
  `node_modules/ms/` in the final fixture depends on npm's resolver and
  what else (if anything) else is installed alongside `debug` in the
  fixture; this doesn't affect the vulnerability's reachability, but the
  exact evidence-path file location should be confirmed against the
  actual generated `package-lock.json` at implementation time rather than
  assumed from this document.
- **General:** all version ranges and vulnerable-symbol claims above were
  verified against real, live-fetched OSV records and real downloaded
  package source at research time; none were taken from memory alone. Advisory
  text and version ranges can still change upstream between now and
  implementation — re-verification immediately before fixture-freezing
  (the same discipline `docs/VALIDATION-STRATEGY.md § 7` already requires
  via the proposed `advisoryFetchedAt` field) is recommended for all 10
  cases, not only the two flagged above as newest.

## 9. Implementation status update (VT-303)

The independent audit of the implemented benchmark
(`docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md`) found that `RWB-06` and
`RWB-09` — as implemented from this design — each ended up testing more
than one independent mechanism at once (see `tests/validation/FINDINGS.md`
§ "Benchmark methodology note — VT-303 cause-splitting" for the full
before/after breakdown). VT-303 added single-cause sibling cases for
both, leaving every original case and expected verdict in this document
unchanged:

- **`RWB-06A`** (new) — a clean sibling of § "RWB-06 — `node-forge`
  (UNREACHED_DEPENDENCY)" above, isolating that thesis from the
  incidental `token.trim()` construct that turned out to confound it
  (RWF-002). Currently passes.
- **`RWB-11a`/`RWB-11b`** (new) — the genuine, non-aliased nested
  multi-instance case § 8's "RWB-09's realism" note above already
  anticipated might be needed: real `url-parse@1.4.7` (nested under a
  small, honestly-labeled, fixture-authored wrapper package) and real
  `url-parse@1.4.4` (top-level), with **no npm aliasing** — the exact gap
  that note flagged for `semver` at design time. `RWB-09` itself is
  unchanged and now reclassified as the dedicated **ALIASED_INSTALL**
  stress case (its own failures remain attributed to RWF-009/RWF-004,
  neither fixed here). Both new cases currently pass.

The benchmark remains v0.1 in scope: no new CVEs were added by VT-303.
