import type { ModuleModel } from "./module-model.js";

/**
 * One statically-exact forwarding hop taken by a module's export table
 * (P1-A1): "the value this module publishes under `<requested name>` is
 * whatever `<specifier>` publishes under `<exportName>`".
 *
 * Deliberately carries NO resolved file path and NO package identity — the
 * same discipline commonjs-reexports.ts's {@link CommonJsReExportOrigin}
 * already keeps. Resolving the specifier, enforcing whatever
 * package-boundary rule the consumer's own contract requires, and turning
 * the far side into graph nodes are the consumer's job, not this module's.
 * Two consumers exist and they deliberately differ on exactly that point:
 *
 * - call-graph.ts's `resolveReExportChain` — CONSUMER-side chasing, which
 *   follows a hop wherever Node's own resolution lands it, including into
 *   a different installed package (RWF-004b).
 * - verdict.ts's target attribution — TARGET-side chasing, which is bound
 *   to the advisory's own PackageInstance (P1-A1; see that call site).
 *
 * This module exists so those two consumers cannot drift apart on the one
 * question they must answer identically: *which* hop an export takes, and
 * *under what name* the far side is asked. It is a pure function of the
 * module model both of them already build — never a second resolver, and
 * never a second source of export facts (SDD-v0.2.md § 5).
 */
export interface ExportForwardingHop {
  /** The literal `require()`/`from` specifier the forwarded value came from. */
  readonly specifier: string;
  /** The name to request on the far side of the hop. */
  readonly exportName: string;
  /** Which syntax's rule produced this hop — for evidence/provenance only. */
  readonly syntax: "esm" | "commonjs";
}

/**
 * The ESM `export { x } from "y";` hop, behaviorally identical to the
 * relation VT-209 shipped inside call-graph.ts's `resolveEsmReExport`
 * (extracted verbatim, not redesigned).
 *
 * Scoped to the NAMED form only. `export * from "y"` is a different
 * problem — matching one requested name against an unenumerated set — and
 * is deliberately not attempted: a star export must never be resolved
 * heuristically, so its absence here is a fail-closed refusal that leaves
 * the caller's own unresolved/UNKNOWN path exactly as it was.
 */
export function esmExportForwardingHop(
  model: ModuleModel,
  exportName: string,
): ExportForwardingHop | undefined {
  const reExport = model.exports.find(
    (exp) =>
      exp.kind === "re-export" &&
      exp.exportedName === exportName &&
      exp.specifier !== undefined,
  );
  if (!reExport?.specifier) {
    return undefined;
  }
  // `localName` is the name as written on the far side, which is what
  // makes a RENAMED re-export (`export { internalName as vulnerable }`)
  // resolve to `internalName` over there rather than to a search for
  // something literally called `vulnerable`.
  return {
    specifier: reExport.specifier,
    exportName: reExport.localName ?? exportName,
    syntax: "esm",
  };
}

/**
 * The CommonJS hop, behaviorally identical to the relation RWF-004a
 * shipped inside call-graph.ts's `resolveCommonJsReExport` (extracted
 * verbatim, not redesigned). Two forwarding rules, both exactly Node's own
 * semantics:
 *
 * 1. A NAMED re-export (`exports.foo = require("./lib").foo`) forwards
 *    only `foo`, and forwards it to whichever name it actually selected
 *    over there (`exports.foo = require("./lib").bar` forwards to `bar`).
 *    When it selected NO name at all (`exports.foo = require("./lib")` —
 *    the dominant real-world shape, and exactly `qs`'s
 *    `module.exports = { parse: parse }` over
 *    `var parse = require("./parse")`), `foo` IS that module's whole
 *    exported value, so it forwards to the target's canonical `"default"`
 *    export, which is what Node binds there.
 * 2. A WHOLE-MODULE re-export (`module.exports = require("./lib")`) makes
 *    this module's export namespace *be* the other module's, so any
 *    requested name is looked up under the same name over there. The
 *    narrower `module.exports = require("./lib").foo` form forwards only
 *    the module's own default value, hence only `exportName === "default"`.
 *
 * A file that has its own named export for `exportName` which the export
 * model could not attribute a re-export origin to (a dynamic specifier, a
 * conditional assignment, a reassigned alias, a locally-defined value)
 * deliberately stops here rather than falling through to rule 2: that own
 * binding shadows any forwarded namespace at runtime, so forwarding anyway
 * would resolve to a value the module does not actually export under that
 * name.
 *
 * Every negative outcome is a refusal to hop, never a guess — which is
 * what makes ambiguous and unsupported forwarding degrade to the caller's
 * existing unresolved/UNKNOWN result rather than to a fabricated target.
 */
export function commonJsExportForwardingHop(
  model: ModuleModel,
  exportName: string,
): ExportForwardingHop | undefined {
  const own = model.exports.find(
    (exp) =>
      exp.syntax === "commonjs" &&
      exp.kind === "named" &&
      exp.exportedName === exportName,
  );
  if (own) {
    const origin = own.commonJsReExport;
    return origin === undefined
      ? undefined
      : {
          specifier: origin.specifier,
          exportName: origin.importedName ?? "default",
          syntax: "commonjs",
        };
  }

  const whole = model.exports.find(
    (exp) =>
      exp.syntax === "commonjs" &&
      exp.kind === "default" &&
      exp.commonJsReExport !== undefined,
  );
  const origin = whole?.commonJsReExport;
  if (!origin) {
    return undefined;
  }

  if (origin.importedName === undefined) {
    return { specifier: origin.specifier, exportName, syntax: "commonjs" };
  }

  return exportName === "default"
    ? {
        specifier: origin.specifier,
        exportName: origin.importedName,
        syntax: "commonjs",
      }
    : undefined;
}

/**
 * Every forwarding hop `exportName` could take out of this module, in the
 * order a consumer must try them: ESM first, then CommonJS.
 *
 * Ordered rather than single because that is what call-graph.ts's existing
 * chase does — it tries the ESM relation and, when that hop leads nowhere
 * resolvable, still falls through to the CommonJS one. Returning a list
 * keeps that behavior exactly, instead of committing to one syntax's hop
 * and silently losing the other. A file that genuinely forwards under only
 * one syntax (every real case) yields exactly one entry.
 */
export function exportForwardingHops(
  model: ModuleModel,
  exportName: string,
): readonly ExportForwardingHop[] {
  const hops: ExportForwardingHop[] = [];
  const esm = esmExportForwardingHop(model, exportName);
  if (esm) {
    hops.push(esm);
  }
  const cjs = commonJsExportForwardingHop(model, exportName);
  if (cjs) {
    hops.push(cjs);
  }
  return hops;
}
