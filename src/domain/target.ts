/**
 * The kind of code construct a vulnerable-behavior target refers to.
 * Narrower than the checked-in JSON schema (schemas/symbol-rule.schema.json
 * declares `kind` as a free string) by design: this is the strict internal
 * type after rule loading validates and narrows it (see TASK-012 Manual
 * Symbol Rules). SDD § 13 names function/method/constructor/module targets
 * as the extensibility surface; `method` isn't yet used by an MVP fixture
 * but is included since it's explicitly named there.
 */
export type TargetKind = "function" | "method" | "constructor" | "module";

/**
 * A single vulnerable-behavior target within a rule: which module and
 * export implement the vulnerable behavior (see docs/SDD.md § 13,
 * schemas/symbol-rule.schema.json).
 */
export interface VulnerableSymbolTarget {
  readonly module: string;
  readonly export: string;
  readonly kind?: TargetKind;
  readonly confidence?: number;
}

/**
 * A manually authored vulnerability behavior rule — the MVP's only
 * vulnerable-symbol source (see docs/SDD.md § 13-14, ADR-0003). The
 * "Future model" preconditions/`conditions` field from § 13 is deliberately
 * omitted: no MVP rule (see rules/vulntrace-rules.yml) uses it, and adding
 * it now would be out-of-scope speculative modeling.
 */
export interface VulnerableSymbolRule {
  readonly id: string;
  readonly package: { readonly name: string };
  readonly targets: readonly VulnerableSymbolTarget[];
}
