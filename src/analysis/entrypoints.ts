import path from "node:path";
import ts from "typescript";
import type { Entrypoint, EntrypointSource } from "../domain/entrypoint.js";
import {
  PackageJsonFileNotFoundError,
  loadPackageJsonFile,
} from "../dependencies/index.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";

export interface EntrypointDiagnostic {
  readonly source: EntrypointSource;
  readonly message: string;
}

export interface DiscoverEntrypointsResult {
  readonly entrypoints: readonly Entrypoint[];
  readonly diagnostics: readonly EntrypointDiagnostic[];
}

export interface DiscoverEntrypointsOptions {
  readonly projectRoot: string;
  readonly resolver: ModuleResolver;
  /** From `vulntrace.yml`'s `analysis.entrypoints` (paths relative to `projectRoot`; see docs/SDD.md § 26). */
  readonly configuredEntrypoints?: readonly string[];
  /** A plain file-path override (e.g. a future CLI `--entrypoint` flag), independent of `vulntrace.yml`. */
  readonly explicitFiles?: readonly string[];
}

/**
 * True if `candidate` is `projectRoot` itself or lies somewhere beneath it
 * (see docs/SDD.md § 29: "must not trust target project configuration
 * blindly"). `analysis.entrypoints` and package.json's `main`/`bin` are
 * both read from the *scanned project's own* files — a project entirely
 * within an attacker's control — so a value like `"../../../../etc/passwd"`
 * or an absolute path elsewhere on the host must never be silently
 * accepted as a file to statically parse. Compares via `path.relative`
 * rather than a string-prefix check so a sibling directory that merely
 * shares `projectRoot` as a prefix (e.g. `/scan/project-2` next to
 * `/scan/project`) is correctly rejected too.
 */
function isWithinRoot(projectRoot: string, candidate: string): boolean {
  const relative = path.relative(projectRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveFileList(
  projectRoot: string,
  files: readonly string[],
  source: Extract<EntrypointSource, "configured" | "explicit">,
  reasonPrefix: string,
): { entrypoints: Entrypoint[]; diagnostics: EntrypointDiagnostic[] } {
  const entrypoints: Entrypoint[] = [];
  const diagnostics: EntrypointDiagnostic[] = [];

  files.forEach((file, index) => {
    const absolute = path.resolve(projectRoot, file);

    if (!isWithinRoot(projectRoot, absolute)) {
      diagnostics.push({
        source,
        message: `${reasonPrefix}[${index}] resolves outside the project root and was rejected: ${file}`,
      });
      return;
    }

    if (ts.sys.fileExists(absolute)) {
      entrypoints.push({
        filePath: absolute,
        source,
        reason: `${reasonPrefix}[${index}]: ${file}`,
      });
    } else {
      diagnostics.push({
        source,
        message: `${reasonPrefix}[${index}] does not exist: ${file}`,
      });
    }
  });

  return { entrypoints, diagnostics };
}

/**
 * Resolves a package.json `main`/`bin` field value to a real file, using
 * the real module resolver (see docs/SDD.md § 16, ADR-0001) rather than
 * reimplementing extension/index-file fallback rules. A bare value like
 * `"index.js"` is forced into relative form (`"./index.js"`): unlike
 * import specifiers, a package's own `main`/`bin` fields are always
 * relative to the package root, never a `node_modules` lookup.
 */
async function resolvePackageField(
  projectRoot: string,
  resolver: ModuleResolver,
  fieldValue: string,
  source: Extract<EntrypointSource, "package_main" | "package_bin">,
  reason: string,
  binName?: string,
): Promise<{ entrypoint?: Entrypoint; diagnostic?: EntrypointDiagnostic }> {
  const specifier =
    fieldValue.startsWith(".") || fieldValue.startsWith("/")
      ? fieldValue
      : `./${fieldValue}`;
  const importerFilePath = path.join(projectRoot, "package.json");

  const resolution = await resolver.resolve(specifier, importerFilePath);

  if (resolution.kind === "resolved") {
    if (!isWithinRoot(projectRoot, resolution.resolvedFileName)) {
      return {
        diagnostic: {
          source,
          message: `${reason} resolves outside the project root and was rejected: "${fieldValue}"`,
        },
      };
    }
    return {
      entrypoint: {
        filePath: resolution.resolvedFileName,
        source,
        reason,
        binName,
      },
    };
  }

  return {
    diagnostic: {
      source,
      message: `${reason}: could not resolve "${fieldValue}" (${resolution.reason})`,
    },
  };
}

/**
 * Discovers entrypoints for reachability analysis (see docs/SDD.md § 19):
 * configured entrypoints, the target project's own package.json
 * `main`/`bin` fields, and any explicitly supplied files. Framework
 * discovery (Express routes, etc.) is explicitly future work, not
 * attempted here.
 *
 * Never throws for missing/unresolvable entrypoints — each failure becomes
 * a diagnostic instead, so one bad entrypoint source doesn't prevent
 * discovering the others (see docs/SDD.md § 5: UNKNOWN over false
 * certainty).
 */
export async function discoverEntrypoints(
  options: DiscoverEntrypointsOptions,
): Promise<DiscoverEntrypointsResult> {
  const entrypoints: Entrypoint[] = [];
  const diagnostics: EntrypointDiagnostic[] = [];

  if (
    options.configuredEntrypoints &&
    options.configuredEntrypoints.length > 0
  ) {
    const result = resolveFileList(
      options.projectRoot,
      options.configuredEntrypoints,
      "configured",
      "analysis.entrypoints",
    );
    entrypoints.push(...result.entrypoints);
    diagnostics.push(...result.diagnostics);
  }

  if (options.explicitFiles && options.explicitFiles.length > 0) {
    const result = resolveFileList(
      options.projectRoot,
      options.explicitFiles,
      "explicit",
      "explicit entrypoint",
    );
    entrypoints.push(...result.entrypoints);
    diagnostics.push(...result.diagnostics);
  }

  const packageJsonPath = path.join(options.projectRoot, "package.json");
  let packageJson: ReturnType<typeof loadPackageJsonFile> | undefined;

  try {
    packageJson = loadPackageJsonFile(packageJsonPath);
  } catch (error) {
    // A project with no package.json at all is normal (not every scanned
    // directory is an npm package) and produces no diagnostic. A
    // package.json that exists but fails to parse is a real problem with
    // the target project's data and is surfaced.
    if (!(error instanceof PackageJsonFileNotFoundError)) {
      diagnostics.push({
        source: "package_main",
        message: `package.json exists but could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  if (packageJson?.main) {
    const { entrypoint, diagnostic } = await resolvePackageField(
      options.projectRoot,
      options.resolver,
      packageJson.main,
      "package_main",
      "package.json main field",
    );
    if (entrypoint) {
      entrypoints.push(entrypoint);
    }
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }

  if (packageJson?.bin) {
    const binEntries: readonly [string, string][] =
      typeof packageJson.bin === "string"
        ? [[packageJson.name ?? "bin", packageJson.bin]]
        : Object.entries(packageJson.bin);

    for (const [binName, binPath] of binEntries) {
      const { entrypoint, diagnostic } = await resolvePackageField(
        options.projectRoot,
        options.resolver,
        binPath,
        "package_bin",
        `package.json bin.${binName}`,
        binName,
      );
      if (entrypoint) {
        entrypoints.push(entrypoint);
      }
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }
  }

  return { entrypoints, diagnostics };
}
