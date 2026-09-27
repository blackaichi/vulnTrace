/**
 * BL-029 — THE DIFFERENTIAL TOOL'S PURE CORE.
 *
 * Normalizes what one scan produced into a per-case record, diffs two
 * snapshots of such records, and renders the result. No I/O, no git, no
 * scanning: the collector (`src/testing/differential-collect.ts`) produces
 * snapshots, the driver (`scripts/differential.mjs`) orchestrates, and this
 * file decides what counts as a difference. It is plain ESM so the driver
 * can run it under bare `node`; its types are in `differential-lib.d.mts`
 * and `src/testing/differential-lib.test.ts` exercises it under `npm test`.
 *
 * THE THREE DIFFERENTIALS ARE REPORTED SEPARATELY (AGENTS.md § G).
 *
 * - graph: per case, the call graph's nodes and call sites. A site is
 *   `from [type] @ file:line:col`; its value is the multiset of its edges'
 *   resolutions. A site whose resolutions changed is classified as
 *   withdrawn to unknown, unknown to resolved, or retargeted.
 * - proof: per case, advisory and exact package instance, the proof a
 *   finding carries: its negative-proof family (A, B, C of
 *   SOUNDNESS-CONTRACT), evidence path, evidence reasons, the
 *   negative-proof fields, unknown reasons, target and confidence. Each
 *   change says whether the verdict moved too.
 * - verdict: per the same key, verdict changes (a move INTO NOT_AFFECTED
 *   flagged apart: that is the critical direction), findings added,
 *   findings removed (a possible silent drop), and unreported-candidate
 *   entries added and removed.
 *
 * WHAT IS NEVER COUNTED AS ZERO. A case measured on one side only, a case
 * whose scan threw or printed unparseable output, and a case whose graph
 * was not observed are listed as such and excluded from the counts, never
 * folded into "no change". A zero differential is not evidence of
 * soundness (OPEN-DEBTS D-12); a zero differential over cases that were
 * not measured is not even a measurement.
 *
 * IDENTITY. Findings are keyed by advisory and exact `packageInstance`,
 * never by `name@version` (ARCHITECTURE § 4): two installs sharing a name
 * and version are two keys, so a sibling's verdict borrowed by the other
 * shows as two changes. Only a finding that carries no instance at all
 * falls back to name and version, and its key says so.
 */

export const SNAPSHOT_FORMAT = "vulntrace-differential-snapshot/1";

/** Stable JSON: object keys sorted, `undefined` members dropped. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        out[key] = sortKeys(value[key]);
      }
    }
    return out;
  }
  return value;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every occurrence of each root directory with its placeholder,
 * longest root first, so a project directory nested inside the corpus root
 * becomes `<project>` rather than `<corpus>/…`. A root is replaced only
 * where a path component ends (followed by a separator, the end of the
 * string, or a character that cannot continue a directory name in the
 * strings a scan emits), so `/tmp` never rewrites `/tmpfoo`.
 */
export function createPathNormalizer(roots) {
  const pairs = [];
  for (const root of roots) {
    const trimmed = String(root.path ?? "").replace(/[\\/]+$/, "");
    if (trimmed.length > 1) {
      pairs.push([trimmed, root.token]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const patterns = pairs.map(([rootPath, token]) => [
    new RegExp(`${escapeRegExp(rootPath)}(?=$|[\\\\/:#"'\\s)\\]@,])`, "g"),
    token,
  ]);
  return (text) => {
    let out = text;
    for (const [pattern, token] of patterns) {
      out = out.replace(pattern, token);
    }
    return out;
  };
}

/** Applies `normalize` to every string inside a JSON-shaped value. */
export function deepNormalize(value, normalize) {
  if (typeof value === "string") {
    return normalize(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepNormalize(item, normalize));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = deepNormalize(item, normalize);
    }
    return out;
  }
  return value;
}

function edgeSite(edge, normalize) {
  const location = edge.location
    ? `${normalize(edge.location.file)}:${edge.location.line ?? "?"}:${edge.location.column ?? "?"}`
    : "<no location>";
  return `${normalize(edge.from)} [${edge.type}] @ ${location}`;
}

function edgeResolution(edge, normalize) {
  const resolution = edge.resolution;
  if (resolution.kind === "resolved") {
    return `-> ${normalize(resolution.target)}`;
  }
  const potential = [...(resolution.potentialTargets ?? [])]
    .map(normalize)
    .sort(compareStrings);
  return potential.length > 0
    ? `? ${resolution.reason} {${potential.join(", ")}}`
    : `? ${resolution.reason}`;
}

/** The observed call graph as sorted, normalized strings; `null` if none was observed. */
export function graphRecord(observed, normalize) {
  if (observed === null || observed === undefined) {
    return null;
  }
  const nodes = observed.graph.nodes
    .map((node) => `${normalize(node.id)} (${node.kind})`)
    .sort(compareStrings);
  const edges = observed.graph.edges
    .map((edge) => ({
      site: edgeSite(edge, normalize),
      resolution: edgeResolution(edge, normalize),
    }))
    .sort(
      (a, b) =>
        compareStrings(a.site, b.site) ||
        compareStrings(a.resolution, b.resolution),
    );
  return { truncated: observed.truncated === true, nodes, edges };
}

/**
 * A finding's key: advisory and exact installed instance. The fallback for
 * an instance-less finding names package and version, and says it is one.
 */
export function findingKey(vulnerability, pkg, version, packageInstance) {
  const where =
    packageInstance === null || packageInstance === undefined
      ? `<no instance: ${pkg}@${version ?? "?"}>`
      : packageInstance;
  return `${vulnerability} @ ${where}`;
}

function proofOf(finding, normalize) {
  const evidence =
    finding.evidence === undefined
      ? undefined
      : deepNormalize(finding.evidence, normalize);
  const families = [];
  if (evidence?.confirmedAbsentFromModuleLoadClosure) families.push("A");
  if (evidence?.confirmedAbsentInstance) families.push("B");
  if (evidence?.confirmedUnreachableTarget) families.push("C");
  const unknownReasons = (finding.unknownReasons ?? [])
    .map((reason) => canonicalJson(deepNormalize(reason, normalize)))
    .sort(compareStrings)
    .map((text) => JSON.parse(text));
  return {
    family: families.length > 0 ? families.join("+") : null,
    path: evidence?.path ?? [],
    reasons: [...(evidence?.reasons ?? [])].sort(compareStrings),
    negativeProof: {
      A: evidence?.confirmedAbsentFromModuleLoadClosure ?? null,
      B: evidence?.confirmedAbsentInstance ?? null,
      C: evidence?.confirmedUnreachableTarget ?? null,
    },
    unknownReasons,
    target:
      finding.target === undefined
        ? null
        : deepNormalize(finding.target, normalize),
    confidence: finding.confidence ?? null,
  };
}

/** Every finding of one scan, keyed, sorted, duplicates made explicit. */
export function findingRecords(findings, normalize) {
  const records = findings.map((finding) => {
    const packageInstance =
      finding.packageInstance === undefined
        ? null
        : normalize(finding.packageInstance);
    return {
      key: findingKey(
        finding.vulnerability,
        finding.package,
        finding.version,
        packageInstance,
      ),
      vulnerability: finding.vulnerability,
      package: finding.package,
      version: finding.version ?? null,
      packageInstance,
      verdict: finding.verdict,
      proof: proofOf(finding, normalize),
    };
  });
  return disambiguate(records);
}

/**
 * Two findings of one scan with the same key are an identity collision the
 * report must show, not a map entry to overwrite. Each gets an ordinal
 * suffix (by canonical content, so the suffix is stable) and is marked.
 */
function disambiguate(records) {
  const byKey = new Map();
  for (const record of records) {
    const list = byKey.get(record.key) ?? [];
    list.push(record);
    byKey.set(record.key, list);
  }
  const out = [];
  for (const [key, list] of byKey) {
    if (list.length === 1) {
      out.push({ ...list[0], duplicateKey: false });
      continue;
    }
    const sorted = [...list].sort((a, b) =>
      compareStrings(canonicalJson(a), canonicalJson(b)),
    );
    sorted.forEach((record, index) =>
      out.push({ ...record, key: `${key} #${index + 1}`, duplicateKey: true }),
    );
  }
  return out.sort((a, b) => compareStrings(a.key, b.key));
}

/** Every unreported candidate of one scan, normalized, as sorted canonical JSON. */
export function unreportedRecords(candidates, normalize) {
  return candidates
    .map((candidate) => canonicalJson(deepNormalize(candidate, normalize)))
    .sort(compareStrings);
}

/**
 * One case's record. `stdout` is the scan's raw JSON output; `error` is
 * the message of an exception the scan threw (then `stdout` is ignored).
 */
export function buildCaseRecord(input) {
  const normalize = createPathNormalizer(input.roots);
  let output = null;
  let outputStatus = "ok";
  if (input.error !== null && input.error !== undefined) {
    outputStatus = "error";
  } else {
    try {
      output = JSON.parse(input.stdout);
    } catch {
      outputStatus = "unparseable";
    }
  }
  return {
    corpus: input.corpus,
    id: input.id,
    oracle: input.oracle ?? null,
    exitCode: input.exitCode ?? null,
    outputStatus,
    error:
      input.error === null || input.error === undefined
        ? null
        : normalize(String(input.error)),
    stderr: normalize(input.stderr ?? ""),
    schemaIssueCount: input.schemaIssueCount ?? 0,
    graph: graphRecord(input.observedGraph ?? null, normalize),
    findings:
      output === null ? [] : findingRecords(output.findings ?? [], normalize),
    unreported:
      output === null
        ? []
        : unreportedRecords(output.unreportedCandidates ?? [], normalize),
  };
}

export function caseKey(record) {
  return `${record.corpus}/${record.id}`;
}

/**
 * The suites' own selection rule (`tests/validation/validation.test.ts`,
 * `tests/adversarial/v1` and `v2`): filter by package and version, by
 * advisory when the selector names one, by instance when it names one;
 * exactly one match is the verdict, none is `NO_FINDING`, several is
 * `AMBIGUOUS_SELECTOR(…)` — never the first of several.
 */
export function selectFinding(findings, selector) {
  let matches = findings.filter(
    (f) =>
      f.package === selector.package &&
      f.version === selector.version &&
      (selector.vulnerability === undefined ||
        f.vulnerability === selector.vulnerability),
  );
  if (selector.packageInstance !== undefined) {
    matches = matches.filter(
      (f) => f.packageInstance === selector.packageInstance,
    );
  }
  if (matches.length === 0) {
    return "NO_FINDING";
  }
  if (matches.length > 1) {
    return `AMBIGUOUS_SELECTOR(${matches
      .map((f) => f.packageInstance ?? "<no instance>")
      .sort(compareStrings)
      .join(", ")})`;
  }
  return matches[0].verdict;
}

function suiteActual(record, selector) {
  if (record.outputStatus === "error") return "ERROR";
  if (record.outputStatus === "unparseable") return "UNPARSEABLE_OUTPUT";
  return selectFinding(record.findings, selector);
}

function multisetDiff(base, head) {
  const counts = new Map();
  for (const item of base) counts.set(item, (counts.get(item) ?? 0) + 1);
  const added = [];
  for (const item of head) {
    const n = counts.get(item) ?? 0;
    if (n > 0) counts.set(item, n - 1);
    else added.push(item);
  }
  const removed = [];
  for (const [item, n] of counts) {
    for (let i = 0; i < n; i += 1) removed.push(item);
  }
  return { added: added.sort(compareStrings), removed: removed.sort(compareStrings) };
}

function groupSites(edges) {
  const sites = new Map();
  for (const edge of edges) {
    const list = sites.get(edge.site) ?? [];
    list.push(edge.resolution);
    sites.set(edge.site, list);
  }
  for (const list of sites.values()) list.sort(compareStrings);
  return sites;
}

function classifySiteChange(base, head) {
  const baseUnknown = base.some((r) => r.startsWith("?"));
  const headUnknown = head.some((r) => r.startsWith("?"));
  if (!baseUnknown && headUnknown) return "withdrawn_to_unknown";
  if (baseUnknown && !headUnknown) return "unknown_to_resolved";
  return "retargeted";
}

function diffGraph(base, head) {
  const nodes = multisetDiff(base.nodes, head.nodes);
  const baseSites = groupSites(base.edges);
  const headSites = groupSites(head.edges);
  const sitesAdded = [];
  const sitesRemoved = [];
  const sitesChanged = [];
  const allSites = [...new Set([...baseSites.keys(), ...headSites.keys()])].sort(
    compareStrings,
  );
  for (const site of allSites) {
    const b = baseSites.get(site);
    const h = headSites.get(site);
    if (b === undefined && h !== undefined) {
      sitesAdded.push({ site, resolutions: h });
    } else if (h === undefined && b !== undefined) {
      sitesRemoved.push({ site, resolutions: b });
    } else if (b !== undefined && h !== undefined && canonicalJson(b) !== canonicalJson(h)) {
      sitesChanged.push({ site, base: b, head: h, change: classifySiteChange(b, h) });
    }
  }
  return {
    truncated:
      base.truncated === head.truncated
        ? null
        : { base: base.truncated, head: head.truncated },
    nodesAdded: nodes.added,
    nodesRemoved: nodes.removed,
    sitesAdded,
    sitesRemoved,
    sitesChanged,
  };
}

function graphDiffIsEmpty(d) {
  return (
    d.truncated === null &&
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.sitesAdded.length === 0 &&
    d.sitesRemoved.length === 0 &&
    d.sitesChanged.length === 0
  );
}

const PROOF_FIELDS = [
  "family",
  "path",
  "reasons",
  "negativeProof",
  "unknownReasons",
  "target",
  "confidence",
];

function checkFormat(snapshot, side) {
  if (snapshot?.format !== SNAPSHOT_FORMAT) {
    throw new Error(
      `${side} snapshot has format ${JSON.stringify(snapshot?.format)}, expected ${SNAPSHOT_FORMAT}`,
    );
  }
}

/** Diffs two snapshots. Throws on a snapshot of the wrong format. */
export function diffSnapshots(base, head) {
  checkFormat(base, "base");
  checkFormat(head, "head");
  const baseCases = new Map(base.cases.map((c) => [caseKey(c), c]));
  const headCases = new Map(head.cases.map((c) => [caseKey(c), c]));
  const keys = [...new Set([...baseCases.keys(), ...headCases.keys()])].sort(
    compareStrings,
  );

  const result = {
    base: { label: base.label, cases: base.cases.length },
    head: { label: head.label, cases: head.cases.length },
    cases: {
      total: keys.length,
      onlyBase: [],
      onlyHead: [],
      unmeasured: [],
      duplicateKeys: [],
      schemaIssues: [],
    },
    graph: { measured: 0, unavailable: [], changed: [] },
    proof: { measured: 0, changed: [] },
    verdict: {
      measured: 0,
      changed: [],
      added: [],
      removed: [],
      unreportedAdded: [],
      unreportedRemoved: [],
    },
    suite: [],
  };

  for (const key of keys) {
    const b = baseCases.get(key);
    const h = headCases.get(key);
    if (b === undefined) {
      result.cases.onlyHead.push(key);
      continue;
    }
    if (h === undefined) {
      result.cases.onlyBase.push(key);
      continue;
    }

    const oracle = h.oracle ?? b.oracle;
    if (oracle !== null && oracle !== undefined) {
      const baseActual = suiteActual(b, oracle.selector);
      const headActual = suiteActual(h, oracle.selector);
      result.suite.push({
        case: key,
        expected: oracle.expected,
        knownFailure: oracle.knownFailure ?? null,
        base: baseActual,
        head: headActual,
        moved: baseActual !== headActual,
      });
    }

    for (const [side, record] of [
      ["base", b],
      ["head", h],
    ]) {
      for (const f of record.findings) {
        if (f.duplicateKey) {
          result.cases.duplicateKeys.push({ case: key, side, key: f.key });
        }
      }
      if (record.schemaIssueCount > 0) {
        result.cases.schemaIssues.push({
          case: key,
          side,
          count: record.schemaIssueCount,
        });
      }
    }

    if (b.graph === null || h.graph === null) {
      result.graph.unavailable.push({
        case: key,
        base: b.graph !== null,
        head: h.graph !== null,
      });
    } else {
      result.graph.measured += 1;
      const d = diffGraph(b.graph, h.graph);
      if (!graphDiffIsEmpty(d)) {
        result.graph.changed.push({ case: key, ...d });
      }
    }

    if (b.outputStatus !== "ok" || h.outputStatus !== "ok") {
      result.cases.unmeasured.push({
        case: key,
        base: b.outputStatus,
        head: h.outputStatus,
        baseError: b.error,
        headError: h.error,
      });
      continue;
    }
    result.proof.measured += 1;
    result.verdict.measured += 1;

    const baseFindings = new Map(b.findings.map((f) => [f.key, f]));
    const headFindings = new Map(h.findings.map((f) => [f.key, f]));
    const findingKeys = [
      ...new Set([...baseFindings.keys(), ...headFindings.keys()]),
    ].sort(compareStrings);
    for (const fk of findingKeys) {
      const bf = baseFindings.get(fk);
      const hf = headFindings.get(fk);
      if (bf === undefined && hf !== undefined) {
        result.verdict.added.push({ case: key, key: fk, verdict: hf.verdict });
        continue;
      }
      if (hf === undefined && bf !== undefined) {
        const nowUnreported = h.unreported.filter((text) => {
          const u = JSON.parse(text);
          return (
            u.vulnerability === bf.vulnerability &&
            (bf.packageInstance === null
              ? u.package === bf.package
              : u.packageInstance === bf.packageInstance)
          );
        });
        result.verdict.removed.push({
          case: key,
          key: fk,
          verdict: bf.verdict,
          nowUnreported,
        });
        continue;
      }
      if (bf === undefined || hf === undefined) continue;
      const verdictMoved = bf.verdict !== hf.verdict;
      if (verdictMoved) {
        result.verdict.changed.push({
          case: key,
          key: fk,
          from: bf.verdict,
          to: hf.verdict,
          intoNotAffected: hf.verdict === "NOT_AFFECTED",
        });
      }
      const fields = [];
      for (const field of PROOF_FIELDS) {
        const bv = canonicalJson(bf.proof[field]);
        const hv = canonicalJson(hf.proof[field]);
        if (bv !== hv) fields.push({ field, base: bv, head: hv });
      }
      if (fields.length > 0) {
        result.proof.changed.push({
          case: key,
          key: fk,
          verdictBase: bf.verdict,
          verdictHead: hf.verdict,
          verdictMoved,
          fields,
        });
      }
    }

    const unreported = multisetDiff(b.unreported, h.unreported);
    for (const entry of unreported.added) {
      result.verdict.unreportedAdded.push({ case: key, entry });
    }
    for (const entry of unreported.removed) {
      result.verdict.unreportedRemoved.push({ case: key, entry });
    }
  }
  return result;
}

/** Totals for the summary table. */
export function summarize(diff) {
  const g = diff.graph.changed;
  const sum = (list, pick) => list.reduce((n, item) => n + pick(item), 0);
  const changedSites = g.flatMap((c) => c.sitesChanged);
  return {
    graph: {
      measured: diff.graph.measured,
      unavailable: diff.graph.unavailable.length,
      casesChanged: g.length,
      nodesAdded: sum(g, (c) => c.nodesAdded.length),
      nodesRemoved: sum(g, (c) => c.nodesRemoved.length),
      sitesAdded: sum(g, (c) => c.sitesAdded.length),
      sitesRemoved: sum(g, (c) => c.sitesRemoved.length),
      sitesChanged: changedSites.length,
      withdrawnToUnknown: changedSites.filter((s) => s.change === "withdrawn_to_unknown").length,
      unknownToResolved: changedSites.filter((s) => s.change === "unknown_to_resolved").length,
      retargeted: changedSites.filter((s) => s.change === "retargeted").length,
      truncationChanged: g.filter((c) => c.truncated !== null).length,
    },
    proof: {
      measured: diff.proof.measured,
      changed: diff.proof.changed.length,
      changedWithVerdictUnchanged: diff.proof.changed.filter((c) => !c.verdictMoved).length,
    },
    verdict: {
      measured: diff.verdict.measured,
      changed: diff.verdict.changed.length,
      intoNotAffected: diff.verdict.changed.filter((c) => c.intoNotAffected).length,
      added: diff.verdict.added.length,
      addedNotAffected: diff.verdict.added.filter((c) => c.verdict === "NOT_AFFECTED").length,
      removed: diff.verdict.removed.length,
      unreportedAdded: diff.verdict.unreportedAdded.length,
      unreportedRemoved: diff.verdict.unreportedRemoved.length,
    },
    suiteMoved: diff.suite.filter((row) => row.moved).length,
    unmeasured: diff.cases.unmeasured.length,
    onlyOneSide: diff.cases.onlyBase.length + diff.cases.onlyHead.length,
  };
}

const DETAIL_LIMIT = 40;

function limited(lines, limit = DETAIL_LIMIT) {
  if (lines.length <= limit) return lines;
  return [
    ...lines.slice(0, limit),
    `- … ${lines.length - limit} more (see the JSON result)`,
  ];
}

function code(text) {
  return "`" + String(text).replace(/`/g, "'") + "`";
}

/** The Markdown report. */
export function renderReport(diff, context = {}) {
  const s = summarize(diff);
  const lines = [];
  lines.push(`# VulnTrace differential`);
  lines.push("");
  lines.push(`- **Base**: ${diff.base.label} (${diff.base.cases} cases)`);
  lines.push(`- **Head**: ${diff.head.label} (${diff.head.cases} cases)`);
  for (const note of context.notes ?? []) {
    lines.push(`- ${note}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Differential | Result |");
  lines.push("| --- | --- |");
  lines.push(
    `| graph | ${s.graph.casesChanged} of ${s.graph.measured} measured cases changed: nodes +${s.graph.nodesAdded}/−${s.graph.nodesRemoved}; call sites +${s.graph.sitesAdded}/−${s.graph.sitesRemoved}, ${s.graph.sitesChanged} re-resolved (${s.graph.withdrawnToUnknown} withdrawn to unknown, ${s.graph.unknownToResolved} unknown to resolved, ${s.graph.retargeted} retargeted); truncation changed in ${s.graph.truncationChanged}. **Unavailable: ${s.graph.unavailable} cases** |`,
  );
  lines.push(
    `| proof | ${s.proof.changed} findings with a changed proof (${s.proof.changedWithVerdictUnchanged} with the verdict unchanged), over ${s.proof.measured} measured cases |`,
  );
  lines.push(
    `| verdict | ${s.verdict.changed} changed (**${s.verdict.intoNotAffected} into NOT_AFFECTED**); ${s.verdict.added} added (${s.verdict.addedNotAffected} NOT_AFFECTED); **${s.verdict.removed} removed**; unreported candidates +${s.verdict.unreportedAdded}/−${s.verdict.unreportedRemoved}; over ${s.verdict.measured} measured cases |`,
  );
  lines.push(`| suite view | ${s.suiteMoved} cases whose selected verdict moved |`);
  lines.push(
    `| not measured | ${s.unmeasured} cases unmeasured on a side; ${s.onlyOneSide} cases present on one side only |`,
  );
  lines.push("");
  lines.push(
    "A zero differential is not evidence of soundness (OPEN-DEBTS D-12). Unavailable and unmeasured cases are excluded from the counts above, never counted as unchanged.",
  );
  lines.push("");

  const warnings = [];
  if (diff.cases.onlyBase.length > 0)
    warnings.push(`Cases on the base side only: ${diff.cases.onlyBase.join(", ")}`);
  if (diff.cases.onlyHead.length > 0)
    warnings.push(`Cases on the head side only: ${diff.cases.onlyHead.join(", ")}`);
  for (const u of diff.cases.unmeasured) {
    warnings.push(
      `${u.case} not measured: base ${u.base}${u.baseError ? ` (${u.baseError})` : ""}, head ${u.head}${u.headError ? ` (${u.headError})` : ""}`,
    );
  }
  for (const d of diff.cases.duplicateKeys) {
    warnings.push(`${d.case} (${d.side}): two findings share the key ${code(d.key)}`);
  }
  for (const d of diff.cases.schemaIssues) {
    warnings.push(`${d.case} (${d.side}): output failed the result schema (${d.count} issues)`);
  }
  if (diff.graph.unavailable.length > 0) {
    const baseMissing = diff.graph.unavailable.filter((u) => !u.base).length;
    const headMissing = diff.graph.unavailable.filter((u) => !u.head).length;
    warnings.push(
      `Graph not observed for ${diff.graph.unavailable.length} cases (missing on base: ${baseMissing}, on head: ${headMissing}). A base without the \`onCallGraph\` seam (before BL-029) has no graph to observe; a scan that failed before building one has none either.`,
    );
  }
  if (warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of limited(warnings.map((w) => `- ${w}`))) lines.push(w);
    lines.push("");
  }

  lines.push("## Graph differential");
  lines.push("");
  if (diff.graph.changed.length === 0) {
    lines.push(`No change in ${s.graph.measured} measured cases.`);
  }
  for (const c of diff.graph.changed) {
    lines.push(
      `### ${c.case}: nodes +${c.nodesAdded.length}/−${c.nodesRemoved.length}, sites +${c.sitesAdded.length}/−${c.sitesRemoved.length}, re-resolved ${c.sitesChanged.length}`,
    );
    lines.push("");
    const detail = [];
    if (c.truncated !== null)
      detail.push(`- truncated: ${c.truncated.base} → ${c.truncated.head}`);
    for (const x of c.sitesChanged)
      detail.push(
        `- ${x.change}: ${code(x.site)}: ${x.base.map(code).join(", ")} → ${x.head.map(code).join(", ")}`,
      );
    for (const x of c.sitesAdded)
      detail.push(`- site added: ${code(x.site)}: ${x.resolutions.map(code).join(", ")}`);
    for (const x of c.sitesRemoved)
      detail.push(`- site removed: ${code(x.site)}: ${x.resolutions.map(code).join(", ")}`);
    for (const n of c.nodesAdded) detail.push(`- node added: ${code(n)}`);
    for (const n of c.nodesRemoved) detail.push(`- node removed: ${code(n)}`);
    for (const d of limited(detail)) lines.push(d);
    lines.push("");
  }
  lines.push("");

  lines.push("## Proof differential");
  lines.push("");
  if (diff.proof.changed.length === 0) {
    lines.push(`No change in ${s.proof.measured} measured cases.`);
  }
  const proofLines = [];
  for (const c of diff.proof.changed) {
    proofLines.push(
      `- ${c.case} ${code(c.key)} (${c.verdictMoved ? `verdict ${c.verdictBase} → ${c.verdictHead}` : `verdict unchanged, ${c.verdictHead}`}): ${c.fields
        .map((f) => `${f.field} ${code(f.base)} → ${code(f.head)}`)
        .join("; ")}`,
    );
  }
  for (const l of limited(proofLines, 200)) lines.push(l);
  lines.push("");

  lines.push("## Verdict differential");
  lines.push("");
  const verdictLines = [];
  for (const c of diff.verdict.changed)
    verdictLines.push(
      `- ${c.intoNotAffected ? "**INTO NOT_AFFECTED** " : ""}${c.case} ${code(c.key)}: ${c.from} → ${c.to}`,
    );
  for (const c of diff.verdict.removed)
    verdictLines.push(
      `- **removed** (possible silent drop) ${c.case} ${code(c.key)}: was ${c.verdict}${c.nowUnreported.length > 0 ? `; now unreported: ${c.nowUnreported.map(code).join(", ")}` : "; not in unreportedCandidates either"}`,
    );
  for (const c of diff.verdict.added)
    verdictLines.push(`- added ${c.case} ${code(c.key)}: ${c.verdict}`);
  for (const c of diff.verdict.unreportedRemoved)
    verdictLines.push(`- unreported candidate removed ${c.case}: ${code(c.entry)}`);
  for (const c of diff.verdict.unreportedAdded)
    verdictLines.push(`- unreported candidate added ${c.case}: ${code(c.entry)}`);
  if (verdictLines.length === 0) {
    lines.push(`No change in ${s.verdict.measured} measured cases.`);
  }
  for (const l of limited(verdictLines, 200)) lines.push(l);
  lines.push("");

  lines.push("## Suite view (the suites' own selectors)");
  lines.push("");
  lines.push("```");
  lines.push(
    "CASE                      EXPECTED      BASE                HEAD                RESULT",
  );
  for (const row of diff.suite) {
    const result = `${row.base === row.expected ? "PASS" : "FAIL"}→${row.head === row.expected ? "PASS" : "FAIL"}${row.knownFailure ? " (known)" : ""}${row.moved ? "  MOVED" : ""}`;
    lines.push(
      row.case.padEnd(26) +
        String(row.expected).padEnd(14) +
        String(row.base).padEnd(20) +
        String(row.head).padEnd(20) +
        result,
    );
  }
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
