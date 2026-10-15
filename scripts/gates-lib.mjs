/**
 * BL-089 — the pure core of `scripts/gates.mjs`, the local runner for the
 * gate set of `AGENTS.md` § I: which gates exist and in what order, how a
 * suite's vitest arguments are derived from `package.json` (never
 * restated, so the runner cannot drift from `npm run`), the structural
 * check that every test file runs exactly once, the reading of vitest's
 * JSON report, and the comparison of `test:validation` with its
 * documented known failures.
 *
 * Plain ESM, so the runner works under bare `node`; its types live in the
 * matching `.d.mts` file and its suite is `src/testing/gates-lib.test.ts`.
 */

/**
 * The fast gates, run first; the run stops at the first one that fails.
 * Every entry is a gate of `AGENTS.md` § I, run with exactly § I's
 * command.
 */
export const FAST_GATES = [
  { name: "typecheck", argv: ["npm", "run", "typecheck"] },
  { name: "lint", argv: ["npm", "run", "lint"] },
  { name: "format", argv: ["npm", "run", "format"] },
  { name: "scorecard", argv: ["node", "scripts/generate-scorecard.mjs", "--check"] },
  { name: "check-docs", argv: ["node", "scripts/check-docs.mjs"] },
  { name: "build", argv: ["npm", "run", "build"] },
  { name: "validate:history", argv: ["npm", "run", "validate:history"] },
  { name: "validate:metadata", argv: ["npm", "run", "validate:metadata"] },
];

/**
 * The test suites, run one after another, in this order: the foundation
 * gate first (it is the fast deterministic subset), the performance guards
 * alone, the validation suite last (it fails by design, OPEN-DEBTS D-09).
 * `script` is the `package.json` script whose vitest arguments are used.
 */
export const SUITES = [
  { name: "test:foundation", script: "test:foundation" },
  { name: "test", script: "test" },
  { name: "test:performance", script: "test:performance" },
  { name: "test:adversarial", script: "test:adversarial" },
  { name: "test:binding-grammar", script: "test:binding-grammar" },
  { name: "test:oracle", script: "test:oracle" },
  { name: "test:validation", script: "test:validation" },
];

export const DIFFERENTIAL = "differential";

export const ALL_GATE_NAMES = [
  ...FAST_GATES.map((g) => g.name),
  ...SUITES.map((s) => s.name),
  DIFFERENTIAL,
];

/**
 * The vitest arguments of a `package.json` script, which must be a plain
 * `vitest run …` with no shell syntax — anything else is refused rather
 * than approximated, so the runner never runs a suite differently from
 * `npm run`.
 */
export function vitestArgs(scripts, name) {
  const script = scripts[name];
  if (typeof script !== "string") {
    throw new Error(`package.json has no "${name}" script`);
  }
  if (/[;&|<>$`\\"'()*?]/.test(script)) {
    throw new Error(
      `package.json's "${name}" script is not a plain vitest command: ${script}`,
    );
  }
  const words = script.trim().split(/\s+/);
  if (words[0] !== "vitest" || words[1] !== "run") {
    throw new Error(
      `package.json's "${name}" script does not start with "vitest run": ${script}`,
    );
  }
  return words.slice(1);
}

/**
 * Every test file runs exactly once across the suites of one run, and the
 * split of `npm test` loses nothing: the foundation files plus the rest of
 * `npm test` are exactly `npm test`'s own files. `lists` maps each suite
 * name to the files vitest lists for it with the arguments it will run
 * with; `fullTest`, when the split is in effect, is `npm test`'s own list.
 */
export function exactlyOnceProblems(lists, fullTest) {
  const problems = [];
  const seen = new Map();
  for (const [suite, files] of Object.entries(lists)) {
    for (const file of files) {
      const earlier = seen.get(file);
      if (earlier !== undefined) {
        problems.push(`${file} would run twice: in ${earlier} and in ${suite}`);
      } else {
        seen.set(file, suite);
      }
    }
  }
  if (fullTest !== undefined) {
    const split = new Set([
      ...(lists["test:foundation"] ?? []),
      ...(lists["test"] ?? []),
    ]);
    for (const file of fullTest) {
      if (!split.has(file)) {
        problems.push(`${file} is in npm test but in neither half of the split`);
      }
    }
    for (const file of split) {
      if (!fullTest.includes(file)) {
        problems.push(`${file} is in the split but not in npm test`);
      }
    }
  }
  return problems;
}

/** The counts and failures of one vitest JSON report. */
export function readVitestReport(text) {
  const report = JSON.parse(text);
  const failures = [];
  let files = 0;
  let failedFiles = 0;
  for (const file of report.testResults ?? []) {
    files += 1;
    if (file.status === "failed") failedFiles += 1;
    const failedAssertions = (file.assertionResults ?? []).filter(
      (a) => a.status === "failed",
    );
    for (const a of failedAssertions) {
      failures.push({
        file: file.name,
        title: a.title,
        fullName: a.fullName,
        message: String((a.failureMessages ?? [])[0] ?? "").split("\n")[0],
      });
    }
    if (file.status === "failed" && failedAssertions.length === 0) {
      // A file that failed outside any test (an import error, a hook).
      failures.push({
        file: file.name,
        title: "(file)",
        fullName: file.name,
        message: String(file.message ?? "").split("\n")[0],
      });
    }
  }
  return {
    files,
    failedFiles,
    tests: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    success: report.success === true,
    failures,
  };
}

/**
 * `test:validation`'s failures against its documented baseline: the cases
 * `tests/validation/cases/cases.json` marks `knownFailure` (OPEN-DEBTS
 * D-09). The suite names each case's test `<id> <description>`. Matches
 * only when exactly the known failures fail and nothing else does; a known
 * failure that now passes is a deviation too.
 */
export function compareValidation(failures, cases) {
  const ids = new Set(cases.map((c) => c.id));
  const known = cases.filter((c) => c.knownFailure).map((c) => c.id);
  const failedIds = [];
  const unexpected = [];
  const observed = {};
  for (const f of failures) {
    const id = String(f.title).split(" ")[0];
    if (ids.has(id)) {
      failedIds.push(id);
      observed[id] = f.message;
      if (!known.includes(id)) unexpected.push(id);
    } else {
      unexpected.push(f.fullName);
    }
  }
  const nowPassing = known.filter((id) => !failedIds.includes(id));
  return {
    known,
    failedIds,
    unexpected,
    nowPassing,
    observed,
    matches: unexpected.length === 0 && nowPassing.length === 0,
  };
}

/** A fixed-width text table. */
export function table(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) =>
    cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join(
    "\n",
  );
}
