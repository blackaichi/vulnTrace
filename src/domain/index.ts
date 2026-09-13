/**
 * Core VulnTrace domain models (see docs/SDD.md § 9-10).
 *
 * These types are independent of the CLI and of any specific provider
 * implementation (AGENTS.md: "Keep domain models independent from CLI and
 * providers"). All object fields are `readonly`: domain models represent
 * immutable analysis inputs/outputs. Code that builds them incrementally
 * (e.g. a call graph builder) should accumulate into local mutable
 * collections and return the finished, readonly-typed structure.
 */

export type { DependencyNode } from "./dependency.js";
export type { Entrypoint, EntrypointSource } from "./entrypoint.js";
export type {
  PackageQuery,
  RawVulnerability,
  Severity,
  Vulnerability,
  VulnerabilityProvider,
  VulnerabilityReference,
  VersionRange,
} from "./vulnerability.js";
export type {
  TargetKind,
  VulnerableSymbolRule,
  VulnerableSymbolTarget,
} from "./target.js";
export type {
  CallEdge,
  CallEdgeResolution,
  CallEdgeType,
  CallGraph,
  DynamicCallReason,
  GraphNode,
  GraphNodeId,
  GraphNodeKind,
  ReachabilityEngine,
  ReachabilityResult,
  ReachabilityState,
  SourceLocation,
  UnresolvedEdge,
} from "./graph.js";
export { isCallResolved, isReachable } from "./graph.js";
export type {
  ConfirmedAbsentFromModuleLoadClosure,
  ConfirmedAbsentInstance,
  ConfirmedUnreachableTarget,
  Evidence,
} from "./evidence.js";
export {
  SUPPORTED_MODEL_EXCLUSIONS,
  SUPPORTED_MODEL_STATEMENT,
} from "./evidence.js";
export type {
  KnownPackageRoots,
  ModuleIdentity,
  PackageInstanceId,
  ResolvedTarget,
} from "./resolved-target.js";
export {
  buildKnownPackageRoots,
  buildResolvedTarget,
  canonicalizePackageInstancePath,
  identifyModule,
} from "./resolved-target.js";
export type { Finding, Verdict } from "./verdict.js";
export type { Coverage, Diagnostic } from "./coverage.js";
