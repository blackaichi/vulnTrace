import { realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
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
 * The specifier names a Node.js builtin module (`fs`, `node:fs`, `path`,
 * ...) -- a known runtime module supplied by Node itself, not a file on
 * disk (VT-305, RWF-007). `specifier` is normalized to the bare,
 * unprefixed form (`"fs"`, never `"node:fs"`) so the two spellings are
 * never treated as different module identities downstream. Deliberately
 * has no `resolvedFileName`: a builtin has no filesystem path, and callers
 * must never invent one or attempt a `node_modules` lookup for it.
 */
export interface BuiltinModule {
  readonly kind: "builtin";
  readonly specifier: string;
}

/**
 * See docs/SDD.md § 16. A plain union of tagged variants (rather than
 * throwing on failure) -- resolution failure is an expected, first-class
 * outcome (an unresolved import, a typo, an optional dependency that
 * isn't installed), not an exceptional condition (AGENTS.md: every
 * uncertainty must be represented explicitly). `DeclarationOnlyModule`
 * (VT-304) is a third, equally first-class outcome: the specifier resolved
 * to a real file on disk, but that file cannot serve as runtime evidence.
 * `BuiltinModule` (VT-305) is a fourth: the specifier is a known Node
 * runtime module, neither a file to analyze nor an uncertainty to flag.
 */
export type ModuleResolutionResult =
  ResolvedModule | DeclarationOnlyModule | BuiltinModule | ResolutionFailure;

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

const NODE_PREFIX = "node:";

/**
 * Normalizes a Node builtin specifier to its bare, unprefixed form
 * (`"node:fs"` -> `"fs"`), so `require("fs")` and `require("node:fs")`
 * are recognized as the exact same module identity everywhere downstream
 * (VT-305 Part 2). Only ever called after {@link isBuiltin} has already
 * confirmed the specifier names a real builtin -- a handful of newer
 * builtins (e.g. `node:test`, `node:sea`) are only valid *with* the
 * prefix, so this must never be used to decide builtin-ness itself.
 */
function normalizeBuiltinSpecifier(specifier: string): string {
  return specifier.startsWith(NODE_PREFIX)
    ? specifier.slice(NODE_PREFIX.length)
    : specifier;
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

declare const nodeResolutionOptionsBrand: unique symbol;

/**
 * The compiler options every module resolution runs under, whatever the
 * project's tsconfig says (ADR 0010 invariant C2, task C-1): `module` and
 * `moduleResolution` NodeNext -- package `exports` / `imports` honoured,
 * the `node`, `require` / `import` and `default` conditions, Node's
 * file/package-scope format detection -- and `allowJs`, because Node loads
 * JavaScript whatever a tsconfig says. Nothing else from the project's
 * tsconfig: Node never reads it, so its `module`, `moduleResolution`,
 * `customConditions`, `moduleSuffixes`, `rootDirs` and `preserveSymlinks`
 * cannot change which file Node loads. Before C-1 the project's own
 * options were used, and under `module: commonjs` (node10) or `bundler`
 * resolution that named a file Node never loads (PRM-33).
 *
 * This is Node's resolution MODE, not Node's algorithm in every detail.
 * TypeScript still matches the `types` condition (dropped by the noDts
 * pass {@link resolveSync} runs first), and still substitutes and prefers
 * TypeScript extensions (`./x.js` → `x.ts`, `index.ts` before
 * `index.js`), also inside `node_modules` and for a JavaScript importer,
 * where Node loads the `.js` file: RWF-086, open.
 *
 * Branded, with one producer ({@link nodeResolutionOptions}), so every
 * TypeScript resolution call in this module provably receives options it
 * built: `VT-INV-C-runtime-resolution`'s census
 * (src/testing/runtime-resolution-census.ts) checks the call sites and the
 * assertion.
 */
export type NodeResolutionOptions = ts.CompilerOptions & {
  readonly [nodeResolutionOptionsBrand]: true;
};

/**
 * The one producer of {@link NodeResolutionOptions}. `mapping` adds a
 * tsconfig's `baseUrl` / `paths` (and the `pathsBasePath` TypeScript
 * resolves `paths` against) and nothing else: it exists only for the
 * cross-check in {@link createModuleResolver}, never to decide a file.
 */
function nodeResolutionOptions(mapping?: {
  readonly baseUrl?: string;
  readonly paths?: ts.MapLike<string[]>;
  readonly pathsBasePath?: ts.CompilerOptions[string];
}): NodeResolutionOptions {
  const options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  if (mapping?.baseUrl !== undefined) options.baseUrl = mapping.baseUrl;
  if (mapping?.paths !== undefined) options.paths = mapping.paths;
  if (mapping?.pathsBasePath !== undefined) {
    options.pathsBasePath = mapping.pathsBasePath;
  }
  return Object.freeze(options) as NodeResolutionOptions;
}

/** Node's runtime resolution: never anything from the tsconfig (C2). */
const NODE_RUNTIME_RESOLUTION_OPTIONS = nodeResolutionOptions();

/**
 * Determines whether the importer is being resolved as ESM or CommonJS —
 * required to pick the right side of a conditional package export
 * (`{"import": "...", "require": "..."}`) — by delegating to TypeScript's
 * own implementation of Node's file/package-scope format detection
 * (extension, and the nearest ancestor package.json's `"type"` field),
 * rather than reimplementing that lookup (see ADR-0001). Under
 * {@link NodeResolutionOptions} that detection is Node's own.
 */
function resolutionModeFor(
  importerFilePath: string,
  compilerOptions: NodeResolutionOptions,
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
  compilerOptions: NodeResolutionOptions,
  resolutionMode: ts.ResolutionMode,
): ts.ResolvedModuleFull | undefined {
  try {
    // Still Node's resolution: the same branded options (the spread keeps
    // the brand), plus TypeScript's own switch that drops declaration
    // candidates.
    const noDtsOptions: NodeResolutionOptions = {
      ...compilerOptions,
      noDtsResolution: true,
    };
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

/**
 * A specifier Node resolves through `node_modules` (and so through a
 * package's `exports`), as opposed to a relative or absolute path, which
 * `exports` never governs.
 */
function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    specifier !== "." &&
    specifier !== ".." &&
    !path.isAbsolute(specifier)
  );
}

/**
 * Whether a bare specifier that resolved only to `declarationFileName` may
 * fall back to a sibling runtime file or `main` (task C-1, ADR 0010 C2;
 * the independent audit's finding 2). Node resolves a bare specifier into
 * a package that declares `exports`, and every `#` specifier (the
 * importer's own `imports` map), through that map alone, never through
 * `main` or a file beside a declaration.
 *
 * Decided from the package the specifier NAMES, located the way Node
 * locates it -- not from TypeScript's `packageId` or a
 * `node_modules/<name>/` segment of the declaration's path (which a
 * package without a `version`, a workspace symlink or a self-reference
 * lacks), and not from the manifests above the declaration (a subpath
 * proxy `package.json` with its own `name`, or a separate `@types/<name>`
 * package, is not the package Node reads `exports` from). C-1's audit and
 * re-audit found each of those bypasses. In Node's order:
 *
 * 1. Self-reference: the importer's package scope (its nearest
 *    `package.json`) names the package and declares `exports` -- refuse;
 *    an unreadable scope refuses too.
 * 2. `node_modules/<name>/package.json`, from the importer's directory up.
 *    Not found, unreadable, or declaring `exports` -- refuse.
 * 3. The declaration file's real path must lie inside that package's real
 *    directory; otherwise the declaration is not that package's own
 *    (`@types/<name>`) and its siblings are not what Node loads -- refuse.
 *
 * `exports: null` is absent, as in Node and package-entry.ts. Anything
 * unestablished refuses: the result is then declaration-only, which
 * fails closed.
 */
function siblingFallbackAllowed(
  specifier: string,
  declarationFileName: string,
  importerFilePath: string,
): boolean {
  if (specifier.startsWith("#")) return false;
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  if (packageName === undefined || packageName === "") return false;

  // 1. Self-reference, which Node tries before node_modules.
  const scope = nearestManifest(path.dirname(importerFilePath));
  if (scope === "unreadable") return false;
  if (
    scope !== undefined &&
    scope.manifest.name === packageName &&
    declaresExports(scope.manifest)
  ) {
    return false;
  }

  // 2. The package Node loads for the name.
  let packageDir: string | undefined;
  for (let dir = path.dirname(importerFilePath); ;) {
    const candidate = path.join(dir, "node_modules", packageName);
    if (ts.sys.fileExists(path.join(candidate, "package.json"))) {
      packageDir = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (packageDir === undefined) return false;
  const manifest = readManifest(path.join(packageDir, "package.json"));
  if (manifest === undefined || declaresExports(manifest)) return false;

  // 3. The declaration is that package's own.
  const realPackageDir = realPath(packageDir);
  const realDeclaration = realPath(declarationFileName);
  return (
    realPackageDir !== undefined &&
    realDeclaration !== undefined &&
    realDeclaration.startsWith(realPackageDir + path.sep)
  );
}

interface Manifest {
  readonly name?: unknown;
  readonly exports?: unknown;
}

function declaresExports(manifest: Manifest): boolean {
  return manifest.exports !== undefined && manifest.exports !== null;
}

/** A `package.json`, or `undefined` when it cannot be read or parsed as an object. */
function readManifest(manifestPath: string): Manifest | undefined {
  const text = ts.sys.readFile(manifestPath);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Manifest)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The nearest `package.json` at or above `dir` (Node's package scope). */
function nearestManifest(
  dir: string,
): { readonly manifest: Manifest } | "unreadable" | undefined {
  for (let current = dir; ;) {
    const manifestPath = path.join(current, "package.json");
    if (ts.sys.fileExists(manifestPath)) {
      const manifest = readManifest(manifestPath);
      return manifest === undefined ? "unreadable" : { manifest };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function realPath(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
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
 * Order: (0) a Node builtin specifier (VT-305, RWF-007) is classified as
 * {@link BuiltinModule} immediately, before any filesystem/`node_modules`
 * lookup is even attempted -- this matches real Node.js semantics, where a
 * builtin always shadows any same-named `node_modules` package, and
 * `ts.resolveModuleName` itself never resolves core specifiers at all (its
 * knowledge of Node's core API is ambient `@types/node` declarations, not
 * per-specifier resolution -- see docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md
 * § 3.5). (1) Otherwise, {@link attemptNoDtsResolution}: runtime
 * candidates only, and without the `types` export condition Node never
 * matches; a runtime file found here is the answer -- the common case,
 * one TypeScript call. (2) Otherwise, the default resolution: nothing is
 * unresolved; a runtime file it reaches that step (1) did not was reached
 * only through the `types` condition, and is unresolved too (task C-1).
 * (3) Otherwise (a declaration file), {@link attemptSiblingRuntimeFile}
 * tries a structurally-scoped same-package fallback -- but never for a
 * bare specifier governed by an `exports` or `imports` map, nor where the
 * package scope cannot be established ({@link siblingFallbackAllowed}):
 * Node resolves such a specifier through the map alone, and step (1)
 * already applied it and found no runtime file (task C-1, ADR 0010 C2).
 * (4) Otherwise, the result is honestly reported as
 * {@link DeclarationOnlyModule} -- an explicit, first-class uncertainty,
 * never silently coerced into either a normal resolution or a plain
 * resolution failure.
 */
function resolveSync(
  specifier: string,
  importerFilePath: string,
  compilerOptions: NodeResolutionOptions,
): ModuleResolutionResult {
  if (isBuiltin(specifier)) {
    return { kind: "builtin", specifier: normalizeBuiltinSpecifier(specifier) };
  }

  const resolutionMode = resolutionModeFor(importerFilePath, compilerOptions);

  // Node's answer first. TypeScript's NodeNext resolution always matches
  // the `types` export condition, which Node never does, so a package
  // whose `types` target is a runtime file would otherwise be read through
  // a file Node never loads (C-1's independent audit, finding 1). The
  // noDts resolution drops that condition along with declaration
  // candidates.
  const runtimeFromNoDts = attemptNoDtsResolution(
    specifier,
    importerFilePath,
    compilerOptions,
    resolutionMode,
  );
  if (runtimeFromNoDts && !isDeclarationExtension(runtimeFromNoDts.extension)) {
    return toResolvedModuleFrom(runtimeFromNoDts);
  }

  // No runtime file through Node's route. The default resolution is
  // consulted only to give an honest declaration-only account.
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
    // A runtime file reached only through a route Node does not take (the
    // `types` condition): Node does not load it.
    return {
      kind: "unresolved",
      specifier,
      importer: importerFilePath,
      reason:
        `Cannot resolve module "${specifier}" from "${importerFilePath}": ` +
        `"${resolved.resolvedFileName}" is reached only through TypeScript's ` +
        `\`types\` condition, which Node never matches`,
    };
  }

  const packageRootDir = derivePackageRootDir(
    resolved.resolvedFileName,
    resolved.packageId?.name,
  );
  if (
    isBareSpecifier(specifier) &&
    !siblingFallbackAllowed(
      specifier,
      resolved.resolvedFileName,
      importerFilePath,
    )
  ) {
    return toDeclarationOnlyModule(resolved);
  }
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

/** One resolution outcome, as a comparable key: the kind and the file it names. */
function outcomeKey(result: ModuleResolutionResult): string {
  switch (result.kind) {
    case "resolved":
    case "declaration":
      return `${result.kind}:${result.resolvedFileName}`;
    case "builtin":
      return `builtin:${result.specifier}`;
    case "unresolved":
      return "unresolved";
  }
}

/** An outcome, as a reason names it. */
function describeOutcome(result: ModuleResolutionResult): string {
  switch (result.kind) {
    case "resolved":
      return `"${result.resolvedFileName}"`;
    case "declaration":
      return `the declaration file "${result.resolvedFileName}"`;
    case "builtin":
      return `the builtin "${result.specifier}"`;
    case "unresolved":
      return "nothing (no file)";
  }
}

/**
 * Creates a {@link ModuleResolver} for a loaded {@link TsProject}
 * (TASK-013). Resolves through `ts.resolveModuleName` -- the real compiler
 * API, rather than a simplistic string-based resolver (see docs/SDD.md
 * § 16, ADR-0001) -- under {@link NodeResolutionOptions}, which is Node's
 * algorithm: package `main`, `exports` (conditional exports and subpaths),
 * ESM/CJS boundaries. Declaration-vs-runtime disambiguation (VT-304) is
 * layered on top in {@link resolveSync}, not reimplemented here.
 *
 * The project's tsconfig never decides which file loads (ADR 0010
 * invariant C2, task C-1). Before C-1 its options did: under
 * `module: commonjs` they selected node10 resolution, which ignores
 * `exports` (PRM-33), and every mode applied `paths` / `baseUrl`, which
 * Node never reads (RWF-083). A tsconfig `baseUrl` / `paths` mapping is
 * still consulted, but only as a cross-check: when resolving with it gives
 * a different outcome than Node's resolution, the specifier is
 * `unresolved`, with a reason naming both, rather than either answer
 * followed silently (ADR 0010 § 3; REMEDIATION-PLAN § 6.1 decision 7;
 * downstream it is `unresolved_module`, category `identity_unresolved`).
 * That includes a mapped alias Node cannot load at all
 * (`@lib/wrapper.js`): the program then runs only under a toolchain that
 * rewrites or honours `paths`, whose answer is not Node's (the project
 * owner's decision of 2026-10-09).
 */
export function createModuleResolver(project: TsProject): ModuleResolver {
  const raw = project.rawCompilerOptions;
  const tsconfigMapping =
    raw.baseUrl !== undefined || raw.paths !== undefined
      ? nodeResolutionOptions({
          baseUrl: raw.baseUrl,
          paths: raw.paths,
          pathsBasePath: raw.pathsBasePath,
        })
      : undefined;
  return {
    resolve(specifier, importerFilePath) {
      const node = resolveSync(
        specifier,
        importerFilePath,
        NODE_RUNTIME_RESOLUTION_OPTIONS,
      );
      if (tsconfigMapping === undefined) {
        return Promise.resolve(node);
      }
      const mapped = resolveSync(specifier, importerFilePath, tsconfigMapping);
      if (outcomeKey(mapped) === outcomeKey(node)) {
        return Promise.resolve(node);
      }
      return Promise.resolve({
        kind: "unresolved",
        specifier,
        importer: importerFilePath,
        reason:
          `Cannot resolve module "${specifier}" from "${importerFilePath}": ` +
          `the tsconfig's baseUrl/paths mapping resolves it to ` +
          `${describeOutcome(mapped)}, Node's resolution to ` +
          `${describeOutcome(node)} (ADR 0010 C2: neither is followed)`,
      });
    },
  };
}
