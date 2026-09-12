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
// RUNTIME FILES VS DECLARATION FILES
//
// This is measured TWICE, and the two numbers are not interchangeable.
//
// A `.d.ts` sibling can never contribute advisory target authority: target
// attribution (`findExportNodeInFile`) only materializes a node when the
// call graph contains one whose `module` is that exact file, and the graph
// never traverses declaration files -- VT-304 refuses declaration-only
// resolutions outright. So a "same-name collision" whose only rival is a
// `.d.ts` is a MEASUREMENT ARTIFACT of walking the tree, not a case the
// legacy scan could ever have got wrong.
//
//   `allFiles`    -- every indexable file (.js/.cjs/.mjs/.ts/.cts/.mts),
//                    which includes `.d.ts` declarations. Reported for
//                    continuity and to size the artifact itself.
//   `runtimeOnly` -- .js/.cjs/.mjs only. THIS is the figure that describes
//                    real target-authority disagreement, and the one to
//                    quote.
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
// A "collision" is a same-name sibling the legacy scan could have bound
// instead of the public one. Whether it actually WOULD have depends on
// which files the call graph discovered in a given scan, which a corpus
// walk cannot know -- so collisions are an upper bound on the legacy
// defect's reach, never a count of real findings.
//
// The forwarding chase below is an independent, deliberately conservative
// re-implementation of the hop rule (relative specifiers only, single
// unambiguous hop, same instance, cycle-guarded). It uses the production
// `exportForwardingHops` relation but not the production module resolver,
// so it UNDER-counts rather than over-counts.
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

/** Files that can actually carry a runtime implementation. */
const RUNTIME_EXTENSIONS = [".js", ".cjs", ".mjs"];
/** Everything indexable, declarations included. */
const ALL_EXTENSIONS = [...RUNTIME_EXTENSIONS, ".ts", ".cts", ".mts"];

const MAX_HOPS = 16;

function* walk(dir, extensions) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, extensions);
    } else if (extensions.has(path.extname(entry.name))) {
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

function resolveRelative(dir, specifier, extensions) {
  const base = path.resolve(dir, specifier);
  const candidates = [
    base,
    ...[...extensions].map((ext) => base + ext),
    ...[...extensions].map((ext) => path.join(base, "index" + ext)),
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

/**
 * Follows the public entry's explicit forwarding chain for `name`, under the
 * same PackageInstance gate and cycle guard the production relation uses,
 * refusing anything it cannot resolve exactly.
 */
function followForwarding(file, name, instance, extensions) {
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
    const resolved = resolveRelative(
      path.dirname(current.file),
      next.specifier,
      extensions,
    );
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

async function measure(extensionList) {
  const extensions = new Set(extensionList);
  const stats = {
    instancesScanned: 0,
    instancesWithResolvableEntry: 0,
    instancesWithNoDefaultPublicEntry: 0,
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
  const differentTarget = [];
  const noPublicEntry = [];
  const noDefaultEntryInstances = [];

  for (const root of ROOTS) {
    const absRoot = path.resolve(root);
    if (!fs.existsSync(absRoot)) {
      continue;
    }

    const byInstance = new Map();
    for (const file of walk(absRoot, extensions)) {
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

      // ---- 1. the authoritative public entry, the production way --------
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
        // NOT an ordinary resolver failure. In practice this is a
        // SUBPATH-ONLY package -- `"main": false` with an `exports` map that
        // declares only subpaths and no "." -- so no default public entry
        // exists to anchor at under the P1-A2 contract, and advisory
        // resolution fails closed. Subpath advisory support is later
        // P1-A package-resolution work.
        stats.instancesWithNoDefaultPublicEntry += 1;
        let manifest = {};
        try {
          manifest = JSON.parse(
            fs.readFileSync(path.join(instance, "package.json"), "utf-8"),
          );
        } catch {
          // keep the empty manifest
        }
        noDefaultEntryInstances.push({
          instance: path.relative(process.cwd(), instance),
          main: manifest.main ?? null,
          exportsKeys: Object.keys(manifest.exports ?? {}),
        });
        continue;
      }

      // ---- 2. the legacy candidate population ---------------------------
      const legacy = new Map();
      for (const file of files.sort()) {
        const facts = exportNamesOf(file);
        if (!facts) {
          stats.unparsable += 1;
          continue;
        }
        for (const name of facts.attributable) {
          legacy.set(name, [...(legacy.get(name) ?? []), file]);
        }
      }

      const entryFacts = exportNamesOf(entry);
      if (!entryFacts) {
        continue;
      }

      // ---- 3. compare, per candidate export name ------------------------
      for (const [name, owners] of [...legacy.entries()].sort()) {
        stats.exportNameCandidates += 1;

        if (owners.length > 1 || !owners.includes(entry)) {
          stats.sameNameSiblingCollisions += 1;
        }

        let authoritative;
        if (entryFacts.attributable.has(name)) {
          authoritative = entry;
          stats.publicEntryDirect += 1;
        } else {
          authoritative = followForwarding(entry, name, instance, extensions);
          if (authoritative) {
            stats.publicEntryForwardingResolves += 1;
          } else {
            stats.publicEntryRefuses += 1;
          }
        }

        if (!authoritative) {
          if (owners.length > 0) {
            stats.legacyHadTargetPublicEntryHasNone += 1;
            if (noPublicEntry.length < 12) {
              noPublicEntry.push({
                instance: path.relative(process.cwd(), instance),
                name,
                legacyOwners: owners.map((f) => path.relative(instance, f)),
              });
            }
          }
          continue;
        }

        if (!owners.every((f) => f === authoritative)) {
          stats.authoritativeSelectsDifferentTarget += 1;
          // Deliberately NOT capped against the other example list: these
          // are the cases the finding is actually about, and an earlier
          // shared cap silently hid one of them from the record.
          differentTarget.push({
            instance: path.relative(process.cwd(), instance),
            name,
            legacyOwners: owners.map((f) => path.relative(instance, f)),
            authoritative: path.relative(instance, authoritative),
          });
        }
      }
    }
  }

  return { stats, differentTarget, noPublicEntry, noDefaultEntryInstances };
}

const allFiles = await measure(ALL_EXTENSIONS);
const runtimeOnly = await measure(RUNTIME_EXTENSIONS);

console.log(
  JSON.stringify(
    {
      roots: ROOTS,
      note:
        "runtimeOnly is the figure that describes real target-authority " +
        "disagreement; allFiles additionally counts .d.ts rivals, which can " +
        "never contribute a target node.",
      allFiles,
      runtimeOnly,
    },
    null,
    2,
  ),
);
