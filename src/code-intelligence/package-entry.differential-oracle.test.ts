import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { createModuleResolver } from "./module-resolver.js";
import { resolveAuthoritativePackageEntries } from "./package-entry.js";
import { loadTsProject } from "./ts-project.js";

/**
 * PACKAGE-ENTRY DIFFERENTIAL ORACLE (P1-A3).
 *
 * For every package-entry form in the hermetic `package-entry` fixture,
 * compares:
 *
 * - **real Node** — `require.resolve(specifier)` from the fixture root,
 *   executed out-of-process by the real `node` binary, reporting either the
 *   file it would load or the error code it throws; against
 * - **VulnTrace** — {@link resolveAuthoritativePackageEntries}, the single
 *   relation that decides which file may answer for a package.
 *
 * The claim under test is narrow and precise: *VulnTrace adds no
 * package-resolution semantics of its own.* Where Node resolves a public
 * surface, VulnTrace must select exactly that file; where Node refuses one
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`, `MODULE_NOT_FOUND`), VulnTrace must
 * return nothing — never a sibling, never a `main` that `exports`
 * supersedes, never an internal file that merely exists.
 *
 * Deliberately a CommonJS comparison throughout: `require.resolve` answers
 * for exactly one condition set, so the reference context here is a `.cjs`
 * file and no entrypoints are supplied. Which branch of a CONDITIONAL
 * export a real consumer selects is a different question, pinned by
 * `verdict.package-entry.integration.test.ts` against both a `.cjs` and an
 * `.mjs` consumer.
 *
 * This oracle never executes target code inside the analyzer (AGENTS.md):
 * the child process only resolves specifiers, and the analyzer side is pure
 * resolution.
 */

const FIXTURE = "package-entry";

interface Case {
  /** The advisory-style module specifier. */
  readonly specifier: string;
  /** Install path relative to the fixture's `node_modules/`. */
  readonly instance: string;
  /** Why this case is in the matrix. */
  readonly shape: string;
}

const CASES: readonly Case[] = [
  {
    specifier: "expmain-lib",
    instance: "expmain-lib",
    shape: 'exports "." over main',
  },
  {
    specifier: "expmainsafe-lib",
    instance: "expmainsafe-lib",
    shape: 'exports "." over a reachable, same-named main',
  },
  {
    specifier: "shorthand-lib",
    instance: "shorthand-lib",
    shape: "exports string shorthand",
  },
  { specifier: "subpath-lib", instance: "subpath-lib", shape: 'exports "."' },
  {
    specifier: "subpath-lib/parse",
    instance: "subpath-lib",
    shape: "explicit exports subpath",
  },
  {
    specifier: "subpath-lib/lib/internal",
    instance: "subpath-lib",
    shape: "unexported internal file (encapsulation)",
  },
  {
    specifier: "subpathonly-lib",
    instance: "subpathonly-lib",
    shape: 'subpath-only package, no "." entry',
  },
  {
    specifier: "subpathonly-lib/get",
    instance: "subpathonly-lib",
    shape: "subpath-only package's subpath",
  },
  {
    specifier: "subpathonly-lib/missing",
    instance: "subpathonly-lib",
    shape: "undeclared subpath",
  },
  {
    specifier: "cond-lib",
    instance: "cond-lib",
    shape: "conditional exports, require branch",
  },
  {
    specifier: "condsafe-lib",
    instance: "condsafe-lib",
    shape: "conditional exports, safe require branch",
  },
  {
    specifier: "wildcard-lib/features/alpha",
    instance: "wildcard-lib",
    shape: "wildcard subpath with a matching file",
  },
  {
    specifier: "wildcard-lib/features/missing",
    instance: "wildcard-lib",
    shape: "wildcard subpath with no matching file",
  },
  {
    specifier: "wildcard-lib",
    instance: "wildcard-lib",
    shape: "pattern-only exports map, no root",
  },
  {
    specifier: "@scope/pkg",
    instance: "@scope/pkg",
    shape: "scoped package root",
  },
  {
    specifier: "@scope/pkg/api",
    instance: "@scope/pkg",
    shape: "scoped package subpath",
  },
  {
    specifier: "@scope/pkg/out/api.js",
    instance: "@scope/pkg",
    shape: "scoped package, unexported internal path",
  },
  {
    specifier: "@other/pkg",
    instance: "@other/pkg",
    shape: "same basename under another scope",
  },
  {
    specifier: "twin-lib",
    instance: "twin-lib",
    shape: "the real install of a twin pair",
  },
  {
    specifier: "twin-lib/api",
    instance: "twin-lib",
    shape: "the real install's subpath surface",
  },
  {
    specifier: "encap-lib",
    instance: "encap-lib",
    shape: "exports-encapsulated package root",
  },
  {
    specifier: "encap-lib/lib/vulnerable",
    instance: "encap-lib",
    shape: "reachable but unexported internal file",
  },
  {
    specifier: "mainonly-lib",
    instance: "mainonly-lib",
    shape: "main only, no exports",
  },
  {
    specifier: "badexports-lib",
    instance: "badexports-lib",
    shape: "exports target that is not there",
  },
  {
    specifier: "escape-lib",
    instance: "escape-lib",
    shape: "exports target escaping the package root",
  },
  {
    specifier: "subpathfwd-lib/api",
    instance: "subpathfwd-lib",
    shape: "forwarding subpath entry",
  },
  {
    specifier: "renamed-lib",
    instance: "renamed-lib",
    shape: "forwarding root entry",
  },
  {
    specifier: "unreach-lib",
    instance: "unreach-lib",
    shape: "plain exports root",
  },
];

/**
 * What real `node` would load for each specifier — or `null` when it
 * refuses. Runs out-of-process so the answer is the real loader's, not a
 * re-derivation of it.
 */
function nodeResolutions(root: string): Record<string, string | null> {
  const script = `
    const path = require("node:path");
    const specifiers = ${JSON.stringify(CASES.map((c) => c.specifier))};
    const out = {};
    for (const specifier of specifiers) {
      try {
        out[specifier] = require.resolve(specifier, { paths: [process.argv[1]] });
      } catch {
        out[specifier] = null;
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ["-e", script, root], {
    encoding: "utf-8",
  });
  return JSON.parse(stdout) as Record<string, string | null>;
}

describe("P1-A3 package-entry differential oracle (real node vs VulnTrace)", () => {
  it("selects exactly the file real Node loads, and nothing where Node refuses", async () => {
    const root = fixturePath(FIXTURE);
    const resolver = createModuleResolver(loadTsProject(root));
    const fromNode = nodeResolutions(root);

    const disagreements: string[] = [];

    for (const testCase of CASES) {
      const entries = await resolveAuthoritativePackageEntries({
        resolver,
        requestedModuleSpecifier: testCase.specifier,
        packageInstance: path.join(
          root,
          "node_modules",
          ...testCase.instance.split("/"),
        ),
        // A CommonJS reference context, to match `require.resolve`'s own
        // condition set exactly.
        referenceContext: path.join(root, "src", "expmain-consumer.cjs"),
        entrypointFiles: [],
      });

      const vulnTrace = entries.map((entry) => entry.resolvedFile).sort();
      // `null` is Node refusing; a missing key would mean the child script
      // and this matrix drifted apart, which must fail loudly rather than
      // read as a refusal.
      expect(fromNode).toHaveProperty(testCase.specifier);
      const node = fromNode[testCase.specifier] ?? null;
      const expected = node === null ? [] : [node];

      if (JSON.stringify(vulnTrace) !== JSON.stringify(expected)) {
        disagreements.push(
          `${testCase.specifier} (${testCase.shape}): node=${
            node === null ? "REFUSED" : path.relative(root, node)
          } vulntrace=${
            vulnTrace.length === 0
              ? "REFUSED"
              : vulnTrace.map((f) => path.relative(root, f)).join(",")
          }`,
        );
      }
    }

    expect(disagreements).toEqual([]);
  });

  it("covers every package-entry form this task implements", () => {
    // A guard against the matrix quietly shrinking: each named shape must
    // still be present.
    const shapes = CASES.map((c) => c.shape).join(" | ");
    for (const required of [
      "exports string shorthand",
      "explicit exports subpath",
      'subpath-only package, no "." entry',
      "conditional exports",
      "wildcard subpath",
      "scoped package root",
      "main only, no exports",
      "exports target that is not there",
      "exports target escaping the package root",
      "encapsulation",
    ]) {
      expect(shapes).toContain(required);
    }
  });
});
