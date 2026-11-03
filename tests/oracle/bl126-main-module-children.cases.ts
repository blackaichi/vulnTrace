import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";
import {
  type Bl096Case,
  oracleCase,
} from "./bl096-module-paths-read-only.cases.js";

/**
 * Task BL-126 (docs/tasks/BL-126-trust-boundary-all-builtins.md), from its
 * independent audit (round 1, B1): a change to a module loader object,
 * which stays INSIDE the claim under the trust boundary over the runtime's
 * built-in objects (SOUNDNESS-CONTRACT § 1, "What it does not cover:
 * Node's module loader objects"), reached through `process.mainModule`'s
 * `children` -- the lookup list of `wrap`'s own module object, shifted so
 * that its later `require` skips `wrap/node_modules` and loads the
 * affected top-level instance instead of the decoy.
 *
 * The analyzer misses it (RWF-165, pre-existing: the analyzer is the
 * base's): each such case is an open-soundness-defect record, never an
 * expectation. The same change through `require.main.children` is
 * modeled (`UNKNOWN`), and the same program reading the list without
 * changing it keeps its proof, where real Node loads the decoy.
 *
 * THE SETUP is BL-092's and BL-096's (see their cases files). Measured on
 * this task's branch, whose analyzer rules are unchanged from the base
 * (`85195065`; only disclosure strings differ), with real Node v22.11.0.
 */

export {
  ADVISORY_ID,
  TARGET_MARKER,
} from "./bl092-loader-capability-routes.cases.js";

export { oracleCase };

/** The family-B proof the analyzer gives for a case it misses. */
function familyB(unknownEdges: number): VerdictObservation {
  return {
    verdict: "NOT_AFFECTED",
    proofFamily: "B",
    target: "vuln-lib#parse",
    reachableSubgraphComplete: false,
    unknownEdges,
  };
}

export const ALL_CASES: readonly Bl096Case[] = [
  {
    id: "main-module.children-paths-shift",
    finding: "RWF-165",
    mechanism:
      "`process.mainModule.children[0].paths.shift()`: `wrap`'s own module object reached through the main module's `children`, its lookup list changed",
    redirect: `process.mainModule.children[0].paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-165", observed: familyB(1) },
  },
  {
    id: "main-module.children-alias",
    finding: "RWF-165",
    mechanism:
      "`const c = process.mainModule.children; c[0].paths.shift();`: the same list through an alias",
    redirect: `const c = process.mainModule.children;\nc[0].paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-165", observed: familyB(1) },
  },
  {
    id: "main-module.children-paths-assign",
    finding: "RWF-165",
    mechanism:
      "`process.mainModule.children[0].paths = […]`: the lookup list replaced, without `wrap/node_modules`",
    redirect: `process.mainModule.children[0].paths = process.mainModule.children[0].paths.slice(1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-165", observed: familyB(2) },
  },
  {
    id: "modeled.require-main-children",
    finding: "RWF-165",
    mechanism:
      "`require.main.children[0].paths.shift()`: the same module object through `require.main`, modeled",
    redirect: `require.main.children[0].paths.shift();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "control.main-module-children-read",
    finding: "RWF-165",
    mechanism:
      "`process.mainModule.children[0].paths` read and kept, not changed: Node loads the decoy",
    redirect: `const __p = process.mainModule.children[0].paths;\nvoid __p;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
