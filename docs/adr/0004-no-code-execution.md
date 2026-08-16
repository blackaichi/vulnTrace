# ADR 0004 — No Target Code Execution

## Decision

The static analyzer must not execute target application or package code.

## Rationale

Executing untrusted dependencies creates supply-chain and analyzer security risk.

## Future

Runtime evidence, if ever added, must be isolated behind a sandbox boundary.
