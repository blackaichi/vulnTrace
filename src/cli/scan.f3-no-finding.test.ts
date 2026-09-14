import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScanCommand } from "./scan.js";
import type {
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import type { UnreportedCandidate } from "./output.js";

/**
 * FOUNDATION F3 -- the NO-FINDING half, end to end through a real scan.
 *
 * THE DEFECT. A candidate that produced no finding row carried nothing at
 * all, so two completely different states reached a consumer as identical
 * bytes:
 *
 *   "this advisory confidently does not apply to this instance"
 *   "nobody could determine whether this advisory applies"
 *
 * `RWB-09b` is scored as a disagreement for exactly that reason. The
 * patched `semver@7.5.2` instance is outside the advisory's range, so
 * producing no finding is CORRECT -- and the report had no way to say so,
 * leaving the oracle to compare an expected `NOT_AFFECTED` against the
 * string `NO_FINDING`.
 *
 * WHAT IS BEING PROTECTED HERE. The two dispositions must never converge:
 *
 *  - out-of-range must stay a CONCLUSION and must not become uncertainty
 *    merely because a taxonomy now exists to hold one (F3 § 3, attack C);
 *  - neither disposition may become a NOT_AFFECTED, because no
 *    reachability analysis ran for either and there is no negative proof
 *    to promote (F3 § 25, attack B);
 *  - a version conflict must not fabricate an advisory finding to make
 *    the taxonomy tidy (F3 § 4, attack K).
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

/** The advisory used throughout: `vuln-lib`, affected below 2.0.0. */
const ADVISORY: RawVulnerability = {
  id: "GHSA-f3-nofinding",
  affected: [
    {
      package: { ecosystem: "npm", name: "vuln-lib" },
      ranges: [
        {
          type: "SEMVER",
          events: [{ introduced: "0" }, { fixed: "2.0.0" }],
        },
      ],
    },
  ],
};

function providerFor(
  advisories: readonly RawVulnerability[],
): VulnerabilityProvider {
  return {
    queryPackage: (): Promise<readonly RawVulnerability[]> =>
      Promise.resolve(advisories),
  };
}

interface ScanFindingShape {
  readonly verdict: string;
  readonly package: string;
  readonly vulnerability: string;
  readonly version?: string;
  readonly packageInstance?: string;
  readonly unknownReasons?: { readonly reason: string }[];
}

interface ScanOutputShape {
  readonly findings: ScanFindingShape[];
  readonly diagnostics: { readonly source: string; readonly message: string }[];
  readonly unreportedCandidates: UnreportedCandidate[];
}

/**
 * A provider that RECORDS every query it is asked to make.
 *
 * The recording is the point. "No advisory was evaluated against this
 * instance" is only half the contract; the other half is that the scan did
 * not invent or borrow a version in order to ask about it, and the only
 * way to see that is to look at what was actually asked.
 */
function recordingProvider(advisories: readonly RawVulnerability[]): {
  readonly provider: VulnerabilityProvider;
  readonly queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    provider: {
      queryPackage: (query): Promise<readonly RawVulnerability[]> => {
        queries.push(`${query.name}@${query.version ?? "(no version)"}`);
        return Promise.resolve(advisories);
      },
    },
  };
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f3-nf-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

async function scan(
  root: string,
  provider: VulnerabilityProvider,
): Promise<{ readonly output: ScanOutputShape; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  });
  return {
    output: JSON.parse(stdout.join("")) as ScanOutputShape,
    stderr: stderr.join(""),
  };
}

/** A project with one installed `vuln-lib` at the given version. */
function projectWithLib(options: {
  readonly installedVersion?: string;
  readonly lockVersion?: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
}): string {
  const files: Record<string, string> = {
    "vulntrace.yml": CONFIG,
    "rules.yml": "rules: []\n",
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "vuln-lib": "^1.0.0" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "^1.0.0" },
        },
        ...(options.lockVersion === undefined
          ? {}
          : { "node_modules/vuln-lib": { version: options.lockVersion } }),
      },
    }),
    "src/index.js":
      'const lib = require("vuln-lib");\n' +
      "function main(input) {\n  return lib.safe(input);\n}\n" +
      "module.exports = { main };\n",
    ...options.extraFiles,
  };

  if (options.installedVersion !== undefined) {
    files["node_modules/vuln-lib/package.json"] = JSON.stringify({
      name: "vuln-lib",
      version: options.installedVersion,
    });
    files["node_modules/vuln-lib/index.js"] =
      "function vulnerable(x){ return x; }\n" +
      "function safe(x){ return x; }\n" +
      "module.exports = { vulnerable, safe };\n";
  }

  return project(files);
}

const undetermined = (output: ScanOutputShape): UnreportedCandidate[] =>
  output.unreportedCandidates.filter(
    (entry) => entry.disposition === "undetermined",
  );

const notApplicable = (output: ScanOutputShape): UnreportedCandidate[] =>
  output.unreportedCandidates.filter(
    (entry) => entry.disposition === "not_applicable",
  );

describe("F3 test matrix H/I/K: out-of-range stays a conclusion, not uncertainty", () => {
  /**
   * ROW H, and the RWB-09b shape exactly.
   *
   * `vuln-lib@2.5.0` is outside the advisory's `< 2.0.0` range. No finding
   * is produced, which is correct and unchanged. What changed is that the
   * reason is now sayable.
   */
  it("H: an out-of-range package produces no finding and a not_applicable entry", async () => {
    const { output } = await scan(
      projectWithLib({ installedVersion: "2.5.0", lockVersion: "2.5.0" }),
      providerFor([ADVISORY]),
    );

    expect(output.findings).toHaveLength(0);

    const entries = notApplicable(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      stage: "advisory_applicability",
      disposition: "not_applicable",
      vulnerability: "GHSA-f3-nofinding",
      package: "vuln-lib",
      version: "2.5.0",
      reason: "advisory_not_applicable_to_installed_version",
    });
  });

  /**
   * ATTACK C, stated as its own assertion because it is the single easiest
   * mistake to make once a taxonomy exists: sweeping out-of-range into the
   * uncertainty bucket because it is now convenient to have a bucket.
   */
  it("H: a not_applicable entry carries NO uncertainty category", async () => {
    const { output } = await scan(
      projectWithLib({ installedVersion: "2.5.0", lockVersion: "2.5.0" }),
      providerFor([ADVISORY]),
    );

    for (const entry of notApplicable(output)) {
      expect(entry.category).toBeUndefined();
    }
    // And it is not counted as uncertainty anywhere.
    expect(undetermined(output)).toHaveLength(0);
  });

  /**
   * ATTACK B / F3 § 25. The most important negative in this file.
   *
   * "No finding" is not "proved safe". An out-of-range entry is a
   * statement about VERSION RANGES: no reachability ran, so there is no
   * negative proof, and nothing may present it as one.
   */
  it("H: a not_applicable entry is never a NOT_AFFECTED verdict", async () => {
    const { output } = await scan(
      projectWithLib({ installedVersion: "2.5.0", lockVersion: "2.5.0" }),
      providerFor([ADVISORY]),
    );

    // No finding at all, so certainly no NOT_AFFECTED.
    expect(
      output.findings.filter((f) => f.verdict === "NOT_AFFECTED"),
    ).toHaveLength(0);
    // And the entry itself is structurally incapable of carrying one: the
    // shape has no verdict and no evidence field to put a proof in.
    for (const entry of notApplicable(output)) {
      expect(entry).not.toHaveProperty("verdict");
      expect(entry).not.toHaveProperty("evidence");
      expect(entry.detail).toContain("not a proof");
    }
  });

  /**
   * ROW I -- a package the advisory names that is not installed at all.
   *
   * Distinct from out-of-range in the only way that matters: there is no
   * instance, so there is nothing to be in or out of range, and the scan
   * says nothing rather than concluding anything.
   */
  it("I: an absent package is distinguishable from an out-of-range one", async () => {
    // The lockfile and manifest declare `vuln-lib`, but nothing is
    // installed under node_modules.
    const { output } = await scan(
      projectWithLib({ lockVersion: "1.0.0" }),
      providerFor([ADVISORY]),
    );

    // Whatever this scan concludes, it must not be the out-of-range
    // conclusion: no installed instance was ever compared to a range.
    expect(
      output.unreportedCandidates.filter(
        (entry) =>
          entry.reason === "advisory_not_applicable_to_installed_version",
      ),
    ).toHaveLength(0);
  });

  /**
   * ATTACK K. A conflicted version must not conjure an advisory finding.
   *
   * The temptation is real: an UNKNOWN finding would be a tidier place to
   * hang the reason. But there is no advisory established for this
   * instance, so a finding naming one would be inventing the very fact the
   * entry exists to say is missing.
   */
  it("K: a version conflict records an entry and fabricates no finding", async () => {
    const { output } = await scan(
      // The lockfile says 1.0.0; the installed manifest says 1.5.0.
      projectWithLib({ installedVersion: "1.5.0", lockVersion: "1.0.0" }),
      providerFor([ADVISORY]),
    );

    const conflicts = output.unreportedCandidates.filter(
      (entry) => entry.reason === "installed_version_conflicted",
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      stage: "package_identity",
      disposition: "undetermined",
      // ROW E: a version conflict is an IDENTITY failure -- the version is
      // an applicability identity fact, and without it no range can be
      // evaluated.
      category: "identity_unresolved",
      package: "vuln-lib",
    });

    // F3 § 16: the diagnostic is NOT removed, and says the same thing in
    // the same words, so the two channels cannot contradict each other
    // (attack L).
    const diagnostic = output.diagnostics.find(
      (entry) =>
        entry.source === "dependencies" &&
        entry.message.includes("conflicting versions"),
    );
    expect(diagnostic).toBeDefined();
    expect(conflicts[0]?.detail).toBe(diagnostic?.message);
  });
});

describe("F3 test matrix G: workspace incompleteness reaches the structured model", () => {
  function monorepo(
    workspaces: unknown,
    extraFiles: Readonly<Record<string, string>> = {},
  ): string {
    return project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules: []\n",
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces,
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "app", version: "1.0.0" } },
      }),
      "src/index.js": "module.exports = { main: (x) => x };\n",
      ...extraFiles,
    });
  }

  /**
   * ROW G. A traversal bound is `budget_exceeded` and nothing else --
   * raising a limit closes it, and no frontend work does (attack E).
   */
  it("G: a truncated workspace traversal is budget_exceeded", async () => {
    // A `**` pattern below a deliberately deep tree, so enumeration hits
    // the analyzer's own descendant-depth bound.
    const deep: Record<string, string> = {};
    let dir = "packages";
    for (let depth = 0; depth < 12; depth += 1) {
      dir = `${dir}/nested${String(depth)}`;
      deep[`${dir}/package.json`] = JSON.stringify({
        name: `pkg${String(depth)}`,
        version: "1.0.0",
      });
    }

    const { output } = await scan(
      monorepo(["packages/**"], deep),
      providerFor([]),
    );

    const truncated = output.unreportedCandidates.filter(
      (entry) => entry.reason === "workspace_enumeration_truncated",
    );
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({
      stage: "workspace_discovery",
      disposition: "undetermined",
      category: "budget_exceeded",
    });
    // F3 § 5: no package is named, because what is missing is exactly the
    // set of packages nobody enumerated. A placeholder here would be a lie
    // in the one field a consumer would key on.
    expect(truncated[0]?.package).toBeUndefined();
    expect(truncated[0]?.packageInstance).toBeUndefined();
  });

  /**
   * The three workspace reasons land in THREE different categories, which
   * is the entire argument for typing them rather than leaving prose.
   */
  it("separates an uninterpretable declaration from an unsupported pattern shape", async () => {
    const uninterpretable = await scan(
      monorepo({ notPackages: 7 }),
      providerFor([]),
    );
    expect(
      uninterpretable.output.unreportedCandidates.map((e) => [
        e.reason,
        e.category,
      ]),
    ).toEqual([
      ["workspace_declaration_uninterpretable", "identity_unresolved"],
    ]);

    const unsupportedPattern = await scan(
      monorepo(["packages/!secret"]),
      providerFor([]),
    );
    expect(
      unsupportedPattern.output.unreportedCandidates.map((e) => [
        e.reason,
        e.category,
      ]),
    ).toEqual([["workspace_pattern_unsupported", "unmodeled_construct"]]);
  });

  /**
   * F3 § 15 -- the channel boundary, asserted rather than asserted-in-prose.
   *
   * `diagnostics` keeps every message it had before F3, word for word.
   * The structured channel adds classification; it does not move, reword
   * or replace the operational one.
   */
  it("keeps diagnostics unchanged alongside the structured entries", async () => {
    const { output, stderr } = await scan(
      monorepo({ notPackages: 7 }),
      providerFor([]),
    );

    const workspaceDiagnostics = output.diagnostics.filter(
      (entry) => entry.source === "workspaces",
    );
    expect(workspaceDiagnostics).toHaveLength(1);
    expect(workspaceDiagnostics[0]?.message).toContain("not a supported shape");
    // Same sentence in both channels (attack L).
    expect(output.unreportedCandidates[0]?.detail).toBe(
      workspaceDiagnostics[0]?.message,
    );
    // And the human stream still gets its line.
    expect(stderr).toContain("not a supported shape");
  });
});

describe("F3 § 27: unreportedCandidates ordering is deterministic", () => {
  /**
   * These entries come from three different loops, and the advisory
   * fan-out inherits the registry's insertion order for a package name.
   * Scanning the same project twice must produce byte-identical bytes.
   */
  it("produces byte-identical entries for the same project scanned twice", async () => {
    const root = projectWithLib({
      installedVersion: "2.5.0",
      lockVersion: "2.5.0",
    });
    const first = await scan(root, providerFor([ADVISORY]));
    const second = await scan(root, providerFor([ADVISORY]));

    expect(JSON.stringify(second.output.unreportedCandidates)).toBe(
      JSON.stringify(first.output.unreportedCandidates),
    );
  });

  it("sorts entries by stage, widest first", async () => {
    const { output } = await scan(
      projectWithLib({ installedVersion: "2.5.0", lockVersion: "2.5.0" }),
      providerFor([ADVISORY]),
    );

    const order = [
      "workspace_discovery",
      "package_identity",
      "advisory_applicability",
    ];
    const seen = output.unreportedCandidates.map((entry) =>
      order.indexOf(entry.stage),
    );
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe("F3 § 4 / F-1: an instance whose version was never established", () => {
  /**
   * THE PATH THIS PROTECTS, and why it needs its own regression.
   *
   * `advisoryQueryVersions` contributes no query for an instance with no
   * established version -- correctly, because there is nothing to ask
   * about. An instance whose SIBLINGS have versions is still rescued: it
   * is evaluated against whatever their queries returned and reaches its
   * own honest UNKNOWN finding (the second describe below pins that).
   *
   * But when NO instance of the package name has a version, no query
   * happens at all, no advisory is ever surfaced, and before F3 the
   * instance produced no finding and no note -- it simply vanished from
   * the report. "This package has no known advisories" and "nobody could
   * ask whether this package has advisories" were the same silence.
   *
   * This is the only entirely new no-finding path F3 introduced, and the
   * independent F3 audit found it had no committed coverage: it was
   * reachable and correct, but nothing guarded it. AGENTS.md requires a
   * test for every behavior change, so here it is, exercised through the
   * real `runScanCommand` orchestration rather than through the mapping
   * helper -- the helper cannot tell anyone whether the orchestration
   * still reaches it.
   */
  const VERSIONLESS_WORKSPACE_PACKAGE: Readonly<Record<string, string>> = {
    "vulntrace.yml": CONFIG,
    "rules.yml": "rules: []\n",
    // A workspace member with a name and NO version is the realistic
    // shape: a private monorepo package that is never published, so it
    // has no version to declare. P1-A5/F1 made these enumerable; they are
    // genuine PackageInstances with genuine identity and no version.
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "app", version: "1.0.0" } },
    }),
    "packages/vuln-lib/package.json": JSON.stringify({ name: "vuln-lib" }),
    "packages/vuln-lib/index.js":
      "function vulnerable(x){ return x; }\nmodule.exports = { vulnerable };\n",
    "src/index.js": "module.exports = { main: () => 1 };\n",
  };

  it("records it as an undetermined candidate instead of dropping it", async () => {
    const { provider, queries } = recordingProvider([ADVISORY]);
    const { output } = await scan(
      project(VERSIONLESS_WORKSPACE_PACKAGE),
      provider,
    );

    // NO QUERY AT ALL. Not a query with a borrowed version, not one with a
    // fabricated version, not one with the package's directory name
    // standing in for a version.
    expect(queries).toEqual([]);

    // NO SYNTHETIC FINDING. There is no advisory to name -- the provider
    // was never asked -- so inventing a finding would be inventing the
    // very fact this entry exists to say is missing (F3 § 4).
    expect(output.findings).toEqual([]);

    // Selected by REASON, never by array position (F3 § 27): candidate
    // ordering is a function of what was unreported, and a positional
    // assertion would silently start testing something else the day
    // another entry is added.
    const entry = output.unreportedCandidates.find(
      (candidate) => candidate.reason === "installed_version_unavailable",
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      stage: "package_identity",
      disposition: "undetermined",
      package: "vuln-lib",
      // Exact instance identity, not the package name.
      packageInstance: "packages/vuln-lib",
      category: "identity_unresolved",
    });
    // No version key at all, rather than "" or a placeholder: a consumer
    // must be able to tell "no version established" from "version is the
    // empty string".
    expect(entry?.version).toBeUndefined();
    // It names no advisory, honestly, because none was ever discovered.
    expect(entry?.vulnerability).toBeUndefined();
  });

  it("reaches no confident verdict about it in either direction", async () => {
    const { provider } = recordingProvider([ADVISORY]);
    const { output } = await scan(
      project(VERSIONLESS_WORKSPACE_PACKAGE),
      provider,
    );

    // The whole point of the entry is that nothing is claimed. An
    // AFFECTED would be fabricated; a NOT_AFFECTED would be an unproven
    // negative, which is the failure AGENTS.md forbids outright.
    expect(output.findings.filter((f) => f.verdict === "AFFECTED")).toEqual([]);
    expect(output.findings.filter((f) => f.verdict === "NOT_AFFECTED")).toEqual(
      [],
    );
    // And it is emphatically not the out-of-range conclusion: no installed
    // version was ever compared against any range.
    expect(
      output.unreportedCandidates.filter(
        (c) => c.reason === "advisory_not_applicable_to_installed_version",
      ),
    ).toEqual([]);
  });
});

describe("F3 § 4 / F-1 control: a sibling's version is never borrowed", () => {
  /**
   * The other half of the contract, and the one that would break silently.
   *
   * Instance A has no version. Instance B shares A's ownership name and
   * has a concrete one. B's version legitimately drives the provider
   * query -- that is how the advisory is discovered at all -- and the
   * danger is that A then gets evaluated against a range using B's
   * version, which would be a statement about a different physical
   * install.
   *
   * What must happen instead: A is evaluated against the advisory with its
   * OWN (absent) version, which is `indeterminate`, so A reaches an honest
   * UNKNOWN finding. F3 § 4 requires that existing rescue to be preserved,
   * which also means A must NOT appear as an unreported candidate here --
   * the two representations are mutually exclusive, and this pins that
   * boundary from the other side.
   */
  const TWO_INSTANCES: Readonly<Record<string, string>> = {
    "vulntrace.yml": CONFIG,
    "rules.yml": "rules: []\n",
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { "vuln-lib": "^1.0.0" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "^1.0.0" },
        },
        "node_modules/vuln-lib": { version: "1.0.0" },
      },
    }),
    // A: versionless.
    "packages/vuln-lib/package.json": JSON.stringify({ name: "vuln-lib" }),
    "packages/vuln-lib/index.js":
      "function vulnerable(x){ return x; }\nmodule.exports = { vulnerable };\n",
    // B: same ownership name, concrete version.
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/vuln-lib/index.js":
      "function vulnerable(x){ return x; }\nmodule.exports = { vulnerable };\n",
    "src/index.js": "module.exports = { main: () => 1 };\n",
  };

  it("queries only the sibling's real version, never one invented for A", async () => {
    const { provider, queries } = recordingProvider([ADVISORY]);
    await scan(project(TWO_INSTANCES), provider);

    // Exactly one query, carrying B's own version. One query per distinct
    // installed VERSION -- never one per instance -- so A contributes
    // none, and no query is ever made on A's behalf.
    expect(queries).toEqual(["vuln-lib@1.0.0"]);
  });

  it("gives A its own instance-local UNKNOWN rather than B's version", async () => {
    const { provider } = recordingProvider([ADVISORY]);
    const { output } = await scan(project(TWO_INSTANCES), provider);

    const a = output.findings.find(
      (f) => f.packageInstance === "packages/vuln-lib",
    );
    const b = output.findings.find(
      (f) => f.packageInstance === "node_modules/vuln-lib",
    );

    // A exists as a finding -- F3 § 4's "preserve that behavior" -- and
    // therefore NOT as an unreported candidate.
    expect(a).toBeDefined();
    expect(output.unreportedCandidates).toEqual([]);

    // THE ASSERTION THIS FILE EXISTS FOR: A carries no version. If it ever
    // borrowed B's, this would read "1.0.0" and the report would be making
    // a claim about a different physical install.
    expect(a?.version).toBeUndefined();
    expect(b?.version).toBe("1.0.0");

    // A's uncertainty is about ITS OWN applicability, not about B.
    expect(a?.verdict).toBe("UNKNOWN");
    expect(a?.unknownReasons?.map((r) => r.reason)).toEqual([
      "advisory_version_applicability_indeterminate",
    ]);

    // Neither instance acquires a confident verdict from the other.
    expect(output.findings.filter((f) => f.verdict === "AFFECTED")).toEqual([]);
    expect(output.findings.filter((f) => f.verdict === "NOT_AFFECTED")).toEqual(
      [],
    );
  });
});

describe("F3 § 21: the array is always present", () => {
  it("emits an empty array rather than omitting the key when nothing is unreported", async () => {
    // An installed, in-range package with an advisory produces a FINDING,
    // not an unreported candidate -- so the array is legitimately empty,
    // and must still be there. A consumer must never have to tell "no
    // unreported candidates" from "this scan predates the field".
    const { output } = await scan(
      projectWithLib({ installedVersion: "1.0.0", lockVersion: "1.0.0" }),
      providerFor([ADVISORY]),
    );

    expect(output.findings.length).toBeGreaterThan(0);
    expect(output.unreportedCandidates).toEqual([]);
  });
});
