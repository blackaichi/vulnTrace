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
  (GHSA-7p7h-4mm5-852v / CVE-2021-33623). RWB-01, DIRECT.
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
- `rwb-10-handlebars-dynamic-dispatch/` — real `handlebars@4.7.6`
  (GHSA-f2jv-r9rf-7988 / CVE-2021-23369), `Handlebars.compile` reachable
  only through a computed property lookup keyed by a runtime config value.
  RWB-10, UNKNOWN.

Not lintable/prettier-checked project code — see `eslint.config.js` and
`.prettierignore`'s `tests/validation/fixtures/**` entries.
