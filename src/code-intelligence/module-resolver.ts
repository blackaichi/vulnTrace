import ts from "typescript";
import type { TsProject } from "./ts-project.js";

export interface ResolvedPackageId {
  readonly name: string;
  readonly version: string;
  readonly subModuleName: string;
}

export interface ResolvedModule {
  readonly kind: "resolved";
  readonly resolvedFileName: string;
  readonly isExternalLibraryImport: boolean;
  readonly packageId?: ResolvedPackageId;
}

export interface ResolutionFailure {
  readonly kind: "unresolved";
  readonly specifier: string;
  readonly importer: string;
  readonly reason: string;
}

/**
 * See docs/SDD.md § 16. A plain union of two tagged variants (rather than
 * throwing on failure) — resolution failure is an expected, first-class
 * outcome (an unresolved import, a typo, an optional dependency that
 * isn't installed), not an exceptional condition (AGENTS.md: every
 * uncertainty must be represented explicitly).
 */
export type ModuleResolutionResult = ResolvedModule | ResolutionFailure;

/**
 * See docs/SDD.md § 16. `importerFilePath` (a plain path) stands in for
 * SDD's abstract `SourceFile` parameter: resolution only needs to know
 * where the importer is, not its parsed contents, so requiring a fully
 * parsed {@link SourceIndex} just to resolve one of its specifiers would
 * be an unnecessary coupling.
 */
export interface ModuleResolver {
  resolve(
    specifier: string,
    importerFilePath: string,
  ): Promise<ModuleResolutionResult>;
}

function toResolvedModule(resolved: ts.ResolvedModuleFull): ResolvedModule {
  return {
    kind: "resolved",
    resolvedFileName: resolved.resolvedFileName,
    isExternalLibraryImport: resolved.isExternalLibraryImport ?? false,
    packageId: resolved.packageId
      ? {
          name: resolved.packageId.name,
          version: resolved.packageId.version,
          subModuleName: resolved.packageId.subModuleName,
        }
      : undefined,
  };
}

/**
 * Determines whether the importer is being resolved as ESM or CommonJS —
 * required to pick the right side of a conditional package export
 * (`{"import": "...", "require": "..."}`) — by delegating to TypeScript's
 * own implementation of Node's file/package-scope format detection
 * (extension, and the nearest ancestor package.json's `"type"` field),
 * rather than reimplementing that lookup (see ADR-0001).
 */
function resolutionModeFor(
  importerFilePath: string,
  compilerOptions: ts.CompilerOptions,
): ts.ResolutionMode {
  return ts.getImpliedNodeFormatForFile(
    importerFilePath,
    undefined,
    ts.sys,
    compilerOptions,
  );
}

function resolveSync(
  specifier: string,
  importerFilePath: string,
  compilerOptions: ts.CompilerOptions,
): ModuleResolutionResult {
  const resolutionMode = resolutionModeFor(importerFilePath, compilerOptions);
  const result = ts.resolveModuleName(
    specifier,
    importerFilePath,
    compilerOptions,
    ts.sys,
    undefined,
    undefined,
    resolutionMode,
  );

  if (result.resolvedModule) {
    return toResolvedModule(result.resolvedModule);
  }

  return {
    kind: "unresolved",
    specifier,
    importer: importerFilePath,
    reason: `Cannot resolve module "${specifier}" from "${importerFilePath}"`,
  };
}

/**
 * Creates a {@link ModuleResolver} for a loaded {@link TsProject}
 * (TASK-013). Follows Node.js/TypeScript module resolution semantics
 * through `ts.resolveModuleName` — the real compiler API — rather than a
 * simplistic string-based resolver (see docs/SDD.md § 16, ADR-0001): this
 * is what correctly handles package `main`, `exports` (including
 * conditional exports and subpaths), ESM/CJS boundaries, and TypeScript
 * `paths`/`baseUrl` mapping without VulnTrace re-deriving that logic
 * itself.
 */
export function createModuleResolver(project: TsProject): ModuleResolver {
  return {
    resolve(specifier, importerFilePath) {
      return Promise.resolve(
        resolveSync(specifier, importerFilePath, project.rawCompilerOptions),
      );
    },
  };
}
