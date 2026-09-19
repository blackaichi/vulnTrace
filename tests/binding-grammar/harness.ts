import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallEdge, CallGraph, GraphNode } from "../../src/domain/graph.js";
import { buildCallGraph } from "../../src/code-intelligence/call-graph.js";
import { createModuleResolver } from "../../src/code-intelligence/module-resolver.js";
import { loadTsProject } from "../../src/code-intelligence/ts-project.js";

/**
 * THE LOUD FIXTURE VOCABULARY.
 *
 * Every fixture package exports EVERY name any cell in the matrix binds,
 * as a distinct named function. This is the loud-fixture rule, and it is
 * not cosmetic: against a package that does NOT export the name, a
 * fabricated attribution degrades to `unresolved_target` and reads as an
 * honest UNKNOWN -- which is exactly how the RWF-046 array-hole defect
 * (`const [, run] = require("pkg")` resolving to `pkg#run`) survived a
 * green suite. With the name present the fabrication RESOLVES, the
 * observation is `<module>#run`, and the cell fails loudly.
 *
 * The numeric keys `"0"`, `"1"`, `"2"` are here for the same reason one
 * step further in: a case that fabricates BY POSITION rather than by text
 * also lands on a real export instead of vanishing into UNKNOWN.
 */
export const LOUD_EXPORTS = [
  "run",
  "danger",
  "safe",
  "execute",
  "handler",
  "alpha",
  "beta",
  "gamma",
  "first",
  "second",
  "third",
  "item",
  "value",
  "method",
  "cb",
  "fn",
  "zero",
  "one",
  "two",
  "Thing",
  // --- The LOCAL names the matrix's own cells bind ------------------
  //
  // These are here precisely BECAUSE no honest resolution can ever name
  // them. A text-authority defect attributes a call to the LOCAL
  // identifier's spelling, and against a package that does not export
  // that spelling the fabrication degrades to `unresolved_target` and
  // reads as an honest UNKNOWN. Exporting them turns every such
  // fabrication into a loud EXACT observation the matrix can see.
  "probeTarget",
  "fallback",
  "restBag",
  "sibling",
  "KEY",
  "rest",
  "key",
] as const;

/** Numeric-string export names, so a positional fabrication also lands loudly. */
export const LOUD_NUMERIC_EXPORTS = ["0", "1", "2"] as const;

/**
 * The two structured members, so nested patterns have a real path to
 * name. `api.run` and `deep[0]` exist as genuine, single-valued
 * callables: a nested cell that stays UNKNOWN is then a precision
 * refusal, and a nested cell that resolves to `pkg#run` (dropping the
 * `api.` hop) is a visible mis-attribution rather than a plausible miss.
 */
const LOUD_STRUCTURED = [
  "  api: { run: apiRun, execute: apiExecute }",
  "  deep: [deep0, deep1]",
] as const;

function loudLeafDeclarations(exported: boolean): string[] {
  const keyword = exported ? "export function" : "function";
  const lines: string[] = [];
  for (const n of LOUD_EXPORTS) {
    lines.push(`${keyword} ${n}() {}`);
  }
  for (const n of LOUD_NUMERIC_EXPORTS) {
    lines.push(`function _n${n}() {}`);
  }
  for (const n of ["apiRun", "apiExecute", "deep0", "deep1"]) {
    lines.push(`function ${n}() {}`);
  }
  return lines;
}

function loudCommonJsSource(): string {
  const lines = loudLeafDeclarations(false);
  const entries = [
    ...LOUD_EXPORTS.map((n) => `  ${n}: ${n}`),
    // WRITTEN AS A COMPUTED LITERAL KEY, NOT AS `"0": _n0`.
    //
    // The sweep's own numeric-export control found that
    // `module.exports = { "0": f }` is not indexed as an export at all:
    // `module-model.ts`'s object-literal export extraction accepts an
    // IDENTIFIER property name or a COMPUTED one whose literal it can
    // read, and a plain string-literal or numeric-literal key matches
    // neither. Left as `"0": _n0`, every numeric slot in this fixture
    // would be silently absent -- and an absent name is exactly what
    // makes a positional fabrication degrade to `unresolved_target` and
    // read as an honest UNKNOWN. That is the failure the loud-fixture
    // rule exists to prevent, so the fixture uses the spelling the
    // export model can see. The gap itself is recorded in
    // `tests/validation/FINDINGS.md`.
    ...LOUD_NUMERIC_EXPORTS.map((n) => `  ["${n}"]: _n${n}`),
    ...LOUD_STRUCTURED,
  ];
  lines.push(`module.exports = {\n${entries.join(",\n")}\n};`);
  return lines.join("\n") + "\n";
}

function loudEsmSource(): string {
  const lines = loudLeafDeclarations(true);
  lines.push(
    `export { ${LOUD_NUMERIC_EXPORTS.map((n) => `_n${n} as "${n}"`).join(", ")} };`,
  );
  lines.push("export const api = { run: apiRun, execute: apiExecute };");
  lines.push("export const deep = [deep0, deep1];");
  return lines.join("\n") + "\n";
}

const tempRoots: string[] = [];

export function disposeTempRoots(): void {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function write(
  root: string,
  relativePath: string,
  content: string,
): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

/**
 * The fixture packages every cell may reach, each exporting the full loud
 * vocabulary. `nested/node_modules/twin` is a SECOND INSTALL of `twin`:
 * the observation format names the module path, so a reference that
 * reaches the wrong install is visible as a different observation rather
 * than merely a different name.
 */
export const FIXTURE_PACKAGES = [
  "pkg",
  "pkg-a",
  "pkg-b",
  "outer",
  "inner",
  "twin",
] as const;

export interface ProjectKind {
  readonly esm: boolean;
}

export function makeProject(kind: ProjectKind): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-grammar-"));
  tempRoots.push(root);
  const body = kind.esm ? loudEsmSource() : loudCommonJsSource();
  const type = kind.esm ? { type: "module" } : {};
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "grammar-host", version: "1.0.0", ...type }),
  );
  for (const name of FIXTURE_PACKAGES) {
    write(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version: "1.0.0", main: "index.js", ...type }),
    );
    write(root, `node_modules/${name}/index.js`, body);
  }
  write(
    root,
    `node_modules/nested/package.json`,
    JSON.stringify({
      name: "nested",
      version: "1.0.0",
      main: "index.js",
      ...type,
    }),
  );
  write(root, `node_modules/nested/index.js`, body);
  write(
    root,
    `node_modules/nested/node_modules/twin/package.json`,
    JSON.stringify({
      name: "twin",
      version: "2.0.0",
      main: "index.js",
      ...type,
    }),
  );
  write(root, `node_modules/nested/node_modules/twin/index.js`, body);
  return root;
}

/**
 * What a cell observed. Exactly two shapes are admissible as an
 * EXPECTATION, matching the matrix's own rule: an EXACT target, or
 * UNKNOWN under a NAMED reason. "an edge exists", "it did not crash" and
 * "some node" are deliberately not representable.
 *
 * The three remaining members are OBSERVATION-only degeneracies. None of
 * them may ever appear as an expectation, and the driver asserts that:
 * they exist so a cell whose probe vanished reports that fact instead of
 * quietly reading as a refusal.
 */
export type Observation =
  /** `<module path relative to the project root>#<declaration name>`. */
  | { readonly kind: "exact"; readonly target: string }
  | { readonly kind: "unknown"; readonly reason: string }
  /** No call edge left the probe at all -- itself a defect, never a refusal. */
  | { readonly kind: "no-edge" }
  /** More than one call edge left the probe; the cell's question is ill-posed. */
  | { readonly kind: "ambiguous"; readonly count: number }
  /** The probe function itself is not in the graph. */
  | { readonly kind: "no-probe" };

export function formatObservation(o: Observation): string {
  switch (o.kind) {
    case "exact":
      return `EXACT ${o.target}`;
    case "unknown":
      return `UNKNOWN ${o.reason}`;
    case "no-edge":
      return "NO-EDGE";
    case "ambiguous":
      return `AMBIGUOUS(${o.count})`;
    case "no-probe":
      return "NO-PROBE";
  }
}

export async function graphFor(
  root: string,
  entry: string,
): Promise<CallGraph> {
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles: [entry], resolver });
}

/**
 * One project root shared by every cell that runs in it, with one
 * resolver built after all cell files are on disk.
 *
 * Per-cell temp projects would mean re-vendoring nine loud fixture
 * packages several hundred times; sharing the root makes the sweep's cost
 * linear in cells rather than in cells times fixtures. Each cell still
 * gets its OWN entry file and its own call graph, so nothing leaks
 * between cells but the (read-only) fixture packages.
 */
export interface PreparedProject {
  readonly root: string;
  graph(entryRelativePath: string): Promise<CallGraph>;
}

export function prepareProject(
  kind: ProjectKind,
  files: ReadonlyMap<string, string>,
): PreparedProject {
  const root = makeProject(kind);
  for (const [relativePath, content] of files) {
    write(root, relativePath, content);
  }
  const resolver = createModuleResolver(loadTsProject(root));
  return {
    root,
    graph: (entryRelativePath: string) =>
      buildCallGraph({
        entryFiles: [path.join(root, entryRelativePath)],
        resolver,
      }),
  };
}

/**
 * The single call edge leaving `probeName`, reduced to an
 * {@link Observation}.
 *
 * `module_load` edges are excluded: `domain/graph.ts` is explicit that
 * such an edge is a fact about the module system and never a claim that a
 * function was called, and every cell here asks a question about a CALL.
 *
 * Asserting on `<module>#<name>` rather than on the name alone is the
 * whole point: every fixture package exports the same vocabulary, so a
 * name-only assertion would pass under exactly the install-collapse these
 * cells exist to catch.
 */
export function observe(
  graph: CallGraph,
  root: string,
  probeName: string,
): Observation {
  const probe: GraphNode | undefined = graph.nodes.find(
    (n) => n.name === probeName,
  );
  if (!probe) {
    return { kind: "no-probe" };
  }
  const edges: CallEdge[] = graph.edges.filter(
    (e) => e.from === probe.id && e.type !== "module_load",
  );
  const [edge] = edges;
  if (!edge) {
    return { kind: "no-edge" };
  }
  if (edges.length > 1) {
    return { kind: "ambiguous", count: edges.length };
  }
  if (edge.resolution.kind === "unknown") {
    return { kind: "unknown", reason: edge.resolution.reason };
  }
  const node = graph.nodes.find((n) => n.id === edge.resolution.target);
  if (!node) {
    return { kind: "no-edge" };
  }
  const rel = path.relative(root, node.module).split(path.sep).join("/");
  return { kind: "exact", target: `${rel}#${node.name ?? "<anonymous>"}` };
}
