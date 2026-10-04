import { AUDIT_CASES } from "./a3a-escaped-values.cases.js";
import { registerA3aCases } from "./a3a-escaped-values.register.js";

/**
 * Task A-3a: the programs its independent audit broke earlier versions of
 * the change with, over three rounds, each against real Node. Each failed
 * on the commit it was found on, or was an open-soundness-defect record
 * (PRM-13, flipped by task A-5a). Split from `a3a-escaped-values.test.ts` only to keep each
 * vitest file short (backlog BL-033).
 */
registerA3aCases(AUDIT_CASES);
