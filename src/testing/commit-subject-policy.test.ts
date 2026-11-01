/**
 * `scripts/commit-subject-policy.mjs` (task BL-120): AGENTS.md § H's
 * subject rule, at most 72 characters, `<type>(<task ID>): <summary>`,
 * for the commits a branch adds.
 */

import { describe, expect, it } from "vitest";

import {
  branchSubjectProblems,
  COMMIT_TYPES,
  parseSubject,
  SUBJECT_LIMIT,
  subjectProblems,
} from "../../scripts/commit-subject-policy.mjs";

/** BL-119's branch, as merged (PR #125). */
const BL_119 = [
  "docs(tasks): BL-119 task file — records restructure",
  "docs(BL-119): findings register, one file per record; next-id",
  "docs(BL-119): BACKLOG notes over 300 characters into task files",
  "docs(BL-119): OPEN-DEBTS D-17 summarized; full record in its own file",
  "docs(BL-119): progress.md on one screen; records",
];

describe("commit-subject-policy", () => {
  it("accepts a merged branch's subjects and infers its task", () => {
    expect(branchSubjectProblems(BL_119)).toEqual({
      taskId: "BL-119",
      violations: [],
    });
  });

  it("counts code points, not bytes: 72 with an em dash passes, 73 fails", () => {
    // The longest subject since the rule was made, 71 characters.
    const longest =
      "test(BL-117): spread builtin-admission's ambient positions over 4 files";
    expect([...longest].length).toBe(71);
    expect(subjectProblems(longest, "BL-117")).toEqual([]);
    // 72 code points, 74 bytes in UTF-8.
    const at =
      "docs(BL-116): workflow — two audit rounds, say it once, short templates!";
    expect([...at].length).toBe(SUBJECT_LIMIT);
    expect(Buffer.byteLength(at)).toBe(74);
    expect(subjectProblems(at, "BL-116")).toEqual([]);
    expect(subjectProblems(`${at}s`, "BL-116")).toEqual([
      "73 characters, over the limit of 72",
    ]);
  });

  it("rejects a subject without the shape, and says only that", () => {
    for (const subject of [
      "BL-120: no type",
      "docs: no scope",
      "docs(BL-120):no space",
      "docs(BL-120): ",
      "docs(BL-120):  two spaces",
      "docs(BL-120): trailing space ",
      "docs (BL-120): space before the scope",
      "docs(BL 120): space in the scope",
    ]) {
      expect(parseSubject(subject), subject).toBeUndefined();
      expect(subjectProblems(subject, "BL-120"), subject).toEqual([
        "not of the shape `<type>(<task ID>): <summary>`",
      ]);
    }
  });

  it("accepts exactly the types history uses", () => {
    for (const type of COMMIT_TYPES) {
      expect(subjectProblems(`${type}(BL-120): a change`, "BL-120")).toEqual(
        [],
      );
    }
    expect(subjectProblems("feature(BL-120): a change", "BL-120")).toEqual([
      `type \`feature\` is not one of ${COMMIT_TYPES.join(", ")}`,
    ]);
  });

  it("holds every commit to the branch's one task", () => {
    expect(
      branchSubjectProblems([
        "docs(tasks): BL-120 task file — agent tooling",
        "build(BL-120): a check",
        "fix(BL-121): another task's change",
      ]).violations,
    ).toEqual([
      {
        index: 2,
        subject: "fix(BL-121): another task's change",
        problems: ["scope `BL-121` is not this branch's task, `BL-120`"],
      },
    ]);
  });

  it("requires a task file commit to name the task first", () => {
    expect(
      branchSubjectProblems([
        "docs(tasks): task file — BL-120",
        "build(BL-120): a check",
      ]).violations[0]?.problems,
    ).toEqual([
      "a `(tasks)` commit's summary starts with the task ID, `BL-120`",
    ]);
    // `BL-1200` is not `BL-120`.
    expect(
      subjectProblems("docs(tasks): BL-1200 task file", "BL-120"),
    ).toHaveLength(1);
  });

  it("infers the task from a task file commit when it is the only one", () => {
    expect(
      branchSubjectProblems(["docs(tasks): BL-120 task file — agent tooling"]),
    ).toEqual({ taskId: "BL-120", violations: [] });
  });

  it("a given task wins over the inferred one", () => {
    const result = branchSubjectProblems(["build(BL-121): a check"], {
      taskId: "BL-120",
    });
    expect(result.taskId).toBe("BL-120");
    expect(result.violations).toHaveLength(1);
  });

  it("reports every problem of one subject, and an empty branch has none", () => {
    const long = `feature(BL-121): ${"x".repeat(60)}`;
    expect(subjectProblems(long, "BL-120")).toHaveLength(3);
    expect(branchSubjectProblems([])).toEqual({
      taskId: undefined,
      violations: [],
    });
  });
});
