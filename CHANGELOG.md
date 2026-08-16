# Changelog

Note: entries below `0.1.0` predate the npm package and describe the
*specification document's* own version history, not implementation
releases — a separate numbering scheme from `package.json`'s.

## 0.1.0 — MVP release

All 30 tasks complete (see `docs/adr/0007-mvp-known-limitations.md` for
what's deliberately out of scope). Implements the full vertical slice:
`package-lock.json` → dependency graph → OSV → normalized vulnerability
→ manually authored vulnerable-symbol rule → JS/TS source model →
module/symbol resolution → call graph → reachability → verdict →
evidence + JSON, exposed as `vulntrace scan`/`rules validate`/`version`.

- Real TypeScript compiler API for module/symbol resolution (no
  reimplemented Node/TS resolution semantics — ADR-0001).
- First-class `AFFECTED`/`NOT_AFFECTED`/`UNKNOWN` verdicts; `UNKNOWN`
  is never silently coerced to `NOT_AFFECTED`.
- Coverage and diagnostics explaining analysis blockers.
- JSON output validated against a checked-in schema.
- Deterministic OSV response caching, keyed by tool + input version.
- Path-traversal and resource-limit hardening against an adversarial
  target project; untrusted provider/target data validated throughout.
- Per-phase performance instrumentation and a regression baseline.

## 0.6.0

- Renamed project to VulnTrace.
- Reframed product around vulnerability-specific behavior.
- Added competitive analysis against OWASP VulnReach.
- Added first-class UNKNOWN and coverage model.
- Added future security-fix/diff inference architecture.
- Updated coding-agent tasks and prompts.
