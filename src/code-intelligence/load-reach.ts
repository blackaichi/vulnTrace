import { realpathSync } from "node:fs";
import type { CallGraph } from "../domain/graph.js";
import type { JsxSettings } from "./jsx-runtime.js";
import { findClosureWideningConstructs } from "./loader-constructs.js";
import {
  buildModuleModel,
  fileReachesLoaderRegistry,
  globalObjectIdiomSites,
  loadReachQuery,
  REGISTRY_BUILTINS,
  type LoadReach,
} from "./module-model.js";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "./module-resolver.js";
import { indexSourceFileFromDisk, type SourceIndex } from "./source-index.js";

/**
 * The module graph the export census asks "may this load hand back one of
 * my export objects?" (task BL-074; ADR 0009 § 4, "a cyclic `require` that
 * cannot reach back … does not split the write set"; RWF-103, RWF-106).
 *
 * THE QUESTION. A load of module M from file F may return F's own exports
 * object -- M, or a module M loads, loads F back (a cycle), or reaches it
 * without a static load (the loader registry) -- or, when F's whole-module
 * write installs another module S's object (`module.exports =
 * require("./safe")`), S's object: M is S, or M reaches S. The census
 * (`module-model.ts`, `loadResultEscapes`) treats a load the answer may be
 * yes for as an alias of the export object wherever its value flows.
 *
 * THE ANSWER. A literal specifier may reach back when it:
 *
 * - is unresolved or resolves only to a declaration (the module that runs
 *   is unknown);
 * - names a registry builtin (`REGISTRY_BUILTINS`: `module`, `process`,
 *   `vm`, …); any other builtin's object is Node's, never a module's
 *   exports object;
 * - resolves to a module whose static load closure contains a target (F,
 *   or a module F's whole-module write installs), or is TAINTED: a member
 *   that cannot be read or parsed, a closure-widening construct
 *   (`findClosureWideningConstructs`: a computed `require`, `import()`,
 *   `eval`, `Function`, `vm`, `module.require`, `Module._load`, a
 *   `createRequire`, a loader hook), a load the closure does not follow as
 *   an edge, a registry reference (`fileReachesLoaderRegistry`), an
 *   unresolved or declaration-only load, a registry builtin, or the closure
 *   exceeding its file bound.
 *
 * One closure-widening reason is not taint: `loader_capability_escape`, a
 * loader capability whose value the classifier stops following (`module`
 * or `require` bound to a local, handed to a call). Every capability it
 * tracks (`loader-constructs.ts`, `resolveLoaderCapability`) comes from the
 * ambient `module` or `require`, `require("module")`, `module.constructor`
 * or `process.mainModule`, and `fileReachesLoaderRegistry` already taints
 * each of those wherever it is used other than inertly -- a `module` bound
 * to a local that reads only `exports` (lodash's `freeModule`), a `require`
 * alias only ever called (and any load through it is itself a non-edge, so
 * taint). Counting the reason as well would taint every lodash-built
 * package for a use that reaches no other module.
 *
 * Nor is `function_constructor` at a `Function("return this")()` whose
 * value only initializes a binding (`globalObjectIdiomSites`): lodash's and
 * many UMD builds' way to reach the global object (measured: VAL-001's
 * `lodash.template`, through `lodash.templatesettings`). The literal body
 * evaluates nothing else, and every use of the binding is the registry
 * scan's: a code-evaluating or registry member of the global object, a
 * computed member, or the object handed on taints.
 *
 * The closure's edges are every literal `require` anywhere in a member
 * (deferred ones too: a function M exports may load F when F calls it),
 * every ESM import and every re-export source -- the module-load closure's
 * relation (`analysis/module-load-closure.ts`) widened to deferred loads.
 *
 * A file whose whole-module write installs a value no load names (a call's
 * result, a reassigned binding) gets no answer: any load may return it.
 *
 * Writes by OTHER modules onto an export object stay out of this relation
 * (task E-4): it decides only what THIS file's own loads may return.
 *
 * Performance only ever narrows the answer to "may reach": a bound
 * reached, a file not prepared, a resolution that fails -- each is "may
 * reach", never "cannot".
 */
export class LoadReachGraph {
  private readonly resolver: ModuleResolver;
  private readonly jsx: JsxSettings | undefined;
  private readonly maxFiles: number;
  private readonly members = new Map<string, Promise<MemberFacts>>();
  private readonly closures = new Map<string, Promise<ClosureFacts>>();
  private readonly prepared = new Map<string, LoadReach>();
  private readonly pending = new Map<string, Promise<LoadReach>>();
  private readonly indexes = new Map<string, SourceIndex | null>();

  constructor(
    resolver: ModuleResolver,
    options: { readonly jsx?: JsxSettings; readonly maxFiles?: number } = {},
  ) {
    this.resolver = resolver;
    this.jsx = options.jsx;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_CLOSURE_FILES;
  }

  /**
   * The context of `index`'s file, computed once per graph; the same
   * object is returned to every caller, so the census's caches keyed by it
   * are shared.
   */
  async prepare(index: SourceIndex): Promise<LoadReach> {
    const key = canonicalPath(index.filePath);
    const done = this.prepared.get(key);
    if (done !== undefined) {
      return done;
    }
    let promise = this.pending.get(key);
    if (promise === undefined) {
      promise = this.compute(index, key).then((reach) => {
        this.prepared.set(key, reach);
        return reach;
      });
      this.pending.set(key, promise);
    }
    return promise;
  }

  /** {@link prepare} for a file read from disk; a file that cannot be read gets no context. */
  async prepareFile(filePath: string): Promise<LoadReach | undefined> {
    const index = this.indexOf(filePath);
    return index === undefined ? undefined : this.prepare(index);
  }

  /**
   * The file's index, read and parsed once per graph -- shared with the
   * call graph built with it (`call-graph.ts`'s `prepareFile`), so a scan
   * parses each file once, and the census caches keyed by its source file
   * are shared too. Performance only: `undefined` for a file that cannot be
   * read, exactly as reading it again would answer.
   */
  indexOf(filePath: string): SourceIndex | undefined {
    if (this.indexes.has(filePath)) {
      return this.indexes.get(filePath) ?? undefined;
    }
    let index: SourceIndex | null;
    try {
      index = indexSourceFileFromDisk(filePath);
    } catch {
      index = null;
    }
    this.indexes.set(filePath, index);
    return index ?? undefined;
  }

  /** The context {@link prepare} computed for `filePath`, or `undefined` (the census's per-file rule). */
  cached(filePath: string): LoadReach | undefined {
    return this.prepared.get(canonicalPath(filePath));
  }

  private async compute(index: SourceIndex, file: string): Promise<LoadReach> {
    const query = loadReachQuery(index);
    if (query.opaqueFinalObject) {
      return ALWAYS_REACHES;
    }
    const targets = new Set<string>([file]);
    for (const specifier of query.forwardSpecifiers) {
      const resolution = await this.resolve(specifier, index.filePath);
      if (resolution?.kind !== "resolved") {
        // A forwarded builtin's or unknown module's object: any load of
        // anything may return it.
        return ALWAYS_REACHES;
      }
      targets.add(canonicalPath(resolution.resolvedFileName));
    }
    const answers = new Map<string, boolean>();
    for (const specifier of query.specifiers) {
      answers.set(
        specifier,
        await this.specifierReaches(specifier, index.filePath, targets),
      );
    }
    return {
      mayReachBack: (specifier) => answers.get(specifier) ?? true,
    };
  }

  private async specifierReaches(
    specifier: string,
    importer: string,
    targets: ReadonlySet<string>,
  ): Promise<boolean> {
    const resolution = await this.resolve(specifier, importer);
    if (resolution === undefined) {
      return true;
    }
    switch (resolution.kind) {
      case "builtin":
        return REGISTRY_BUILTINS.has(builtinName(resolution.specifier));
      case "resolved": {
        const closure = await this.closureOf(
          canonicalPath(resolution.resolvedFileName),
        );
        return (
          closure.tainted || [...targets].some((t) => closure.files.has(t))
        );
      }
      default:
        return true;
    }
  }

  /** The static load closure of `root` (canonical), memoized per root. */
  private closureOf(root: string): Promise<ClosureFacts> {
    let closure = this.closures.get(root);
    if (closure === undefined) {
      closure = this.walk(root);
      this.closures.set(root, closure);
    }
    return closure;
  }

  private async walk(root: string): Promise<ClosureFacts> {
    const files = new Set<string>();
    const queue = [root];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (files.has(file)) {
        continue;
      }
      if (files.size >= this.maxFiles) {
        return { files, tainted: true };
      }
      files.add(file);
      loadReachClosureVisits += 1;
      const member = await this.memberOf(file);
      if (member.tainted) {
        return { files, tainted: true };
      }
      for (const edge of member.edges) {
        if (!files.has(edge)) {
          queue.push(edge);
        }
      }
    }
    return { files, tainted: false };
  }

  private memberOf(file: string): Promise<MemberFacts> {
    let member = this.members.get(file);
    if (member === undefined) {
      member = this.scan(file);
      this.members.set(file, member);
    }
    return member;
  }

  private async scan(file: string): Promise<MemberFacts> {
    loadReachMemberScans += 1;
    const index = this.indexOf(file);
    if (index === undefined) {
      return TAINTED;
    }
    if (index.hasSyntaxErrors) {
      return TAINTED;
    }
    const model = buildModuleModel(index);
    const idioms = globalObjectIdiomSites(index);
    if (
      fileReachesLoaderRegistry(index) ||
      findClosureWideningConstructs({ index, model, jsx: this.jsx }).some(
        (construct) =>
          construct.reason !== "loader_capability_escape" &&
          !(
            construct.reason === "function_constructor" &&
            idioms.has(
              `${construct.location.line}:${construct.location.column}`,
            )
          ),
      )
    ) {
      return TAINTED;
    }
    const specifiers = new Set<string>(
      model.imports.map((binding) => binding.specifier),
    );
    for (const binding of model.exports) {
      if (binding.kind === "re-export" && binding.specifier !== undefined) {
        specifiers.add(binding.specifier);
      }
    }
    const edges: string[] = [];
    for (const specifier of specifiers) {
      const resolution = await this.resolve(specifier, file);
      if (resolution === undefined) {
        return TAINTED;
      }
      if (resolution.kind === "builtin") {
        if (REGISTRY_BUILTINS.has(builtinName(resolution.specifier))) {
          return TAINTED;
        }
        continue;
      }
      if (resolution.kind !== "resolved") {
        return TAINTED;
      }
      edges.push(canonicalPath(resolution.resolvedFileName));
    }
    return { tainted: false, edges };
  }

  private async resolve(
    specifier: string,
    importer: string,
  ): Promise<ModuleResolutionResult | undefined> {
    try {
      return await this.resolver.resolve(specifier, importer);
    } catch {
      return undefined;
    }
  }
}

interface MemberFacts {
  readonly tainted: boolean;
  /** The canonical files this member loads statically. */
  readonly edges: readonly string[];
}

interface ClosureFacts {
  readonly tainted: boolean;
  readonly files: ReadonlySet<string>;
}

const TAINTED: MemberFacts = { tainted: true, edges: [] };

const ALWAYS_REACHES: LoadReach = { mayReachBack: () => true };

/**
 * The closure bound. Reaching it is "may reach" (fail closed), never a
 * silently partial answer.
 */
export const DEFAULT_MAX_CLOSURE_FILES = 4096;

function builtinName(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

/** One spelling per file: a symlinked install and its target are one module to Node. */
function canonicalPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

let loadReachMemberScans = 0;
let loadReachClosureVisits = 0;

/** Files {@link LoadReachGraph} has read and scanned in this process (BL-074's structural performance test). */
export function loadReachMemberScanCount(): number {
  return loadReachMemberScans;
}

/** Closure members {@link LoadReachGraph} has visited in this process. */
export function loadReachClosureVisitCount(): number {
  return loadReachClosureVisits;
}

const graphsByResolver = new WeakMap<ModuleResolver, LoadReachGraph>();

/**
 * The scan's one {@link LoadReachGraph}, shared by every consumer that
 * holds its resolver (the call graph, target attribution, entrypoint
 * roots), so a file's context -- and the census caches keyed by it -- is
 * computed once.
 */
export function loadReachGraphFor(
  resolver: ModuleResolver,
  options: { readonly jsx?: JsxSettings } = {},
): LoadReachGraph {
  let graph = graphsByResolver.get(resolver);
  if (graph === undefined) {
    graph = new LoadReachGraph(resolver, options);
    graphsByResolver.set(resolver, graph);
  }
  return graph;
}

const graphsByCallGraph = new WeakMap<CallGraph, LoadReachGraph>();

/** Records the {@link LoadReachGraph} a call graph was built with, for the consumers that hold only the graph. */
export function attachLoadReachGraph(
  callGraph: CallGraph,
  graph: LoadReachGraph,
): void {
  graphsByCallGraph.set(callGraph, graph);
}

/**
 * The {@link LoadReachGraph} `callGraph` was built with, or `undefined` (a
 * graph built by hand, as tests do): the census then applies its per-file
 * rule.
 */
export function loadReachGraphOf(
  callGraph: CallGraph,
): LoadReachGraph | undefined {
  return graphsByCallGraph.get(callGraph);
}

/**
 * A resolver that prepares the reach context of every file it resolves to
 * before answering, so a consumer that prepares files synchronously after
 * resolving them (`call-graph.ts`'s `ensurePrepared`) finds each one's
 * context ready. Resolution answers are passed through unchanged.
 */
export function preparingResolver(
  resolver: ModuleResolver,
  graph: LoadReachGraph,
): ModuleResolver {
  return {
    resolve: async (specifier, importer) => {
      const resolution = await resolver.resolve(specifier, importer);
      if (resolution.kind === "resolved") {
        await graph.prepareFile(resolution.resolvedFileName);
      }
      return resolution;
    },
  };
}
