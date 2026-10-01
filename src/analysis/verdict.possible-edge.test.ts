import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import {
  createProofWorkspace,
  describeOutcome,
  mutate,
  runProof,
  type MaterializedProof,
  type MutationOutcome,
  type ProofProject,
} from "../testing/proof-mutation.js";

/**
 * Task A-2 -- the `possible` edge kind, through the PRODUCTION verdict
 * composition (`createAnalysisProofContext` + `buildFinding`).
 *
 * ADR 0008 Decision 2, as SOUNDNESS-CONTRACT § 1 and § 3 state it:
 *
 * - a target reached only through `possible` edges is UNKNOWN, carrying
 *   `value_uncertainty` / `possible_invocation` -- never AFFECTED (no
 *   concrete path) and never NOT_AFFECTED (the program may call it);
 * - a `possible` edge counts as reachable for completeness: the unknown
 *   edges behind it withhold family C, and a widening construct behind it
 *   withdraws family B (VT-300);
 * - a `possible` edge whose region provably cannot reach the target
 *   leaves family C standing.
 *
 * When task A-2 wrote these rows no producer emitted a `possible` edge, so
 * each takes a REAL graph built from a real on-disk project and adds one
 * `possible` edge to a real node, exactly as a producer would. Task A-3a's
 * producers are exercised at the end, through edges the production graph
 * builder EMITS (REMEDIATION-PLAN § 5a, "A-2 additions"). The
 * projects are loud (AGENTS.md § G): `vuln-lib` exports both names every
 * case binds, so an edge attributed to the wrong function resolves to the
 * wrong target instead of degrading quietly to UNKNOWN.
 */

const LIB_CJS =
  "function vulnerable(x){ return x; }\n" +
  "function safe(x){ return x; }\n" +
  "module.exports = { vulnerable, safe };\n";

const INSTALLED_LIB: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "1.0.0",
  }),
  "node_modules/vuln-lib/index.js": LIB_CJS,
};

/**
 * Family C: `main` (the only root) calls `safe`. `callsVulnerable` and
 * `callsSafe` are never called, so today nothing reaches them -- they
 * stand for the function values A-3 and A-4 will give `possible` edges
 * (a callback handed to an unmodeled builtin, an accessor body).
 */
const FAMILY_C_PROJECT: ProofProject = {
  files: {
    ...INSTALLED_LIB,
    "src/index.js":
      'const { safe, vulnerable } = require("vuln-lib");\n' +
      "function main(){ return safe(1); }\n" +
      "function callsVulnerable(){ return vulnerable(1); }\n" +
      "function callsSafe(){ return safe(2); }\n" +
      "module.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: ["node_modules/vuln-lib"],
  findingInstall: "node_modules/vuln-lib",
};

/** `main` calls the target: a resolved path exists. */
const AFFECTED_PROJECT: ProofProject = {
  files: {
    ...INSTALLED_LIB,
    "src/index.js":
      'const { safe, vulnerable } = require("vuln-lib");\n' +
      "function main(){ return vulnerable(1); }\n" +
      "function callsSafe(){ return safe(2); }\n" +
      "module.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: ["node_modules/vuln-lib"],
  findingInstall: "node_modules/vuln-lib",
};

/**
 * Family B (as in the F4 suite): two installs of one name and version; the
 * entrypoint reaches the top-level one, and the finding is about the
 * nested twin the call graph never traversed.
 */
const FAMILY_B_PROJECT: ProofProject = {
  files: {
    ...INSTALLED_LIB,
    "node_modules/consumer/package.json": JSON.stringify({
      name: "consumer",
      version: "1.0.0",
    }),
    "node_modules/consumer/node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_CJS,
    "src/index.js":
      'const { vulnerable } = require("vuln-lib");\n' +
      "function main(){ return vulnerable(1); }\n" +
      "function neverCalled(){ return 1; }\n" +
      "module.exports = { main };\n",
  },
  entries: ["src/index.js"],
  installs: [
    "node_modules/vuln-lib",
    "node_modules/consumer/node_modules/vuln-lib",
  ],
  findingInstall: "node_modules/consumer/node_modules/vuln-lib",
};

const workspace = createProofWorkspace();
let familyC: MaterializedProof;
let affected: MaterializedProof;
let familyB: MaterializedProof;

beforeAll(async () => {
  familyC = await workspace.materialize(FAMILY_C_PROJECT);
  affected = await workspace.materialize(AFFECTED_PROJECT);
  familyB = await workspace.materialize(FAMILY_B_PROJECT);
});

afterAll(() => workspace.cleanup());

/** The node of `name`, found by name and file in the real graph -- never a guessed id. */
function nodeNamed(proof: MaterializedProof, name: string): GraphNode {
  const file = proof.entryFiles[0];
  const found = proof.inputs.graph.nodes.filter(
    (node) => node.name === name && node.module === file,
  );
  expect(found, `exactly one node named ${name} in ${file}`).toHaveLength(1);
  return found[0] as GraphNode;
}

/** The entry file's module node: an entrypoint root. */
function entryModule(proof: MaterializedProof): GraphNode {
  const file = proof.entryFiles[0];
  const found = proof.inputs.graph.nodes.filter(
    (node) => node.kind === "module" && node.module === file,
  );
  expect(found).toHaveLength(1);
  return found[0] as GraphNode;
}

/** The target node: `vulnerable` in the finding's own instance. */
function targetNode(proof: MaterializedProof): GraphNode {
  const instance = proof.inputs.packageInstance ?? "";
  const found = proof.inputs.graph.nodes.filter(
    (node) => node.name === "vulnerable" && node.module.startsWith(instance),
  );
  expect(found).toHaveLength(1);
  return found[0] as GraphNode;
}

function possible(from: GraphNode, to: GraphNode): CallEdge {
  return {
    from: from.id,
    type: "callback",
    resolution: { kind: "possible", target: to.id },
    location: { file: from.module, line: 1, column: 1 },
  };
}

function withEdges(
  graph: CallGraph,
  edges: readonly CallEdge[],
  nodes: readonly GraphNode[] = [],
): CallGraph {
  return {
    nodes: [...graph.nodes, ...nodes],
    edges: [...graph.edges, ...edges],
  };
}

/** A node the analysis never discovered, standing for escaped code. */
function syntheticNode(proof: MaterializedProof, name: string): GraphNode {
  const file = proof.entryFiles[0] as string;
  return { id: `${file}#${name}@99:1`, kind: "callback", module: file, name };
}

function reasonsOf(outcome: MutationOutcome): string[] {
  return outcome.unknownReasons.map((r) => `${r.category}/${r.reason}`);
}

describe("baselines", () => {
  it("family C: the target is never called, and no possible edge exists", async () => {
    const outcome = await runProof(familyC.inputs);
    expect(outcome.verdict, describeOutcome(outcome)).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("C");
    expect(
      familyC.inputs.graph.edges.some((e) => e.resolution.kind === "possible"),
    ).toBe(false);
  });

  it("AFFECTED: main calls the target over resolved edges", async () => {
    const outcome = await runProof(affected.inputs);
    expect(outcome.verdict, describeOutcome(outcome)).toBe("AFFECTED");
  });

  it("family B: the nested twin was never traversed", async () => {
    const outcome = await runProof(familyB.inputs);
    expect(outcome.verdict, describeOutcome(outcome)).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("B");
  });
});

describe("a target reached only through a possible edge is UNKNOWN (possible_invocation)", () => {
  it("a possible edge to a function that calls the target: UNKNOWN, never AFFECTED or NOT_AFFECTED", async () => {
    const outcome = await runProof(
      mutate(familyC.inputs, {
        graph: withEdges(familyC.inputs.graph, [
          possible(entryModule(familyC), nodeNamed(familyC, "callsVulnerable")),
        ]),
      }),
    );

    expect(outcome.verdict, describeOutcome(outcome)).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expect(outcome.finding?.evidence?.path ?? []).toEqual([]);
    expect(reasonsOf(outcome)).toContain(
      "value_uncertainty/possible_invocation",
    );
    expect(
      outcome.reasons.some((r) => r.startsWith("possible_invocation at ")),
      describeOutcome(outcome),
    ).toBe(true);
  });

  it("a possible edge naming the target itself: UNKNOWN (possible_invocation)", async () => {
    const outcome = await runProof(
      mutate(familyC.inputs, {
        graph: withEdges(familyC.inputs.graph, [
          possible(nodeNamed(familyC, "main"), targetNode(familyC)),
        ]),
      }),
    );

    expect(outcome.verdict, describeOutcome(outcome)).toBe("UNKNOWN");
    expect(reasonsOf(outcome)).toContain(
      "value_uncertainty/possible_invocation",
    );
  });

  it("a possible edge alongside a resolved path does not block AFFECTED, and never enters its path", async () => {
    const base = await runProof(affected.inputs);
    const outcome = await runProof(
      mutate(affected.inputs, {
        graph: withEdges(affected.inputs.graph, [
          possible(entryModule(affected), nodeNamed(affected, "callsSafe")),
          possible(entryModule(affected), targetNode(affected)),
        ]),
      }),
    );

    expect(outcome.verdict, describeOutcome(outcome)).toBe("AFFECTED");
    expect(outcome.finding?.evidence?.path).toEqual(
      base.finding?.evidence?.path,
    );
  });
});

describe("the code behind a possible edge is searched (family C)", () => {
  it("control: a possible edge into a clean region that never reaches the target leaves family C standing", async () => {
    const outcome = await runProof(
      mutate(familyC.inputs, {
        graph: withEdges(familyC.inputs.graph, [
          possible(entryModule(familyC), nodeNamed(familyC, "callsSafe")),
        ]),
      }),
    );

    expect(outcome.verdict, describeOutcome(outcome)).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("C");
    expect(
      outcome.finding?.evidence?.confirmedUnreachableTarget
        ?.reachableSubgraphComplete,
    ).toBe(true);
  });

  it("an unknown edge behind a possible edge withdraws family C", async () => {
    const escaped = syntheticNode(familyC, "escaped");
    const outcome = await runProof(
      mutate(familyC.inputs, {
        graph: withEdges(
          familyC.inputs.graph,
          [
            possible(entryModule(familyC), escaped),
            {
              from: escaped.id,
              type: "direct",
              resolution: {
                kind: "unknown",
                reason: "unsupported_construct",
                potentialTargets: [],
              },
            },
          ],
          [escaped],
        ),
      }),
    );

    expect(outcome.verdict, describeOutcome(outcome)).toBe("UNKNOWN");
    expect(outcome.family).toBe("NONE");
    expect(reasonsOf(outcome)).toContain(
      "unmodeled_construct/unsupported_construct",
    );
    // Incompleteness, not a possible-only reach: the target was not reached.
    expect(reasonsOf(outcome)).not.toContain(
      "value_uncertainty/possible_invocation",
    );
  });
});

describe("VT-300 sees a widening construct behind a possible edge (family B)", () => {
  function widening(escaped: GraphNode): CallEdge {
    return {
      from: escaped.id,
      type: "direct",
      resolution: {
        kind: "unknown",
        reason: "dynamic_require",
        potentialTargets: [],
      },
    };
  }

  it("a widening construct behind a possible edge withdraws family B", async () => {
    const escaped = syntheticNode(familyB, "escaped");
    const outcome = await runProof(
      mutate(familyB.inputs, {
        graph: withEdges(
          familyB.inputs.graph,
          [possible(entryModule(familyB), escaped), widening(escaped)],
          [escaped],
        ),
      }),
    );

    expect(outcome.family, describeOutcome(outcome)).not.toBe("B");
    expect(outcome.verdict).not.toBe("NOT_AFFECTED");
    expect(reasonsOf(outcome)).toContain(
      "capability_escape/closure_widening_construct_reachable",
    );
  });

  it("control: the same construct with no edge leading to it leaves family B standing", async () => {
    const escaped = syntheticNode(familyB, "escaped");
    const outcome = await runProof(
      mutate(familyB.inputs, {
        graph: withEdges(familyB.inputs.graph, [widening(escaped)], [escaped]),
      }),
    );

    expect(outcome.verdict, describeOutcome(outcome)).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("B");
  });

  it("control: a possible edge into a clean function leaves family B standing", async () => {
    const outcome = await runProof(
      mutate(familyB.inputs, {
        graph: withEdges(familyB.inputs.graph, [
          possible(entryModule(familyB), nodeNamed(familyB, "neverCalled")),
        ]),
      }),
    );

    expect(outcome.verdict, describeOutcome(outcome)).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("B");
  });
});

/**
 * Task A-3a, REMEDIATION-PLAN § 5a ("A-2 additions"): one reproduction per
 * site kind that EMITS a `possible` edge, through the production graph
 * builder and `buildFinding`, with no edge injected. Each hands a function
 * that calls the target to code the graph does not model; each must be
 * UNKNOWN with `value_uncertainty` / `possible_invocation`.
 */
describe("A-3a's emitted possible edges reach buildFinding as possible_invocation", () => {
  const SITE_KINDS: readonly {
    readonly name: string;
    readonly body: string;
  }[] = [
    {
      name: "an argument of a builtin call (fs.readFile's callback)",
      body: 'require("fs").readFile("x", callsVulnerable);\n',
    },
    {
      name: "a member of an object-literal argument (an inline Proxy trap)",
      body: "new Proxy({}, { get: callsVulnerable });\n",
    },
    {
      name: "an assignment into a builtin value (Error.prepareStackTrace)",
      body: "Error.prepareStackTrace = callsVulnerable;\n",
    },
    {
      name: "an argument an implicit constructor forwards to a builtin base (RWF-060)",
      body:
        'class R extends require("stream").Readable {}\n' +
        "new R({ read: callsVulnerable });\n",
    },
  ];

  it.each(SITE_KINDS.map((k) => [k.name, k] as const))(
    "%s",
    async (_name, kind) => {
      const proof = await workspace.materialize({
        ...FAMILY_C_PROJECT,
        files: {
          ...FAMILY_C_PROJECT.files,
          "src/index.js":
            'const { safe, vulnerable } = require("vuln-lib");\n' +
            "function main(){ return safe(1); }\n" +
            "function callsVulnerable(){ return vulnerable(1); }\n" +
            kind.body +
            "module.exports = { main };\n",
        },
      });
      expect(
        proof.inputs.graph.edges.some((e) => e.resolution.kind === "possible"),
        "the production graph emits the possible edge",
      ).toBe(true);
      const outcome = await runProof(proof.inputs);
      expect(outcome.verdict, describeOutcome(outcome)).toBe("UNKNOWN");
      expect(reasonsOf(outcome)).toContain(
        "value_uncertainty/possible_invocation",
      );
    },
  );
});
