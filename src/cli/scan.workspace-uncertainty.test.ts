import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScanCommand } from "./scan.js";
import type {
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";

/**
 * FOUNDATION F1-A -- WORKSPACE DISCOVERY INCOMPLETENESS, end to end.
 *
 * `discoverWorkspacePackages` has always detected the layouts it cannot
 * enumerate. What it could not do was TELL ANYONE in a form a program can
 * read: the reasons went to stderr, so a consumer parsing `ScanOutput`
 * saw a scan of an incompletely enumerated monorepo as indistinguishable
 * from a scan of a fully enumerated one. The verdict layer failed closed
 * throughout -- this is not a wrong-verdict defect -- but AGENTS.md's
 * "every uncertainty must be represented explicitly" is not satisfied by
 * a line on a stream nothing structured reads.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NO_ADVISORIES: VulnerabilityProvider = {
  queryPackage(): Promise<readonly RawVulnerability[]> {
    return Promise.resolve([]);
  },
};

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

interface ScanOutputShape {
  readonly diagnostics: { readonly source: string; readonly message: string }[];
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f1a-cli-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

/** A scannable project, with `workspaces` (and extra files) supplied. */
function monorepo(
  workspaces: unknown,
  extraFiles: Readonly<Record<string, string>> = {},
): string {
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": "rules: []\n",
    "package.json": JSON.stringify(
      workspaces === undefined
        ? { name: "app", version: "1.0.0" }
        : { name: "app", version: "1.0.0", workspaces },
    ),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "app", version: "1.0.0" } },
    }),
    "src/index.js":
      "function main(input) {\n  return input;\n}\nmodule.exports = { main };\n",
    ...extraFiles,
  });
}

async function scan(
  root: string,
  options: {
    readonly format?: "json" | "html";
    readonly outputPath?: string;
  } = {},
): Promise<{ readonly output: ScanOutputShape; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider: NO_ADVISORIES,
    noCache: true,
    ...(options.format ? { format: options.format } : {}),
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  });
  return {
    output:
      options.format === "html"
        ? { diagnostics: [] }
        : (JSON.parse(stdout.join("")) as ScanOutputShape),
    stderr: stderr.join(""),
  };
}

function workspaceDiagnostics(output: ScanOutputShape): readonly string[] {
  return output.diagnostics
    .filter((diagnostic) => diagnostic.source === "workspaces")
    .map((diagnostic) => diagnostic.message);
}

describe("F1-A: workspace uncertainty reaches the machine-readable diagnostics", () => {
  it("reports an uninterpretable `workspaces` declaration", async () => {
    const { output, stderr } = await scan(monorepo({ notPackages: 7 }));

    expect(workspaceDiagnostics(output)).toHaveLength(1);
    expect(workspaceDiagnostics(output)[0]).toContain("not a supported shape");
    // The human-facing stream keeps its line too -- this adds a channel,
    // it does not move one.
    expect(stderr).toContain("not a supported shape");
  });

  it("reports an unsupported pattern while still honoring its siblings", async () => {
    const root = monorepo(["packages/*", "packages/!secret"], {
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        version: "1.0.0",
      }),
      "packages/lib/index.js": "module.exports = {};\n",
    });

    const { output } = await scan(root);

    expect(workspaceDiagnostics(output)).toHaveLength(1);
    expect(workspaceDiagnostics(output)[0]).toContain('"packages/!secret"');
  });

  it("reports a truncated traversal, and says instances may be missing", async () => {
    const files: Record<string, string> = {};
    let dir = "packages";
    for (let i = 0; i < 14; i++) {
      dir = `${dir}/d${i}`;
      files[`${dir}/package.json`] = JSON.stringify({
        name: `pkg${i}`,
        version: "1.0.0",
      });
    }
    const { output } = await scan(monorepo(["packages/**"], files));

    expect(workspaceDiagnostics(output)).toHaveLength(1);
    expect(workspaceDiagnostics(output)[0]).toContain(
      "could not be enumerated completely",
    );
    expect(workspaceDiagnostics(output)[0]).toContain(
      "may not have been analyzed",
    );
  });

  it("reports a pnpm-workspace.yaml-only layout", async () => {
    const root = monorepo(undefined, {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        version: "1.0.0",
      }),
      "packages/lib/index.js": "module.exports = {};\n",
    });

    const { output } = await scan(root);

    expect(workspaceDiagnostics(output)).toHaveLength(1);
    expect(workspaceDiagnostics(output)[0]).toContain("pnpm-workspace.yaml");
  });

  it("records no workspace diagnostic for an ordinary project (control)", async () => {
    const { output } = await scan(monorepo(undefined));

    expect(workspaceDiagnostics(output)).toEqual([]);
  });

  it("records no workspace diagnostic for a fully enumerated monorepo (control)", async () => {
    const root = monorepo(["packages/*"], {
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        version: "1.0.0",
      }),
      "packages/lib/index.js": "module.exports = {};\n",
    });

    const { output } = await scan(root);

    expect(workspaceDiagnostics(output)).toEqual([]);
  });

  it("emits one diagnostic per condition, not one per repetition", async () => {
    const { output } = await scan(
      monorepo(["packages/!secret", "packages/!secret"]),
    );

    expect(workspaceDiagnostics(output)).toHaveLength(1);
  });

  it("emits the same diagnostics whichever order the patterns are declared in", async () => {
    const forward = await scan(
      monorepo(["packages/*", "pkg-*", "packages/!secret"]),
    );
    const backward = await scan(
      monorepo(["packages/!secret", "pkg-*", "packages/*"]),
    );

    expect(workspaceDiagnostics(forward.output)).toEqual(
      workspaceDiagnostics(backward.output),
    );
    expect(workspaceDiagnostics(forward.output)).toHaveLength(2);
  });

  it("renders workspace uncertainty into the HTML report too", async () => {
    const reportPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "vulntrace-f1a-html-")),
      "report.html",
    );
    dirs.push(path.dirname(reportPath));
    const root = monorepo(undefined, {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    });

    await scan(root, { format: "html", outputPath: reportPath });

    const html = readFileSync(reportPath, "utf-8");
    expect(html).toContain("Diagnostics");
    expect(html).toContain("pnpm-workspace.yaml");
    expect(html).toContain("workspaces");
  });
});
