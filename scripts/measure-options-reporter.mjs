/**
 * Task BL-120 — the vitest reporter `measure-options.mjs` runs the oracle
 * suite with.
 *
 * WHY NOT VITEST'S OWN JSON REPORTER. An open-soundness-defect record is
 * asserted as `expect(openSoundnessDefectProblems(…)).toEqual([])`. When
 * it fails, vitest's message is only `expected [ Array(1) ] to deeply
 * equal []`: the JSON reporter keeps the message and the stack, and drops
 * the problem's text, which is what tells a record that flipped ("is now
 * ADMISSIBLE") from one that drifted or a control that was lost. Measured
 * on BL-111's `B.patch` (task BL-120's account). The error object vitest
 * hands a reporter still has the asserted value (`actual`) and the
 * `diff`; this reporter keeps them.
 *
 * It writes, to the file named by `VT_MEASURE_OPTIONS_REPORT`, the subset
 * of the JSON reporter's shape `measure-options-lib.mjs`'s
 * `oracleOutcomes` reads: `testResults[]` with `name`, `status`, `message`
 * and `assertionResults[]` (`fullName`, the ancestor titles and the title
 * joined by spaces as the JSON reporter joins them, `status`,
 * `failureMessages`), where each failure message is the error's message,
 * then its `actual`, then its `diff`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const STATUS = { pass: "passed", fail: "failed", skip: "skipped", todo: "todo" };

/** An error's message, asserted value and diff; a value not serialized yet is. */
export function errorText(error) {
  const text = (part) => {
    if (typeof part === "string") return part;
    if (part === undefined) return "";
    try {
      return JSON.stringify(part) ?? "";
    } catch {
      return String(part);
    }
  };
  return [error.message, error.actual, error.diff]
    .map(text)
    .filter((part) => part !== "")
    .join("\n");
}

function collect(task, titles, out) {
  if (task.type === "suite") {
    for (const child of task.tasks ?? []) collect(child, [...titles, task.name], out);
    return;
  }
  out.push({
    fullName: [...titles, task.name].join(" "),
    status: STATUS[task.result?.state ?? task.mode] ?? "pending",
    failureMessages: (task.result?.errors ?? []).map(errorText),
  });
}

export default class MeasureOptionsReporter {
  onFinished(files = []) {
    const target = process.env.VT_MEASURE_OPTIONS_REPORT;
    if (!target) {
      throw new Error("VT_MEASURE_OPTIONS_REPORT names no file");
    }
    const testResults = files.map((file) => {
      const assertionResults = [];
      for (const task of file.tasks ?? []) collect(task, [], assertionResults);
      return {
        name: file.filepath,
        status: file.result?.state === "fail" ? "failed" : "passed",
        message: (file.result?.errors ?? []).map(errorText).join("\n"),
        assertionResults,
      };
    });
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ testResults }) + "\n");
  }
}
