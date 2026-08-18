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

Not lintable/prettier-checked project code — see `eslint.config.js` and
`.prettierignore`'s `tests/validation/fixtures/**` entries.
