# Real-world CVE validation cases (scaffold)

Each entry here will describe one real, previously-published CVE/GHSA
validation case, in the same spirit as an oracle entry in
`tests/adversarial/v1/expected.json` / `v2/expected.json`:

- the real advisory id (CVE/GHSA);
- the real package name and vulnerable version range;
- the real vulnerable symbol (module/export/kind), authored as a
  `VulnerableSymbolRule` the same way `rules/vulntrace-rules.yml` already
  does for production use;
- an expected verdict, with the human rationale for it — written by
  reading the real advisory and the real vulnerable code path, never by
  running VulnTrace first and copying its output;
- a pointer to the matching directory under `../fixtures/`.

Empty for now — see `../README.md`.
