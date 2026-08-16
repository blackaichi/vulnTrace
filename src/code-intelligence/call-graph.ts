import ts from "typescript";
import type {
  CallEdge,
  CallGraph,
  GraphNode,
  GraphNodeId,
} from "../domain/graph.js";
import { buildModuleModel, type ModuleModel } from "./module-model.js";
import type { ModuleResolver } from "./module-resolver.js";
import {
  type IndexedFunction,
  type SourceIndex,
  indexSourceFileFromDisk,
  isFunctionLike,
  toSourceLocation,
} from "./source-index.js";
import { bindCallee } from "./symbol-binder.js";

function locationKey(location: { line?: number; column?: number }): string {
  return `${location.line ?? "?"}:${location.column ?? "?"}`;
}

function functionNodeId(filePath: string, fn: IndexedFunction): GraphNodeId {
  return `${filePath}#${fn.name ?? "<anonymous>"}@${locationKey(fn.location)}`;
}

function moduleNodeId(filePath: string): GraphNodeId {
  return `${filePath}#<module>`;
}

interface FileGraphData {
  readonly index: SourceIndex;
  readonly model: ModuleModel;
  readonly moduleNodeId: GraphNodeId;
  readonly functionNodeIdByLocation: ReadonlyMap<string, GraphNodeId>;
  /** Export name -> the node implementing it, when it could be attributed to a local function declaration. */
  readonly exportNameToNodeId: ReadonlyMap<string, GraphNodeId>;
}

/**
 * Indexes one file, registers a node for it and every function it
 * contains, and builds the export-name -> node lookup call-edge resolution
 * needs. Returns `undefined` (rather than throwing) when the file cannot
 * be read/parsed — this is target-project data, so a single bad file
 * degrades gracefully instead of aborting the whole graph build (see
 * docs/SDD.md § 5: UNKNOWN over false certainty).
 */
function prepareFile(
  filePath: string,
  registerNode: (node: GraphNode) => void,
): FileGraphData | undefined {
  let index: SourceIndex;
  try {
    index = indexSourceFileFromDisk(filePath);
  } catch {
    return undefined;
  }

  const model = buildModuleModel(index);
  const modNodeId = moduleNodeId(filePath);
  registerNode({ id: modNodeId, kind: "module", module: filePath });

  const functionNodeIdByLocation = new Map<string, GraphNodeId>();
  for (const fn of index.functions) {
    const id = functionNodeId(filePath, fn);
    functionNodeIdByLocation.set(locationKey(fn.location), id);
    registerNode({
      id,
      kind: fn.kind,
      module: filePath,
      name: fn.name,
      location: fn.location,
    });
  }

  const exportNameToNodeId = new Map<string, GraphNodeId>();
  for (const exp of model.exports) {
    if (exp.kind === "re-export") {
      // Chasing a re-export to its ultimate source file is not attempted
      // here — see TASK-018 completion report.
      continue;
    }
    const canonicalName = exp.kind === "default" ? "default" : exp.exportedName;
    // Prefer the actual local identifier; for CommonJS `exports.foo = ...`
    // there is no separate localName, but TASK-014 already infers the
    // assigned function's own name as "foo" from the assignment target,
    // so exportedName doubles as the correct lookup key there too.
    const localKey = exp.localName ?? exp.exportedName;
    if (!canonicalName || !localKey) {
      continue;
    }
    const matchingFn = index.functions.find((fn) => fn.name === localKey);
    if (matchingFn) {
      const nodeId = functionNodeIdByLocation.get(
        locationKey(matchingFn.location),
      );
      if (nodeId) {
        exportNameToNodeId.set(canonicalName, nodeId);
      }
    }
  }

  return {
    index,
    model,
    moduleNodeId: modNodeId,
    functionNodeIdByLocation,
    exportNameToNodeId,
  };
}

function findLocalFunctionNodeId(
  callee: ts.Expression,
  prepared: FileGraphData,
): GraphNodeId | undefined {
  if (!ts.isIdentifier(callee)) {
    return undefined;
  }
  const match = prepared.index.functions.find((fn) => fn.name === callee.text);
  if (!match) {
    return undefined;
  }
  return prepared.functionNodeIdByLocation.get(locationKey(match.location));
}

interface WalkContext {
  readonly edges: CallEdge[];
  readonly resolver: ModuleResolver;
  readonly ensurePrepared: (filePath: string) => FileGraphData | undefined;
  readonly onDiscoverFile: (filePath: string) => void;
}

/**
 * Classifies and (when possible) resolves one call expression into a
 * {@link CallEdge}. Returns `undefined` when the call isn't meaningful to
 * track (e.g. calling a builtin/global that isn't part of the analyzed
 * project) — not every call site needs an edge, only ones we can attribute
 * to our own code (see docs/SDD.md § 18).
 */
async function classifyCall(
  call: ts.CallExpression,
  from: GraphNodeId,
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<CallEdge | undefined> {
  const location = toSourceLocation(prepared.index.sourceFile, call);
  const callee = call.expression;

  if (ts.isIdentifier(callee) && callee.text === "eval") {
    return {
      from,
      type: "direct",
      resolution: { kind: "unknown", reason: "eval", potentialTargets: [] },
      location,
    };
  }

  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
    // Dynamic import() is always treated as uncertain in this MVP, even
    // when its argument happens to be a string literal — statically
    // resolving it like a declaration-form import is not attempted here
    // (see TASK-018 completion report).
    return {
      from,
      type: "import",
      resolution: {
        kind: "unknown",
        reason: "dynamic_import",
        potentialTargets: [],
      },
      location,
    };
  }

  if (
    ts.isIdentifier(callee) &&
    callee.text === "require" &&
    call.arguments.length === 1
  ) {
    const [argument] = call.arguments;
    if (argument && !ts.isStringLiteral(argument)) {
      return {
        from,
        type: "import",
        resolution: {
          kind: "unknown",
          reason: "dynamic_require",
          potentialTargets: [],
        },
        location,
      };
    }
    // A static require("literal") is import setup, already captured in
    // the module model; it is not itself a meaningful "call into" target.
    return undefined;
  }

  const binding = await bindCallee(
    callee,
    prepared.model,
    ctx.resolver,
    prepared.index.filePath,
  );

  if (binding.kind === "resolved") {
    ctx.onDiscoverFile(binding.target.modulePath);
    const targetFile = ctx.ensurePrepared(binding.target.modulePath);
    const targetNodeId = targetFile?.exportNameToNodeId.get(
      binding.target.exportedName,
    );

    if (targetNodeId) {
      return {
        from,
        type: "import",
        resolution: { kind: "resolved", target: targetNodeId },
        location,
      };
    }

    return {
      from,
      type: "import",
      resolution: {
        kind: "unknown",
        reason: "unresolved_target",
        potentialTargets: [],
      },
      location,
    };
  }

  if (binding.kind === "ambiguous") {
    return {
      from,
      type: "direct",
      resolution: {
        kind: "unknown",
        reason: binding.reason,
        potentialTargets: [],
      },
      location,
    };
  }

  if (binding.kind === "unresolved_module") {
    return {
      from,
      type: "import",
      resolution: {
        kind: "unknown",
        reason: "unresolved_module",
        potentialTargets: [],
      },
      location,
    };
  }

  // Not an import: a direct, same-file call is still worth an edge.
  const localTarget = findLocalFunctionNodeId(callee, prepared);
  if (localTarget) {
    return {
      from,
      type: "direct",
      resolution: { kind: "resolved", target: localTarget },
      location,
    };
  }

  return undefined;
}

async function walkFile(
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<void> {
  const stack: GraphNodeId[] = [prepared.moduleNodeId];

  async function visit(node: ts.Node): Promise<void> {
    let pushed = false;

    if (isFunctionLike(node)) {
      const nodeId = prepared.functionNodeIdByLocation.get(
        locationKey(toSourceLocation(prepared.index.sourceFile, node)),
      );
      if (nodeId) {
        stack.push(nodeId);
        pushed = true;
      }
    }

    if (ts.isCallExpression(node)) {
      const from = stack[stack.length - 1];
      if (from) {
        const edge = await classifyCall(node, from, prepared, ctx);
        if (edge) {
          ctx.edges.push(edge);
        }
      }
    }

    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (const child of children) {
      await visit(child);
    }

    if (pushed) {
      stack.pop();
    }
  }

  await visit(prepared.index.sourceFile);
}

export interface BuildCallGraphOptions {
  /** Files to start building the graph from (see TASK-019 Entrypoints for how these will eventually be selected). */
  readonly entryFiles: readonly string[];
  readonly resolver: ModuleResolver;
}

/**
 * Builds the initial call graph (see docs/SDD.md § 18) starting from
 * `entryFiles`, following resolved imports on demand: a file discovered
 * only through another file's import is indexed and walked too, so
 * `import`-typed edges can reach across module/package boundaries (e.g.
 * into `node_modules`). Already-visited files are never re-walked, which
 * also makes this safe against import cycles.
 */
export async function buildCallGraph(
  options: BuildCallGraphOptions,
): Promise<CallGraph> {
  const nodes = new Map<GraphNodeId, GraphNode>();
  const fileData = new Map<string, FileGraphData>();
  const walked = new Set<string>();
  const edges: CallEdge[] = [];
  const queue: string[] = [...options.entryFiles];

  function registerNode(node: GraphNode): void {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  }

  function ensurePrepared(filePath: string): FileGraphData | undefined {
    const cached = fileData.get(filePath);
    if (cached) {
      return cached;
    }
    const prepared = prepareFile(filePath, registerNode);
    if (prepared) {
      fileData.set(filePath, prepared);
    }
    return prepared;
  }

  const ctx: WalkContext = {
    edges,
    resolver: options.resolver,
    ensurePrepared,
    onDiscoverFile: (filePath) => {
      ensurePrepared(filePath);
      if (!walked.has(filePath)) {
        queue.push(filePath);
      }
    },
  };

  while (queue.length > 0) {
    const filePath = queue.shift();
    if (!filePath || walked.has(filePath)) {
      continue;
    }
    walked.add(filePath);

    const prepared = ensurePrepared(filePath);
    if (!prepared) {
      continue;
    }

    await walkFile(prepared, ctx);
  }

  return { nodes: [...nodes.values()], edges };
}
