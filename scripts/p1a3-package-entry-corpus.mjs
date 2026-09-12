// P1-A3 package-entry semantics corpus measurement.
//
// Measures, over every installed package instance in the given roots
// (default: the repository's own fixture corpora), two separate things that
// must never be quoted as if they were one:
//
//   1. CAPABILITY / SYNTAX counts -- how many installed instances declare
//      each package-entry form (exports "." , the string shorthand, explicit
//      subpaths, wildcard patterns, conditional branches, custom conditions,
//      subpath-only with no ".", main only, neither, scoped names, and
//      install directories whose manifest name differs from them, i.e. the
//      npm-ALIAS shape). These describe the prevalence of a SHAPE in THESE
//      corpora. They are not claims about npm at large, and they imply
//      nothing about any verdict.
//
//   2. AUTHORITATIVE-ENTRY SELECTION DIFFERENCES -- for each instance, the
//      package-root public entry selected by the P1-A3 relation versus the
//      one merged main's probe set would have selected. main's probe set
//      included the instance's absolute install PATH unconditionally, and a
//      path request never consults `exports` in real Node, so for any
//      instance declaring both `main` and `exports` it could admit the
//      superseded `main` file as an authoritative public entry. This counts
//      exactly how often the two disagree.
//
// Neither number is a verdict movement. Nothing here builds a call graph or
// runs a reachability search. Verdict movements are measured by the focused
// suites and the canonical validation baseline, and nowhere else.
//
// The reference "what would real Node do" answer is not re-derived here: the
// production relation itself is used, and the package-entry differential
// oracle (src/code-intelligence/package-entry.differential-oracle.test.ts)
// is what checks that relation against real `node`.
//
// Usage: node scripts/p1a3-package-entry-corpus.mjs [roots...]

import fs from "node:fs";
import path from "node:path";
import { createModuleResolver } from "../dist/code-intelligence/module-resolver.js";
import {
  declaresExports,
  installDirectorySpecifier,
  resolveAuthoritativePackageEntries,
} from "../dist/code-intelligence/package-entry.js";
import { loadTsProject } from "../dist/code-intelligence/ts-project.js";
import {
  canonicalizePackageInstancePath,
  identifyModule,
} from "../dist/domain/resolved-target.js";

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
  ROOTS.push("fixtures", "tests/validation/fixtures");
}

/** Conditions the analysis context can actually select between. */
const SUPPORTED_CONDITIONS = new Set([
  "import",
  "require",
  "default",
  "node",
  "types",
]);

/** Every `node_modules/<name>` (or `node_modules/@scope/name`) directory under `dir`. */
function* installedInstances(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === "node_modules") {
      for (const pkg of fs.readdirSync(full, { withFileTypes: true })) {
        if (!pkg.isDirectory()) {
          continue;
        }
        if (pkg.name.startsWith("@")) {
          for (const scoped of fs.readdirSync(path.join(full, pkg.name), {
            withFileTypes: true,
          })) {
            if (scoped.isDirectory()) {
              yield path.join(full, pkg.name, scoped.name);
            }
          }
        } else {
          yield path.join(full, pkg.name);
        }
      }
    }
    yield* installedInstances(full);
  }
}

function readManifest(instance) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(instance, "package.json"), "utf-8"),
    );
  } catch {
    return undefined;
  }
}

/** Classifies one manifest's `exports`/`main` shape. */
function classify(manifest) {
  const shape = {
    hasExports: false,
    exportsStringShorthand: false,
    exportsDot: false,
    explicitSubpaths: 0,
    wildcardSubpaths: 0,
    subpathOnlyNoDot: false,
    conditional: false,
    customConditions: [],
    hasMain: false,
    mainAndExports: false,
    neither: false,
  };
  if (!manifest || typeof manifest !== "object") {
    return shape;
  }
  shape.hasMain = typeof manifest.main === "string" && manifest.main.length > 0;

  const exportsField = manifest.exports;
  if (exportsField === undefined || exportsField === null) {
    shape.neither = !shape.hasMain;
    return shape;
  }
  shape.hasExports = true;
  shape.mainAndExports = shape.hasMain;

  if (typeof exportsField === "string") {
    shape.exportsStringShorthand = true;
    shape.exportsDot = true;
    return shape;
  }
  if (typeof exportsField !== "object") {
    return shape;
  }

  const keys = Object.keys(exportsField);
  const isSubpathMap = keys.some((key) => key === "." || key.startsWith("./"));
  if (!isSubpathMap) {
    // A bare conditions object IS the "." entry.
    shape.exportsDot = true;
    shape.conditional = true;
    for (const key of keys) {
      if (!SUPPORTED_CONDITIONS.has(key)) {
        shape.customConditions.push(key);
      }
    }
    return shape;
  }

  for (const key of keys) {
    if (key === ".") {
      shape.exportsDot = true;
    } else if (key.includes("*")) {
      shape.wildcardSubpaths += 1;
    } else if (key.startsWith("./")) {
      shape.explicitSubpaths += 1;
    }
    const value = exportsField[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      shape.conditional = true;
      for (const condition of Object.keys(value)) {
        if (!SUPPORTED_CONDITIONS.has(condition)) {
          shape.customConditions.push(condition);
        }
      }
    }
  }
  shape.subpathOnlyNoDot = !shape.exportsDot;
  return shape;
}

/**
 * Merged main's probe set for the package ROOT: the advisory name plus the
 * instance's absolute install PATH, unconditionally. Re-stated here (rather
 * than imported) because it no longer exists in production -- that is the
 * whole point of the comparison.
 */
async function legacyRootEntries(resolver, name, instance, contexts) {
  const found = new Set();
  for (const specifier of [name, instance]) {
    for (const context of contexts) {
      const resolution = await resolver.resolve(specifier, context);
      if (resolution.kind !== "resolved") {
        continue;
      }
      if (identifyModule(resolution.resolvedFileName).packageInstance === instance) {
        found.add(resolution.resolvedFileName);
      }
    }
  }
  return [...found].sort();
}

const stats = {
  instances: 0,
  unreadableManifest: 0,
  scoped: 0,
  aliasShape: 0,
  mainOnly: 0,
  neitherMainNorExports: 0,
  hasExports: 0,
  exportsStringShorthand: 0,
  exportsDot: 0,
  mainAndExports: 0,
  instancesWithExplicitSubpaths: 0,
  explicitSubpaths: 0,
  instancesWithWildcardSubpaths: 0,
  wildcardSubpaths: 0,
  subpathOnlyNoDot: 0,
  conditional: 0,
  instancesWithCustomConditions: 0,
  rootEntryResolved: 0,
  rootEntryRefused: 0,
  legacyAdmittedNonPublicFile: 0,
  legacyResolvedWhereP1A3Refuses: 0,
};
const customConditions = new Map();
const selectionDifferences = [];

for (const root of ROOTS) {
  const projectRoot = path.resolve(root);
  if (!fs.existsSync(projectRoot)) {
    continue;
  }
  const resolver = createModuleResolver(loadTsProject(projectRoot));

  for (const rawInstance of installedInstances(projectRoot)) {
    const instance = canonicalizePackageInstancePath(rawInstance);
    stats.instances += 1;

    const manifest = readManifest(instance);
    if (!manifest) {
      stats.unreadableManifest += 1;
      continue;
    }

    const installDirectory = installDirectorySpecifier(instance);
    const name =
      typeof manifest.name === "string" && manifest.name.length > 0
        ? manifest.name
        : installDirectory;
    if (!name) {
      continue;
    }
    if (name.startsWith("@")) {
      stats.scoped += 1;
    }
    if (installDirectory && installDirectory !== name) {
      stats.aliasShape += 1;
    }

    const shape = classify(manifest);
    if (shape.hasExports) {
      stats.hasExports += 1;
    }
    if (shape.exportsStringShorthand) {
      stats.exportsStringShorthand += 1;
    }
    if (shape.exportsDot) {
      stats.exportsDot += 1;
    }
    if (shape.mainAndExports) {
      stats.mainAndExports += 1;
    }
    if (shape.hasMain && !shape.hasExports) {
      stats.mainOnly += 1;
    }
    if (shape.neither) {
      stats.neitherMainNorExports += 1;
    }
    if (shape.explicitSubpaths > 0) {
      stats.instancesWithExplicitSubpaths += 1;
      stats.explicitSubpaths += shape.explicitSubpaths;
    }
    if (shape.wildcardSubpaths > 0) {
      stats.instancesWithWildcardSubpaths += 1;
      stats.wildcardSubpaths += shape.wildcardSubpaths;
    }
    if (shape.subpathOnlyNoDot) {
      stats.subpathOnlyNoDot += 1;
    }
    if (shape.conditional) {
      stats.conditional += 1;
    }
    if (shape.customConditions.length > 0) {
      stats.instancesWithCustomConditions += 1;
      for (const condition of shape.customConditions) {
        customConditions.set(
          condition,
          (customConditions.get(condition) ?? 0) + 1,
        );
      }
    }

    const contexts = [
      path.join(projectRoot, "package.json"),
      path.join(instance, "package.json"),
    ];

    const entries = await resolveAuthoritativePackageEntries({
      resolver,
      requestedModuleSpecifier: name,
      packageInstance: instance,
      referenceContext: contexts[0],
      entrypointFiles: [],
    });
    const current = entries.map((entry) => entry.resolvedFile).sort();
    if (current.length > 0) {
      stats.rootEntryResolved += 1;
    } else {
      stats.rootEntryRefused += 1;
    }

    const legacy = await legacyRootEntries(resolver, name, instance, contexts);
    if (JSON.stringify(legacy) === JSON.stringify(current)) {
      continue;
    }

    const extra = legacy.filter((file) => !current.includes(file));
    if (extra.length > 0) {
      if (current.length === 0) {
        stats.legacyResolvedWhereP1A3Refuses += 1;
      } else {
        stats.legacyAdmittedNonPublicFile += 1;
      }
    }
    selectionDifferences.push({
      instance: path.relative(process.cwd(), instance),
      name,
      declaresExports: declaresExports(instance),
      main: typeof manifest.main === "string" ? manifest.main : null,
      p1a3: current.map((file) => path.relative(instance, file)),
      legacyOnly: extra.map((file) => path.relative(instance, file)),
    });
  }
}

console.log(
  JSON.stringify(
    {
      roots: ROOTS,
      note:
        "Capability counts describe the prevalence of a package-entry SHAPE " +
        "in THESE corpora only, and imply no verdict movement. " +
        "legacyAdmittedNonPublicFile counts instances where merged main's " +
        "unconditional install-PATH probe admitted a file the package does " +
        "not publish (typically a `main` superseded by `exports`).",
      stats,
      customConditions: Object.fromEntries(
        [...customConditions.entries()].sort((a, b) => b[1] - a[1]),
      ),
      selectionDifferences,
    },
    null,
    2,
  ),
);
