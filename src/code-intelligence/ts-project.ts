import path from "node:path";
import ts from "typescript";
import { TsProjectRootNotFoundError } from "./ts-project-errors.js";

/**
 * Only the compiler options that matter for module/symbol resolution and
 * project boundaries are represented (see docs/SDD.md § 15-16), converted
 * to plain strings/booleans so consumers never need to import `typescript`
 * themselves (AGENTS.md: "Keep AST/parser implementation behind analysis
 * interfaces").
 */
export interface RelevantCompilerOptions {
  readonly baseUrl?: string;
  readonly paths?: Readonly<Record<string, readonly string[]>>;
  readonly rootDir?: string;
  readonly outDir?: string;
  readonly module?: string;
  readonly moduleResolution?: string;
  readonly target?: string;
  readonly jsx?: string;
  readonly allowJs: boolean;
  readonly checkJs: boolean;
  readonly esModuleInterop: boolean;
  readonly resolveJsonModule: boolean;
}

export interface TsProjectDiagnostic {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * Loaded TS/JS project configuration for one project root (see
 * docs/SDD.md § 15-18). `configFilePath: undefined` means no
 * tsconfig.json was found — a valid, expected state for plain JavaScript
 * projects, not an error.
 */
export interface TsProject {
  readonly projectRoot: string;
  readonly configFilePath: string | undefined;
  readonly rootDir: string;
  readonly compilerOptions: RelevantCompilerOptions;
  readonly fileNames: readonly string[];
  readonly diagnostics: readonly TsProjectDiagnostic[];
  /**
   * The raw `ts.CompilerOptions`, for other `src/code-intelligence/`
   * modules that must call TypeScript compiler APIs directly (e.g.
   * module-resolver.ts's `ts.resolveModuleName`) and therefore need real
   * enum values, not {@link RelevantCompilerOptions}'s stringified summary.
   * Not intended for consumers outside `src/code-intelligence/`.
   */
  readonly rawCompilerOptions: ts.CompilerOptions;
}

export interface TsProjectOptions {
  /** Overrides discovery; must still resolve to a real, readable file. */
  readonly configFilePath?: string;
}

function toDiagnostic(diagnostic: ts.Diagnostic): TsProjectDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    return {
      message,
      file: diagnostic.file.fileName,
      line: line + 1,
      column: character + 1,
    };
  }

  return { message };
}

function extractRelevantOptions(
  options: ts.CompilerOptions,
): RelevantCompilerOptions {
  return {
    baseUrl: options.baseUrl,
    paths: options.paths as
      Readonly<Record<string, readonly string[]>> | undefined,
    rootDir: options.rootDir,
    outDir: options.outDir,
    module:
      options.module !== undefined ? ts.ModuleKind[options.module] : undefined,
    moduleResolution:
      options.moduleResolution !== undefined
        ? ts.ModuleResolutionKind[options.moduleResolution]
        : undefined,
    target:
      options.target !== undefined
        ? ts.ScriptTarget[options.target]
        : undefined,
    jsx: options.jsx !== undefined ? ts.JsxEmit[options.jsx] : undefined,
    allowJs: options.allowJs ?? false,
    checkJs: options.checkJs ?? false,
    esModuleInterop: options.esModuleInterop ?? false,
    resolveJsonModule: options.resolveJsonModule ?? false,
  };
}

/**
 * Finds tsconfig.json for a project.
 *
 * Deliberately does NOT walk up parent directories the way
 * `ts.findConfigFile`/`tsc` do by default: an ancestor directory's
 * tsconfig.json belongs to a different project, and picking it up would
 * silently violate the project boundary this task's acceptance criteria
 * require to be explicit (see TASK-013 completion report — this was
 * verified to be a real risk when scanning a fixture nested inside this
 * very repository, which itself has a root tsconfig.json).
 */
function discoverConfigFilePath(projectRoot: string): string | undefined {
  const candidate = path.join(projectRoot, "tsconfig.json");
  return ts.sys.fileExists(candidate) ? candidate : undefined;
}

const DEFAULT_JS_PROJECT_OPTIONS: RelevantCompilerOptions = {
  allowJs: true,
  checkJs: false,
  esModuleInterop: false,
  resolveJsonModule: false,
};

/**
 * Plain JavaScript projects (no tsconfig.json) still run on real, modern
 * Node.js — which supports package.json `exports`/conditional exports and
 * ESM/CJS boundaries regardless of TypeScript. Defaulting resolution to
 * NodeNext (rather than leaving it unset, which falls back to the TS
 * compiler's own historical Node10/classic default) is what makes module
 * resolution (TASK-016) behave correctly for these projects too.
 */
const DEFAULT_JS_PROJECT_RAW_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

/**
 * Loads TS/JS project configuration for `projectRoot` (see docs/SDD.md
 * § 15-18). Supports both TypeScript projects (tsconfig.json present) and
 * plain JavaScript projects (none found) — the latter is not an error.
 *
 * A malformed tsconfig.json is also not thrown: it is target-project data
 * being analyzed, not VulnTrace's own configuration, so it degrades to a
 * `diagnostics` entry and best-effort defaults rather than aborting the
 * scan (see docs/SDD.md § 5: UNKNOWN over false certainty). Contrast with
 * TASK-002's `vulntrace.yml` loader, which throws — that is VulnTrace's
 * own configuration, where failing loudly immediately is correct.
 */
export function loadTsProject(
  projectRoot: string,
  options: TsProjectOptions = {},
): TsProject {
  const absoluteProjectRoot = path.resolve(projectRoot);

  if (!ts.sys.directoryExists(absoluteProjectRoot)) {
    throw new TsProjectRootNotFoundError(absoluteProjectRoot);
  }

  const configFilePath = options.configFilePath
    ? path.resolve(options.configFilePath)
    : discoverConfigFilePath(absoluteProjectRoot);

  if (!configFilePath) {
    return {
      projectRoot: absoluteProjectRoot,
      configFilePath: undefined,
      rootDir: absoluteProjectRoot,
      compilerOptions: DEFAULT_JS_PROJECT_OPTIONS,
      fileNames: [],
      diagnostics: [],
      rawCompilerOptions: DEFAULT_JS_PROJECT_RAW_OPTIONS,
    };
  }

  const readResult = ts.readConfigFile(configFilePath, ts.sys.readFile);
  const diagnostics: TsProjectDiagnostic[] = [];

  if (readResult.error) {
    diagnostics.push(toDiagnostic(readResult.error));
  }

  const configDir = path.dirname(configFilePath);
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config ?? {},
    ts.sys,
    configDir,
    undefined,
    configFilePath,
  );

  diagnostics.push(...parsed.errors.map(toDiagnostic));

  return {
    projectRoot: absoluteProjectRoot,
    configFilePath,
    rootDir: parsed.options.rootDir
      ? path.resolve(parsed.options.rootDir)
      : configDir,
    compilerOptions: extractRelevantOptions(parsed.options),
    fileNames: parsed.fileNames,
    diagnostics,
    rawCompilerOptions: parsed.options,
  };
}
