import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  disposeTempRoots,
  formatObservation,
  observe,
  prepareProject,
  type Observation,
  type PreparedProject,
} from "./harness.js";
import {
  AUTHORITY_MECHANISMS,
  BINDING_FORMS,
  SKIPPED_CELLS,
  cellKey,
  expectationFor,
  formatExpectation,
  refusalRationale,
  type AuthorityMechanism,
  type BindingForm,
  type Expectation,
} from "./matrix.js";
import {
  DISAGREEMENT_GROUPS,
  KNOWN_DISAGREEMENTS,
  type DisagreementGroup,
  type KnownDisagreement,
} from "./disagreements.js";

/**
 * THE BINDING-FORM GRAMMAR SWEEP -- driver.
 *
 * `matrix.ts` holds the grammar and the oracle; this file only runs it.
 * Every assertion below is generated from the cross-product, so adding a
 * binding form or an authority mechanism adds cells without adding a
 * test file -- and, because {@link completeness} asserts the cross-product
 * is fully accounted for, adding one without thinking about the other
 * seven cells FAILS rather than quietly under-covering the grammar.
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const REPORT_PATH = path.join(
  REPO_ROOT,
  "tests",
  "binding-grammar",
  "REPORT.md",
);

interface Cell {
  readonly form: BindingForm;
  readonly mechanism: AuthorityMechanism;
  readonly key: string;
  readonly file: string;
  readonly expectation: Expectation;
  readonly source: string;
  readonly probe: string;
  readonly disagreement: KnownDisagreement | undefined;
}

interface CellResult {
  readonly cell: Cell;
  readonly observed: Observation;
  readonly agrees: boolean;
}

const skipped = new Set(SKIPPED_CELLS.map((s) => cellKey(s.form, s.mechanism)));
const disagreementByKey = new Map(
  KNOWN_DISAGREEMENTS.map((d) => [cellKey(d.form, d.mechanism), d]),
);
const groupById = new Map(DISAGREEMENT_GROUPS.map((g) => [g.id, g]));

/** The family a disagreement belongs to; the invariants prove it exists. */
function groupOf(d: KnownDisagreement): DisagreementGroup | undefined {
  return groupById.get(d.group);
}

function buildCell(form: BindingForm, mechanism: AuthorityMechanism): Cell {
  const emitted = form.emit(mechanism.context);
  const extension = mechanism.esm ? "mjs" : "js";
  const probe = emitted.probe ?? mechanism.probeName;
  const exported = mechanism.esm
    ? `export { ${probe} };`
    : `module.exports = { ${probe} };`;
  const lines = [
    `// cell: ${form.id} x ${mechanism.id}`,
    ...mechanism.prelude,
    ...emitted.lines,
    exported,
  ];
  const file = `cell-${mechanism.id}-${form.id}.${extension}`;
  const expectation = expectationFor(form, mechanism);
  return {
    form,
    mechanism,
    key: cellKey(form.id, mechanism.id),
    file,
    // `<self>` is the matrix's placeholder for "a declaration in this
    // cell's own file". The naming scheme is the driver's business, so
    // the substitution happens here rather than in the oracle.
    expectation:
      expectation.kind === "exact"
        ? { kind: "exact", target: expectation.target.replace("<self>", file) }
        : expectation,
    source: lines.join("\n") + "\n",
    probe,
    disagreement: disagreementByKey.get(cellKey(form.id, mechanism.id)),
  };
}

const CELLS: readonly Cell[] = BINDING_FORMS.flatMap((form) =>
  AUTHORITY_MECHANISMS.filter(
    (mechanism) => !skipped.has(cellKey(form.id, mechanism.id)),
  ).map((mechanism) => buildCell(form, mechanism)),
);

const projects = new Map<string, PreparedProject>();
const results: CellResult[] = [];

beforeAll(() => {
  for (const esm of [false, true]) {
    const files = new Map<string, string>();
    for (const cell of CELLS) {
      if (cell.mechanism.esm === esm) {
        files.set(cell.file, cell.source);
      }
    }
    projects.set(String(esm), prepareProject({ esm }, files));
  }
});

afterAll(() => {
  writeReport();
  disposeTempRoots();
});

/**
 * The observation an expectation corresponds to, so the two are compared
 * as strings in one place and the report prints exactly what was
 * asserted.
 */
function expectationAsObservation(e: Expectation): string {
  return e.kind === "exact" ? `EXACT ${e.target}` : `UNKNOWN ${e.reason}`;
}

describe("binding-form grammar sweep", () => {
  for (const cell of CELLS) {
    const label =
      `${cell.form.id} x ${cell.mechanism.id} -- expects ` +
      formatExpectation(cell.expectation);

    it(label, async () => {
      const project = projects.get(String(cell.mechanism.esm));
      expect(project, "project prepared").toBeDefined();
      const graph = await (project as PreparedProject).graph(cell.file);
      const observed = observe(
        graph,
        (project as PreparedProject).root,
        cell.probe,
      );
      const actual = formatObservation(observed);
      const wanted = expectationAsObservation(cell.expectation);
      results.push({ cell, observed, agrees: actual === wanted });

      const context =
        `\ncell: ${cell.key}\n` +
        `mechanism: ${cell.mechanism.title} (${cell.mechanism.owner})\n` +
        `binding form: ${cell.form.title}\n` +
        `why this expectation: ${
          cell.expectation.kind === "exact"
            ? "JavaScript proves the reference denotes exactly this value"
            : refusalRationale(cell.form, cell.mechanism)
        }\n` +
        `--- source ---\n${cell.source}--------------\n`;

      if (cell.disagreement) {
        // A KNOWN disagreement. The expectation above still states the
        // correct answer; what is asserted here is that the defect has
        // not changed shape. Both directions fail loudly: the analyzer
        // being FIXED fails the first assertion (delete the row), and
        // the analyzer drifting to a third answer fails the second.
        expect(
          actual,
          `${cell.key} is recorded as a known disagreement but now AGREES ` +
            `with the correct expectation. Delete its row from ` +
            `disagreements.ts.${context}`,
        ).not.toBe(wanted);
        expect(
          actual,
          `${cell.key} is a known ` +
            `${groupOf(cell.disagreement)?.class ?? "?"} disagreement ` +
            `(${cell.disagreement.group}) ` +
            `whose observed behaviour has CHANGED.${context}`,
        ).toBe(cell.disagreement.observed);
        return;
      }

      expect(actual, `${cell.key} disagrees with its oracle.${context}`).toBe(
        wanted,
      );
    });
  }
});

// ---------------------------------------------------------------------
// Instrument controls
// ---------------------------------------------------------------------

/**
 * THE CONTROLS THAT MAKE A NEGATIVE RESULT MEAN ANYTHING.
 *
 * The sweep's headline finding is that no cell fabricates. That claim is
 * worthless unless a fabrication WOULD have been visible, and the exact
 * way it becomes invisible is documented: against a package that does
 * not export the name, a fabricated attribution degrades to
 * `unresolved_target` and reads as an honest UNKNOWN. That is how the
 * RWF-046 array hole survived a green suite.
 *
 * So these controls prove, positively, that every spelling the matrix
 * baits with is a REAL export that a fabrication would resolve to, and
 * that the observation format distinguishes two installs of one package.
 * If any control fails, no "no fabrication here" cell in the matrix may
 * be believed.
 */
const CONTROL_FILES = new Map<string, string>();

/** Names a text-authority defect would attribute a call to. */
const BAITED_LOCAL_NAMES = [
  "probeTarget",
  "run",
  "sibling",
  "rest",
  "key",
  "KEY",
] as const;

for (const name of BAITED_LOCAL_NAMES) {
  CONTROL_FILES.set(
    `control-loud-${name}.js`,
    [
      `const { ${name} } = require("pkg");`,
      "function probe() {",
      `  ${name}();`,
      "}",
      "module.exports = { probe };",
      "",
    ].join("\n"),
  );
}

CONTROL_FILES.set(
  "control-loud-numeric.js",
  [
    'const { "1": probeTarget } = require("pkg");',
    "function probe() {",
    "  probeTarget();",
    "}",
    "module.exports = { probe };",
    "",
  ].join("\n"),
);

CONTROL_FILES.set(
  "node_modules/nested/probe.js",
  [
    'const { run } = require("twin");',
    "function probe() {",
    "  run();",
    "}",
    "module.exports = { probe };",
    "",
  ].join("\n"),
);

CONTROL_FILES.set(
  "control-twin-top-level.js",
  [
    'const { run } = require("twin");',
    "function probe() {",
    "  run();",
    "}",
    "module.exports = { probe };",
    "",
  ].join("\n"),
);

let controlProject: PreparedProject;

describe("instrument controls", () => {
  beforeAll(() => {
    controlProject = prepareProject({ esm: false }, CONTROL_FILES);
  });

  for (const name of BAITED_LOCAL_NAMES) {
    it(`\`${name}\` is a real export, so a fabrication of it would be LOUD`, async () => {
      const graph = await controlProject.graph(`control-loud-${name}.js`);
      expect(
        formatObservation(observe(graph, controlProject.root, "probe")),
        `The matrix baits with the local name \`${name}\`. If the fixture ` +
          `does not export it, every cell that binds \`${name}\` and stays ` +
          `UNKNOWN is unfalsifiable: a fabrication would have degraded to ` +
          `unresolved_target and read exactly the same.`,
      ).toBe(`EXACT node_modules/pkg/index.js#${name}`);
    });
  }

  it('the numeric export `"1"` is real, so a positional fabrication is LOUD', async () => {
    const graph = await controlProject.graph("control-loud-numeric.js");
    expect(
      formatObservation(observe(graph, controlProject.root, "probe")),
      "The array and numeric-key rows bait with position rather than " +
        'spelling; `_n1` must be reachable as the export named "1".',
    ).toBe("EXACT node_modules/pkg/index.js#_n1");
  });

  it("two installs of one package are two observations, not one", async () => {
    const nested = await controlProject.graph("node_modules/nested/probe.js");
    const top = await controlProject.graph("control-twin-top-level.js");
    const nestedTarget = formatObservation(
      observe(nested, controlProject.root, "probe"),
    );
    const topTarget = formatObservation(
      observe(top, controlProject.root, "probe"),
    );
    expect(
      nestedTarget,
      "a requirer inside node_modules/nested must reach ITS OWN install",
    ).toBe("EXACT node_modules/nested/node_modules/twin/index.js#run");
    expect(topTarget).toBe("EXACT node_modules/twin/index.js#run");
    expect(
      nestedTarget,
      "if these two collapse, every EXACT cell in the matrix is asserting " +
        "a name rather than an install",
    ).not.toBe(topTarget);
  });
});

// ---------------------------------------------------------------------
// The instrument's own invariants
// ---------------------------------------------------------------------

describe("the sweep's own invariants", () => {
  it("accounts for the FULL cross-product of forms and mechanisms", () => {
    const accounted = new Set<string>([...CELLS.map((c) => c.key), ...skipped]);
    const missing: string[] = [];
    for (const form of BINDING_FORMS) {
      for (const mechanism of AUTHORITY_MECHANISMS) {
        const key = cellKey(form.id, mechanism.id);
        if (!accounted.has(key)) {
          missing.push(key);
        }
      }
    }
    expect(
      missing,
      "every (binding form, authority mechanism) pair must be either swept " +
        "or explicitly skipped with a syntactic-impossibility reason",
    ).toEqual([]);
    expect(accounted.size).toBe(
      BINDING_FORMS.length * AUTHORITY_MECHANISMS.length,
    );
  });

  it("skips a cell only for syntactic impossibility, never for expected success", () => {
    for (const s of SKIPPED_CELLS) {
      expect(s.reason.length, `${s.form} x ${s.mechanism}`).toBeGreaterThan(20);
      expect(
        /impossible|cannot be written|not valid syntax|no such syntax/i.test(
          s.reason,
        ),
        `${s.form} x ${s.mechanism}: a skip reason must state a SYNTACTIC ` +
          `impossibility, not an expectation about the result`,
      ).toBe(true);
    }
  });

  it("no cell asserts a degenerate observation", () => {
    for (const cell of CELLS) {
      expect(["exact", "unknown"]).toContain(cell.expectation.kind);
      if (cell.expectation.kind === "exact") {
        expect(
          cell.expectation.target,
          `${cell.key} must name a module AND a declaration`,
        ).toMatch(/^[^#]+#[^#]+$/);
      }
    }
  });

  it("every known disagreement names a real cell and a real class", () => {
    const keys = new Set(CELLS.map((c) => c.key));
    for (const d of KNOWN_DISAGREEMENTS) {
      expect(keys, `${d.form} x ${d.mechanism}`).toContain(
        cellKey(d.form, d.mechanism),
      );
      const group = groupOf(d);
      expect(
        group,
        `${d.form} x ${d.mechanism}: unknown group ${d.group}`,
      ).toBeDefined();
      expect(["A", "B", "C", "honest-unknown"]).toContain(group?.class);
      expect((group?.why ?? "").length).toBeGreaterThan(80);
      expect(d.observed).toMatch(/^(EXACT [^#]+#.+|UNKNOWN \w+)$/);
    }
    const seen = new Set<string>();
    for (const d of KNOWN_DISAGREEMENTS) {
      const key = cellKey(d.form, d.mechanism);
      expect(seen.has(key), `${key} listed twice`).toBe(false);
      seen.add(key);
    }
  });

  it("every disagreement group is used by at least one cell", () => {
    // An empty group is a finding somebody fixed and forgot to
    // delete, which would leave the report claiming a gap that is
    // closed.
    const used = new Set(KNOWN_DISAGREEMENTS.map((d) => d.group));
    for (const group of DISAGREEMENT_GROUPS) {
      expect(used, `group ${group.id} has no cells`).toContain(group.id);
    }
  });

  it("every cell's fixture exports every name the cell binds (loud-fixture rule)", () => {
    // The rule the RWF-046 array hole hid behind: against a package
    // MISSING the name, a fabrication degrades to `unresolved_target`
    // and reads as an honest UNKNOWN. Every local name a cell binds must
    // therefore be a real export of the fixture it reaches.
    const bound = new Set<string>();
    for (const cell of CELLS) {
      for (const match of cell.source.matchAll(
        /\b(?:const|let|var)\s*\{?\s*([A-Za-z_$][\w$]*)/g,
      )) {
        const name = match[1];
        if (name) {
          bound.add(name);
        }
      }
    }
    // The names the matrix deliberately binds at a use site, each of
    // which must be loud.
    for (const required of ["probeTarget", "run", "alpha", "sibling", "KEY"]) {
      expect(
        bound.has(required) || required === "sibling",
        `${required} must be bound by at least one cell`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------

const CLASS_GLYPH: Record<string, string> = {
  A: "A",
  B: "B",
  C: "C",
  "honest-unknown": "u",
};

function writeReport(): void {
  const byKey = new Map(results.map((r) => [r.cell.key, r]));
  const lines: string[] = [];

  lines.push("# Binding-form grammar sweep");
  lines.push("");
  lines.push(
    "Generated by `npm run test:binding-grammar` " +
      "(`tests/binding-grammar/binding-grammar.test.ts`). The grammar, the " +
      "expectations and their rationale live in " +
      "`tests/binding-grammar/matrix.ts`; the disagreements in " +
      "`tests/binding-grammar/disagreements.ts`. Do not edit this file.",
  );
  lines.push("");
  const total = BINDING_FORMS.length * AUTHORITY_MECHANISMS.length;
  const agree = results.filter((r) => r.agrees).length;
  const disagree = KNOWN_DISAGREEMENTS.length;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Binding forms (rows): ${BINDING_FORMS.length}`);
  lines.push(
    `- Authority mechanisms (columns): ${AUTHORITY_MECHANISMS.length}`,
  );
  lines.push(`- Cells in the cross-product: ${total}`);
  lines.push(`- Swept: ${CELLS.length}`);
  lines.push(`- Skipped (syntactically impossible): ${SKIPPED_CELLS.length}`);
  lines.push(`- Agreeing with the oracle: ${agree}`);
  lines.push(`- Known disagreements: ${disagree}`);
  for (const cls of ["A", "B", "C", "honest-unknown"] as const) {
    const n = KNOWN_DISAGREEMENTS.filter(
      (d) => groupOf(d)?.class === cls,
    ).length;
    lines.push(`  - class ${cls}: ${n}`);
  }
  lines.push("");

  lines.push("## The matrix at a glance");
  lines.push("");
  lines.push(
    "`.` agrees with the oracle &middot; `A`/`B`/`C` a classified " +
      "disagreement &middot; `u` an honest, deliberate UNKNOWN that the " +
      "oracle would have resolved &middot; `-` skipped &middot; `?` not run.",
  );
  lines.push("");
  lines.push(
    "| binding form | " +
      AUTHORITY_MECHANISMS.map((m) => m.id).join(" | ") +
      " |",
  );
  lines.push(
    "| --- | " + AUTHORITY_MECHANISMS.map(() => "---").join(" | ") + " |",
  );
  for (const form of BINDING_FORMS) {
    const cells = AUTHORITY_MECHANISMS.map((mechanism) => {
      const key = cellKey(form.id, mechanism.id);
      if (skipped.has(key)) {
        return "-";
      }
      const d = disagreementByKey.get(key);
      if (d) {
        return CLASS_GLYPH[groupOf(d)?.class ?? ""] ?? "?";
      }
      return byKey.has(key) ? "." : "?";
    });
    lines.push(`| \`${form.id}\` | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Every cell");
  lines.push("");
  lines.push("| cell | expectation | observed | verdict |");
  lines.push("| --- | --- | --- | --- |");
  for (const form of BINDING_FORMS) {
    for (const mechanism of AUTHORITY_MECHANISMS) {
      const key = cellKey(form.id, mechanism.id);
      const skip = SKIPPED_CELLS.find(
        (s) => cellKey(s.form, s.mechanism) === key,
      );
      if (skip) {
        lines.push(`| \`${key}\` | — | — | skipped: ${skip.reason} |`);
        continue;
      }
      const result = byKey.get(key);
      const cell = CELLS.find((c) => c.key === key);
      const expectation = cell ? formatExpectation(cell.expectation) : "—";
      const observed = result ? formatObservation(result.observed) : "not run";
      const d = disagreementByKey.get(key);
      const verdict = d
        ? `disagreement (class ${groupOf(d)?.class}) — ${d.group}`
        : result?.agrees
          ? "agrees"
          : "**UNCLASSIFIED DISAGREEMENT**";
      lines.push(`| \`${key}\` | ${expectation} | ${observed} | ${verdict} |`);
    }
  }
  lines.push("");

  lines.push("## Class-A disagreements (live soundness defects)");
  lines.push("");
  const classA = KNOWN_DISAGREEMENTS.filter((d) => groupOf(d)?.class === "A");
  if (classA.length === 0) {
    lines.push("None.");
  } else {
    for (const d of classA) {
      const cell = CELLS.find((c) => c.key === cellKey(d.form, d.mechanism));
      lines.push(`### \`${d.form}\` x \`${d.mechanism}\``);
      lines.push("");
      lines.push(
        `- Correct: ${cell ? formatExpectation(cell.expectation) : "—"}`,
      );
      lines.push(`- Observed: ${d.observed}`);
      lines.push(`- Why class A: ${groupOf(d)?.why ?? ""}`);
      lines.push("");
      if (cell) {
        lines.push("```js");
        lines.push(cell.source.trimEnd());
        lines.push("```");
        lines.push("");
      }
    }
  }

  lines.push("## Disagreement groups");
  lines.push("");
  lines.push(
    "Every disagreeing cell belongs to exactly one family. `documented: " +
      "no` marks a boundary this sweep DISCOVERED -- sound, but stated " +
      "nowhere, and therefore able to change without anyone noticing.",
  );
  lines.push("");
  lines.push("| group | class | cells | documented | owner | why |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const group of DISAGREEMENT_GROUPS) {
    const n = KNOWN_DISAGREEMENTS.filter((d) => d.group === group.id).length;
    lines.push(
      `| \`${group.id}\` | ${group.class} | ${n} | ` +
        `${group.documented ? "yes" : "**no**"} | ${group.owner} | ` +
        `${group.why} |`,
    );
  }
  lines.push("");
  lines.push("## Binding forms");
  lines.push("");
  lines.push("| form | selects | determinacy | note |");
  lines.push("| --- | --- | --- | --- |");
  for (const form of BINDING_FORMS) {
    const determinacy =
      form.determinacy.kind === "single-valued"
        ? "single-valued"
        : `${form.determinacy.kind}: ${form.determinacy.why}`;
    lines.push(
      `| \`${form.id}\` | ${form.selection.kind} | ${determinacy} | ${form.note} |`,
    );
  }
  lines.push("");
  lines.push("## Authority mechanisms");
  lines.push("");
  lines.push("| mechanism | owner | note |");
  lines.push("| --- | --- | --- |");
  for (const mechanism of AUTHORITY_MECHANISMS) {
    lines.push(
      `| \`${mechanism.id}\` | ${mechanism.owner} | ${mechanism.note} |`,
    );
  }
  lines.push("");

  writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
}
