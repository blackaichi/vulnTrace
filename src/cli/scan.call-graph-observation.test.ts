import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import { adversarialV1Provider } from "../testing/adversarial-providers.js";
import { runScanCommand } from "./scan.js";

/**
 * BL-029 -- `RunScanOptions.onCallGraph` is an OBSERVATION seam and
 * nothing else.
 *
 * The differential tool reads the call graph through it, so the seam must
 * report the graph the scan really built, exactly once, and must be
 * structurally unable to change what the scan concludes. Each property is
 * a separate test, because each can break on its own: a second invocation
 * (the graph reported twice, e.g. once per finding), a changed output (the
 * seam moved in the order of operations), and a leaked reference (the
 * callback handed the very graph the proof context binds, so a careless
 * observer could retarget an edge the verdicts are computed from).
 *
 * Scans the v1 adversarial fixture ADV-001 in place, exactly as its suite
 * does: `main()` calls `adv-vuln-lib`'s `vulnerable()` directly, so the
 * finding is AFFECTED only through a real resolved edge -- the edge the
 * mutation test below deletes from its copy.
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const FIXTURE = path.join(
  REPO_ROOT,
  "tests",
  "adversarial",
  "v1",
  "fixtures",
  "adv-001-direct-esm-call",
);

type Observed = { readonly graph: CallGraph; readonly truncated: boolean };

async function scan(
  onCallGraph?: (observed: Observed) => void,
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const stdout: string[] = [];
  const exitCode = await runScanCommand({
    projectPathArg: FIXTURE,
    configPathOverride: path.join(FIXTURE, "vulntrace.yml"),
    provider: adversarialV1Provider(),
    noCache: true,
    io: { stdout: (t) => stdout.push(t), stderr: () => undefined },
    ...(onCallGraph ? { onCallGraph } : {}),
  });
  return {
    exitCode,
    output: JSON.parse(stdout.join("")) as Record<string, unknown>,
  };
}

/** Everything but the per-run scan ID and the wall-clock timings. */
function comparable(output: Record<string, unknown>): unknown {
  const { scan: _scan, timings: _timings, ...rest } = output;
  void _scan;
  void _timings;
  return rest;
}

function verdicts(output: Record<string, unknown>): string[] {
  return (output.findings as ReadonlyArray<{ verdict: string }>).map(
    (f) => f.verdict,
  );
}

describe("BL-029: onCallGraph observes the scan's call graph without influencing it", () => {
  it("fires exactly once, with the graph the scan built", async () => {
    const seen: Observed[] = [];
    const { exitCode } = await scan((observed) => seen.push(observed));

    // 1: the scan completed and reported an AFFECTED finding.
    expect(exitCode).toBe(1);
    expect(seen).toHaveLength(1);
    const [observed] = seen;
    expect(observed?.truncated).toBe(false);
    // The resolved edge the AFFECTED verdict rests on is in what the seam
    // reports: an edge into adv-vuln-lib's `vulnerable` function.
    const nodesById = new Map(
      (observed?.graph.nodes ?? []).map((n) => [n.id, n]),
    );
    const intoVulnerable = (observed?.graph.edges ?? []).filter(
      (e) =>
        e.resolution.kind === "resolved" &&
        nodesById.get(e.resolution.target)?.name === "vulnerable" &&
        (nodesById.get(e.resolution.target)?.module ?? "").includes(
          `${path.sep}adv-vuln-lib${path.sep}`,
        ),
    );
    expect(intoVulnerable.length).toBeGreaterThan(0);
  });

  it("leaves the scan output unchanged (apart from scan ID and timings)", async () => {
    const without = await scan();
    const withSeam = await scan(() => undefined);

    expect(verdicts(without.output)).toEqual(["AFFECTED"]);
    expect(withSeam.exitCode).toBe(without.exitCode);
    expect(comparable(withSeam.output)).toEqual(comparable(without.output));
  });

  it("hands the callback a copy: emptying it cannot change a verdict", async () => {
    const without = await scan();
    const withMutation = await scan(({ graph }) => {
      // Deliberately ignores the readonly types, as a careless observer
      // could. Had the seam passed the graph the proof context binds, the
      // AFFECTED path would vanish with these arrays.
      (graph.edges as CallEdge[]).length = 0;
      (graph.nodes as GraphNode[]).length = 0;
    });

    expect(verdicts(withMutation.output)).toEqual(["AFFECTED"]);
    expect(comparable(withMutation.output)).toEqual(comparable(without.output));
  });
});
