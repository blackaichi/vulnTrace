# VulnTrace MVP Implementation Plan

## Strategy

Implement a narrow vertical slice first, then expand language semantics.

Order:

1. foundation;
2. dependency intelligence;
3. vulnerability intelligence;
4. vulnerability rules;
5. code model;
6. resolution;
7. graph;
8. verdict;
9. CLI;
10. end-to-end;
11. hardening.

## Milestones

### M1 — Foundation
Tasks 001-004

### M2 — Dependency/Vulnerability
Tasks 005-012

### M3 — Code Intelligence
Tasks 013-018

### M4 — Analysis
Tasks 019-021

### M5 — Product Surface
Tasks 022-026

### M6 — Hardening
Tasks 027-030

## Critical path

```text
001 -> 003 -> 005 -> 006 -> 007 -> 009 -> 010 -> 011
                         |
                         v
012 -> 013 -> 014 -> 015 -> 016 -> 017 -> 018
                                      |
                                      v
019 -> 020 -> 021 -> 022 -> 023 -> 025
```

## Coding-agent rules

- One task at a time.
- Do not create framework integrations before the core graph works.
- Do not add a second vulnerability provider before the provider boundary is stable.
- Do not implement automatic CVE-to-symbol inference during MVP.
- Every fixture should isolate one semantic behavior.
