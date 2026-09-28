import { describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
// Plain ESM (run by `scripts/differential.mjs` under bare `node`); its
// types live in the matching `.d.mts` file.
import {
  buildCaseRecord,
  createPathNormalizer,
  diffSnapshots,
  renderReport,
  selectFinding,
  SNAPSHOT_FORMAT,
  summarize,
  type CaseOracle,
  type CaseRecord,
  type Snapshot,
} from "../../scripts/differential-lib.mjs";

/**
 * BL-029 — the differential tool's pure core, driven by planted changes.
 *
 * Every category the report counts is shown to FIRE on a change planted
 * for it, because a category that can never fire reports a reassuring
 * zero forever. The other half is the loud side: what was not measured
 * (a graph not observed, a scan that failed, a case on one side only) must
 * be reported as such and never folded into "no change".
 *
 * Each case record is built through `buildCaseRecord` from a synthetic
 * scan output under a synthetic root, so path normalization is exercised
 * on the way in: base and head deliberately use different roots.
 */

const BASE_ROOT = "/work/base-checkout/tests/fixture";
const HEAD_ROOT = "/scratch/head-checkout/tests/fixture";

interface FakeFinding {
  readonly vulnerability?: string;
  readonly package?: string;
  readonly version?: string;
  readonly packageInstance?: string;
  readonly verdict: "AFFECTED" | "NOT_AFFECTED" | "UNKNOWN";
  readonly evidence?: Record<string, unknown>;
  readonly unknownReasons?: readonly unknown[];
  readonly confidence?: number;
}

function finding(
  root: string,
  overrides: Partial<FakeFinding> & Pick<FakeFinding, "verdict">,
): Record<string, unknown> {
  return {
    vulnerability: "GHSA-test-0001",
    package: "lib",
    version: "1.0.0",
    packageInstance: "node_modules/lib",
    evidence: {
      path: [`${root}/src/index.js:3`, `${root}/node_modules/lib/index.js:1`],
    },
    ...overrides,
  };
}

function node(root: string, name: string): GraphNode {
  return {
    id: `${root}/src/index.js#${name}@1:1`,
    kind: "function",
    module: `${root}/src/index.js`,
    name,
  };
}

function edge(
  root: string,
  from: string,
  line: number,
  resolution: CallEdge["resolution"],
): CallEdge {
  return {
    from: `${root}/src/index.js#${from}@1:1`,
    type: "direct",
    resolution,
    location: { file: `${root}/src/index.js`, line, column: 3 },
  };
}

function resolvedTo(root: string, name: string): CallEdge["resolution"] {
  return { kind: "resolved", target: `${root}/src/index.js#${name}@1:1` };
}

const UNKNOWN: CallEdge["resolution"] = {
  kind: "unknown",
  reason: "unresolved_target",
  potentialTargets: [],
};

/** A small graph: main calls a (line 2) and b (line 3). */
function graph(root: string, overrides: Partial<CallGraph> = {}): CallGraph {
  return {
    nodes: [node(root, "main"), node(root, "a"), node(root, "b")],
    edges: [
      edge(root, "main", 2, resolvedTo(root, "a")),
      edge(root, "main", 3, resolvedTo(root, "b")),
    ],
    ...overrides,
  };
}

interface CaseSpec {
  readonly id?: string;
  readonly findings?: readonly Record<string, unknown>[];
  readonly unreported?: readonly Record<string, unknown>[];
  readonly graph?: CallGraph | null;
  readonly truncated?: boolean;
  readonly error?: string;
  readonly stdout?: string;
  readonly oracle?: CaseOracle;
}

function record(root: string, spec: CaseSpec): CaseRecord {
  const g = spec.graph === undefined ? graph(root) : spec.graph;
  return buildCaseRecord({
    corpus: "adversarial-v1",
    id: spec.id ?? "ADV-T01",
    oracle: spec.oracle ?? null,
    exitCode: 0,
    stdout:
      spec.stdout ??
      JSON.stringify({
        findings: spec.findings ?? [],
        unreportedCandidates: spec.unreported ?? [],
      }),
    error: spec.error ?? null,
    observedGraph:
      g === null ? null : { graph: g, truncated: spec.truncated ?? false },
    roots: [{ path: root, token: "<project>" }],
  });
}

function snapshot(label: string, cases: readonly CaseRecord[]): Snapshot {
  return { format: SNAPSHOT_FORMAT, label, corpora: ["adversarial-v1"], cases };
}

function diffOf(base: CaseSpec | CaseSpec[], head: CaseSpec | CaseSpec[]) {
  const b = (Array.isArray(base) ? base : [base]).map((s) =>
    record(BASE_ROOT, s),
  );
  const h = (Array.isArray(head) ? head : [head]).map((s) =>
    record(HEAD_ROOT, s),
  );
  return diffSnapshots(snapshot("base", b), snapshot("head", h));
}

function zeroSummary() {
  return {
    graph: {
      measured: 1,
      unavailable: 0,
      casesChanged: 0,
      nodesAdded: 0,
      nodesRemoved: 0,
      sitesAdded: 0,
      sitesRemoved: 0,
      sitesChanged: 0,
      withdrawnToUnknown: 0,
      withdrawnToPossible: 0,
      unknownToPossible: 0,
      unknownToResolved: 0,
      possibleToResolved: 0,
      retargeted: 0,
      truncationChanged: 0,
    },
    proof: { measured: 1, changed: 0, changedWithVerdictUnchanged: 0 },
    verdict: {
      measured: 1,
      changed: 0,
      intoNotAffected: 0,
      added: 0,
      addedNotAffected: 0,
      removed: 0,
      unreportedAdded: 0,
      unreportedRemoved: 0,
    },
    suiteMoved: 0,
    unmeasured: 0,
    onlyOneSide: 0,
  };
}

describe("BL-029 differential: normalization", () => {
  it("the same scan under two different roots is one record, and diffs to zero", () => {
    const spec: CaseSpec = {
      findings: [finding(BASE_ROOT, { verdict: "AFFECTED" })],
    };
    const base = record(BASE_ROOT, spec);
    const head = record(HEAD_ROOT, {
      findings: [finding(HEAD_ROOT, { verdict: "AFFECTED" })],
    });
    expect(head).toEqual(base);
    expect(JSON.stringify(base)).not.toContain(BASE_ROOT);
    expect(
      summarize(diffSnapshots(snapshot("b", [base]), snapshot("h", [head]))),
    ).toEqual(zeroSummary());
  });

  it("replaces a root only where a path component ends", () => {
    const normalize = createPathNormalizer([
      { path: "/tmp", token: "<tmp>" },
      { path: "/tmp/project", token: "<project>" },
    ]);
    expect(normalize("/tmpfoo/x /tmp/y /tmp/project/z /tmp/projectile")).toBe(
      "/tmpfoo/x <tmp>/y <project>/z <tmp>/projectile",
    );
  });
});

describe("BL-029 differential: graph", () => {
  it("counts a resolved call site withdrawn to unknown", () => {
    const d = diffOf(
      {},
      {
        graph: graph(HEAD_ROOT, {
          edges: [
            edge(HEAD_ROOT, "main", 2, UNKNOWN),
            edge(HEAD_ROOT, "main", 3, resolvedTo(HEAD_ROOT, "b")),
          ],
        }),
      },
    );
    expect(summarize(d).graph).toMatchObject({
      casesChanged: 1,
      sitesChanged: 1,
      withdrawnToUnknown: 1,
    });
  });

  it("counts an unknown call site that became resolved", () => {
    const d = diffOf(
      {
        graph: graph(BASE_ROOT, {
          edges: [
            edge(BASE_ROOT, "main", 2, UNKNOWN),
            edge(BASE_ROOT, "main", 3, resolvedTo(BASE_ROOT, "b")),
          ],
        }),
      },
      {},
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      unknownToResolved: 1,
    });
  });

  it("counts a call site retargeted to a different node", () => {
    const d = diffOf(
      {},
      {
        graph: graph(HEAD_ROOT, {
          edges: [
            edge(HEAD_ROOT, "main", 2, resolvedTo(HEAD_ROOT, "b")),
            edge(HEAD_ROOT, "main", 3, resolvedTo(HEAD_ROOT, "b")),
          ],
        }),
      },
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      retargeted: 1,
    });
  });

  it("counts call sites added and removed, and nodes added and removed", () => {
    const d = diffOf(
      {},
      {
        graph: graph(HEAD_ROOT, {
          nodes: [
            node(HEAD_ROOT, "main"),
            node(HEAD_ROOT, "a"),
            node(HEAD_ROOT, "c"),
          ],
          edges: [
            edge(HEAD_ROOT, "main", 2, resolvedTo(HEAD_ROOT, "a")),
            edge(HEAD_ROOT, "main", 4, resolvedTo(HEAD_ROOT, "c")),
          ],
        }),
      },
    );
    expect(summarize(d).graph).toMatchObject({
      nodesAdded: 1,
      nodesRemoved: 1,
      sitesAdded: 1,
      sitesRemoved: 1,
      sitesChanged: 0,
    });
  });

  it("counts a second edge at an existing call site (a multiset, not a set)", () => {
    const d = diffOf(
      {},
      {
        graph: graph(HEAD_ROOT, {
          edges: [
            edge(HEAD_ROOT, "main", 2, resolvedTo(HEAD_ROOT, "a")),
            edge(HEAD_ROOT, "main", 2, resolvedTo(HEAD_ROOT, "a")),
            edge(HEAD_ROOT, "main", 3, resolvedTo(HEAD_ROOT, "b")),
          ],
        }),
      },
    );
    expect(summarize(d).graph.sitesChanged).toBe(1);
  });

  it("counts a change of the truncation flag", () => {
    const d = diffOf({}, { truncated: true });
    expect(summarize(d).graph.truncationChanged).toBe(1);
  });

  it("reports a graph not observed on one side as unavailable, never as unchanged", () => {
    const d = diffOf({ graph: null }, {});
    const s = summarize(d);
    expect(s.graph).toMatchObject({
      measured: 0,
      unavailable: 1,
      casesChanged: 0,
    });
    expect(d.graph.unavailable).toEqual([
      { case: "adversarial-v1/ADV-T01", base: false, head: true },
    ]);
    const report = renderReport(d);
    expect(report).toContain("0 of 0 measured cases changed");
    expect(report).toContain("**Unavailable: 1 cases**");
    expect(report).toContain("missing on base: 1, on head: 0");
  });
});

describe("BL-029 differential: proof", () => {
  it("reports a negative-proof family change with the verdict move it caused", () => {
    const d = diffOf(
      {
        findings: [
          finding(BASE_ROOT, {
            verdict: "NOT_AFFECTED",
            evidence: {
              path: [],
              confirmedUnreachableTarget: {
                target: {
                  module: `${BASE_ROOT}/node_modules/lib/index.js`,
                  export: "f",
                },
                entrypointRoots: [`${BASE_ROOT}/src/index.js`],
                reachableSubgraphComplete: true,
              },
            },
          }),
        ],
      },
      {
        findings: [
          finding(HEAD_ROOT, {
            verdict: "UNKNOWN",
            evidence: { path: [] },
            unknownReasons: [
              {
                category: "value_uncertainty",
                reason: "unresolved_target",
                count: 1,
              },
            ],
          }),
        ],
      },
    );
    expect(d.proof.changed).toHaveLength(1);
    const change = d.proof.changed[0];
    expect(change?.verdictMoved).toBe(true);
    expect(change?.fields.map((f) => f.field)).toEqual([
      "family",
      "negativeProof",
      "unknownReasons",
    ]);
    expect(change?.fields[0]).toMatchObject({ base: '"C"', head: "null" });
  });

  it("reports a proof change whose verdict did not move, and counts it apart", () => {
    const d = diffOf(
      {
        findings: [
          finding(BASE_ROOT, {
            verdict: "UNKNOWN",
            unknownReasons: [
              {
                category: "value_uncertainty",
                reason: "unresolved_target",
                count: 1,
              },
            ],
          }),
        ],
      },
      {
        findings: [
          finding(HEAD_ROOT, {
            verdict: "UNKNOWN",
            unknownReasons: [
              {
                category: "value_uncertainty",
                reason: "unresolved_target",
                count: 2,
              },
            ],
          }),
        ],
      },
    );
    expect(summarize(d).proof).toEqual({
      measured: 1,
      changed: 1,
      changedWithVerdictUnchanged: 1,
    });
    expect(summarize(d).verdict.changed).toBe(0);
  });

  it("reports an AFFECTED path that changed", () => {
    const d = diffOf(
      { findings: [finding(BASE_ROOT, { verdict: "AFFECTED" })] },
      {
        findings: [
          finding(HEAD_ROOT, {
            verdict: "AFFECTED",
            evidence: {
              path: [
                `${HEAD_ROOT}/src/index.js:9`,
                `${HEAD_ROOT}/node_modules/lib/index.js:1`,
              ],
            },
          }),
        ],
      },
    );
    expect(d.proof.changed[0]?.fields.map((f) => f.field)).toEqual(["path"]);
  });
});

describe("BL-029 differential: verdict", () => {
  it("flags a move into NOT_AFFECTED apart from other changes", () => {
    const d = diffOf(
      { findings: [finding(BASE_ROOT, { verdict: "UNKNOWN" })] },
      { findings: [finding(HEAD_ROOT, { verdict: "NOT_AFFECTED" })] },
    );
    expect(summarize(d).verdict).toMatchObject({
      changed: 1,
      intoNotAffected: 1,
    });
    expect(renderReport(d)).toContain("**INTO NOT_AFFECTED**");
  });

  it("flags a removed finding as a possible silent drop, and says where it went", () => {
    const d = diffOf(
      { findings: [finding(BASE_ROOT, { verdict: "UNKNOWN" })] },
      {
        unreported: [
          {
            stage: "package_identity",
            disposition: "undetermined",
            vulnerability: "GHSA-test-0001",
            package: "lib",
            packageInstance: "node_modules/lib",
            reason: "package_version_unknown",
            category: "identity_unresolved",
            detail: "…",
          },
        ],
      },
    );
    expect(summarize(d).verdict).toMatchObject({
      removed: 1,
      unreportedAdded: 1,
    });
    expect(d.verdict.removed[0]?.nowUnreported).toHaveLength(1);
    expect(renderReport(d)).toContain("**removed** (possible silent drop)");
  });

  it("reports a removed finding that went nowhere", () => {
    const d = diffOf(
      { findings: [finding(BASE_ROOT, { verdict: "AFFECTED" })] },
      {},
    );
    expect(d.verdict.removed[0]?.nowUnreported).toEqual([]);
    expect(renderReport(d)).toContain("not in unreportedCandidates either");
  });

  it("reports an added finding, and counts an added NOT_AFFECTED apart", () => {
    const d = diffOf(
      {},
      { findings: [finding(HEAD_ROOT, { verdict: "NOT_AFFECTED" })] },
    );
    expect(summarize(d).verdict).toMatchObject({
      added: 1,
      addedNotAffected: 1,
    });
  });

  it("reports unreported candidates removed", () => {
    const d = diffOf(
      {
        unreported: [
          {
            stage: "advisory_applicability",
            disposition: "not_applicable",
            reason: "advisory_not_applicable_to_installed_version",
            detail: "x",
          },
        ],
      },
      {},
    );
    expect(summarize(d).verdict.unreportedRemoved).toBe(1);
  });
});

describe("BL-029 differential: PackageInstance identity", () => {
  // Two installs of lib@1.0.0 at different paths, whose verdicts swap
  // between base and head: a sibling's verdict borrowed by the other. A
  // differential keyed by name@version sees the same multiset of
  // (lib@1.0.0, verdict) on both sides and reports nothing; keyed by
  // exact instance it is two verdict changes.
  const nested = "node_modules/host/node_modules/lib";
  const top = "node_modules/lib";

  it("a sibling swap between two same-name@version installs is two verdict changes", () => {
    const d = diffOf(
      {
        findings: [
          finding(BASE_ROOT, { packageInstance: nested, verdict: "AFFECTED" }),
          finding(BASE_ROOT, { packageInstance: top, verdict: "NOT_AFFECTED" }),
        ],
      },
      {
        findings: [
          finding(HEAD_ROOT, {
            packageInstance: nested,
            verdict: "NOT_AFFECTED",
          }),
          finding(HEAD_ROOT, { packageInstance: top, verdict: "AFFECTED" }),
        ],
      },
    );
    const byNameVersion = (side: "base" | "head") =>
      (side === "base"
        ? ["AFFECTED", "NOT_AFFECTED"]
        : ["NOT_AFFECTED", "AFFECTED"]
      ).sort();
    // The name@version view is blind to the swap...
    expect(byNameVersion("base")).toEqual(byNameVersion("head"));
    // ...the instance-keyed view is not.
    expect(d.verdict.changed.map((c) => [c.key, c.from, c.to])).toEqual([
      [`GHSA-test-0001 @ ${nested}`, "AFFECTED", "NOT_AFFECTED"],
      [`GHSA-test-0001 @ ${top}`, "NOT_AFFECTED", "AFFECTED"],
    ]);
    expect(summarize(d).verdict.intoNotAffected).toBe(1);
  });

  it("keeps two findings that share one key, and reports the collision", () => {
    const twins = [
      finding(BASE_ROOT, { verdict: "AFFECTED" }),
      finding(BASE_ROOT, { verdict: "UNKNOWN" }),
    ];
    const d = diffOf(
      { findings: twins },
      { findings: [finding(HEAD_ROOT, { verdict: "AFFECTED" })] },
    );
    expect(d.cases.duplicateKeys.map((x) => x.key)).toEqual([
      "GHSA-test-0001 @ node_modules/lib #1",
      "GHSA-test-0001 @ node_modules/lib #2",
    ]);
    // Neither twin silently wins the key the head finding is compared to.
    expect(summarize(d).verdict).toMatchObject({ added: 1, removed: 2 });
  });

  it("names an instance-less finding's key as such", () => {
    const d = diffOf(
      {},
      {
        findings: [
          finding(HEAD_ROOT, {
            packageInstance: undefined,
            verdict: "UNKNOWN",
          }),
        ],
      },
    );
    expect(d.verdict.added[0]?.key).toBe(
      "GHSA-test-0001 @ <no instance: lib@1.0.0>",
    );
  });
});

describe("BL-029 differential: what was not measured is never zero", () => {
  it("reports a scan that threw as unmeasured, excluded from the proof and verdict counts", () => {
    const d = diffOf(
      { findings: [finding(BASE_ROOT, { verdict: "AFFECTED" })] },
      { error: "boom", graph: null },
    );
    const s = summarize(d);
    expect(s.unmeasured).toBe(1);
    expect(s.proof.measured).toBe(0);
    expect(s.verdict).toMatchObject({ measured: 0, removed: 0 });
    expect(renderReport(d)).toContain(
      "adversarial-v1/ADV-T01 not measured: base ok, head error (boom)",
    );
  });

  it("reports unparseable output as unmeasured", () => {
    const d = diffOf({}, { stdout: "not json" });
    expect(d.cases.unmeasured[0]).toMatchObject({
      base: "ok",
      head: "unparseable",
    });
  });

  it("reports a case present on one side only", () => {
    const d = diffOf(
      [{ id: "ADV-T01" }, { id: "ADV-T02" }],
      [{ id: "ADV-T01" }],
    );
    expect(d.cases.onlyBase).toEqual(["adversarial-v1/ADV-T02"]);
    expect(summarize(d).onlyOneSide).toBe(1);
  });

  it("refuses a snapshot of another format", () => {
    const good = snapshot("b", []);
    expect(() =>
      diffSnapshots({ ...good, format: "other" } as unknown as Snapshot, good),
    ).toThrow(/expected vulntrace-differential-snapshot\/1/);
  });
});

describe("BL-029 differential: the suites' selector", () => {
  const records = record(BASE_ROOT, {
    findings: [
      finding(BASE_ROOT, {
        packageInstance: "node_modules/a/node_modules/lib",
        verdict: "AFFECTED",
      }),
      finding(BASE_ROOT, {
        packageInstance: "node_modules/lib",
        verdict: "NOT_AFFECTED",
      }),
      finding(BASE_ROOT, {
        vulnerability: "GHSA-other",
        packageInstance: "node_modules/x",
        package: "x",
        verdict: "UNKNOWN",
      }),
    ],
  }).findings;

  it("never picks the first of several matches", () => {
    expect(selectFinding(records, { package: "lib", version: "1.0.0" })).toBe(
      "AMBIGUOUS_SELECTOR(node_modules/a/node_modules/lib, node_modules/lib)",
    );
  });

  it("selects by instance when the selector names one", () => {
    expect(
      selectFinding(records, {
        package: "lib",
        version: "1.0.0",
        packageInstance: "node_modules/lib",
      }),
    ).toBe("NOT_AFFECTED");
  });

  it("filters by advisory when the selector names one, and reports no match as NO_FINDING", () => {
    expect(
      selectFinding(records, {
        package: "x",
        version: "1.0.0",
        vulnerability: "GHSA-other",
      }),
    ).toBe("UNKNOWN");
    expect(
      selectFinding(records, {
        package: "x",
        version: "1.0.0",
        vulnerability: "GHSA-test-0001",
      }),
    ).toBe("NO_FINDING");
  });

  it("puts expected, base and head side by side, and marks a moved case", () => {
    const oracle: CaseOracle = {
      expected: "AFFECTED",
      selector: { package: "lib", version: "1.0.0" },
    };
    const d = diffOf(
      { oracle, findings: [finding(BASE_ROOT, { verdict: "AFFECTED" })] },
      { oracle, findings: [finding(HEAD_ROOT, { verdict: "UNKNOWN" })] },
    );
    expect(d.suite).toEqual([
      {
        case: "adversarial-v1/ADV-T01",
        expected: "AFFECTED",
        knownFailure: null,
        base: "AFFECTED",
        head: "UNKNOWN",
        moved: true,
      },
    ]);
    expect(renderReport(d)).toContain("PASS→FAIL  MOVED");
  });
});

describe("BL-029 differential: the report", () => {
  it("keeps the three differentials in separate sections, in order", () => {
    const report = renderReport(diffOf({}, {}));
    const at = (heading: string) => report.indexOf(heading);
    expect(at("## Graph differential")).toBeGreaterThan(0);
    expect(at("## Proof differential")).toBeGreaterThan(
      at("## Graph differential"),
    );
    expect(at("## Verdict differential")).toBeGreaterThan(
      at("## Proof differential"),
    );
    expect(report).toContain(
      "A zero differential is not evidence of soundness (OPEN-DEBTS D-12)",
    );
  });
});

function possibleTo(root: string, name: string): CallEdge["resolution"] {
  return { kind: "possible", target: `${root}/src/index.js#${name}@1:1` };
}

/** The default graph with main's line-2 call re-resolved. */
function graphWithLine2(
  root: string,
  resolution: CallEdge["resolution"],
): CallGraph {
  return graph(root, {
    edges: [
      edge(root, "main", 2, resolution),
      edge(root, "main", 3, resolvedTo(root, "b")),
    ],
  });
}

describe("A-2 differential: possible edges", () => {
  it("renders a possible edge as `~> target`, never as an unknown", () => {
    const d = diffOf(
      {},
      { graph: graphWithLine2(HEAD_ROOT, possibleTo(HEAD_ROOT, "a")) },
    );
    const site = d.graph.changed[0]?.sitesChanged[0];
    expect(site?.base).toEqual(["-> <project>/src/index.js#a@1:1"]);
    expect(site?.head).toEqual(["~> <project>/src/index.js#a@1:1"]);
  });

  it("counts a resolved call site withdrawn to possible", () => {
    const d = diffOf(
      {},
      { graph: graphWithLine2(HEAD_ROOT, possibleTo(HEAD_ROOT, "a")) },
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      withdrawnToPossible: 1,
      withdrawnToUnknown: 0,
      retargeted: 0,
    });
    expect(renderReport(d)).toContain("1 withdrawn to possible");
  });

  it("counts an unknown call site that became possible", () => {
    const d = diffOf(
      { graph: graphWithLine2(BASE_ROOT, UNKNOWN) },
      { graph: graphWithLine2(HEAD_ROOT, possibleTo(HEAD_ROOT, "a")) },
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      unknownToPossible: 1,
      unknownToResolved: 0,
    });
  });

  it("counts a possible call site that became resolved", () => {
    const d = diffOf(
      { graph: graphWithLine2(BASE_ROOT, possibleTo(BASE_ROOT, "a")) },
      {},
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      possibleToResolved: 1,
    });
  });

  it("counts a possible call site withdrawn to unknown", () => {
    const d = diffOf(
      { graph: graphWithLine2(BASE_ROOT, possibleTo(BASE_ROOT, "a")) },
      { graph: graphWithLine2(HEAD_ROOT, UNKNOWN) },
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      withdrawnToUnknown: 1,
      withdrawnToPossible: 0,
    });
  });

  it("counts a resolved edge beside an unknown one that became possible as withdrawn to possible", () => {
    const eval_: CallEdge["resolution"] = {
      kind: "unknown",
      reason: "eval",
      potentialTargets: [],
    };
    const site = (root: string, first: CallEdge["resolution"]) =>
      graph(root, {
        edges: [
          edge(root, "main", 2, first),
          edge(root, "main", 2, eval_),
          edge(root, "main", 3, resolvedTo(root, "b")),
        ],
      });
    const d = diffOf(
      { graph: site(BASE_ROOT, resolvedTo(BASE_ROOT, "a")) },
      { graph: site(HEAD_ROOT, possibleTo(HEAD_ROOT, "a")) },
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      withdrawnToPossible: 1,
      retargeted: 0,
    });
  });

  it("counts a possible call site given another possible target as retargeted", () => {
    const d = diffOf(
      { graph: graphWithLine2(BASE_ROOT, possibleTo(BASE_ROOT, "a")) },
      { graph: graphWithLine2(HEAD_ROOT, possibleTo(HEAD_ROOT, "b")) },
    );
    expect(summarize(d).graph).toMatchObject({
      sitesChanged: 1,
      retargeted: 1,
    });
  });
});
