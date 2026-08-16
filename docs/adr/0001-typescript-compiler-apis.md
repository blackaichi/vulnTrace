# ADR 0001 — Prefer TypeScript Compiler APIs for TS Resolution

## Decision

Use TypeScript compiler APIs where they provide correct module and source
semantics, behind VulnTrace interfaces.

## Rationale

Reimplementing Node/TypeScript module resolution creates subtle incompatibilities.

## Consequence

The implementation must isolate compiler-specific types behind adapters.
