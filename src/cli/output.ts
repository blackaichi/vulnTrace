import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type AnySchemaObject } from "ajv/dist/2020.js";
import type { Coverage, Diagnostic } from "../domain/coverage.js";
import type {
  UncertaintyCategory,
  UncertaintyClassification,
  UncertaintyReason,
} from "../domain/uncertainty.js";
import type { Finding } from "../domain/verdict.js";
import type { PhaseTimings } from "../performance/timing.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const schemaPath = path.join(repoRoot, "schemas", "result.schema.json");

// VulnTrace's own checked-in schema file, not untrusted external data (see
// src/rules/schema-validator.ts, which follows the same pattern).
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as AnySchemaObject;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

/** docs/SDD.md § 24's example output; matches schemas/result.schema.json's `$id`. */
export const SCHEMA_VERSION = "0.6";

export interface JsonTarget {
  readonly module: string;
  readonly symbol: string;
  readonly kind?: string;
  readonly confidence?: number;
}

export interface JsonFinding {
  readonly vulnerability: string;
  readonly package: string;
  /** Omitted only when this instance's version could not be established at all (P1-A5). */
  readonly version?: string;
  /**
   * Which installed instance this finding is about (P1-A5) --
   * project-relative when inside the scanned project, canonical absolute
   * otherwise. This is what distinguishes two findings that share an
   * advisory, a package name and a version but describe two different
   * physical installs with two independent verdicts.
   */
  readonly packageInstance?: string;
  readonly verdict: Finding["verdict"];
  readonly confidence?: number;
  readonly target?: JsonTarget;
  readonly evidence?: Finding["evidence"];
  /**
   * FOUNDATION F3 -- structured reasons, present on UNKNOWN findings only.
   * See {@link Finding.unknownReasons}.
   */
  readonly unknownReasons?: readonly UncertaintyClassification[];
}

/**
 * WHERE in the pipeline a candidate stopped producing a finding.
 *
 * Ordered from widest to narrowest, and that order is meaningful: a
 * `workspace_discovery` note says an unknown NUMBER of candidates may not
 * exist at all, `package_identity` says a KNOWN instance could not be
 * placed against advisory ranges, and `advisory_applicability` says a
 * known instance was evaluated against a known advisory and the pair did
 * not apply.
 */
export type UnreportedCandidateStage =
  "workspace_discovery" | "package_identity" | "advisory_applicability";

/**
 * WHETHER the absence of a finding is a CONCLUSION or a GAP.
 *
 * This is the single most important field in F3's no-finding model, and it
 * is required rather than optional for exactly that reason (F3 § 2, § 3,
 * § 25).
 *
 * - `not_applicable`: VulnTrace positively established that this advisory
 *   does not apply to this instance -- the installed version is outside
 *   every affected range. Real information, arrived at with certainty, and
 *   NOT uncertainty. F3 § 3 forbids laundering it into an UNKNOWN merely
 *   because a taxonomy now exists to hold one.
 * - `undetermined`: VulnTrace could not establish whether the advisory
 *   applies, so nothing is claimed either way.
 *
 * What neither value means is NOT_AFFECTED. A `not_applicable` entry is a
 * statement about VERSION RANGES and nothing else -- no reachability
 * analysis ran, no negative proof exists, and promoting one to a verdict
 * would be precisely the unproven negative AGENTS.md forbids (F3 § 25).
 * The two live in different arrays, carry different field names and are
 * rendered in different sections, so that promotion cannot happen by
 * accident.
 */
export type UnreportedCandidateDisposition = "not_applicable" | "undetermined";

/**
 * FOUNDATION F3 -- one vulnerability candidate that produced NO finding
 * row, and why.
 *
 * NOT A FINDING, and deliberately not shaped like one: it has no
 * `verdict`, no `evidence` and no `confidence`, it lives in its own
 * top-level array, and no code path converts one into a `JsonFinding`.
 * Before F3 every one of these states was either invisible or a line of
 * English on stderr, which is how `RWB-09b` came to be scored as a
 * disagreement: the scan's answer ("this patched instance is outside the
 * affected range, so there is nothing to report") and its output ("")
 * were the same bytes as "this scan never considered that instance at
 * all".
 *
 * Identity fields are all OPTIONAL because identity is exactly what is
 * sometimes missing (F3 § 5: "carry enough identity WHERE KNOWN"). A
 * `workspace_discovery` entry names no package at all -- its whole content
 * is that an unknown set of packages may never have been enumerated -- and
 * inventing a placeholder there would be a lie in the one field a consumer
 * would key on.
 */
export interface UnreportedCandidate {
  readonly stage: UnreportedCandidateStage;
  readonly disposition: UnreportedCandidateDisposition;
  /** The advisory this entry is about, when one was known. */
  readonly vulnerability?: string;
  /** The package name, when one was known. */
  readonly package?: string;
  /** The exact installed instance, rendered as in {@link JsonFinding.packageInstance}. */
  readonly packageInstance?: string;
  /** The installed version, when it was established. */
  readonly version?: string;
  /**
   * The specific reason, from the same vocabulary
   * {@link Finding.unknownReasons} uses -- one token namespace, not two.
   */
  readonly reason: UnreportedCandidateReason;
  /**
   * The uncertainty class, present IF AND ONLY IF `disposition` is
   * `undetermined`.
   *
   * Its absence on a `not_applicable` entry is structural, not incidental:
   * a confident non-applicability has no uncertainty class because it is
   * not uncertain, and leaving the field off is what stops a consumer
   * summing categories across this array from silently counting
   * out-of-range packages as analysis gaps (F3 self-review attack C).
   */
  readonly category?: UncertaintyCategory;
  /** Human-readable explanation; always present. */
  readonly detail: string;
}

/**
 * The reason vocabulary for {@link UnreportedCandidate}.
 *
 * Every uncertainty reason, plus the one token that is NOT an uncertainty:
 * `advisory_not_applicable_to_installed_version`. That token is
 * deliberately excluded from {@link UncertaintyReason} -- it has no
 * category, it can never appear in `unknownReasons`, and nothing can
 * aggregate it into an uncertainty count by mistake.
 */
export type UnreportedCandidateReason =
  UncertaintyReason | "advisory_not_applicable_to_installed_version";

export interface ScanOutput {
  readonly schemaVersion: string;
  readonly scan: { readonly id: string; readonly project: string };
  readonly findings: readonly JsonFinding[];
  readonly coverage: Coverage;
  /**
   * Explains blockers behind {@link Coverage}'s aggregate counts (see
   * docs/SDD.md § 8, TASK-026): unresolved entrypoints, unresolved/dynamic
   * call-graph edges, and vulnerability records that could not be
   * normalized. Always present, possibly empty — never omitted merely
   * because a scan happened to hit no blockers.
   */
  readonly diagnostics: readonly Diagnostic[];
  /**
   * FOUNDATION F3 -- vulnerability candidates that produced NO finding
   * row, each with why. Always present, possibly empty.
   *
   * SEPARATE FROM `findings` BY CONSTRUCTION (F3 § 5, § 21, § 23). These
   * are not findings, are not verdicts, and must never be counted,
   * rendered or exported as either. The separation is the feature: a
   * consumer that reads `findings` sees exactly what it saw before F3,
   * and a consumer that wants to know why a package it expected is
   * missing now has somewhere to look.
   *
   * SEPARATE FROM `diagnostics` BY PURPOSE (F3 § 15). `diagnostics` is the
   * OPERATIONAL channel -- what went wrong while running, in the words a
   * human running the CLI reads. This is the ANALYSIS-SEMANTICS channel --
   * what the analyzer concluded, or could not conclude, about a specific
   * candidate, in tokens a machine can aggregate. Some conditions
   * legitimately appear in both (a version conflict is both an
   * operational warning and an applicability gap); when they do, they use
   * the SAME facts and the same numbers, and the structured entry links
   * itself to the diagnostic by naming the same instance.
   */
  readonly unreportedCandidates: readonly UnreportedCandidate[];
  /** Per-phase timing instrumentation (see docs/SDD.md § 30, TASK-029). */
  readonly timings: PhaseTimings;
}

/**
 * Maps a domain {@link Finding} onto the JSON shape documented in
 * docs/SDD.md § 24, which names the vulnerable-behavior target field
 * "symbol" — the domain model calls the same concept "export" (see
 * src/domain/target.ts, chosen there to match JS/TS's own `export`
 * terminology). This is the one place that reconciles the naming
 * difference: the domain type itself is left alone, since the CLI's output
 * shape is a presentation concern, not a domain one (AGENTS.md: "Keep
 * domain models independent from CLI and providers").
 */
export function findingToJson(finding: Finding): JsonFinding {
  const json: {
    vulnerability: string;
    package: string;
    version?: string;
    packageInstance?: string;
    verdict: Finding["verdict"];
    confidence?: number;
    target?: JsonTarget;
    evidence?: Finding["evidence"];
    unknownReasons?: readonly UncertaintyClassification[];
  } = {
    vulnerability: finding.vulnerability,
    package: finding.package,
    verdict: finding.verdict,
  };

  // Emitted between `package` and `verdict` in the domain type's own field
  // order, and omitted rather than written as `null`/`""` when absent: a
  // consumer must be able to tell "this instance has no established
  // version" from "this instance's version is the empty string", and an
  // absent key is the only encoding that cannot be mistaken for a value.
  if (finding.version !== undefined) {
    json.version = finding.version;
  }
  if (finding.packageInstance !== undefined) {
    json.packageInstance = finding.packageInstance;
  }

  if (finding.confidence !== undefined) {
    json.confidence = finding.confidence;
  }
  if (finding.target) {
    const target = finding.target;
    json.target = {
      module: target.module,
      symbol: target.export,
      ...(target.kind !== undefined ? { kind: target.kind } : {}),
      ...(target.confidence !== undefined
        ? { confidence: target.confidence }
        : {}),
    };
  }
  if (finding.evidence) {
    json.evidence = finding.evidence;
  }

  // F3: emitted last, after `evidence`, and omitted entirely rather than
  // written as `[]` when the domain finding carries none. An empty array
  // and an absent key would otherwise be indistinguishable from "this
  // UNKNOWN has no classified reasons", which is a state F3 does not
  // produce -- every UNKNOWN gets at least one -- and which a consumer
  // should therefore never have to interpret. Non-UNKNOWN findings reach
  // here with `unknownReasons` undefined and are byte-identical to their
  // pre-F3 output.
  if (finding.unknownReasons !== undefined) {
    json.unknownReasons = finding.unknownReasons;
  }

  return json;
}

export interface SchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Validates a scan result against the checked-in `schemas/result.schema.json`. */
export function validateScanOutput(output: unknown): SchemaValidationIssue[] {
  const valid = validate(output);

  if (valid) {
    return [];
  }

  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath || "<root>",
    message: error.message ?? "invalid",
  }));
}

export function formatScanOutput(output: ScanOutput, pretty: boolean): string {
  return JSON.stringify(output, null, pretty ? 2 : undefined);
}
