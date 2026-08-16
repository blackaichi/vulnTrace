import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DependencyNode } from "../domain/dependency.js";
import { summarizeZodError } from "../shared/zod-issues.js";
import {
  CycloneDxFileNotFoundError,
  CycloneDxSyntaxError,
  CycloneDxValidationError,
} from "./cyclonedx-errors.js";

/**
 * This module is VulnTrace's only CycloneDX-aware code (see docs/SDD.md
 * § 27: "SBOM ingestion is intentionally a boundary"). Only the fields
 * needed to map onto {@link DependencyNode} are modeled — this is not a
 * general-purpose CycloneDX library. Nothing outside `src/dependencies/`
 * (in particular, `src/domain/` and the package.json/package-lock.json
 * dependency graph builder in dependency-graph.ts) knows this schema
 * exists; it only ever produces plain `DependencyNode[]`.
 */
const CycloneDxComponentSchema = z.object({
  type: z.string().optional(),
  name: z.string(),
  version: z.string().optional(),
  purl: z.string().optional(),
  "bom-ref": z.string().optional(),
});

export type CycloneDxComponent = z.infer<typeof CycloneDxComponentSchema>;

const CycloneDxDependencySchema = z.object({
  ref: z.string(),
  dependsOn: z.array(z.string()).default([]),
});

const CycloneDxDocumentSchema = z.object({
  bomFormat: z.literal("CycloneDX"),
  specVersion: z.string(),
  components: z.array(CycloneDxComponentSchema).default([]),
  dependencies: z.array(CycloneDxDependencySchema).default([]),
  metadata: z
    .object({
      component: CycloneDxComponentSchema.optional(),
    })
    .optional(),
});

export type CycloneDxDocument = z.infer<typeof CycloneDxDocumentSchema>;

/** Validates an already-parsed CycloneDX SBOM value. */
export function parseCycloneDx(raw: unknown): CycloneDxDocument {
  const result = CycloneDxDocumentSchema.safeParse(raw ?? {});

  if (!result.success) {
    throw new CycloneDxValidationError(summarizeZodError(result.error));
  }

  return result.data;
}

/** Parses CycloneDX SBOM text and validates it. */
export function parseCycloneDxText(
  jsonText: string,
  source = "<cyclonedx-sbom>",
): CycloneDxDocument {
  let raw: unknown;

  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CycloneDxSyntaxError(source, message, error);
  }

  return parseCycloneDx(raw);
}

/**
 * Reads a CycloneDX SBOM file from disk and validates it.
 *
 * Reading a static SBOM file is permitted under the project's security
 * constraints (see docs/SDD.md § 29): it is parsed as data and never
 * executed.
 */
export function loadCycloneDxFile(filePath: string): CycloneDxDocument {
  let text: string;

  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new CycloneDxFileNotFoundError(filePath, error);
  }

  return parseCycloneDxText(text, filePath);
}

function componentRef(component: CycloneDxComponent): string | undefined {
  return component["bom-ref"] ?? component.purl;
}

/** The purl "type" segment, e.g. "npm" for `pkg:npm/foo@1.0.0`. */
function purlEcosystem(purl: string | undefined): string | undefined {
  if (!purl) {
    return undefined;
  }
  const match = /^pkg:([^/]+)\//.exec(purl);
  return match?.[1];
}

interface QueueItem {
  readonly ref: string;
  readonly chain: readonly string[];
}

/**
 * Maps a CycloneDX SBOM onto the same normalized {@link DependencyNode}
 * shape the package.json/package-lock.json graph builder produces (see
 * docs/SDD.md § 11, § 27), so downstream consumers (vulnerability
 * matching, verdicts) never need to know which input produced a given
 * node.
 *
 * Differences from the lockfile-derived graph, both inherent to what a
 * CycloneDX document actually contains:
 * - `direct` is derived purely from the `dependencies[]` graph — whether a
 *   component is an immediate `dependsOn` of the root `metadata.component`
 *   — since CycloneDX has no `node_modules` install-path concept to
 *   cross-check against (contrast dependency-graph.ts's `isTopLevelPath`).
 * - `locations` is always `[]`: an SBOM describes what is present, not
 *   where on disk it physically lives.
 *
 * Only `pkg:npm/...` components are mapped; components in other
 * ecosystems are silently excluded, matching the MVP's npm-only scope
 * (AGENTS.md: "MVP excludes: multi-language support") rather than being
 * miscategorized as npm.
 *
 * If `metadata.component` (the root) is absent, no `direct`/`dependencyPaths`
 * can be determined — every mapped node then has `direct: false` and
 * `dependencyPaths: []`, which is the honest representation of "topology
 * unknown," not a guess.
 */
export function buildDependencyGraphFromCycloneDx(
  sbom: CycloneDxDocument,
): DependencyNode[] {
  const refToComponent = new Map<string, CycloneDxComponent>();

  for (const component of sbom.components) {
    const ref = componentRef(component);
    if (ref) {
      refToComponent.set(ref, component);
    }
  }

  const rootComponent = sbom.metadata?.component;
  const rootRef = rootComponent ? componentRef(rootComponent) : undefined;

  const dependsOnByRef = new Map<string, readonly string[]>();
  for (const dependency of sbom.dependencies) {
    dependsOnByRef.set(dependency.ref, dependency.dependsOn);
  }

  const dependencyPathByRef = new Map<string, readonly string[]>();

  if (rootRef) {
    const visited = new Set<string>([rootRef]);
    const queue: QueueItem[] = [{ ref: rootRef, chain: [] }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      for (const childRef of dependsOnByRef.get(current.ref) ?? []) {
        if (visited.has(childRef)) {
          continue;
        }
        visited.add(childRef);

        const childName = refToComponent.get(childRef)?.name ?? childRef;
        const chain = [...current.chain, childName];
        dependencyPathByRef.set(childRef, chain);
        queue.push({ ref: childRef, chain });
      }
    }
  }

  const nodes: DependencyNode[] = [];

  for (const [ref, component] of refToComponent) {
    if (ref === rootRef) {
      continue;
    }

    if (purlEcosystem(component.purl) !== "npm") {
      continue;
    }

    const { version } = component;
    if (!version) {
      continue;
    }

    const dependencyPath = dependencyPathByRef.get(ref);

    nodes.push({
      id: `sbom:${ref}`,
      name: component.name,
      version,
      ecosystem: "npm",
      direct: dependencyPath?.length === 1,
      locations: [],
      dependencyPaths: dependencyPath ? [dependencyPath] : [],
      purl: component.purl,
    });
  }

  return nodes;
}
