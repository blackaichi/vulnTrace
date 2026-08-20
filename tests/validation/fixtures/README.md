# Real-world validation fixtures

Each subdirectory here is one real-world reproduction project for a
`tests/validation/cases/cases.json` entry: a real `package.json` and
`package-lock.json` pinning the actual vulnerable package version, the
real installed package vendored under `node_modules/` (pruned to only the
files actually needed for resolution, verified to produce identical scan
behavior to the full install — see each case's own commit), plus the
minimum application source needed to either reach or not reach the real
vulnerable symbol.

## Current fixtures

- `lodash-template-4.5.0-affected/` — real `lodash.template@4.5.0`
  (GHSA-35jh-r3h4-6jhm / CVE-2021-23337). VAL-001.
- `lodash-4.17.15-vulnerable-call-unknown/` — real `lodash@4.17.15`
  (GHSA-29mw-wpgm-hmr9 / CVE-2020-28500), entrypoint genuinely calls
  `trim()`. VAL-002.
- `lodash-4.17.15-safe-call-unknown/` — same real `lodash@4.17.15`
  vulnerability, entrypoint genuinely never calls `trim`/`trimEnd`/
  `toNumber`. VAL-003.
- `rwb-01-trim-newlines-direct/` — real `trim-newlines@3.0.0`
  (GHSA-7p7h-4mm5-852v / CVE-2021-33623). RWB-01, DIRECT. Also the
  RWF-005/VT-304 exhibit: `trim-newlines` ships a hand-authored `index.d.ts`
  alongside its real `index.js` with no `main` field to disambiguate them,
  which is exactly the shape TypeScript's resolver used to prefer the
  declaration file for. **Currently passes** (AFFECTED) since VT-304.
- `rwb-02-minimist-wrapper/` — real `minimist@1.2.5`
  (GHSA-xvch-5gv4-984h / CVE-2021-44906), reached through an app-authored
  CLI-args wrapper. RWB-02, WRAPPER.
- `rwb-03-fast-xml-parser-method/` — real `fast-xml-parser@5.3.3`
  (GHSA-37qj-frw5-hhjh / CVE-2026-25128), reached via a constructed
  `XMLParser` instance's `.parse()` method. RWB-03, METHOD.
- `rwb-04-url-parse-constructor/` — real `url-parse@1.4.4`
  (GHSA-8v38-pw62-9cw2 / CVE-2022-0639), vulnerable logic runs entirely
  inside the `Url` constructor. RWB-04, CONSTRUCTOR.
- `rwb-05-qs-unused-api/` — real `qs@6.10.1` (GHSA-hrpp-h998-j3pp /
  CVE-2022-24999); only the unrelated `stringify()` export is used. RWB-05,
  UNUSED_API.
- `rwb-06-node-forge-unreached/` — real `node-forge@1.3.3`
  (GHSA-2328-f5f3-gj25 / CVE-2026-33896), installed but never imported
  anywhere in the fixture's source. RWB-06, UNREACHED_DEPENDENCY.
  **Confounded/precision-stress case (VT-303)**: the entrypoint also
  contains an incidental `token.trim()` call, an unrelated
  `unsupported_construct` that drives the actual result to UNKNOWN
  instead of the intended NOT_AFFECTED (RWF-002). Kept unchanged
  deliberately, as the RWF-002 exhibit — see `rwb-06a-...` below for the
  isolated control.
- `rwb-06a-node-forge-unreached-clean/` (VT-303) — identical thesis to
  `rwb-06-node-forge-unreached/` (same package, same version, same
  advisory), but with zero other unresolved/dynamic constructs anywhere
  in the entrypoint's reachable subgraph (plain string concatenation
  instead of `token.trim()`). Verified directly: 2 graph nodes, 0 edges,
  node-forge never discovered in the graph at all. **Clean single-cause
  UNREACHED_DEPENDENCY control — currently passes.** RWB-06A.
- `rwb-07-ini-entrypoint-unreached/` — real `ini@1.3.5`
  (GHSA-qqgx-2p2h-9c37 / CVE-2020-7788); `ini.parse()` is genuinely called,
  but only from a function unreachable from the configured `{file, symbol}`
  entrypoint. RWB-07.
- `rwb-08-debug-ms-nested/` — real `debug@2.0.0` pulling in real, vulnerable
  `ms@0.6.2` transitively (GHSA-3fx5-fwvr-xrjg / CVE-2015-8315), reached
  only via `debug`'s own re-export (`debug.humanize`). RWB-08.
- `rwb-09-semver-multi-instance/` — real `semver@7.5.2` (direct) and real
  `semver@7.5.1` (npm-aliased as `semver-vulnerable`) coexisting
  (GHSA-c2qf-rxjj-qqgw / CVE-2022-25883). RWB-09a (vulnerable instance,
  AFFECTED) + RWB-09b (patched instance, NOT_AFFECTED), MULTI_INSTANCE.
  **Reclassified (VT-303): ALIASED_INSTALL / package identity under npm
  aliasing.** RWF-009 (`identifyModule` derived identity from the
  install-directory alias name, not the package's own declared `name`)
  was **fixed by VT-306** — RWB-09a moved from a false `NOT_AFFECTED` to
  the safe `UNKNOWN`, since the aliased instance's own `Range` export is
  still blocked by the separate, independent RWF-004 (cross-file
  re-export chasing, open, out of VT-306's scope). RWB-09b's own
  NO_FINDING-vs-NOT_AFFECTED gap remains its own pre-existing
  benchmark-design limitation, unrelated to either finding — see
  `FINDINGS.md`. See `rwb-11-...` below for a genuine multi-instance case
  with no aliasing at all.
- `rwb-11-url-parse-nested-multi-instance/` (VT-303) — real
  `url-parse@1.4.7` nested under a small, fixture-authored wrapper package
  (`node_modules/consumer/node_modules/url-parse`, honestly labeled as
  fixture-only in its own `package.json` — NOT a real published npm
  package) and real `url-parse@1.4.4` at the top level
  (GHSA-8v38-pw62-9cw2 / CVE-2022-0639, vulnerable range `>=1.0.0
  <1.5.7`). Both `url-parse` copies are the real, unmodified,
  npm-published package content (`npm pack url-parse@1.4.4` /
  `url-parse@1.4.7`) — **no npm alias anywhere**, a plain nested install
  exactly like npm itself produces for a transitive dependency needing a
  version its consumers don't share. RWB-11a (nested instance, reached via
  `consumer.parseNested()`, AFFECTED) + RWB-11b (top-level instance, never
  imported by anything reachable, NOT_AFFECTED). Both instances are
  deliberately vulnerable versions (not one patched) so the case tests
  pure instance discrimination without also depending on version-range
  matching. **Both currently pass.**
- `rwb-10-handlebars-dynamic-dispatch/` — real `handlebars@4.7.6`
  (GHSA-f2jv-r9rf-7988 / CVE-2021-23369), `Handlebars.compile` reachable
  only through a computed property lookup keyed by a runtime config value.
  RWB-10, UNKNOWN. Also the RWF-007/VT-305 exhibit: its entrypoint's own
  `require("fs")`/`require("path")` used to each produce a spurious
  closure-widening `unresolved_module` edge alongside the case's intended
  `unsupported_construct` blocker. **Since VT-305**, those builtin-related
  edges are gone (Node builtins are now classified explicitly, never as
  unresolved modules); the verdict itself was already the correct
  `UNKNOWN` either way, via the intended blocker alone.

Not lintable/prettier-checked project code — see `eslint.config.js` and
`.prettierignore`'s `tests/validation/fixtures/**` entries.
