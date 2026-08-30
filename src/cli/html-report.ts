/**
 * HTML Report v0.1 — a self-contained, static PRESENTATION of one
 * {@link ScanOutput}.
 *
 * This module has exactly one job: render what the scan already decided.
 * It is deliberately NOT a second semantic model. It does not recompute a
 * verdict, re-derive applicability, reinterpret an evidence object, or
 * traverse anything (no `CallGraph`, no `ModuleLoadClosure`, no source
 * project — the scan has already happened; `ScanOutput` is its serialized
 * result, see docs/SDD.md § 24). Every claim the report makes must be
 * reconstructible from the same JSON `vulntrace scan --format json`
 * prints, so the two outputs can never disagree.
 *
 * The one place that rule needs care is prose. Where the report explains
 * what a verdict MEANS, the wording is fixed text keyed off a value the
 * result actually carries (a verdict, an evidence object's presence, a
 * reason string) — never a new inference from the underlying analysis, and
 * never stronger than the evidence contract in `domain/evidence.ts`
 * allows. In particular, a NOT_AFFECTED is described as absence under
 * VulnTrace's declared supported model (see
 * {@link SUPPORTED_MODEL_EXCLUSIONS}), never as "this code cannot run".
 *
 * Output invariants, all covered by `html-report.test.ts` and
 * `html-report.security.test.ts`:
 *
 * - ONE self-contained document: inline CSS, inline JS, no CDN script, no
 *   remote stylesheet, no remote font, no remote image, no network request
 *   of any kind. It opens from disk.
 * - EVERY project-controlled string is HTML-escaped exactly once, at the
 *   single boundary {@link text} below. No project data is ever
 *   interpolated into the inline `<script>`, so there is no
 *   `</script>`-termination and no JS-string-escaping surface at all: the
 *   script reads the DOM instead of carrying a data copy.
 * - JavaScript is an enhancement, never a requirement: all substantive
 *   information is in the static HTML, every finding renders expanded, and
 *   the interactive controls hide themselves when scripting is off.
 * - DETERMINISTIC: the same `ScanOutput` renders byte-identical HTML.
 *   Nothing here reads the clock, the filesystem, the environment, or a
 *   random source; element ids come from the finding's index.
 */

import type { Coverage, Diagnostic } from "../domain/coverage.js";
import {
  SUPPORTED_MODEL_EXCLUSIONS,
  SUPPORTED_MODEL_STATEMENT,
} from "../domain/evidence.js";
import type { PhaseTimings } from "../performance/timing.js";
import type { JsonFinding, ScanOutput } from "./output.js";

/**
 * Presentation order, most actionable first — deliberately NOT the domain
 * `Verdict` union's own declaration order. UNKNOWN sits second because it
 * is a first-class result a reader must act on (docs/SDD.md § 3.4,
 * ADR-0002), not a footnote after the answered cases.
 */
const VERDICT_ORDER = ["AFFECTED", "UNKNOWN", "NOT_AFFECTED"] as const;

type ReportVerdict = (typeof VERDICT_ORDER)[number];

/**
 * A distinct shape per verdict, so verdict is never communicated by COLOUR
 * ALONE: every badge also carries its uppercase text label, and the pair
 * survives greyscale printing.
 */
const VERDICT_GLYPH: Readonly<Record<ReportVerdict, string>> = {
  AFFECTED: "▲",
  UNKNOWN: "◆",
  NOT_AFFECTED: "■",
};

/**
 * What each verdict claims — fixed text, keyed only off the verdict the
 * result already reports. Worded to the evidence contract in
 * `domain/evidence.ts`: NOT_AFFECTED is a positive, model-relative proof,
 * and UNKNOWN is a first-class outcome rather than a failure.
 */
const VERDICT_MEANING: Readonly<Record<ReportVerdict, string>> = {
  AFFECTED:
    "A path from a configured entrypoint to the vulnerable target was established by the analysis.",
  UNKNOWN:
    "Applicability could not be decided. This is a first-class result, not an analysis error: something concrete blocked the proof, and every finding below states what.",
  NOT_AFFECTED:
    "A positive proof was established that this advisory does not apply to this installed instance, relative to VulnTrace's declared supported model (see Analysis scope).",
};

const PROOF_FAMILY_TITLE = {
  A: "Family A — module-load absence",
  B: "Family B — exact-instance absence, corroborated by call graph and module-load closure",
  C: "Family C — confirmed unreachable target",
} as const;

/**
 * Per-family human-readable claims, phrased at exactly the strength the
 * corresponding evidence type in `domain/evidence.ts` licenses — and no
 * stronger. Family A in particular says the instance is absent from a
 * COMPLETE module-load closure over the configured entrypoints; it must
 * never be paraphrased as "this package can never execute".
 */
const PROOF_FAMILY_CLAIM = {
  A: "The exact installed package instance was absent from a complete module-load closure over the configured entrypoints: nothing those entrypoints load reaches this install location's code.",
  B: "The exact installed package instance was never traversed by a non-truncated call graph, and its absence was independently corroborated by a complete module-load closure that does not contain it either.",
  C: "The resolved, attributed vulnerable target has no call path from any configured entrypoint: the search ran to exhaustion and met no unresolved edge anywhere in the reachable subgraph.",
} as const;

/**
 * What each family's proof does NOT establish. Included because the three
 * families are easy to over-read as one another: A says nothing about
 * symbols inside a package that IS loaded; C says nothing about whether
 * the package is loaded at all.
 */
const PROOF_FAMILY_LIMIT = {
  A: "Proves package-load absence only. It says nothing about which symbols inside a package that IS loaded are reachable.",
  B: "Proves that this exact install location was neither traversed nor loaded. Another installed instance of the same package name may still be both.",
  C: "Says nothing about whether the package is present or loaded — it may well be both. It says this specific symbol is never called.",
} as const;

type ProofFamily = keyof typeof PROOF_FAMILY_TITLE;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * The report's ONLY escaping primitive. Escapes the five characters that
 * are syntactically significant in HTML text AND in both quoted-attribute
 * forms, so one function is correct in every position the renderer uses
 * and there is no "which escaper does this context need?" decision left to
 * get wrong later.
 *
 * Single-pass by construction: a two-pass implementation that replaced `<`
 * before `&` would double-escape its own output (see this function's own
 * regression test).
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped = HTML_ESCAPES[character];
    return escaped ?? character;
  });
}

/**
 * The single boundary every project-controlled value crosses on its way
 * into the document. Escapes strings and, defensively, renders anything
 * that is somehow not a string without producing the two failure modes a
 * report reader cannot act on: `[object Object]` and a bare
 * `undefined`/`null`.
 *
 * Its parameter is `unknown` deliberately, even though `ScanOutput` is
 * fully typed: this renderer's input is a result that has round-tripped
 * through a file/schema boundary, so a value whose static type says
 * `string` can still arrive as something else, and silently painting
 * `[object Object]` into a security report is worse than rendering that
 * value's JSON form.
 */
function text(value: unknown): string {
  if (typeof value === "string") {
    return escapeHtml(value);
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return escapeHtml(String(value));
  }
  return escapeHtml(JSON.stringify(value) ?? String(value));
}

/** An escaped value in monospace — every path, symbol, identifier and reason token. */
function code(value: unknown): string {
  return `<code>${text(value)}</code>`;
}

export interface ParsedSourceLocation {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

const TRAILING_NON_LOCATION = /(?::(?:undefined|null|NaN)?)+$/;

/**
 * Parses one serialized location string from `Evidence.path`.
 *
 * The producer (`locationOf` in analysis/verdict.ts) emits
 * `` `${file}:${line ?? ""}` `` for a node that has a location, and a bare
 * module path or node id otherwise — so a lineless node yields a trailing
 * `":"` that must not be shown, and a defensive `":undefined"` from any
 * other producer must not either. Returns `undefined` when nothing is left
 * after that trimming, so callers can omit a location cleanly rather than
 * render an empty one.
 */
export function parseSourceLocation(
  raw: string,
): ParsedSourceLocation | undefined {
  const trimmed = raw.trim().replace(TRAILING_NON_LOCATION, "");
  if (trimmed.length === 0) {
    return undefined;
  }

  const withColumn = /^(.*):(\d+):(\d+)$/.exec(trimmed);
  if (withColumn?.[1] && withColumn[2] && withColumn[3]) {
    return {
      file: withColumn[1],
      line: Number(withColumn[2]),
      column: Number(withColumn[3]),
    };
  }

  const withLine = /^(.*):(\d+)$/.exec(trimmed);
  if (withLine?.[1] && withLine[2]) {
    return { file: withLine[1], line: Number(withLine[2]) };
  }

  return { file: trimmed };
}

/**
 * The report's single source-location display form:
 * `path/to/file.ts:line:column`, degrading to `path/to/file.ts:line` and
 * then to `path/to/file.ts`. Returns `""` when there is nothing to show —
 * never `undefined:undefined`.
 */
export function formatSourceLocation(raw: string): string {
  const parsed = parseSourceLocation(raw);
  if (!parsed) {
    return "";
  }
  if (parsed.line === undefined) {
    return parsed.file;
  }
  if (parsed.column === undefined) {
    return `${parsed.file}:${parsed.line}`;
  }
  return `${parsed.file}:${parsed.line}:${parsed.column}`;
}

/**
 * The blocker vocabulary token a reason string was produced with, when the
 * result states one explicitly.
 *
 * Reachability blockers are emitted as `` `${reason} at ${node}` `` (see
 * `describeBlocker` in analysis/reachability.ts), where `reason` is a
 * `DynamicCallReason` — `dynamic_require`, `loader_capability_escape`,
 * `declaration_only_resolution`, `unresolved_module`, ... This lifts that
 * token back out for display, so an UNKNOWN shows WHICH kind of
 * uncertainty blocked it instead of collapsing into "analysis incomplete".
 *
 * Deliberately extracted FROM the string rather than matched against a
 * list of reason names copied into this file: the vocabulary lives in
 * `domain/graph.ts` and grows there, and a copy here would silently
 * mislabel every value added after this file was written. Nothing is
 * inferred — a reason with no such prefix simply has no token, and the
 * full reason text is rendered verbatim either way.
 */
export function unknownReasonToken(reason: string): string | undefined {
  const match = /^([a-z][a-z0-9_]*) at \S/.exec(reason);
  return match?.[1];
}

function verdictOf(finding: JsonFinding): ReportVerdict {
  const verdict = finding.verdict;
  return verdict === "AFFECTED" || verdict === "NOT_AFFECTED"
    ? verdict
    : "UNKNOWN";
}

/**
 * Which negative-proof family justified a NOT_AFFECTED, read ONLY from
 * which evidence object the result carries — the 1:1 evidence-to-family
 * mapping `domain/evidence.ts` guarantees. Returns `undefined` when a
 * NOT_AFFECTED carries no proof evidence object at all, which the report
 * then states plainly rather than guessing a family from prose.
 *
 * Since VT-CONTRACT-01, `schemas/result.schema.json` structurally enforces
 * that a NOT_AFFECTED carries EXACTLY one of the three, so for any
 * schema-valid `ScanOutput` the first match below is also the only one,
 * and the `undefined` branch is unreachable. Both are kept anyway: this
 * renderer is a pure function that any caller may hand an unvalidated
 * object (`renderHtmlReport` performs no validation of its own — see
 * cli/scan.ts, which validates before rendering), and a report that
 * silently mislabels a proof family is worse than one that degrades
 * honestly. Defensive rendering is not made weaker just because the
 * contract got stronger.
 */
function proofFamilyOf(finding: JsonFinding): ProofFamily | undefined {
  const evidence = finding.evidence;
  if (!evidence) {
    return undefined;
  }
  if (evidence.confirmedAbsentFromModuleLoadClosure) {
    return "A";
  }
  if (evidence.confirmedAbsentInstance) {
    return "B";
  }
  if (evidence.confirmedUnreachableTarget) {
    return "C";
  }
  return undefined;
}

/**
 * The exact canonical `PackageInstanceId` this finding is about, when the
 * serialized result carries one — i.e. on the two instance-specific
 * negative proofs, which name it as the authoritative identity of what
 * they proved absent.
 *
 * `undefined` for every other finding, because `ScanOutput` genuinely does
 * not carry one there (`Finding` records package + version; the install
 * location only reaches the output inside those evidence objects). The
 * report says exactly that rather than substituting `name@version`, which
 * is precisely the identity collapse VT-212/VT-306 forbid.
 */
function packageInstanceOf(finding: JsonFinding): string | undefined {
  const evidence = finding.evidence;
  return (
    evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance ??
    evidence?.confirmedAbsentInstance?.packageInstance
  );
}

/**
 * The vulnerable symbol a finding is about, as `module#export`. Falls back
 * to family C's restated target when the finding itself carries none (that
 * evidence object restates the target precisely so it stands alone).
 */
function targetOf(finding: JsonFinding): string | undefined {
  if (finding.target) {
    return `${finding.target.module}#${finding.target.symbol}`;
  }
  const restated = finding.evidence?.confirmedUnreachableTarget?.target;
  return restated ? `${restated.module}#${restated.export}` : undefined;
}

/** The first reason string — the overview table's one-line summary. */
function summaryOf(finding: JsonFinding): string | undefined {
  return finding.evidence?.reasons?.[0];
}

/** Stable, index-derived element id: never random, never content-hashed. */
function findingElementId(index: number): string {
  return `finding-${index + 1}`;
}

function countByVerdict(
  findings: readonly JsonFinding[],
): Record<ReportVerdict, number> {
  const counts: Record<ReportVerdict, number> = {
    AFFECTED: 0,
    UNKNOWN: 0,
    NOT_AFFECTED: 0,
  };
  for (const finding of findings) {
    counts[verdictOf(finding)] += 1;
  }
  return counts;
}

function badge(verdict: ReportVerdict): string {
  return (
    `<span class="badge badge-${verdict}">` +
    `<span class="glyph" aria-hidden="true">${VERDICT_GLYPH[verdict]}</span>` +
    `<span class="badge-label">${verdict}</span>` +
    `</span>`
  );
}

function definitionRow(label: string, valueHtml: string): string {
  return `<div class="dl-row"><dt>${text(label)}</dt><dd>${valueHtml}</dd></div>`;
}

/** A row whose value the result does not carry — stated explicitly, never left blank. */
function absentRow(label: string, why: string): string {
  return definitionRow(label, `<span class="absent">${text(why)}</span>`);
}

function bulletList(itemsHtml: readonly string[]): string {
  return `<ul class="plain">${itemsHtml.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

/** Entrypoint roots, shared by all three negative-proof evidence objects. */
function entrypointRootsRow(roots: readonly string[]): string {
  if (roots.length === 0) {
    return absentRow(
      "Entrypoint roots",
      "no entrypoint roots recorded in this evidence object",
    );
  }
  return definitionRow(
    "Entrypoint roots",
    bulletList(roots.map((root) => code(formatSourceLocation(root)))),
  );
}

/**
 * Family A — `confirmedAbsentFromModuleLoadClosure`. Renders every field
 * the evidence object actually carries, including `closureComplete`, which
 * is the load-bearing precondition and is therefore shown rather than
 * assumed.
 */
function renderFamilyA(
  evidence: NonNullable<
    JsonFinding["evidence"]
  >["confirmedAbsentFromModuleLoadClosure"],
): string {
  if (!evidence) {
    return "";
  }
  return (
    `<dl class="dl">` +
    definitionRow("Package instance", code(evidence.packageInstance)) +
    entrypointRootsRow(evidence.entrypointRoots) +
    definitionRow(
      "Module-load closure complete",
      `${code(evidence.closureComplete)} <span class="note">— absence against an incomplete closure would prove nothing, so completeness is recorded, not assumed.</span>`,
    ) +
    // The reason identifier itself is NOT restated here. It is rendered
    // from the finding's own `evidence.reasons` just below the proof
    // block, so the report shows whatever identifier the merged code
    // actually emits rather than a copy in this file that could drift out
    // of date the next time the vocabulary changes.
    `</dl>`
  );
}

/** Family B — `confirmedAbsentInstance`, with its post-VT-307e fields. */
function renderFamilyB(
  evidence: NonNullable<JsonFinding["evidence"]>["confirmedAbsentInstance"],
): string {
  if (!evidence) {
    return "";
  }
  return (
    `<dl class="dl">` +
    definitionRow("Package instance", code(evidence.packageInstance)) +
    entrypointRootsRow(evidence.entrypointRoots) +
    definitionRow(
      "Call graph truncated",
      `${code(evidence.graphTruncated)} <span class="note">— the call graph's traversal hit no resource limit. That is not the same claim as the call graph being complete.</span>`,
    ) +
    definitionRow(
      "Module-load closure complete",
      `${code(evidence.moduleLoadClosureComplete)} <span class="note">— the independent corroboration this proof rests on: a complete module-load closure that does not contain this instance either.</span>`,
    ) +
    `</dl>`
  );
}

/** Family C — `confirmedUnreachableTarget`. */
function renderFamilyC(
  evidence: NonNullable<JsonFinding["evidence"]>["confirmedUnreachableTarget"],
): string {
  if (!evidence) {
    return "";
  }
  return (
    `<dl class="dl">` +
    definitionRow(
      "Target",
      code(`${evidence.target.module}#${evidence.target.export}`),
    ) +
    entrypointRootsRow(evidence.entrypointRoots) +
    definitionRow(
      "Call graph complete",
      `${code(evidence.callGraphComplete)} <span class="note">— the search over the reachable subgraph was exhaustive and met no unresolved edge. Scoped to that search, not a claim about the whole program.</span>`,
    ) +
    `</dl>`
  );
}

/**
 * The NOT_AFFECTED block: which proof family justified the verdict, what
 * that family does and does not claim, and every field of its evidence
 * object. A NOT_AFFECTED with no proof evidence object gets the same
 * treatment as any other missing value — named, not papered over.
 */
function renderNegativeProof(finding: JsonFinding): string {
  const family = proofFamilyOf(finding);
  const evidence = finding.evidence;

  if (!family) {
    return (
      `<section class="proof proof-missing">` +
      `<h4>Positive proof</h4>` +
      `<p class="absent">This NOT_AFFECTED finding carries no negative-proof evidence object in the scan result, so the report cannot show which proof family justified it. Only the reason strings below are available.</p>` +
      `</section>`
    );
  }

  const body =
    family === "A"
      ? renderFamilyA(evidence?.confirmedAbsentFromModuleLoadClosure)
      : family === "B"
        ? renderFamilyB(evidence?.confirmedAbsentInstance)
        : renderFamilyC(evidence?.confirmedUnreachableTarget);

  return (
    `<section class="proof proof-${family}">` +
    `<h4>Positive proof — ${text(PROOF_FAMILY_TITLE[family])}</h4>` +
    `<p class="claim">${text(PROOF_FAMILY_CLAIM[family])}</p>` +
    body +
    `<p class="limit"><strong>Scope of this proof:</strong> ${text(PROOF_FAMILY_LIMIT[family])}</p>` +
    `</section>`
  );
}

/**
 * The reachability path for an AFFECTED finding, rendered as an ordered
 * sequence of steps.
 *
 * Every node comes from `Evidence.path`, which the scan produced; no node
 * is invented, reordered, or elided. Steps are labelled neutrally
 * ("Entrypoint", "Step n", "Vulnerable target") and never as "calls":
 * `Evidence.path` serializes locations only, and a `module_load` edge in
 * the underlying graph must never be described as a call (see
 * `CallEdgeType` in domain/graph.ts).
 *
 * Only the location is shown per step because only the location is in the
 * serialized result — the symbol and package context of each node are not
 * part of `ScanOutput` (see this file's own known limitations in the
 * report's footer).
 */
function renderPath(path: readonly string[]): string {
  if (path.length === 0) {
    return "";
  }

  const steps = path
    .map((raw, index) => {
      const location = formatSourceLocation(raw);
      const label =
        index === 0
          ? "Entrypoint"
          : index === path.length - 1
            ? "Vulnerable target"
            : `Step ${index}`;
      return (
        `<li class="path-step">` +
        `<span class="path-label">${text(label)}</span>` +
        (location
          ? `<span class="path-location">${code(location)}</span>`
          : `<span class="absent">no source location recorded for this step</span>`) +
        `</li>`
      );
    })
    .join('<li class="path-arrow" aria-hidden="true">↓</li>');

  return (
    `<section class="evidence-path">` +
    `<h4>Reachability path</h4>` +
    `<ol class="path">${steps}</ol>` +
    `</section>`
  );
}

/**
 * The AFFECTED block. Prefers the concrete path; when the finding has
 * none, falls back to whatever concrete evidence it does carry rather than
 * fabricating path nodes.
 */
function renderAffectedEvidence(finding: JsonFinding): string {
  const path = finding.evidence?.path ?? [];
  if (path.length > 0) {
    return renderPath(path);
  }
  return (
    `<section class="evidence-path">` +
    `<h4>Reachability path</h4>` +
    `<p class="absent">This AFFECTED finding carries no path in the scan result. The concrete evidence it does carry is listed under Reasons below.</p>` +
    `</section>`
  );
}

/**
 * The UNKNOWN block: every blocking reason the result recorded, verbatim,
 * each tagged with its own vocabulary token when the result states one.
 * Never collapsed into a single generic explanation.
 */
function renderUnknownBlockers(finding: JsonFinding): string {
  const reasons = finding.evidence?.reasons ?? [];

  if (reasons.length === 0) {
    return (
      `<section class="blockers">` +
      `<h4>Why this is UNKNOWN</h4>` +
      `<p class="absent">The scan result records no reason for this UNKNOWN finding. The most common cause is that applicability itself was undecidable before reachability was ever attempted — an indeterminate version match, or no vulnerable-symbol rule for this advisory.</p>` +
      `</section>`
    );
  }

  const items = reasons.map((reason) => {
    const token = unknownReasonToken(reason);
    return (
      `<li>` +
      (token ? `<span class="token">${text(token)}</span> ` : "") +
      `<span class="reason">${text(reason)}</span>` +
      `</li>`
    );
  });

  return (
    `<section class="blockers">` +
    `<h4>Why this is UNKNOWN</h4>` +
    `<p>Each blocker below is reported exactly as the scan recorded it.</p>` +
    `<ul class="blocker-list">${items.join("")}</ul>` +
    `</section>`
  );
}

function renderReasons(finding: JsonFinding): string {
  const reasons = finding.evidence?.reasons ?? [];
  if (reasons.length === 0) {
    return "";
  }
  return (
    `<section class="reasons">` +
    `<h4>Reasons</h4>` +
    `<ul class="reason-list">${reasons
      .map((reason) => `<li>${code(reason)}</li>`)
      .join("")}</ul>` +
    `</section>`
  );
}

/** One overview-table row, linking to the finding's detail section. */
function renderOverviewRow(finding: JsonFinding, index: number): string {
  const verdict = verdictOf(finding);
  const instance = packageInstanceOf(finding);
  const target = targetOf(finding);
  const summary = summaryOf(finding);
  const id = findingElementId(index);

  return (
    `<tr class="finding-row" data-verdict="${verdict}" data-finding="${text(id)}">` +
    `<td>${badge(verdict)}</td>` +
    `<th scope="row"><a href="#${text(id)}">${text(finding.vulnerability)}</a></th>` +
    `<td>${text(finding.package)}</td>` +
    `<td>${code(finding.version)}</td>` +
    `<td>${
      instance ? code(instance) : `<span class="absent">not in result</span>`
    }</td>` +
    `<td>${target ? code(target) : `<span class="absent">not resolved</span>`}</td>` +
    `<td class="summary">${
      summary ? text(summary) : `<span class="absent">no reason recorded</span>`
    }</td>` +
    `</tr>`
  );
}

const OVERVIEW_HEADER =
  `<thead><tr>` +
  `<th scope="col">Verdict</th>` +
  `<th scope="col">Advisory</th>` +
  `<th scope="col">Package</th>` +
  `<th scope="col">Version</th>` +
  `<th scope="col">Package instance</th>` +
  `<th scope="col">Vulnerable symbol</th>` +
  `<th scope="col">Summary</th>` +
  `</tr></thead>`;

function renderOverviewGroup(
  verdict: ReportVerdict,
  entries: readonly { readonly finding: JsonFinding; readonly index: number }[],
): string {
  const heading =
    `<h3 id="verdict-${verdict}">${badge(verdict)} ` +
    `<span class="count">${entries.length}</span></h3>` +
    `<p class="verdict-meaning">${text(VERDICT_MEANING[verdict])}</p>`;

  if (entries.length === 0) {
    return (
      `<section class="verdict-group" data-verdict="${verdict}">` +
      heading +
      `<p class="absent">No findings with this verdict.</p>` +
      `</section>`
    );
  }

  return (
    `<section class="verdict-group" data-verdict="${verdict}">` +
    heading +
    `<div class="table-scroll"><table class="overview">` +
    `<caption class="sr-only">${verdict} findings</caption>` +
    OVERVIEW_HEADER +
    `<tbody>${entries
      .map((entry) => renderOverviewRow(entry.finding, entry.index))
      .join("")}</tbody>` +
    `</table></div>` +
    `</section>`
  );
}

/** One finding's full detail section. */
function renderFindingDetail(finding: JsonFinding, index: number): string {
  const verdict = verdictOf(finding);
  const id = findingElementId(index);
  const instance = packageInstanceOf(finding);
  const target = targetOf(finding);

  const facts =
    `<dl class="dl">` +
    definitionRow("Advisory", code(finding.vulnerability)) +
    definitionRow("Package", text(finding.package)) +
    definitionRow("Installed version", code(finding.version)) +
    (instance
      ? definitionRow("Package instance", code(instance))
      : absentRow(
          "Package instance",
          "the scan result does not carry a canonical package instance for this finding (only the two instance-specific negative proofs record one)",
        )) +
    (target
      ? definitionRow("Vulnerable symbol", code(target))
      : absentRow(
          "Vulnerable symbol",
          "no vulnerable-behavior target was established for this finding",
        )) +
    (finding.target?.kind
      ? definitionRow("Target kind", code(finding.target.kind))
      : "") +
    (finding.target?.confidence !== undefined
      ? definitionRow("Target confidence", code(finding.target.confidence))
      : "") +
    (finding.confidence !== undefined
      ? definitionRow("Finding confidence", code(finding.confidence))
      : "") +
    definitionRow("Verdict", `${badge(verdict)}`) +
    `</dl>`;

  const verdictSpecific =
    verdict === "AFFECTED"
      ? renderAffectedEvidence(finding) + renderReasons(finding)
      : verdict === "UNKNOWN"
        ? renderUnknownBlockers(finding)
        : renderNegativeProof(finding) + renderReasons(finding);

  return (
    `<article class="finding" id="${text(id)}" data-verdict="${verdict}" data-finding="${text(id)}">` +
    `<details open>` +
    `<summary>` +
    `<span class="summary-line">${badge(verdict)} ` +
    `<span class="summary-id">${text(finding.vulnerability)}</span> ` +
    `<span class="summary-pkg">${text(finding.package)}@${text(finding.version)}</span>` +
    `</span>` +
    `</summary>` +
    `<div class="finding-body">${facts}${verdictSpecific}</div>` +
    `</details>` +
    `</article>`
  );
}

function renderSummary(
  output: ScanOutput,
  counts: Record<ReportVerdict, number>,
): string {
  const total = output.findings.length;
  const cards = VERDICT_ORDER.map(
    (verdict) =>
      `<a class="card card-${verdict}" href="#verdict-${verdict}">` +
      `<span class="card-count">${counts[verdict]}</span>` +
      `<span class="card-label">${badge(verdict)}</span>` +
      `</a>`,
  ).join("");

  return (
    `<section id="summary" class="panel">` +
    `<h2>Scan summary</h2>` +
    `<dl class="dl">` +
    definitionRow("Project", code(output.scan.project)) +
    definitionRow("Scan id", code(output.scan.id)) +
    definitionRow("Result schema version", code(output.schemaVersion)) +
    definitionRow("Scan duration", `${code(output.timings.totalMs)} ms`) +
    definitionRow("Total findings", code(total)) +
    `</dl>` +
    `<div class="cards">` +
    `<a class="card card-total" href="#findings">` +
    `<span class="card-count">${total}</span>` +
    `<span class="card-label">TOTAL</span>` +
    `</a>` +
    cards +
    `</div>` +
    `</section>`
  );
}

function renderScope(): string {
  return (
    `<section id="scope" class="panel scope">` +
    `<h2>Analysis scope / supported model</h2>` +
    `<p>${text(SUPPORTED_MODEL_STATEMENT)}</p>` +
    `<p>The declared model does not cover, and no verdict here claims anything about:</p>` +
    `<ul class="exclusions">${SUPPORTED_MODEL_EXCLUSIONS.map(
      (exclusion) => `<li>${text(exclusion)}</li>`,
    ).join("")}</ul>` +
    `<p class="note">In-source loader and runtime capabilities are <em>not</em> in that list: those are modelled, and encountering one withdraws a negative proof entirely rather than weakening it.</p>` +
    `</section>`
  );
}

function renderCoverage(coverage: Coverage): string {
  const rows: readonly (readonly [string, number])[] = [
    ["Files analyzed", coverage.files],
    ["Modules resolved", coverage.modulesResolved],
    ["Modules unresolved", coverage.modulesUnresolved],
    ["Functions", coverage.functions],
    ["Calls resolved", coverage.callsResolved],
    ["Calls dynamic", coverage.callsDynamic],
  ];
  return (
    `<section id="coverage" class="panel">` +
    `<h2>Analysis coverage</h2>` +
    `<p>What the scan actually analyzed — the context a verdict must be read against.</p>` +
    `<div class="table-scroll"><table class="kv">` +
    `<thead><tr><th scope="col">Metric</th><th scope="col">Value</th></tr></thead>` +
    `<tbody>${rows
      .map(
        ([label, value]) =>
          `<tr><th scope="row">${text(label)}</th><td>${code(value)}</td></tr>`,
      )
      .join("")}</tbody>` +
    `</table></div>` +
    `</section>`
  );
}

function renderDiagnostics(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return (
      `<section id="diagnostics" class="panel">` +
      `<h2>Diagnostics</h2>` +
      `<p class="absent">The scan recorded no diagnostics.</p>` +
      `</section>`
    );
  }
  return (
    `<section id="diagnostics" class="panel">` +
    `<h2>Diagnostics</h2>` +
    `<p>Blockers behind the coverage counts above, including module-load closure availability.</p>` +
    `<div class="table-scroll"><table class="kv">` +
    `<thead><tr><th scope="col">Source</th><th scope="col">Message</th></tr></thead>` +
    `<tbody>${diagnostics
      .map(
        (diagnostic) =>
          `<tr><th scope="row">${code(diagnostic.source)}</th><td>${text(diagnostic.message)}</td></tr>`,
      )
      .join("")}</tbody>` +
    `</table></div>` +
    `</section>`
  );
}

function renderTimings(timings: PhaseTimings): string {
  const rows: readonly (readonly [string, number])[] = [
    ["Parsing (derived)", timings.parsingMs],
    ["Module resolution", timings.resolutionMs],
    ["Call-graph construction", timings.graphConstructionMs],
    ["Reachability", timings.reachabilityMs],
    ["Vulnerability provider", timings.providerMs],
    ["Total", timings.totalMs],
  ];
  return (
    `<section id="timings" class="panel">` +
    `<h2>Timings</h2>` +
    `<div class="table-scroll"><table class="kv">` +
    `<thead><tr><th scope="col">Phase</th><th scope="col">Milliseconds</th></tr></thead>` +
    `<tbody>${rows
      .map(
        ([label, value]) =>
          `<tr><th scope="row">${text(label)}</th><td>${code(value)}</td></tr>`,
      )
      .join("")}` +
    `<tr><th scope="row">Provider cache hits</th><td>${code(timings.cacheHits)}</td></tr>` +
    `<tr><th scope="row">Provider cache misses</th><td>${code(timings.cacheMisses)}</td></tr>` +
    `</tbody></table></div>` +
    `</section>`
  );
}

function renderControls(): string {
  const buttons = ["ALL", ...VERDICT_ORDER]
    .map(
      (value, index) =>
        `<button type="button" class="filter" data-filter="${value}" aria-pressed="${index === 0 ? "true" : "false"}">${text(value)}</button>`,
    )
    .join("");

  return (
    `<div class="controls" id="controls">` +
    `<div class="control-group" role="group" aria-label="Filter findings by verdict">${buttons}</div>` +
    `<div class="control-group">` +
    `<label for="finding-search">Search</label>` +
    `<input type="search" id="finding-search" placeholder="advisory, package or symbol" autocomplete="off">` +
    `</div>` +
    `<div class="control-group">` +
    `<button type="button" id="expand-all">Expand all</button>` +
    `<button type="button" id="collapse-all">Collapse all</button>` +
    `</div>` +
    `<p class="control-status" id="filter-status" role="status"></p>` +
    `</div>`
  );
}

/**
 * The report's stylesheet. Inline by requirement (one self-contained
 * file), light-only by choice: this document is meant to be read in a
 * browser and printed, and a dark full-page background prints badly.
 * Contains no `url()`, no `@import`, and no font file — only system font
 * stacks.
 */
const STYLES = `
:root{--fg:#16191d;--muted:#5a6472;--bg:#ffffff;--panel:#f6f7f9;--line:#d5dae1;--code:#eef1f5;--affected:#8c1d18;--affected-bg:#fdecea;--unknown:#7a4a05;--unknown-bg:#fdf3e3;--notaffected:#14532d;--notaffected-bg:#e8f5ec;--link:#0b4f9c}
*{box-sizing:border-box}
body{margin:0;color:var(--fg);background:var(--bg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
code,.token,.path-location{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:.9em}
code{background:var(--code);padding:.08em .34em;border-radius:3px;overflow-wrap:anywhere;word-break:break-word}
main,header.report{max-width:1100px;margin:0 auto;padding:0 20px}
header.report{padding-top:28px;padding-bottom:8px;border-bottom:1px solid var(--line);margin-bottom:22px}
h1{font-size:1.6rem;margin:0 0 .2em}
h2{font-size:1.2rem;margin:0 0 .6em}
h3{font-size:1.02rem;margin:1.6em 0 .3em;display:flex;align-items:center;gap:.5em}
h4{font-size:.95rem;margin:1.1em 0 .4em;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
p{margin:.5em 0}
a{color:var(--link)}
.subtitle{color:var(--muted);margin:0 0 .8em}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:0 0 20px}
.dl{margin:0;display:grid;grid-template-columns:minmax(11rem,auto) 1fr;gap:.15em 1em}
.dl-row{display:contents}
.dl dt{color:var(--muted);font-weight:600}
.dl dd{margin:0;min-width:0;overflow-wrap:anywhere}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.card{display:flex;flex-direction:column;gap:.25em;min-width:8.5rem;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--bg);text-decoration:none;color:inherit}
.card-count{font-size:1.7rem;font-weight:700;line-height:1}
.card-label{font-size:.8rem;color:var(--muted);letter-spacing:.04em}
.badge{display:inline-flex;align-items:center;gap:.35em;padding:.1em .5em;border-radius:999px;border:1px solid currentColor;font-size:.78rem;font-weight:700;letter-spacing:.03em;white-space:nowrap}
.badge-AFFECTED{color:var(--affected);background:var(--affected-bg)}
.badge-UNKNOWN{color:var(--unknown);background:var(--unknown-bg)}
.badge-NOT_AFFECTED{color:var(--notaffected);background:var(--notaffected-bg)}
.glyph{font-size:.8em}
.count{color:var(--muted);font-weight:600;font-size:.9rem}
.verdict-meaning{color:var(--muted);margin:.1em 0 .7em;max-width:75ch}
.table-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
thead th{background:var(--panel);font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);white-space:nowrap}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
td.summary{max-width:32rem;color:var(--muted)}
.finding{border:1px solid var(--line);border-radius:8px;margin:0 0 12px;background:var(--bg)}
.finding>details>summary{cursor:pointer;padding:10px 14px;list-style-position:inside}
.finding>details[open]>summary{border-bottom:1px solid var(--line)}
.summary-line{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.5em}
.summary-id{font-weight:700}
.summary-pkg{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88rem}
.finding-body{padding:12px 14px 16px}
.finding[data-verdict="AFFECTED"]{border-left:5px solid var(--affected)}
.finding[data-verdict="UNKNOWN"]{border-left:5px solid var(--unknown)}
.finding[data-verdict="NOT_AFFECTED"]{border-left:5px solid var(--notaffected)}
.proof,.blockers,.evidence-path,.reasons{margin-top:14px;padding-top:6px;border-top:1px dashed var(--line)}
.claim{max-width:80ch}
.limit{color:var(--muted);max-width:80ch;font-size:.92rem}
.absent{color:var(--muted);font-style:italic}
.note{color:var(--muted);font-size:.9em}
ul.plain,ul.blocker-list,ul.reason-list,ul.exclusions{margin:.3em 0;padding-left:1.2em}
ul.plain{list-style:square}
.blocker-list li{margin:.3em 0;overflow-wrap:anywhere}
.token{display:inline-block;background:var(--unknown-bg);color:var(--unknown);border:1px solid currentColor;border-radius:3px;padding:0 .35em;font-weight:700;font-size:.8rem}
ol.path{list-style:none;margin:.4em 0;padding:0}
.path-step{display:flex;flex-wrap:wrap;align-items:baseline;gap:.6em;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.path-label{font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);min-width:8.5rem}
.path-location{overflow-wrap:anywhere;min-width:0}
.path-arrow{text-align:center;color:var(--muted);line-height:1.1;padding:2px 0}
.controls{display:none;flex-wrap:wrap;gap:10px 16px;align-items:center;margin:0 0 16px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
html.vt-js .controls{display:flex}
.control-group{display:flex;align-items:center;gap:6px}
button,input[type="search"]{font:inherit;padding:5px 11px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit}
button{cursor:pointer}
button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.control-status{margin:0;color:var(--muted);font-size:.86rem}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip-link{position:absolute;left:-9999px;top:0;z-index:10;padding:8px 12px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:0 0 6px 0}
.skip-link:focus{left:0}
footer.report{max-width:1100px;margin:24px auto 40px;padding:14px 20px 0;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}
@media (max-width:720px){.dl{grid-template-columns:1fr;gap:0}.dl dt{margin-top:.5em}.path-label{min-width:0}}
@media print{
 .controls,.skip-link{display:none!important}
 body{background:#fff;font-size:11pt}
 .panel,.finding,.table-scroll,.path-step{background:#fff!important;border-color:#999}
 .finding,.panel,.path-step,tr{break-inside:avoid}
 a{color:inherit;text-decoration:none}
 .badge{border-color:#333;color:#000;background:#fff!important}
}
`;

/**
 * The report's inline script — strictly progressive enhancement.
 *
 * It carries NO project data: everything it filters on is read back out of
 * the DOM at runtime. That is what keeps the injection surface at zero (no
 * `</script>` break-out, no JS string escaping to get right) and is why
 * this constant can be a fixed literal rather than something generated per
 * scan.
 *
 * It never adds information: it hides, reveals, and collapses nodes that
 * are already in the static document. With scripting off, the controls
 * stay hidden and every finding stays expanded.
 */
const SCRIPT = `
(function(){
  var html=document.documentElement;
  html.className+=" vt-js";
  var rows=[].slice.call(document.querySelectorAll(".finding-row"));
  var articles=[].slice.call(document.querySelectorAll("article.finding"));
  var groups=[].slice.call(document.querySelectorAll(".verdict-group"));
  var buttons=[].slice.call(document.querySelectorAll("button.filter"));
  var search=document.getElementById("finding-search");
  var status=document.getElementById("filter-status");
  var current="ALL";

  function matches(el,verdict,query){
    if(current!=="ALL"&&verdict!==current){return false;}
    if(!query){return true;}
    return (el.textContent||"").toLowerCase().indexOf(query)!==-1;
  }
  function apply(){
    var query=search&&search.value?search.value.toLowerCase().trim():"";
    var shown=0;
    rows.forEach(function(row){
      var ok=matches(row,row.getAttribute("data-verdict"),query);
      row.hidden=!ok;
      if(ok){shown++;}
    });
    var visibleIds={};
    rows.forEach(function(row){ if(!row.hidden){visibleIds[row.getAttribute("data-finding")]=true;} });
    articles.forEach(function(article){
      article.hidden=!visibleIds[article.getAttribute("data-finding")];
    });
    groups.forEach(function(group){
      group.hidden=current!=="ALL"&&group.getAttribute("data-verdict")!==current;
    });
    if(status){
      status.textContent=shown+(shown===1?" finding":" findings")+" shown"+
        (current==="ALL"?"":" (verdict "+current+")")+(query?' matching "'+query+'"':"");
    }
  }
  buttons.forEach(function(button){
    button.addEventListener("click",function(){
      current=button.getAttribute("data-filter")||"ALL";
      buttons.forEach(function(other){
        other.setAttribute("aria-pressed",other===button?"true":"false");
      });
      apply();
    });
  });
  if(search){search.addEventListener("input",apply);}

  function setOpen(open){
    articles.forEach(function(article){
      var details=article.querySelector("details");
      if(details){details.open=open;}
    });
  }
  var expand=document.getElementById("expand-all");
  var collapse=document.getElementById("collapse-all");
  if(expand){expand.addEventListener("click",function(){setOpen(true);});}
  if(collapse){collapse.addEventListener("click",function(){setOpen(false);});}

  // Tidy the initial view only when scripting is available: NOT_AFFECTED
  // findings are the ones a reader usually reads second. The static
  // document still ships them expanded, so nothing is hidden from a
  // no-JS reader, a printer, or a text extractor.
  articles.forEach(function(article){
    if(article.getAttribute("data-verdict")==="NOT_AFFECTED"){
      var details=article.querySelector("details");
      if(details){details.open=false;}
    }
  });

  // Printing must never lose evidence to a collapsed section.
  if(window.matchMedia){
    var print=window.matchMedia("print");
    if(print.addEventListener){print.addEventListener("change",function(e){if(e.matches){setOpen(true);}});}
  }
  window.addEventListener("beforeprint",function(){setOpen(true);});
  apply();
})();
`;

/**
 * Renders one {@link ScanOutput} as a complete, self-contained HTML
 * document.
 *
 * Pure and total: no I/O, no clock, no randomness, linear in the size of
 * the result. Safe to call without running a scan — every test in
 * `html-report.test.ts` does exactly that.
 */
export function renderHtmlReport(output: ScanOutput): string {
  const counts = countByVerdict(output.findings);
  const indexed = output.findings.map((finding, index) => ({ finding, index }));

  const groups = VERDICT_ORDER.map((verdict) =>
    renderOverviewGroup(
      verdict,
      indexed.filter((entry) => verdictOf(entry.finding) === verdict),
    ),
  ).join("");

  const details = VERDICT_ORDER.flatMap((verdict) =>
    indexed.filter((entry) => verdictOf(entry.finding) === verdict),
  )
    .map((entry) => renderFindingDetail(entry.finding, entry.index))
    .join("");

  const findingsSection =
    `<section id="findings">` +
    `<h2>Findings</h2>` +
    (output.findings.length === 0
      ? `<p class="absent">This scan produced no findings. That means no installed dependency matched a vulnerability record the configured provider returned — not that the project was proved unaffected by anything. Read it together with the coverage and diagnostics below.</p>`
      : renderControls() + groups) +
    `</section>`;

  const detailsSection =
    output.findings.length === 0
      ? ""
      : `<section id="finding-details"><h2>Finding details</h2>${details}</section>`;

  return (
    `<!doctype html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    // Empty data: URI, so a browser never issues a favicon request for a
    // report that is required to make no network requests at all.
    `<link rel="icon" href="data:,">\n` +
    `<title>VulnTrace report — ${text(output.scan.project)}</title>\n` +
    `<style>${STYLES}</style>\n` +
    `</head>\n` +
    `<body>\n` +
    `<a class="skip-link" href="#findings">Skip to findings</a>` +
    `<header class="report">` +
    `<h1>VulnTrace report</h1>` +
    `<p class="subtitle">Reachability and impact analysis for ${code(output.scan.project)}</p>` +
    `</header>\n` +
    `<main>` +
    renderSummary(output, counts) +
    renderScope() +
    findingsSection +
    detailsSection +
    renderCoverage(output.coverage) +
    renderDiagnostics(output.diagnostics) +
    renderTimings(output.timings) +
    `</main>\n` +
    `<footer class="report">` +
    `<p>Generated by VulnTrace from a single scan result (schema ${code(output.schemaVersion)}). This document is self-contained: it loads no external script, stylesheet, font or image, and makes no network requests.</p>` +
    `<p>Every statement here is a presentation of that result. Verdicts, evidence and reasons are reproduced as the scan recorded them; the report computes no analysis of its own.</p>` +
    `</footer>\n` +
    `<script>${SCRIPT}</script>\n` +
    `</body>\n` +
    `</html>\n`
  );
}
