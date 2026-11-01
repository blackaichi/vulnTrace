/** Types for `commit-subject-policy.mjs` (task BL-120), for its test. */

export const SUBJECT_LIMIT: number;
export const COMMIT_TYPES: readonly string[];
export const TASK_FILE_SCOPE: string;

export interface ParsedSubject {
  readonly type: string;
  readonly scope: string;
  readonly summary: string;
}

export function parseSubject(subject: string): ParsedSubject | undefined;

export function subjectProblems(
  subject: string,
  taskId?: string,
): readonly string[];

export interface SubjectViolation {
  readonly index: number;
  readonly subject: string;
  readonly problems: readonly string[];
}

export function branchSubjectProblems(
  subjects: readonly string[],
  options?: { readonly taskId?: string },
): { readonly taskId: string | undefined; readonly violations: readonly SubjectViolation[] };
