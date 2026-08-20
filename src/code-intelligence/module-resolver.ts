import path from "node:path";
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

/**
 * The specifier resolved only to a TypeScript declaration file (`.d.ts`,
 * `.d.cts`, `.d.mts`) -- type information with no executable function
 * bodies -- and no real runtime implementation could be identified (see
 * {@link resolveSync}, docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 6,
 * RWF-005/R-4, VT-304). `resolvedFileName` still points at the declaration
 * file, for diagnostics -- but callers MUST NOT treat it as an analyzable
 * module: a declaration file is never proof of a runtime implementation.
 */
export interface DeclarationOnlyModule {
  readonly kind: "declaration";
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
 * See docs/SDD.md § 16. A plain union of tagged variants (rather than
 * throwing on failure) -- resolution failure is an expected, first-class
 * outcome (an unresolved import, a typo, an optional dependency that
 * isn't installed), not an exceptional condition (AGENTS.md: every
 * uncertainty must be represented explicitly). `DeclarationOnlyModule`
 * (VT-304) is a third, equally first-class outcome: the specifier resolved
 * to a real file on disk, but that file cannot serve as runtime evidence.
 */
export type ModuleResolutionResult =
  ResolvedModule | DeclarationOnlyModule | ResolutionFailure;

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

/**
 * The declaration-extension values `ts.resolveModuleName` can report on a
 * successful resolution. `ts.ResolvedModuleFull.extension` is the
 * TypeScript compiler's own classification of the resolved file (a public,
 * documented field) -- checking it here is the single, durable place this
 * distinction is made, rather than callers scattered across the codebase
 * pattern-matching on file suffixes themselves (VT-304 Part 2).
 */
const DECLARATION_EXTENSIONS: ReadonlySet<string> = new Set([
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
]);

function isDeclarationExtension(extension: string): boolean {
  return DECLARATION_EXTENSIONS.has(extension);
}

const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"] as const;

/**
 * Filename-suffix form of {@link isDeclarationExtension}, needed only for
 * files reached via the sibling/`package.json`-`main` probe below (VT-304
 * Part 4), which never go through `ts.resolveModuleName` and so never get
 * a `ts.Extension` classification from the compiler itself.
 */
function isDeclarationFileName(fileName: string): boolean {
  return DECLARATION_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function toResolvedModuleFrom(resolved: ts.ResolvedModuleFull): ResolvedModule {
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

function toDeclarationOnlyModule(
  resolved: ts.ResolvedModuleFull,
): DeclarationOnlyModule {
  return {
    kind: "declaration",
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

/**
 * Re-resolves `specifier` preferring a real runtime implementation over a
 * declaration file, using TypeScript's own `noDtsResolution` compiler
 * option (VT-304 Part 3, docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 6,
 * RWF-005/R-4).
 *
 * `noDtsResolution` is **not part of the public `typescript.d.ts` API** —
 * it is an internal compiler option (verified empirically against the
 * pinned `typescript` version in package.json; see
 * module-resolver.test.ts's "declaration vs. runtime resolution" group for
 * the regression coverage). It is cast in, and isolated to, this one
 * function so that an unversioned
 * internal dependency has exactly one call site to audit or replace, and
 * wrapped in a `try`/`catch` so that a future TypeScript release rejecting
 * (rather than silently ignoring) the unknown option degrades to "no
 * runtime implementation found here" -- handled the same as any other
 * failed resolution attempt -- rather than throwing out of the resolver.
 *
 * Re-resolving the same original `specifier` (not a derived `@types/*`
 * path, and not a guessed sibling filename) is what makes this also
 * correctly handle the `@types/*` case (VT-304 Part 5): when the only
 * thing installed for a bare specifier like `"semver"` is a separate
 * `@types/semver` declaration package, excluding declaration candidates
 * from the *same* real resolution algorithm simply makes resolution fail
 * (a real `unresolved_module`), never a naming-convention guess at a
 * runtime package that may not exist.
 */
function attemptNoDtsResolution(
  specifier: string,
  importerFilePath: string,
  compilerOptions: ts.CompilerOptions,
  resolutionMode: ts.ResolutionMode,
): ts.ResolvedModuleFull | undefined {
  try {
    const noDtsOptions = {
      ...compilerOptions,
      noDtsResolution: true,
    } as ts.CompilerOptions;
    const result = ts.resolveModuleName(
      specifier,
      importerFilePath,
      noDtsOptions,
      ts.sys,
      undefined,
      undefined,
      resolutionMode,
    );
    return result.resolvedModule;
  } catch {
    return undefined;
  }
}

/**
 * Derives the installed package's root directory from a resolved file path
 * and the package name TypeScript itself reported (`packageId.name`),
 * using the same last-`node_modules/<name>` convention as
 * `domain/resolved-target.ts`'s `identifyModule` (kept as a separate, local
 * implementation: this module has no dependency on `domain/`, and the two
 * operate for different purposes -- this one only needs a directory to
 * probe for a sibling runtime file and its `package.json`, not a full
 * {@link ModuleIdentity}).
 *
 * Returns `undefined` (rather than guessing) when the resolved file isn't
 * actually inside a `node_modules/<packageName>/` segment -- e.g. a
 * `@types/*` declaration resolved for a bare specifier whose real name
 * doesn't match the declaration package's own install path, which must
 * never be treated as that package's root (VT-304 Part 5).
 */
function derivePackageRootDir(
  resolvedFile: string,
  packageName: string | undefined,
): string | undefined {
  if (!packageName) {
    return undefined;
  }
  const marker = `/node_modules/${packageName}/`;
  const index = resolvedFile.lastIndexOf(marker);
  if (index === -1) {
    return undefined;
  }
  return resolvedFile.slice(0, index + marker.length - 1);
}

const RUNTIME_SIBLING_EXTENSIONS = [".js", ".cjs", ".mjs"] as const;

/**
 * Structurally-scoped fallback for when {@link attemptNoDtsResolution}
 * finds no runtime implementation (VT-304 Part 4): only ever considers a
 * same-directory, same-basename runtime file next to the resolved
 * declaration file (`index.d.ts` → `index.js`), and only after checking
 * whether the package's own `package.json` names a different,
 * authoritative entry point -- never a blind filename swap applied to an
 * arbitrary resolved path, and never crossing outside the package's own
 * root directory (containment is structural here: every candidate is
 * built from `packageRootDir` or the declaration file's own directory).
 *
 * When `package.json`'s `main` field exists, points elsewhere, resolves to
 * a real file, and that file is not itself a declaration file, it is
 * preferred over the naive same-directory guess (an explicit field beats a
 * guess). A malformed `package.json` is target-project data, not
 * VulnTrace's own configuration (see ts-project.ts's equivalent handling),
 * so it degrades to the naive guess rather than throwing.
 */
function attemptSiblingRuntimeFile(
  declarationFileName: string,
  packageRootDir: string | undefined,
): string | undefined {
  const dir = path.dirname(declarationFileName);
  const base = path.basename(declarationFileName);
  const suffix = DECLARATION_SUFFIXES.find((s) => base.endsWith(s));
  if (!suffix) {
    return undefined;
  }
  const stem = base.slice(0, -suffix.length);

  if (packageRootDir) {
    const pkgJsonPath = path.join(packageRootDir, "package.json");
    if (ts.sys.fileExists(pkgJsonPath)) {
      const pkgJsonText = ts.sys.readFile(pkgJsonPath);
      if (pkgJsonText) {
        try {
          const pkgJson = JSON.parse(pkgJsonText) as { main?: unknown };
          const mainField =
            typeof pkgJson.main === "string" ? pkgJson.main : undefined;
          if (mainField) {
            const mainPath = path.resolve(packageRootDir, mainField);
            if (
              path.dirname(mainPath) !== dir &&
              ts.sys.fileExists(mainPath) &&
              !isDeclarationFileName(mainPath)
            ) {
              return mainPath;
            }
          }
        } catch {
          // Malformed package.json -- fall through to the naive guess.
        }
      }
    }
  }

  for (const ext of RUNTIME_SIBLING_EXTENSIONS) {
    const candidate = path.join(dir, `${stem}${ext}`);
    if (ts.sys.fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Resolves `specifier`, preferring a runtime implementation over a
 * TypeScript declaration file when both TypeScript's own resolver would
 * otherwise pick the latter (VT-304, RWF-005/R-4).
 *
 * `ts.resolveModuleName` is a *type* resolver: given a package shipping
 * both `index.d.ts` and `index.js` (or a bare specifier that resolves only
 * into a separate `@types/*` declaration package), it correctly prefers
 * the declaration file for type-checking purposes. VulnTrace is a
 * runtime-semantics analyzer -- a declaration file has type information
 * but no executable function bodies, so treating one as an analyzable
 * module would let a graph region that looks fully analyzed (and has no
 * edges, because there is no code) silently stand in for code nobody has
 * actually examined, which is precisely the shape of a false confident
 * `NOT_AFFECTED`/`unreachable` conclusion. See
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 6.
 *
 * Order: (1) the default resolution; if it isn't a declaration file, done
 * -- this is the common case and behavior is unchanged. (2) Otherwise,
 * {@link attemptNoDtsResolution} re-resolves the same specifier preferring
 * runtime candidates. (3) Otherwise, {@link attemptSiblingRuntimeFile}
 * tries a structurally-scoped same-package fallback. (4) Otherwise, the
 * result is honestly reported as {@link DeclarationOnlyModule} -- an
 * explicit, first-class uncertainty, never silently coerced into either a
 * normal resolution or a plain resolution failure.
 */
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

  if (!result.resolvedModule) {
    return {
      kind: "unresolved",
      specifier,
      importer: importerFilePath,
      reason: `Cannot resolve module "${specifier}" from "${importerFilePath}"`,
    };
  }

  const resolved = result.resolvedModule;
  if (!isDeclarationExtension(resolved.extension)) {
    return toResolvedModuleFrom(resolved);
  }

  const runtimeFromNoDts = attemptNoDtsResolution(
    specifier,
    importerFilePath,
    compilerOptions,
    resolutionMode,
  );
  if (runtimeFromNoDts && !isDeclarationExtension(runtimeFromNoDts.extension)) {
    return toResolvedModuleFrom(runtimeFromNoDts);
  }

  const packageRootDir = derivePackageRootDir(
    resolved.resolvedFileName,
    resolved.packageId?.name,
  );
  const siblingRuntimeFile = attemptSiblingRuntimeFile(
    resolved.resolvedFileName,
    packageRootDir,
  );
  if (siblingRuntimeFile) {
    return {
      kind: "resolved",
      resolvedFileName: siblingRuntimeFile,
      isExternalLibraryImport: resolved.isExternalLibraryImport ?? false,
      packageId: resolved.packageId
        ? {
            name: resolved.packageId.name,
            version: resolved.packageId.version,
            subModuleName: path.relative(
              packageRootDir ?? path.dirname(siblingRuntimeFile),
              siblingRuntimeFile,
            ),
          }
        : undefined,
    };
  }

  return toDeclarationOnlyModule(resolved);
}

/**
 * Creates a {@link ModuleResolver} for a loaded {@link TsProject}
 * (TASK-013). Follows Node.js/TypeScript module resolution semantics
 * through `ts.resolveModuleName` — the real compiler API — rather than a
 * simplistic string-based resolver (see docs/SDD.md § 16, ADR-0001): this
 * is what correctly handles package `main`, `exports` (including
 * conditional exports and subpaths), ESM/CJS boundaries, and TypeScript
 * `paths`/`baseUrl` mapping without VulnTrace re-deriving that logic
 * itself. Declaration-vs-runtime disambiguation (VT-304) is layered on top
 * in {@link resolveSync}, not reimplemented here.
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
