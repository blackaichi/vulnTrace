import { TASK_CASES } from "./a3a-escaped-values.cases.js";
import { registerA3aCases } from "./a3a-escaped-values.register.js";

/**
 * Task A-3a (docs/tasks/A-3a-escaped-values.md): escaped function values,
 * the documented invoking builtins, the assignment form of the escape row,
 * RWF-060's forwarded arguments and `Reflect.construct`, each against real
 * Node. On the base commit every case whose target real Node calls was a
 * false `NOT_AFFECTED` (measured by this task before its fix; see the task
 * file); nothing here pins that result. The cases the independent audit
 * added are in `a3a-escaped-values.audit.test.ts`; how each is asserted is
 * `a3a-escaped-values.register.ts`.
 */
registerA3aCases(TASK_CASES);
