/**
 * Convenience generators for `rules.yml` and `vulntrace.yml`, in the exact
 * shape every harness in docs/audits/ hand-wrote inline. A case may
 * always write these files itself as plain strings in a
 * {@link import("./project.js").ProjectSpec} -- these exist only so the
 * common shapes (one rule against one module/export, a string or
 * `{file, symbol}` entrypoint, an optional `analysis.limits.maxFiles`)
 * do not need to be re-typed by hand in every case.
 */

export type EntrypointSpec =
  string | { readonly file: string; readonly symbol: string };

export interface SimpleRuleSpec {
  readonly id: string;
  readonly packageName: string;
  readonly moduleName?: string;
  readonly exportName: string;
  readonly kind?: string;
  readonly confidence?: number;
}

/** One `rules.yml` with one rule targeting one `module#export`. */
export function simpleRuleFile(spec: SimpleRuleSpec): string {
  return (
    `rules:\n` +
    `  - id: ${spec.id}\n` +
    `    package:\n` +
    `      name: ${spec.packageName}\n` +
    `    targets:\n` +
    `      - module: ${spec.moduleName ?? spec.packageName}\n` +
    `        export: ${spec.exportName}\n` +
    `        kind: ${spec.kind ?? "function"}\n` +
    `        confidence: ${spec.confidence ?? 1.0}\n`
  );
}

/** Concatenates several `rules.yml` bodies (each from {@link simpleRuleFile}) into one file. */
export function combineRuleFiles(bodies: readonly string[]): string {
  return bodies
    .map((body, index) => (index === 0 ? body : body.replace(/^rules:\n/, "")))
    .join("");
}

export interface SimpleConfigSpec {
  readonly entrypoints: readonly [EntrypointSpec, ...EntrypointSpec[]];
  readonly ruleFiles?: readonly string[];
  readonly maxFiles?: number;
}

/** One `vulntrace.yml` with the given entrypoints, rule files and optional `maxFiles`. */
export function simpleConfigFile(spec: SimpleConfigSpec): string {
  const entrypointLines = spec.entrypoints
    .map((ep) =>
      typeof ep === "string"
        ? `    - ${ep}\n`
        : `    - file: ${ep.file}\n      symbol: ${ep.symbol}\n`,
    )
    .join("");
  const limits =
    spec.maxFiles !== undefined
      ? `  limits:\n    maxFiles: ${spec.maxFiles}\n`
      : "";
  const ruleFileLines = (spec.ruleFiles ?? ["rules.yml"])
    .map((file) => `    - ${file}\n`)
    .join("");
  return (
    `analysis:\n${limits}  entrypoints:\n${entrypointLines}` +
    `rules:\n  files:\n${ruleFileLines}`
  );
}

/** The `package.json` "dependencies" + a matching `package-lock.json` for one plain npm dependency. */
export function simplePackageFiles(
  appName: string,
  dependencyName: string,
  dependencyVersion: string,
): { readonly "package.json": string; readonly "package-lock.json": string } {
  return {
    "package.json": JSON.stringify(
      {
        name: appName,
        version: "1.0.0",
        dependencies: { [dependencyName]: dependencyVersion },
      },
      null,
      2,
    ),
    "package-lock.json": JSON.stringify(
      {
        name: appName,
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: appName,
            version: "1.0.0",
            dependencies: { [dependencyName]: dependencyVersion },
          },
          [`node_modules/${dependencyName}`]: { version: dependencyVersion },
        },
      },
      null,
      2,
    ),
  };
}
