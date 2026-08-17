import ts from "typescript";
import type {
  CallEdge,
  CallGraph,
  GraphNode,
  GraphNodeId,
} from "../domain/graph.js";
import {
  buildModuleModel,
  mapExportsToFunctions,
  type ModuleModel,
} from "./module-model.js";
import type { ModuleResolver } from "./module-resolver.js";
import {
  type IndexedFunction,
  type SourceIndex,
  indexSourceFileFromDisk,
  isFunctionLike,
  toSourceLocation,
} from "./source-index.js";
import { bindCallee } from "./symbol-binder.js";
import type { TsProject } from "./ts-project.js";

function locationKey(location: { line?: number; column?: number }): string {
  return `${location.line ?? "?"}:${location.column ?? "?"}`;
}

/**
 * Ambient ECMAScript/Node.js globals that can never resolve to a tracked
 * import or an analyzed local declaration, and can never be the target of
 * a vulnerable-symbol rule (they aren't installable npm packages). Calls
 * and constructions rooted in one of these are intentionally left without
 * a graph edge (see VT-201, docs/SDD.md § 3.1) -- flagging every
 * `console.log()`/`new Map()` in a real codebase as an explicit UNKNOWN
 * edge would make almost every real-world scan degrade to UNKNOWN, since
 * virtually all real code calls some builtin somewhere; that is a far
 * worse outcome than the silent-edge gap VT-201 closes. Every OTHER
 * unresolvable call-like construct -- crucially, anything rooted in a
 * local parameter, variable, or constructed instance the analyzer cannot
 * fully trace -- still becomes an explicit `unsupported_construct` edge
 * (see {@link classifyCall}, {@link classifyNew}); this list only bounds
 * that to a known, finite, auditable set of ambient identifiers, never
 * anything project-defined.
 */
const KNOWN_GLOBAL_IDENTIFIERS: ReadonlySet<string> = new Set([
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "Proxy",
  "Reflect",
  "Function",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Intl",
  "globalThis",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "fetch",
  "process",
  "Buffer",
  "module",
  "exports",
  "require",
  "__dirname",
  "__filename",
  "global",
]);

function isKnownGlobalIdentifier(name: string): boolean {
  return KNOWN_GLOBAL_IDENTIFIERS.has(name);
}

/**
 * The leftmost identifier of a call/construct callee's expression chain
 * (`foo` for `foo()`/`foo.bar()`/`foo.bar.baz()`/`foo[x]()`), or
 * `undefined` when the callee isn't rooted in a plain identifier at all
 * (e.g. `foo().bar()`) -- used only to check {@link isKnownGlobalIdentifier}
 * before deciding whether an unresolvable call-like construct still
 * deserves an explicit UNKNOWN edge.
 */
function rootIdentifierOf(expr: ts.Expression): string | undefined {
  let current: ts.Expression = expr;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
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
  for (const [canonicalName, fn] of mapExportsToFunctions(index, model)) {
    const nodeId = functionNodeIdByLocation.get(locationKey(fn.location));
    if (nodeId) {
      exportNameToNodeId.set(canonicalName, nodeId);
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

/**
 * The innermost node of `root`'s own subtree whose span contains
 * `position`, or `root` itself if none of its children do. `root` must
 * have parent pointers set (see `ts.createSourceFile`'s own
 * `setParentNodes` argument) for `getChildren`/`getStart`/`getEnd` to work.
 */
function findNodeAtPosition(root: ts.Node, position: number): ts.Node {
  for (const child of root.getChildren()) {
    if (position >= child.getStart() && position < child.getEnd()) {
      return findNodeAtPosition(child, position);
    }
  }
  return root;
}

/**
 * Resolves `instance.method()` to the real class method it calls, using
 * the TypeScript type checker to determine the receiver's own class (see
 * SDD-v0.2.md § 7.3, VT-208) -- something no purely syntactic
 * name/import-based matching can do, since nothing about the identifier
 * `instance` itself names the class `Lib`. Returns `undefined` (the caller
 * falls through to the generic `unsupported_construct` edge) whenever the
 * receiver's type can't be resolved to a concrete class with a matching
 * method -- an `any`-typed receiver, an interface with no located
 * implementation, a union of multiple classes, and so on.
 *
 * `call-graph.ts`'s own traversal walks a lightweight, standalone-parsed
 * AST (`indexSourceFileFromDisk`, no binder/checker), deliberately kept
 * separate from a full `ts.Program` for performance (SDD's own
 * performance requirements). `getTypeAtLocation` needs a node from the
 * *program's* own bound AST, not this standalone one, so this bridges the
 * two by position: the receiver's already-known line/column (from the
 * standalone parse) locates the equivalent node in the program's parse of
 * the exact same source text -- both parses produce identical positions
 * for identical syntax, so this is a safe, if slightly indirect, way to
 * avoid switching the whole traversal onto the program's AST just for
 * this one case.
 */
function resolveInstanceMethod(
  callee: ts.PropertyAccessExpression,
  prepared: FileGraphData,
  ctx: WalkContext,
): GraphNodeId | undefined {
  const program = ctx.getProgram();
  if (!program) {
    return undefined;
  }

  const programSourceFile = program.getSourceFile(prepared.index.filePath);
  if (!programSourceFile) {
    return undefined;
  }

  const receiverLocation = toSourceLocation(
    prepared.index.sourceFile,
    callee.expression,
  );
  if (
    receiverLocation.line === undefined ||
    receiverLocation.column === undefined
  ) {
    return undefined;
  }

  let receiverNode: ts.Node;
  try {
    const position = programSourceFile.getPositionOfLineAndCharacter(
      receiverLocation.line - 1,
      receiverLocation.column - 1,
    );
    receiverNode = findNodeAtPosition(programSourceFile, position);
  } catch {
    return undefined;
  }

  const checker = program.getTypeChecker();
  let classDecl: ts.ClassDeclaration | ts.ClassExpression | undefined;
  try {
    const type = checker.getTypeAtLocation(receiverNode);
    classDecl = type
      .getSymbol()
      ?.declarations?.find(
        (d): d is ts.ClassDeclaration | ts.ClassExpression =>
          ts.isClassDeclaration(d) || ts.isClassExpression(d),
      );
  } catch {
    return undefined;
  }
  if (!classDecl) {
    return undefined;
  }

  const methodDecl = classDecl.members.find(
    (m): m is ts.MethodDeclaration =>
      ts.isMethodDeclaration(m) &&
      m.name !== undefined &&
      ts.isIdentifier(m.name) &&
      m.name.text === callee.name.text,
  );
  if (!methodDecl) {
    return undefined;
  }

  const methodFile = methodDecl.getSourceFile().fileName;
  const methodLocation = toSourceLocation(
    methodDecl.getSourceFile(),
    methodDecl,
  );

  ctx.onDiscoverFile(methodFile);
  const targetFile = ctx.ensurePrepared(methodFile);
  return targetFile?.functionNodeIdByLocation.get(locationKey(methodLocation));
}

interface WalkContext {
  readonly edges: CallEdge[];
  readonly resolver: ModuleResolver;
  readonly ensurePrepared: (filePath: string) => FileGraphData | undefined;
  readonly onDiscoverFile: (filePath: string) => void;
  /**
   * Lazily builds (and memoizes) a real `ts.Program` for VT-208's
   * instance-method resolution (SDD-v0.2.md § 7.3), or `undefined` when no
   * {@link TsProject} was supplied to `buildCallGraph` (every caller that
   * predates VT-208). Never called unless a property-access call this
   * graph cannot otherwise attribute is actually encountered, and built at
   * most once per `buildCallGraph` invocation regardless of how many such
   * calls occur -- this is real type-checking, meaningfully more expensive
   * than the lightweight standalone parsing used everywhere else in this
   * file, so it must never run unconditionally.
   */
  readonly getProgram: () => ts.Program | undefined;
}

/**
 * Classifies and (when possible) resolves one call expression into a
 * {@link CallEdge} (see docs/SDD.md § 18, § 3.1's VT-201 completeness
 * invariant). Returns `undefined` only when the callee is a known ambient
 * global/builtin (see {@link KNOWN_GLOBAL_IDENTIFIERS}) — never merely
 * because resolution failed. Every other visited call, including one
 * bound to a local parameter/variable this binder cannot trace (a
 * function value flowing through an argument, a method call on a
 * locally-constructed instance), still produces an explicit
 * `unknown(unsupported_construct)` edge rather than silently vanishing:
 * before VT-201, such calls disappeared entirely, which let
 * `analyzeReachability` mistake "we never modeled this construct" for
 * "this genuinely calls nothing" and report a false NOT_AFFECTED (see
 * ADV-019/ADV-030's completion reports).
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

  // VT-201: neither an import nor a locally-declared function/method by
  // name -- e.g. a function value flowing through a parameter
  // (`invoke(fn)` calling `fn()`) or a method call on a
  // locally-constructed instance (`instance.method()`). Silently
  // returning `undefined` here (pre-VT-201 behavior) let the vulnerable
  // dependency vanish from the graph entirely rather than being flagged
  // uncertain. Known ambient globals/builtins are the sole exception —
  // they can never be a vulnerable-rule target, and flagging every
  // `console.log()` this way would make almost every real scan degrade to
  // UNKNOWN.
  const root = rootIdentifierOf(callee);
  if (root && isKnownGlobalIdentifier(root)) {
    return undefined;
  }

  // VT-208: a method call on a receiver this binder can't attribute by
  // name/import might still be resolvable via the real TypeScript type
  // checker (SDD-v0.2.md § 7.3) -- e.g. `instance.vulnerableMethod()`
  // where `instance` is a locally-constructed class instance. Attempted
  // only here, after every cheaper syntactic path has already failed.
  if (ts.isPropertyAccessExpression(callee)) {
    const methodTarget = resolveInstanceMethod(callee, prepared, ctx);
    if (methodTarget) {
      return {
        from,
        type: "method",
        resolution: { kind: "resolved", target: methodTarget },
        location,
      };
    }
  }

  return {
    from,
    type: ts.isPropertyAccessExpression(callee) ? "method" : "direct",
    resolution: {
      kind: "unknown",
      reason: "unsupported_construct",
      potentialTargets: [],
    },
    location,
  };
}

/**
 * Classifies and (when possible) resolves one `new` construction into a
 * {@link CallEdge}, mirroring {@link classifyCall} (see docs/SDD.md § 18,
 * § 3.1). Before VT-201, `NewExpression` nodes were never visited by the
 * call graph at all -- not resolved, not flagged unknown, simply invisible
 * -- so `new VulnerableClass()` could never be found reachable no matter
 * how directly it was called (see ADV-020's completion report). Every
 * visited construction now produces an edge: resolved when the
 * constructed class is attributable to an import or local declaration,
 * `unknown(unsupported_construct)` otherwise, unless the callee is a known
 * ambient global constructor (`new Map()`, `new Date()`, ...), which stays
 * without an edge exactly as before. Full class-name -> constructor-node
 * resolution accuracy (matching an exported class name to its own
 * constructor's graph node) is VT-207's job, not this task's — VT-201
 * only guarantees the construct is never silent.
 */
async function classifyNew(
  node: ts.NewExpression,
  from: GraphNodeId,
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<CallEdge | undefined> {
  const location = toSourceLocation(prepared.index.sourceFile, node);
  const callee = node.expression;

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
        type: "constructor",
        resolution: { kind: "resolved", target: targetNodeId },
        location,
      };
    }

    return {
      from,
      type: "constructor",
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
      type: "constructor",
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
      type: "constructor",
      resolution: {
        kind: "unknown",
        reason: "unresolved_module",
        potentialTargets: [],
      },
      location,
    };
  }

  // Not an import: a locally-declared class constructed by name is still
  // worth an edge when it can be attributed (mirrors classifyCall's local
  // function lookup).
  const localTarget = findLocalFunctionNodeId(callee, prepared);
  if (localTarget) {
    return {
      from,
      type: "constructor",
      resolution: { kind: "resolved", target: localTarget },
      location,
    };
  }

  const root = rootIdentifierOf(callee);
  if (root && isKnownGlobalIdentifier(root)) {
    return undefined;
  }

  return {
    from,
    type: "constructor",
    resolution: {
      kind: "unknown",
      reason: "unsupported_construct",
      potentialTargets: [],
    },
    location,
  };
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

    if (ts.isNewExpression(node)) {
      const from = stack[stack.length - 1];
      if (from) {
        const edge = await classifyNew(node, from, prepared, ctx);
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
  /**
   * Resource limits (see docs/SDD.md § 26's `analysis.limits`, § 28-29's
   * hardening requirement to bound analysis of an adversarial/pathological
   * target project). All optional and unbounded by default, so every
   * existing caller that doesn't pass them keeps its current behavior.
   * Once a limit is reached, on-demand discovery of further files stops —
   * already-queued/in-progress work still completes, so this bounds
   * unbounded growth rather than guaranteeing an exact cutoff.
   */
  readonly maxFiles?: number;
  readonly maxGraphNodes?: number;
  readonly maxAnalysisSeconds?: number;
  /**
   * The loaded project (see ts-project.ts), enabling VT-208's instance-
   * method resolution (SDD-v0.2.md § 7.3) via a real, lazily-built
   * `ts.Program`/type checker. Optional and unused by default -- every
   * caller that omits it (as every caller predating VT-208 does) keeps
   * producing an honest `unknown(unsupported_construct)` edge for a method
   * call this graph can't otherwise attribute, exactly as before.
   */
  readonly project?: TsProject;
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

  const startTime = Date.now();
  const maxFiles = options.maxFiles ?? Infinity;
  const maxGraphNodes = options.maxGraphNodes ?? Infinity;
  const maxAnalysisMs = (options.maxAnalysisSeconds ?? Infinity) * 1000;

  function withinLimits(): boolean {
    return (
      walked.size < maxFiles &&
      nodes.size < maxGraphNodes &&
      Date.now() - startTime < maxAnalysisMs
    );
  }

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
    // Gated here — the single choke point every caller (this file's own
    // onDiscoverFile below, and classifyCall's own direct ensurePrepared
    // call to look up a resolved target's exportNameToNodeId) goes
    // through — rather than in each caller individually, so a limit
    // reached mid-walk can never be bypassed by whichever call site
    // happens to run first.
    if (!withinLimits()) {
      return undefined;
    }
    const prepared = prepareFile(filePath, registerNode);
    if (prepared) {
      fileData.set(filePath, prepared);
    }
    return prepared;
  }

  let program: ts.Program | undefined;
  let programAttempted = false;

  function getProgram(): ts.Program | undefined {
    if (!programAttempted) {
      programAttempted = true;
      const project = options.project;
      if (project) {
        try {
          // Rooted at entryFiles, not just project.fileNames: the latter
          // is empty for any project with no tsconfig.json at all (a
          // common case, including most of this file's own test
          // fixtures), which would otherwise silently produce a
          // zero-root-file program that can never resolve anything.
          // entryFiles are guaranteed non-empty and, by construction,
          // reach every file the call graph itself will ever walk via
          // imports -- ts.createProgram follows those same imports to
          // build the rest of the program, same as `tsc` itself. Combined
          // with project.fileNames too, in case a relevant file is only
          // reachable through tsconfig's own "include", not a resolved
          // import chain.
          const rootFiles = new Set([
            ...options.entryFiles,
            ...project.fileNames,
          ]);
          // maxNodeModuleJsDepth defaults to 0: TypeScript will resolve a
          // plain-.js node_modules import's *specifier* but declines to
          // parse/include the file itself for type acquisition, leaving
          // its type as `any` -- confirmed directly (VT-208's own
          // investigation) against a real vulnerable-package-shaped
          // fixture with no .d.ts of its own, exactly the common case
          // this analyzer targets. Set generously rather than left at the
          // default: the existing maxFiles/maxGraphNodes/maxAnalysisSeconds
          // limits already bound the overall analysis, so this doesn't
          // need its own small ceiling.
          const compilerOptions: ts.CompilerOptions = {
            ...project.rawCompilerOptions,
            maxNodeModuleJsDepth: 100,
          };
          program = ts.createProgram(
            [...rootFiles],
            compilerOptions,
            ts.createCompilerHost(compilerOptions, true),
          );
        } catch {
          // Target-project tsconfig/source data can be arbitrarily broken
          // (see docs/SDD.md § 29); VT-208's resolution is a best-effort
          // enhancement, not a requirement -- fall back to the
          // unsupported_construct edge every earlier caller already
          // produces rather than aborting the whole scan.
          program = undefined;
        }
      }
    }
    return program;
  }

  const ctx: WalkContext = {
    edges,
    resolver: options.resolver,
    ensurePrepared,
    onDiscoverFile: (filePath) => {
      const prepared = ensurePrepared(filePath);
      if (!prepared) {
        return;
      }
      if (!walked.has(filePath)) {
        queue.push(filePath);
      }
    },
    getProgram,
  };

  while (queue.length > 0) {
    if (!withinLimits()) {
      break;
    }

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
