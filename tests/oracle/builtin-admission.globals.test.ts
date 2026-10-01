import {
  POSITION_GROUPS,
  registerAdmittedPositionTests,
  yieldBeforeEachTest,
} from "./builtin-admission.positions.js";

/**
 * Task A-3a: the mechanical admission of every admitted position of an
 * AMBIENT builtin (`global:` keys). The rule and the table checks are in
 * `builtin-admission.test.ts`; split from it only to keep each vitest
 * file short (backlog BL-033).
 */
yieldBeforeEachTest();
registerAdmittedPositionTests(POSITION_GROUPS.globals);
