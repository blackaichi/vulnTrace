# ADR 0003 — Manual Vulnerable-Symbol Rules First

## Decision

The MVP uses manually authored vulnerability behavior rules.

## Rationale

Automatic CVE-to-symbol inference is a substantial research problem and must
not block validation of the core reachability engine.

## Future

Add security-fix/diff inference after the vertical slice is reliable.
