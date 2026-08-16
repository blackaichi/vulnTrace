# ADR 0006 — Implementation Language Stays TypeScript/Node; Multi-Language Architecture Deferred

## Context

A move to Go was considered for CLI distribution ergonomics (single static
binary, fast startup) ahead of a longer-term goal of a general multi-language
reachability CLI.

## Decision

Keep the implementation in TypeScript on Node.js for the MVP and near-term
roadmap. Do not design or build a multi-language/plugin architecture now.

## Rationale

- The MVP's differentiator is JS/TS semantic correctness (ESM/CJS, package
  exports/imports, conditional exports, TS path aliases), not binary
  distribution ergonomics.
- ADR-0001 already established that using the real TypeScript compiler API
  in-process is preferred over reimplementing Node/TS resolution semantics.
  A Go core would either reintroduce a Node dependency via a sidecar process
  or require reimplementing that resolution logic — both carry more risk
  than they remove at this stage.
- A speculative multi-language abstraction designed before a second target
  language exists would likely be shaped wrong; the domain boundaries
  already in the SDD (§10) are sufficient to support a future per-language
  backend without redesigning the core now.

## Consequence

- VulnTrace ships as a Node/TypeScript CLI (npm-distributed) for the MVP.
- The Code Intelligence domain boundary remains the seam for a possible
  future per-language analyzer backend (see SDD §3.6).
- Revisit binary-distribution ergonomics (e.g. packaging via `pkg`/Node
  single-executable-application) as a separate, later concern if it becomes
  a real user pain point — not as part of MVP.
