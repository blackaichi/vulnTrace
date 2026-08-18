# VulnTrace v0.2 — Remediation Task Pack

## Goal

Move from the adversarial baseline (23/34 passing) to a sound MVP baseline.

**Status: VT-201..VT-217 complete** (one commit each, `git log --oneline`). Original adversarial suite: 23/34 -> 34/34 (100%), AFFECTED/NOT_AFFECTED/UNKNOWN accuracy each 100%. **Independent v2 adversarial suite: 45/45 (100%).**

**Fully re-closed:** the independent v2 adversarial suite (`tests/adversarial-v2/`, 45 scenarios, authored after VT-211 to test generalization) found 11 new failures. One (ADV2-045) was a correctness regression, not a precision limitation -- see VT-212, SDD-v0.2.md § 4.3. The other 10 were precision limitations (the analyzer correctly and safely returning UNKNOWN rather than something false) -- a full root-cause analysis grouped them into 5 architectural capabilities (see conversation history / commit history for the analysis). VT-212 fixed the correctness bug (34/45 -> 35/45). VT-213 implemented inline callback-argument invocation (35/45 -> 37/45; ADV2-018, ADV2-024). VT-214 implemented local reference aliasing (37/45 -> 40/45; ADV2-036, ADV2-037, ADV2-038). VT-215 implemented implicit-constructor resolution (40/45 -> 42/45; ADV2-041, plus ADV2-021 as a legitimate side effect -- see below). VT-216 implemented inherited-method resolution (42/45 -> 43/45; ADV2-022). VT-217 implemented constant computed-key evaluation (43/45 -> 45/45; ADV2-028, ADV2-042) -- the v2 suite's last two failures, closing it out at 100%.

**VT-215's safety fix and its side effect:** implementing VT-215 exposed a real, pre-existing bug -- `bindCallee` (symbol-binder.ts) ignores a named import's own trailing property chain, so once a bare class name started resolving successfully far more often (VT-215's synthetic constructor), `ClassName.member()` calls began silently misattributing to `ClassName`'s own edge-less constructor instead of staying honestly unresolved. Caught via the v2 suite (ADV2-021 flipped to a confidently WRONG NOT_AFFECTED, not just a missed AFFECTED) before this task was considered done. Fixed with a narrow guard (`resolvesToUnrelatedConstructor`) in the same commit -- not a VT-216 implementation, but removing this guard's blocking bug let VT-208's already-shipped `resolveInstanceMethod` run where it previously never got the chance, which happened to also resolve ADV2-021 correctly. ADV2-022 (which needs VT-216's separate inherited-member lookup fix) correctly still fails, confirming this wasn't an accidental full VT-216 implementation.

## Tasks

- [x] VT-201 Graph completeness invariant
- [x] VT-202 UNKNOWN-safe verdict
- [x] VT-203 ResolvedTarget / module identity
- [x] VT-204 Reuse graph resolution
- [x] VT-205 Entrypoint semantics
- [x] VT-206 TypeScript path aliases
- [x] VT-207 Constructor resolution
- [x] VT-208 Instance method resolution
- [x] VT-209 Re-export chains
- [x] VT-210 Lightweight higher-order value flow
- [x] VT-211 Static branch folding (post-MVP)
- [x] VT-212 PackageInstance selection authority in verdict resolution (P0;
      SDD-v0.2.md § 4.3; fixes ADV2-045)
- [x] VT-213 Inline callback-argument invocation (P1; fixes ADV2-018,
      ADV2-024)
- [x] VT-214 Local reference aliasing (variable/property/destructuring)
      (P1; fixes ADV2-036, ADV2-037, ADV2-038)
- [x] VT-215 Implicit (default) constructor resolution (P1; fixes
      ADV2-041, and ADV2-021 as a side effect of its required safety
      guard -- see note above)
- [x] VT-216 Inherited method resolution (P1; fixes ADV2-022; switched
      resolveInstanceMethod from a raw classDecl.members scan to
      checker.getPropertyOfType, which resolves both inherited and
      static members via the checker's own apparent-type resolution)
- [x] VT-217 Constant computed-key evaluation (P2; fixes ADV2-028,
      ADV2-042; closes the v2 adversarial suite at 45/45, 100%)

## Execution rule

Implement one task at a time.

After each task:
1. run unit tests;
2. run adversarial tests;
3. inspect the diff;
4. verify acceptance criteria;
5. do not start the next task until the current task passes.

Never weaken an adversarial oracle to make the suite pass.
Never convert UNKNOWN into NOT_AFFECTED to improve the score.
