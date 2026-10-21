# BL-094 — the option prototypes' measurements

Raw results behind ADR 0008's "Proposed decision — BL-094", taken with `measure.sh` on the base `842e808` (Node v22.11.0). Generated from the runs' own outputs; not hand-edited.

## Clean-node precision (`scripts/bl081-builtin-store-escape-corpus.mjs`)

| option | corpus | nodes | clean on base | lost | gained | unknown edges base → head | possible edges base → head | seconds |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| o2a0-no-derived-class | JavaScript | 113778 | 29748 | 0 | 0 | 662639 → 662639 | 84690 → 84758 | 2748 |
| o2a0-no-derived-class | TypeScript | 6568 | 1180 | 0 | 0 | 28956 → 28957 | 4644 → 4677 | 109 |
| o2e-hybrid | JavaScript | not run to completion: equal by construction to o2a0-no-derived-class | | | | | | |
| o2e-hybrid | TypeScript | 6568 | 1180 | 10 | 0 | 28956 → 29014 | 4644 → 4693 | 109 |
| o2a-no-class | JavaScript | 113778 | 29748 | 206 | 0 | 662639 → 666062 | 84690 → 84804 | 3986 |
| o2a-no-class | TypeScript | 6568 | 1180 | 10 | 0 | 28956 → 29056 | 4644 → 4678 | 204 |
| o2b-no-class-no-emit-object | JavaScript | not run to completion: equal by construction to o2a-no-class | | | | | | |
| o2b-no-class-no-emit-object | TypeScript | 6568 | 1180 | 10 | 0 | 28956 → 29056 | 4644 → 4693 | 109 |
| o2c-literal-core | JavaScript | 113778 | 29748 | 207 | 0 | 662639 → 666062 | 84690 → 85073 | 2695 |
| o2c-literal-core | TypeScript | 6568 | 1180 | 10 | 0 | 28956 → 29056 | 4644 → 4693 | 108 |
| o2d-no-proof | JavaScript | 113778 | 29748 | 677 | 0 | 662639 → 698852 | 84690 → 94844 | 2632 |
| o2d-no-proof | TypeScript | 6568 | 1180 | 25 | 0 | 28956 → 29280 | 4644 → 4782 | 107 |

## Differentials over the 139 corpus cases (`scripts/differential.mjs --base 842e808`)

### o2a0-no-derived-class

| Differential | Result |
| --- | --- |
| graph | 0 of 139 measured cases changed: nodes +0/−0; call sites +0/−0, 0 re-resolved (0 withdrawn to unknown, 0 withdrawn to possible, 0 unknown to possible, 0 unknown to resolved, 0 possible to resolved, 0 retargeted); truncation changed in 0. **Unavailable: 0 cases** |
| proof | 0 findings with a changed proof (0 with the verdict unchanged), over 139 measured cases |
| verdict | 0 changed (**0 into NOT_AFFECTED**); 0 added (0 NOT_AFFECTED); **0 removed**; unreported candidates +0/−0; over 139 measured cases |
| suite view | 0 cases whose selected verdict moved |
| not measured | 0 cases unmeasured on a side; 0 cases present on one side only |

### o2e-hybrid

| Differential | Result |
| --- | --- |
| graph | 0 of 139 measured cases changed: nodes +0/−0; call sites +0/−0, 0 re-resolved (0 withdrawn to unknown, 0 withdrawn to possible, 0 unknown to possible, 0 unknown to resolved, 0 possible to resolved, 0 retargeted); truncation changed in 0. **Unavailable: 0 cases** |
| proof | 0 findings with a changed proof (0 with the verdict unchanged), over 139 measured cases |
| verdict | 0 changed (**0 into NOT_AFFECTED**); 0 added (0 NOT_AFFECTED); **0 removed**; unreported candidates +0/−0; over 139 measured cases |
| suite view | 0 cases whose selected verdict moved |
| not measured | 0 cases unmeasured on a side; 0 cases present on one side only |

### o2a-no-class

| Differential | Result |
| --- | --- |
| graph | 2 of 139 measured cases changed: nodes +0/−0; call sites +56/−0, 0 re-resolved (0 withdrawn to unknown, 0 withdrawn to possible, 0 unknown to possible, 0 unknown to resolved, 0 possible to resolved, 0 retargeted); truncation changed in 0. **Unavailable: 0 cases** |
| proof | 0 findings with a changed proof (0 with the verdict unchanged), over 139 measured cases |
| verdict | 0 changed (**0 into NOT_AFFECTED**); 0 added (0 NOT_AFFECTED); **0 removed**; unreported candidates +0/−0; over 139 measured cases |
| suite view | 0 cases whose selected verdict moved |
| not measured | 0 cases unmeasured on a side; 0 cases present on one side only |

- graph: validation/RWB-09a: nodes +0/−0, sites +28/−0, re-resolved 0
- graph: validation/RWB-09b: nodes +0/−0, sites +28/−0, re-resolved 0

### o2b-no-class-no-emit-object

| Differential | Result |
| --- | --- |
| graph | 2 of 139 measured cases changed: nodes +0/−0; call sites +56/−0, 0 re-resolved (0 withdrawn to unknown, 0 withdrawn to possible, 0 unknown to possible, 0 unknown to resolved, 0 possible to resolved, 0 retargeted); truncation changed in 0. **Unavailable: 0 cases** |
| proof | 0 findings with a changed proof (0 with the verdict unchanged), over 139 measured cases |
| verdict | 0 changed (**0 into NOT_AFFECTED**); 0 added (0 NOT_AFFECTED); **0 removed**; unreported candidates +0/−0; over 139 measured cases |
| suite view | 0 cases whose selected verdict moved |
| not measured | 0 cases unmeasured on a side; 0 cases present on one side only |

- graph: validation/RWB-09a: nodes +0/−0, sites +28/−0, re-resolved 0
- graph: validation/RWB-09b: nodes +0/−0, sites +28/−0, re-resolved 0

### o2c-literal-core

| Differential | Result |
| --- | --- |
| graph | 2 of 139 measured cases changed: nodes +0/−0; call sites +98/−0, 0 re-resolved (0 withdrawn to unknown, 0 withdrawn to possible, 0 unknown to possible, 0 unknown to resolved, 0 possible to resolved, 0 retargeted); truncation changed in 0. **Unavailable: 0 cases** |
| proof | 0 findings with a changed proof (0 with the verdict unchanged), over 139 measured cases |
| verdict | 0 changed (**0 into NOT_AFFECTED**); 0 added (0 NOT_AFFECTED); **0 removed**; unreported candidates +0/−0; over 139 measured cases |
| suite view | 0 cases whose selected verdict moved |
| not measured | 0 cases unmeasured on a side; 0 cases present on one side only |

- graph: validation/RWB-09a: nodes +0/−0, sites +49/−0, re-resolved 0
- graph: validation/RWB-09b: nodes +0/−0, sites +49/−0, re-resolved 0

### o2d-no-proof

| Differential | Result |
| --- | --- |
| graph | 69 of 139 measured cases changed: nodes +0/−0; call sites +593/−0, 0 re-resolved (0 withdrawn to unknown, 0 withdrawn to possible, 0 unknown to possible, 0 unknown to resolved, 0 possible to resolved, 0 retargeted); truncation changed in 0. **Unavailable: 0 cases** |
| proof | 25 findings with a changed proof (24 with the verdict unchanged), over 139 measured cases |
| verdict | 1 changed (**0 into NOT_AFFECTED**); 0 added (0 NOT_AFFECTED); **0 removed**; unreported candidates +0/−0; over 139 measured cases |
| suite view | 1 cases whose selected verdict moved |
| not measured | 0 cases unmeasured on a side; 0 cases present on one side only |

- validation/RWB-07 `GHSA-qqgx-2p2h-9c37 @ node_modules/ini`: NOT_AFFECTED → UNKNOWN

- graph: adversarial-v1/ADV-002: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: adversarial-v1/ADV-006: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: adversarial-v1/ADV-007: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: adversarial-v1/ADV-015: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: adversarial-v1/ADV-027: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: adversarial-v2/ADV2-002: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: adversarial-v2/ADV2-006: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: adversarial-v2/ADV2-008: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: adversarial-v2/ADV2-026: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: adversarial-v2/ADV2-028: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: adversarial-v2/ADV2-043: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: adversarial-v2/ADV2-046: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-047: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-048: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-049: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-050: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-051: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-052: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-053: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-054: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-055: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: adversarial-v2/ADV2-056: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-057: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-058: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-059: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-060: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-061: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-062: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-063: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-064: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-065: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-066: nodes +0/−0, sites +3/−0, re-resolved 0
- graph: adversarial-v2/ADV2-067: nodes +0/−0, sites +6/−0, re-resolved 0
- graph: adversarial-v2/ADV2-068: nodes +0/−0, sites +5/−0, re-resolved 0
- graph: adversarial-v2/ADV2-069: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-070: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-071: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-072: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-073: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-074: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-075: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-076: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-077: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-078: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-079: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-080: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-081: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-082: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-083: nodes +0/−0, sites +8/−0, re-resolved 0
- graph: adversarial-v2/ADV2-084: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-085: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-086: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-087: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: adversarial-v2/ADV2-088: nodes +0/−0, sites +5/−0, re-resolved 0
- graph: validation/RWB-01: nodes +0/−0, sites +4/−0, re-resolved 0
- graph: validation/RWB-02: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: validation/RWB-03: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: validation/RWB-04: nodes +0/−0, sites +9/−0, re-resolved 0
- graph: validation/RWB-05: nodes +0/−0, sites +49/−0, re-resolved 0
- graph: validation/RWB-06: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: validation/RWB-06A: nodes +0/−0, sites +1/−0, re-resolved 0
- graph: validation/RWB-07: nodes +0/−0, sites +7/−0, re-resolved 0
- graph: validation/RWB-08: nodes +0/−0, sites +17/−0, re-resolved 0
- graph: validation/RWB-09a: nodes +0/−0, sites +150/−0, re-resolved 0
- graph: validation/RWB-09b: nodes +0/−0, sites +150/−0, re-resolved 0
- graph: validation/RWB-10: nodes +0/−0, sites +2/−0, re-resolved 0
- graph: validation/RWB-11a: nodes +0/−0, sites +11/−0, re-resolved 0
- graph: validation/RWB-11b: nodes +0/−0, sites +11/−0, re-resolved 0
- graph: validation/VAL-001: nodes +0/−0, sites +4/−0, re-resolved 0

## Real-Node oracle suite (`vitest.oracle.config.ts`, 1,304 tests; the base passes all)

Every failure is listed. `control → UNKNOWN`: a case whose expected verdict is precise answered `UNKNOWN`; `negative control → UNKNOWN`: the case's own negative control did. No option produced a `NOT_AFFECTED` the base does not.

### o2a0-no-derived-class: 4 failed

| file | case | kind |
| --- | --- | --- |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |

### o2e-hybrid: 22 failed

| file | case | kind |
| --- | --- | --- |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | negative control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl099-namespace-export-member-read.test.ts | `RWF-141:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |

### o2a-no-class: 23 failed

| file | case | kind |
| --- | --- | --- |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-124:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |

### o2b-no-class-no-emit-object: 26 failed

| file | case | kind |
| --- | --- | --- |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-124:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | negative control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl099-namespace-export-member-read.test.ts | `RWF-141:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |

### o2c-literal-core: 29 failed

| file | case | kind |
| --- | --- | --- |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl081-builtin-replaced-without-name.test.ts | `control:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-124:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-126:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-127:` | control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | negative control → UNKNOWN |
| bl091-builtin-store-reaudit.test.ts | `RWF-128:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-131:` | negative control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl095-typescript-emit-stores.test.ts | `RWF-132:` | control → UNKNOWN |
| bl099-namespace-export-member-read.test.ts | `RWF-141:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | negative control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| bl100-decorator-helper-calls.test.ts | `RWF-142:` | control → UNKNOWN |
| e2-forwarding-write-set.test.ts | `control:` | control → UNKNOWN |

### o2d-no-proof: 876 failed

Not listed one by one (the upper bound): 779 negative control → UNKNOWN, 90 control → UNKNOWN, 7 other. The "other" ones are RWF-144's six open-soundness-defect records (the change closes them as a side effect, so each record reports it) and one harness self-test that relies on a precise verdict.

| file | case | kind |
| --- | --- | --- |
| bl097-wrapper-arguments-frame.test.ts | ``g["call"` | other: AssertionError: expected [ Array(1) ] to deeply equal [] |
| bl097-wrapper-arguments-frame.test.ts | ``Reflect.get(g,` | other: AssertionError: expected [ Array(1) ] to deeply equal [] |
| bl097-wrapper-arguments-frame.test.ts | ```g[`${a}er`]``` | other: AssertionError: expected [ Array(1) ] to deeply equal [] |
| bl097-wrapper-arguments-frame.test.ts | `a` | other: AssertionError: expected [ Array(1) ] to deeply equal [] |
| bl097-wrapper-arguments-frame.test.ts | `a` | other: AssertionError: expected [ Array(1) ] to deeply equal [] |
| bl097-wrapper-arguments-frame.test.ts | `a` | other: AssertionError: expected [ Array(1) ] to deeply equal [] |
| case-runner.test.ts | `fails` | other: AssertionError: expected [Function] to throw error matching /ground truth contradicts expected ver…/ but got 'self-test: expected verdict NOT_AFFEC…' |
