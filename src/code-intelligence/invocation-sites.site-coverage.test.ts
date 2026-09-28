import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildCallGraph,
  type InvocationAccountObservation,
} from "./call-graph.js";
import { invocationSiteOf } from "./invocation-sites.js";
import { createModuleResolver } from "./module-resolver.js";
import { indexSourceFileFromDisk } from "./source-index.js";
import { loadTsProject } from "./ts-project.js";

/**
 * ADR 0008 invariant A1, measured (task A-1): every invocation site of
 * every file the call graph walks gets at least one account -- including
 * the sites in a branch VT-211 prunes -- over every fixture of the
 * validation and both adversarial corpora.
 *
 * The sites are enumerated INDEPENDENTLY of the walk: each walked file is
 * re-indexed and every node `invocationSiteOf` accepts is looked up among
 * the accounts `buildCallGraph` reported through `onInvocationAccount`.
 * "At least one", not "exactly one": RWF-023 visits a class member's
 * computed key twice by design (once under the class-definition owner,
 * once under the member), so a site in such a key is accounted twice.
 *
 * The walked files are the graph's module nodes. `prepareFile` registers
 * a module node for every file it prepares, and every prepared file is
 * walked unless a resource limit stops the walk (none is set here) -- so
 * a file prepared but never walked would show up below as a file whose
 * sites have no account at all.
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

const CORPORA = [
  "tests/validation/fixtures",
  "tests/adversarial/v1/fixtures",
  "tests/adversarial/v2/fixtures",
] as const;

const SOURCE_EXTENSION = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/;

function sourceFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFilesUnder(full);
    }
    return SOURCE_EXTENSION.test(entry) && !entry.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

function fixtureRoots(): string[] {
  return CORPORA.flatMap((corpus) => {
    const dir = path.join(REPO_ROOT, corpus);
    return readdirSync(dir)
      .map((entry) => path.join(dir, entry))
      .filter((full) => existsSync(path.join(full, "src")));
  });
}

function siteKey(file: string, node: ts.Node, kind: string): string {
  return `${file}|${kind}|${node.pos}:${node.end}`;
}

async function unaccountedSites(root: string): Promise<{
  readonly walkedFiles: number;
  readonly sites: number;
  readonly unaccounted: readonly string[];
}> {
  const entryFiles = sourceFilesUnder(path.join(root, "src"));
  const accounted = new Set<string>();
  const graph = await buildCallGraph({
    entryFiles,
    resolver: createModuleResolver(loadTsProject(root)),
    onInvocationAccount: (observation: InvocationAccountObservation) => {
      accounted.add(
        siteKey(observation.file, observation.site.node, observation.site.kind),
      );
    },
  });

  const walkedFiles = [
    ...new Set(
      graph.nodes.filter((n) => n.kind === "module").map((n) => n.module),
    ),
  ];
  let sites = 0;
  const unaccounted: string[] = [];
  for (const file of walkedFiles) {
    const { sourceFile } = indexSourceFileFromDisk(file);
    const visit = (node: ts.Node): void => {
      const site = invocationSiteOf(node);
      if (site) {
        sites++;
        if (!accounted.has(siteKey(file, node, site.kind))) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          unaccounted.push(
            `${path.relative(REPO_ROOT, file)}:${line + 1}:${character + 1} ${site.kind}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { walkedFiles: walkedFiles.length, sites, unaccounted };
}

describe("VT-INV-A1-invocation-accounting: every site of every walked file is accounted", () => {
  const roots = fixtureRoots();

  it("finds the corpora", () => {
    expect(roots.length).toBeGreaterThan(100);
  });

  it.each(roots.map((root) => [path.relative(REPO_ROOT, root), root]))(
    "%s",
    async (_name, root) => {
      const result = await unaccountedSites(root);
      expect(result.walkedFiles).toBeGreaterThan(0);
      expect(result.unaccounted).toEqual([]);
    },
  );
});
