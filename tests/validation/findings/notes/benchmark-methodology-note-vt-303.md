## Benchmark methodology note — VT-303 cause-splitting

The independent audit (`docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md` § 9.2)
identified `RWB-06` and `RWB-09` as **cause-confounded**: each mixes an
intended thesis with one or more unrelated, independent mechanisms, so a
single pass/fail result can't tell an observer which one actually changed.
VT-303 added clean, single-cause siblings for both, **without modifying
either original fixture or its oracle**:

| Original (unchanged) | Confounds | New sibling | Isolates |
|---|---|---|---|
| `RWB-06` (UNREACHED_DEPENDENCY thesis) | UNREACHED_DEPENDENCY **+** an incidental `token.trim()` `unsupported_construct` (RWF-002) that drives the actual UNKNOWN result | `RWB-06A` | UNREACHED_DEPENDENCY alone — zero other unresolved/dynamic constructs anywhere in the reachable subgraph (verified: 2 graph nodes, 0 edges) |
| `RWB-09` (MULTI_INSTANCE thesis) | npm-alias identity (RWF-009) **+** cross-file re-export resolution (RWF-004) **+** (pre-VT-302) non-hermetic resolution (RWF-010, since fixed) **+** the NO_FINDING oracle-design limitation on the patched instance (RWB-09b, above) | `RWB-11a`/`RWB-11b` | package-instance discrimination alone — two real, unaliased, differently-versioned `url-parse` installs (one nested under a fixture-authored wrapper, one top-level), using the same whole-module-default-export target shape `RWB-04` already proves resolves cleanly, so export attribution can't be a second variable either |

Both original cases are kept exactly as they were — `RWB-06` remains the
RWF-002 exhibit (its blast-radius demonstration is the point: an entirely
unrelated built-in-method call, nothing to do with `node-forge`, is
sufficient to suppress the correct verdict), and `RWB-09` remains the
dedicated **ALIASED_INSTALL** stress case (reclassified here from its
original bare "MULTI_INSTANCE" label, now that a genuine, non-aliased
multi-instance case exists separately to compare against). Neither RWF-002,
RWF-004, RWF-009, nor RWF-010 is fixed by this task — see each finding's
own entry.

All four new cases (`RWB-06A`, `RWB-11a`, `RWB-11b`) currently **pass**,
each independently confirmed via direct call-graph/target-resolution
inspection (not verdict-only): `RWB-06A` — 0 graph edges, `node-forge`
never discovered; `RWB-11a` — a clean 3-hop evidence path to the `Url`
constructor, `packageId.name` correctly `"url-parse"` (no identity
mismatch); `RWB-11b` — the top-level instance is never discovered by the
call graph, and the 44 unrelated `unsupported_construct` edges elsewhere
in `url-parse`'s own internals (real, non-trivial production code) are
all non-closure-widening, so VT-300's guard correctly does not treat them
as a reason to doubt the `NOT_AFFECTED` conclusion.

