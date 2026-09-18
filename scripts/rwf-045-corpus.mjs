// RWF-045 corpus measurement.
//
// Walks every vendored JS/CJS/MJS/TS file reachable from the committed
// corpus roots and, for every CALL whose callee is a bare identifier,
// recomputes which destructuring source the call graph's bridge would
// attribute it to -- twice:
//
//   OLD: `findDestructuredBindingSource(callee.text, sourceFile)`, the
//        whole-file, first-match-wins walk for any
//        `const { <name> } = src`, reproduced verbatim from the merged
//        base b9bb81b.
//   NEW: `resolveDestructuredBindingSource(callee)`, which starts from
//        the exact BindingElement `resolveDestructuredBindingElement`
//        says the reference binds to. Imported from dist/, so this
//        measures the SHIPPING code rather than a restatement of it.
//
// Both are gated exactly as production gates them: the bridge is only
// consulted when `resolveNamedBinding` refuses with cause
// `destructuring`. A call this gate never reaches is not a bridge call
// site and is not counted.
//
// Reports counts and a per-site classification only. It makes no claim
// about verdicts -- those are measured by the fixture suite, the
// adversarial suites and the validation baseline.
//
// Usage: node scripts/rwf-045-corpus.mjs [roots...]

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  resolveNamedBinding,
  resolveDestructuredBindingElement,
} from "../dist/code-intelligence/named-bindings.js";

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
  ROOTS.push(
    "fixtures",
    "tests/adversarial/v1/fixtures",
    "tests/adversarial/v2/fixtures",
    "tests/validation/fixtures",
  );
}

const EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

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

function isConstDeclaration(declaration) {
  const list = declaration.parent;
  return (
    list &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

/** The helper exactly as it stood on the merged base b9bb81b. */
function oldFindDestructuredBindingSource(name, sourceFile) {
  let found;
  function visit(node) {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      isConstDeclaration(node)
    ) {
      const source = node.initializer;
      for (const element of node.name.elements) {
        if (
          element.dotDotDotToken ||
          !ts.isIdentifier(element.name) ||
          element.name.text !== name
        ) {
          continue;
        }
        const propertyNameNode = element.propertyName ?? element.name;
        if (
          ts.isIdentifier(propertyNameNode) ||
          ts.isStringLiteralLike(propertyNameNode)
        ) {
          found = { source, propertyName: propertyNameNode.text };
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/** The shipping replacement, driven by the real declaration lookup. */
function newResolveDestructuredBindingSource(reference) {
  const element = resolveDestructuredBindingElement(reference);
  if (!element || element.dotDotDotToken || element.initializer) return undefined;
  const pattern = element.parent;
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  const declaration = pattern.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isIdentifier(declaration.initializer) ||
    !isConstDeclaration(declaration)
  ) {
    return undefined;
  }
  const propertyNameNode = element.propertyName ?? element.name;
  if (
    !ts.isIdentifier(propertyNameNode) &&
    !ts.isStringLiteralLike(propertyNameNode)
  ) {
    return undefined;
  }
  return {
    source: declaration.initializer,
    propertyName: propertyNameNode.text,
  };
}

/** How many `const { <name> } = <identifier>` patterns bind this name. */
function sameNameCandidateCount(name, sourceFile) {
  let count = 0;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      isConstDeclaration(node)
    ) {
      for (const element of node.name.elements) {
        if (
          !element.dotDotDotToken &&
          ts.isIdentifier(element.name) &&
          element.name.text === name
        ) {
          count += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

const stats = {
  filesScanned: 0,
  filesWithDestructuredCallSites: 0,
  projects: new Set(),
  bridgeCallSites: 0,
  oldHits: 0,
  newHits: 0,
  multiCandidateSites: 0,
  // Classification of every site where old and new disagree.
  changed: {
    A_fabricatedRemoved: [], // old resolved, new refuses
    B_targetCorrected: [], // both resolve, different source/property
    C_unchanged: 0, // both resolve, identical
    D_newlyResolved: [], // old refused, new resolves
  },
};

/** The corpus "project" a file belongs to: the fixture directory root. */
function projectOf(file) {
  const parts = file.split(path.sep);
  const idx = parts.indexOf("fixtures");
  return idx >= 0 ? parts.slice(0, idx + 2).join(path.sep) : path.dirname(file);
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    stats.filesScanned += 1;
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );

    let fileHasSite = false;

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression;
        let binding;
        try {
          binding = resolveNamedBinding(callee);
        } catch {
          binding = undefined;
        }
        // The production gate: the bridge is consulted ONLY for a
        // `destructuring` refusal. Every other outcome is either
        // authoritative already or a refusal that must not be routed
        // around.
        if (
          binding &&
          binding.kind === "unresolved" &&
          binding.cause === "destructuring"
        ) {
          stats.bridgeCallSites += 1;
          fileHasSite = true;
          stats.projects.add(projectOf(file));

          const candidates = sameNameCandidateCount(callee.text, sourceFile);
          if (candidates > 1) stats.multiCandidateSites += 1;

          const oldResult = oldFindDestructuredBindingSource(
            callee.text,
            sourceFile,
          );
          const newResult = newResolveDestructuredBindingSource(callee);
          if (oldResult) stats.oldHits += 1;
          if (newResult) stats.newHits += 1;

          const where = `${file}:${
            sourceFile.getLineAndCharacterOfPosition(callee.getStart(sourceFile))
              .line + 1
          } ${callee.text}`;

          if (oldResult && !newResult) {
            stats.changed.A_fabricatedRemoved.push(
              `${where} (old -> ${oldResult.source.text}.${oldResult.propertyName})`,
            );
          } else if (!oldResult && newResult) {
            stats.changed.D_newlyResolved.push(
              `${where} (new -> ${newResult.source.text}.${newResult.propertyName})`,
            );
          } else if (oldResult && newResult) {
            const same =
              oldResult.source === newResult.source &&
              oldResult.propertyName === newResult.propertyName;
            if (same) {
              stats.changed.C_unchanged += 1;
            } else {
              stats.changed.B_targetCorrected.push(
                `${where} (old -> ${oldResult.source.text}.${oldResult.propertyName}; new -> ${newResult.source.text}.${newResult.propertyName})`,
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    try {
      visit(sourceFile);
    } catch {
      // A file this parser cannot walk contributes nothing; the suites
      // own correctness, this script only counts.
    }

    if (fileHasSite) stats.filesWithDestructuredCallSites += 1;
  }
}

const out = {
  roots: ROOTS,
  filesScanned: stats.filesScanned,
  filesWithBridgeCallSites: stats.filesWithDestructuredCallSites,
  projectsWithBridgeCallSites: stats.projects.size,
  bridgeCallSites: stats.bridgeCallSites,
  oldHelperHits: stats.oldHits,
  newHelperHits: stats.newHits,
  sitesWithMultipleSameNameCandidates: stats.multiCandidateSites,
  changedEdges: {
    // A and D are the SAME set of sites -- old resolved, new refuses --
    // seen from two sides: the refusal is category A when the old answer
    // was wrong and category D when it was right but not provable from
    // the binding element alone. No script can tell those apart, so the
    // set is reported once and classified by manual audit.
    AD_resolvedBeforeRefusedNow: stats.changed.A_fabricatedRemoved.length,
    B_wrongTargetCorrected: stats.changed.B_targetCorrected.length,
    C_honestEdgeRetained: stats.changed.C_unchanged,
    E_unexpectedNewResolution: stats.changed.D_newlyResolved.length,
  },
  detail: {
    AD_resolvedBeforeRefusedNow: stats.changed.A_fabricatedRemoved,
    B_wrongTargetCorrected: stats.changed.B_targetCorrected,
    E_unexpectedNewResolution: stats.changed.D_newlyResolved,
  },
};

console.log(JSON.stringify(out, null, 2));
