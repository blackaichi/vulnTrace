/**
 * Task BL-120 — THE COMMIT SUBJECT POLICY (AGENTS.md § H, task BL-116).
 *
 * A pure function over the subjects a branch adds, separated from the git
 * walk in `check-commit-subjects.mjs` so it can be unit-tested without a
 * repository (`src/testing/commit-subject-policy.test.ts`), as
 * `commit-metadata-policy.mjs` is.
 *
 * THE RULE, AS AGENTS.md § H STATES IT: a subject is at most 72 characters,
 * `<type>(<task ID>): <summary>`. Two facts of practice, measured on every
 * commit since the rule was made (BL-116's first commit, `de8af14`, to
 * BL-119's last, `d54511e`; all 18 comply):
 *
 * - the task file's commit, the first on a branch, is scoped `tasks` and
 *   its summary starts with the task's ID
 *   (`docs(tasks): BL-119 task file — records restructure`);
 * - the types in use are the ten of {@link COMMIT_TYPES}.
 *
 * "Characters" are counted as Unicode code points, so an em dash counts
 * one, as an editor and GitHub show it.
 *
 * One task per branch (AGENTS.md § H): every subject not scoped `tasks`
 * carries the same task ID. When the ID is not given, it is the scope the
 * first such subject carries (or, when there is none, the first word of a
 * `tasks` commit's summary), and a subject that differs is reported.
 *
 * WHAT IT DOES NOT CHECK: earlier history, which is not rewritten (§ H);
 * merge commits, which `check-commit-subjects.mjs` never passes in; the
 * body, which `commit-metadata-policy.mjs` checks for metadata.
 */

/** AGENTS.md § H's limit, in code points. */
export const SUBJECT_LIMIT = 72;

/** The conventional types this repository's history uses. */
export const COMMIT_TYPES = Object.freeze([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "style",
  "test",
]);

/** The scope of a task file's commit. */
export const TASK_FILE_SCOPE = "tasks";

const SHAPE = /^([a-z]+)\(([^()\s]+)\): (\S(?:.*\S)?)$/u;

/**
 * Parses one subject. `undefined` when it does not have the shape
 * `<type>(<scope>): <summary>` (one space after the colon, no leading or
 * trailing white space).
 */
export function parseSubject(subject) {
  const match = SHAPE.exec(subject);
  if (match === null) return undefined;
  return { type: match[1], scope: match[2], summary: match[3] };
}

/** The problems of one subject; `taskId`, when known, is the branch's task. */
export function subjectProblems(subject, taskId) {
  const problems = [];
  const length = [...subject].length;
  if (length > SUBJECT_LIMIT) {
    problems.push(`${length} characters, over the limit of ${SUBJECT_LIMIT}`);
  }
  const parsed = parseSubject(subject);
  if (parsed === undefined) {
    problems.push("not of the shape `<type>(<task ID>): <summary>`");
    return problems;
  }
  if (!COMMIT_TYPES.includes(parsed.type)) {
    problems.push(
      `type \`${parsed.type}\` is not one of ${COMMIT_TYPES.join(", ")}`,
    );
  }
  if (taskId !== undefined) {
    if (parsed.scope === TASK_FILE_SCOPE) {
      if (!parsed.summary.startsWith(`${taskId} `)) {
        problems.push(
          `a \`(${TASK_FILE_SCOPE})\` commit's summary starts with the task ID, \`${taskId}\``,
        );
      }
    } else if (parsed.scope !== taskId) {
      problems.push(
        `scope \`${parsed.scope}\` is not this branch's task, \`${taskId}\``,
      );
    }
  }
  return problems;
}

/**
 * The problems of a branch's subjects, oldest first. Returns the task ID
 * the check used (given, or inferred from the first subject not scoped
 * `tasks`) and every subject with a problem.
 */
export function branchSubjectProblems(subjects, options = {}) {
  let taskId = options.taskId;
  if (taskId === undefined) {
    const parsed = subjects.map(parseSubject).filter((p) => p !== undefined);
    taskId =
      parsed.find((p) => p.scope !== TASK_FILE_SCOPE)?.scope ??
      parsed.find((p) => p.scope === TASK_FILE_SCOPE)?.summary.split(" ")[0];
  }
  const violations = [];
  subjects.forEach((subject, index) => {
    const problems = subjectProblems(subject, taskId);
    if (problems.length > 0) violations.push({ index, subject, problems });
  });
  return { taskId, violations };
}
