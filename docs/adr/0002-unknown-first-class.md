# ADR 0002 — UNKNOWN Is First-Class

## Decision

The analyzer has three verdicts:

- AFFECTED
- NOT_AFFECTED
- UNKNOWN

## Rationale

Static analysis is incomplete by nature. Treating unresolved behavior as safe
creates false negatives.

## Consequence

All graph/resolution uncertainty must be representable in the domain model.
