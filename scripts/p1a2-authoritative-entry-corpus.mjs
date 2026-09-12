// P1-A2 authoritative-public-entry corpus measurement (RWF-030).
//
// Measures how often the LEGACY same-name sibling attribution would have
// differed from AUTHORITATIVE public-entry resolution, over every installed
// package instance in the given roots (default: the repository's own fixture
// corpora).
//
// For each installed PackageInstance it:
//
//   1. resolves the instance's authoritative public entry the way the
//      production relation does -- the package's own declared entry via the
//      real module resolver, never a filename guess;
//   2. enumerates every export NAME any file of the instance publishes (the
//      candidate population the legacy per-file scan drew from);
//   3. for each such name, compares:
//        LEGACY    -- the set of files whose own export table carries that
//                     name (what the old per-file loop would have offered);
//        AUTHORITATIVE -- the file the public entry attributes or forwards
//                     that name to, if any.
//
// WHAT THESE NUMBERS ARE, AND ARE NOT
//
// These are RESOLUTION measurements, not verdict improvements. Nothing here
// runs a reachability search or builds a call graph, so no count below
// implies any finding changed verdict. Verdicts are measured by the focused
// suites and the canonical validation baseline, and nowhere else. They size
// the shape's prevalence in THESE corpora only; this is not a claim about
// the npm ecosystem.
//
// A "collision" here is a same-name sibling that the legacy scan could have
// bound instead of the public one. Whether it actually WOULD have depends on
// which files the call graph discovered in a given scan, which a corpus walk
// cannot know -- so collisions are an upper bound on the legacy defect's
// reach, never a count of real findings.
//
// Usage: node scripts/p1a2-authoritative-entry-corpus.mjs [roots...]

import fs from "node:fs";
import path from "node:path";
import { exportForwardingHops } from "../dist/code-intelligence/export-forwarding.js";
import {
  buildModuleModel,
  mapExportsToFunctions,
} from "../dist/code-intelligence/module-model.js";
import { createModuleResolver } from "../dist/code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../dist/code-intelligence/source-index.js";
import { loadTsProject } from "../dist/code-intelligence/ts-project.js";
import { identifyModule } from "../dist/domain/resolved-target.js";

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
  ROOTS.push("fixtures", "tests/validation/fixtures");
}

const EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);
const MAX_HOPS = 16;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

/** Every export name this file publishes, or null if it could not be read/parsed. */
function exportNamesOf(file) {
  try {
    const index = indexSourceFileFromDisk(file);
    const model = buildModuleModel(index);
    return {
      attributable: new Set(mapExportsToFunctions(index, model).keys()),
      model,
    };
  } catch {
    return null;
  }
}

const stats = {
  instancesScanned: 0,
  instancesWithResolvableEntry: 0,
  instancesWithUnresolvableEntry: 0,
  filesScanned: 0,
  unparsable: 0,
  exportNameCandidates: 0,
  sameNameSiblingCollisions: 0,
  authoritativeSelectsDifferentTarget: 0,
  legacyHadTargetPublicEntryHasNone: 0,
  publicEntryDirect: 0,
  publicEntryForwardingResolves: 0,
  publicEntryRefuses: 0,
};

const examples = [];

for (const root of ROOTS) {
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot)) {
    continue;
  }

  // Group every file under this root by its owning PackageInstance.
  const byInstance = new Map();
  for (const file of walk(absRoot)) {
    stats.filesScanned += 1;
    const identity = identifyModule(file, undefined);
    if (!identity.packageInstance) {
      continue;
    }
    const files = byInstance.get(identity.packageInstance) ?? [];
    files.push(file);
    byInstance.set(identity.packageInstance, files);
  }

  for (const [instance, files] of [...byInstance.entries()].sort()) {
    stats.instancesScanned += 1;

    // ---- 1. the authoritative public entry, the production way ----------
    let entry;
    try {
      const resolver = createModuleResolver(loadTsProject(absRoot));
      const pkgName = JSON.parse(
        fs.readFileSync(path.join(instance, "package.json"), "utf-8"),
      ).name;
      for (const specifier of [pkgName, instance]) {
        if (!specifier) continue;
        const resolution = await resolver.resolve(
          specifier,
          path.join(instance, "package.json"),
        );
        if (
          resolution.kind === "resolved" &&
          identifyModule(resolution.resolvedFileName, undefined)
            .packageInstance === instance
        ) {
          entry = resolution.resolvedFileName;
          break;
        }
      }
    } catch {
      entry = undefined;
    }

    if (entry) {
      stats.instancesWithResolvableEntry += 1;
    } else {
      stats.instancesWithUnresolvableEntry += 1;
      continue;
    }

    // ---- 2. the legacy candidate population ------------------------------
    /** exportName -> [files whose own export table carries it] */
    const legacy = new Map();
    for (const file of files.sort()) {
      const facts = exportNamesOf(file);
      if (!facts) {
        stats.unparsable += 1;
        continue;
      }
      for (const name of facts.attributable) {
        const owners = legacy.get(name) ?? [];
        owners.push(file);
        legacy.set(name, owners);
      }
    }

    const entryFacts = exportNamesOf(entry);
    if (!entryFacts) {
      continue;
    }

    // ---- 3. compare, per candidate export name ---------------------------
    for (const [name, owners] of [...legacy.entries()].sort()) {
      stats.exportNameCandidates += 1;

      const collides = owners.length > 1 || !owners.includes(entry);
      if (collides) {
        stats.sameNameSiblingCollisions += 1;
      }

      // What the PUBLIC ENTRY says about this name.
      let authoritative;
      if (entryFacts.attributable.has(name)) {
        authoritative = entry;
        stats.publicEntryDirect += 1;
      } else {
        authoritative = followForwarding(entry, name, instance, absRoot);
        if (authoritative) {
          stats.publicEntryForwardingResolves += 1;
        } else {
          stats.publicEntryRefuses += 1;
        }
      }

      if (!authoritative) {
        if (owners.length > 0) {
          stats.legacyHadTargetPublicEntryHasNone += 1;
          if (examples.length < 12) {
            examples.push({
              kind: "legacy-had-target-public-entry-has-none",
              instance: path.relative(process.cwd(), instance),
              name,
              legacyOwners: owners.map((f) => path.relative(instance, f)),
            });
          }
        }
        continue;
      }

      const legacyWouldDiffer = !owners.every((f) => f === authoritative);
      if (legacyWouldDiffer) {
        stats.authoritativeSelectsDifferentTarget += 1;
        if (examples.length < 12) {
          examples.push({
            kind: "authoritative-selects-different-target",
            instance: path.relative(process.cwd(), instance),
            name,
            legacyOwners: owners.map((f) => path.relative(instance, f)),
            authoritative: path.relative(instance, authoritative),
          });
        }
      }
    }
  }
}

/**
 * Follows the public entry's explicit forwarding chain for `name`, under the
 * same PackageInstance gate and cycle guard the production relation uses.
 * Synchronous best-effort: it uses the resolver's own sync path via
 * indexing + literal specifier joining, and refuses anything it cannot
 * resolve exactly, so it never over-counts.
 */
function followForwarding(file, name, instance, absRoot) {
  const visited = new Set();
  let current = { file, name };

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const key = `${current.file}#${current.name}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);

    const facts = exportNamesOf(current.file);
    if (!facts) {
      return undefined;
    }
    if (facts.attributable.has(current.name)) {
      return current.file;
    }

    const hops = [...exportForwardingHops(facts.model, current.name)];
    if (hops.length !== 1) {
      return undefined;
    }
    const [next] = hops;
    if (!next.specifier.startsWith(".")) {
      // Bare specifier: a cross-package hop, refused by the production
      // relation's package-ownership rule.
      return undefined;
    }
    const resolved = resolveRelative(path.dirname(current.file), next.specifier);
    if (!resolved) {
      return undefined;
    }
    if (identifyModule(resolved, undefined).packageInstance !== instance) {
      return undefined;
    }
    current = { file: resolved, name: next.exportName };
  }
  return undefined;
}

function resolveRelative(dir, specifier) {
  const base = path.resolve(dir, specifier);
  const candidates = [
    base,
    ...[...EXTENSIONS].map((ext) => base + ext),
    ...[...EXTENSIONS].map((ext) => path.join(base, "index" + ext)),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // next candidate
    }
  }
  return undefined;
}

console.log(JSON.stringify({ roots: ROOTS, stats, examples }, null, 2));
