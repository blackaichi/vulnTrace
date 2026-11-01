/**
 * Task BL-119 — the size limits two records keep, so neither grows back
 * into what that task cut down. Checked by
 * `src/testing/records-limits.test.ts`.
 *
 * - `NOTE_LIMIT`: a `Notes` cell of `docs/tasks/BACKLOG.md`'s § 1 and § 3,
 *   in characters. A longer note goes into the task's file, under
 *   `## Backlog note`, and the cell links it (`docs/tasks/README.md`,
 *   "Naming"). BACKLOG.md owns order and status; a note is not either.
 * - `PROGRESS_MAX_LINES`: `docs/progress.md`, in lines. WORKFLOW § 6
 *   asks for one screen.
 */

export const NOTE_LIMIT = 300;
export const PROGRESS_MAX_LINES = 60;
