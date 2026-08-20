export {
  type DiscoverEntrypointsOptions,
  type DiscoverEntrypointsResult,
  type EntrypointDiagnostic,
  discoverEntrypoints,
} from "./entrypoints.js";
export {
  type BuildModuleLoadClosureOptions,
  type ClosureIncompleteness,
  type ClosureIncompletenessReason,
  type ModuleLoadClosure,
  buildModuleLoadClosure,
  closureContainsFile,
  closureContainsPackageInstance,
} from "./module-load-closure.js";
export {
  analyzeReachability,
  collectGraphDiagnostics,
  computeCoverage,
  reachabilityEngine,
} from "./reachability.js";
export { type BuildFindingOptions, buildFinding } from "./verdict.js";
