# VulnTrace — Software Design Document

**Version:** 0.6  
**Status:** Implementation-ready MVP specification  
**Project:** VulnTrace  
**Primary language:** TypeScript  
**Primary ecosystem:** JavaScript/TypeScript on Node.js

---

## 1. Executive Summary

VulnTrace is an open-source JavaScript/TypeScript vulnerability-specific
reachability and impact analysis engine.

Its primary question is:

> Given a specific vulnerability, can the vulnerable behavior actually be
> reached by the application code?

Traditional SCA primarily answers whether a vulnerable package/version is
present. Generic reachability can answer whether package code is reachable.
VulnTrace focuses one level deeper: the relationship between a specific
vulnerability and the code behavior responsible for that vulnerability.

The MVP combines:

- dependency intelligence;
- vulnerability intelligence;
- vulnerable-symbol rules;
- JavaScript/TypeScript semantic analysis;
- Node/TypeScript-aware module resolution;
- symbol binding;
- call graph construction;
- reachability;
- evidence generation;
- explicit uncertainty.

The MVP does **not** attempt automatic CVE-to-symbol inference. That is a later
research/product phase.

---

## 2. Product Thesis

For a finding to be useful to a developer, it should answer:

1. Which vulnerability?
2. Which dependency and version?
3. What behavior is vulnerable?
4. Which symbol(s) implement that behavior?
5. Is that symbol reachable by the application?
6. Through which path?
7. What evidence supports the conclusion?
8. What analysis limitations remain?

Core pipeline:

```text
CVE/GHSA
   |
   v
Affected Dependency
   |
   v
Vulnerability Behavior Model
   |
   v
Vulnerable Symbol(s)
   |
   v
Code Model
   |
   v
Call Graph
   |
   v
Reachability
   |
   v
Evidence
   |
   v
Verdict
```

---

## 3. Differentiation

VulnTrace must not be positioned as a generic replacement for every OWASP
dependency or reachability tool.

The relevant competitive reference is OWASP VulnReach, which already combines
software composition analysis, AST/call-graph style analysis, taint concepts,
HTTP route exposure, and optional runtime evidence, with JavaScript support
described as experimental.

VulnTrace differentiates by specializing the problem:

### 3.1 JavaScript/TypeScript first

The implementation prioritizes:

- npm;
- Node.js;
- ESM;
- CommonJS;
- TypeScript;
- package exports/imports;
- TypeScript path mapping;
- monorepos;
- multiple package versions.

### 3.2 Vulnerability-specific behavior

The core object is not merely:

```text
package + vulnerable version
```

but:

```text
vulnerability + vulnerable behavior + vulnerable symbol(s)
```

### 3.3 Explainable verdicts

Every verdict must have evidence.

### 3.4 First-class UNKNOWN

Static analysis must communicate uncertainty rather than silently producing
false negatives.

### 3.5 Future automatic symbol inference

A major future differentiator is:

```text
advisory
  -> security fix
  -> git diff
  -> AST diff
  -> changed symbols
  -> vulnerable behavior candidates
  -> reachability
```

This is intentionally outside the MVP.

### 3.6 Future: Multi-Language Architecture (explicitly not MVP)

VulnTrace's core domain model (dependency graph, vulnerability behavior,
call graph, reachability, verdict, evidence) is intentionally
language-agnostic; only the Code Intelligence domain (§10) is JS/TS-specific.

A future multi-language capability, if pursued, should follow a
thin-core-plus-analyzer-backend pattern:

- the core (dependency intelligence, vulnerability intelligence, graph,
  verdict, evidence, CLI/API) remains implementation-language-neutral and
  does not change per target language;
- each supported target language is analyzed by a dedicated backend that
  uses that language's own native parsing/resolution tooling (e.g. the
  TypeScript compiler API for JS/TS) rather than a reimplementation of that
  language's semantics;
- backends communicate with the core through a stable interface/protocol
  equivalent to the existing `ModuleResolver`/Code Intelligence boundary
  (§10, §16-17).

This avoids two known failure modes: fragmenting the evidence/verdict/JSON
output model per language, and reimplementing subtle language-specific
resolution semantics that are better sourced from each language's official
tooling (see ADR-0001, ADR-0006).

This is a future-research item, not an MVP goal — see §4 non-goals.

---

## 4. Goals

### MVP goals

- Parse project dependency metadata.
- Resolve installed dependency versions.
- Query OSV.
- Normalize vulnerability data.
- Match vulnerabilities to installed dependencies.
- Represent manually authored vulnerable-symbol rules.
- Parse JavaScript/TypeScript source.
- Resolve relevant imports/requires.
- Build a basic call graph.
- Determine reachability of known vulnerable symbols.
- Produce `AFFECTED`, `NOT_AFFECTED`, or `UNKNOWN`.
- Produce evidence and analysis coverage.
- Provide deterministic JSON output.
- Provide useful fixtures and end-to-end tests.

### Non-goals for MVP

- Runtime instrumentation.
- eBPF.
- Dynamic execution of target applications.
- Exploit generation.
- Automatic remediation.
- Multi-language analysis.
- Browser bundle analysis.
- Full taint analysis.
- LLM-dependent verdicts.
- Automatic inference of vulnerable symbols from every CVE.

---

## 5. Verdict Model

```text
AFFECTED
NOT_AFFECTED
UNKNOWN
```

### AFFECTED

The analyzer has sufficient evidence that the vulnerable behavior can be
reached from an analyzed application entrypoint.

### NOT_AFFECTED

The analyzer has sufficient evidence that the known vulnerable behavior is not
reachable and analysis coverage is adequate for that conclusion.

### UNKNOWN

The analyzer cannot safely establish either conclusion.

Examples:

- dynamic property access;
- unresolved module;
- unsupported language construct;
- incomplete project configuration;
- ambiguous symbol binding;
- analysis budget exceeded.

UNKNOWN must never be coerced into NOT_AFFECTED.

---

## 6. Evidence Model

Example:

```json
{
  "vulnerability": "GHSA-XXXX",
  "package": "foo",
  "version": "1.2.3",
  "verdict": "AFFECTED",
  "confidence": 0.94,
  "target": {
    "module": "foo/parser",
    "symbol": "parseUnsafe"
  },
  "path": [
    "src/routes/import.ts:18",
    "src/import.ts:42",
    "node_modules/foo/parser.js:87"
  ],
  "reasons": [
    "vulnerable symbol resolved",
    "symbol reachable from application entrypoint"
  ]
}
```

Evidence should prefer stable identifiers and source locations where available.

---

## 7. Confidence

Confidence is supporting metadata, not a replacement for verdict semantics.

Suggested interpretation:

- `1.00`: exact statically resolved path;
- `0.90-0.99`: strong path with minor uncertainty;
- `0.60-0.89`: partially resolved or heuristic path;
- `<0.60`: weak evidence, normally resulting in UNKNOWN.

The implementation may initially use categorical confidence levels or a
simple numeric score. The final API must be consistent.

---

## 8. Analysis Coverage

Every scan must report what was analyzed.

Example:

```json
{
  "files": 183,
  "modulesResolved": 176,
  "modulesUnresolved": 7,
  "functions": 4210,
  "callsResolved": 3850,
  "callsDynamic": 360
}
```

Coverage is essential because:

```text
NOT_AFFECTED + high coverage
```

means something different from:

```text
NOT_AFFECTED + large unresolved region
```

The verdict engine must take analysis blockers into account.

---

## 9. High-Level Architecture

```text
+-------------------------+
| CLI / API               |
+------------+------------+
             |
             v
+-------------------------+
| Scan Orchestrator       |
+------------+------------+
             |
     +-------+--------+
     |                |
     v                v
Dependency        Vulnerability
Intelligence      Intelligence
     |                |
     +-------+--------+
             |
             v
+-------------------------+
| Vulnerability Behavior  |
| Model / Symbol Rules    |
+------------+------------+
             |
             v
+-------------------------+
| JS/TS Code Intelligence |
+------------+------------+
             |
     +-------+--------+
     |                |
     v                v
Module Resolver    Symbol Binder
     |                |
     +-------+--------+
             |
             v
+-------------------------+
| Call Graph              |
+------------+------------+
             |
             v
+-------------------------+
| Reachability            |
+------------+------------+
             |
             v
+-------------------------+
| Evidence / Verdict      |
+-------------------------+
```

---

## 10. Domain Boundaries

### Dependency Intelligence

Responsible for:

- manifests;
- lockfiles;
- dependency graph;
- direct/transitive classification;
- package locations;
- PURLs.

### Vulnerability Intelligence

Responsible for:

- OSV queries;
- vulnerability normalization;
- affected version matching.

### Vulnerability Behavior

Responsible for:

- vulnerable symbol rules;
- future behavior inference;
- preconditions;
- vulnerability-specific targets.

### Code Intelligence

Responsible for:

- source parsing;
- AST/source index;
- imports/exports;
- symbols;
- calls;
- module resolution.

### Graph Analysis

Responsible for:

- call graph;
- entrypoints;
- reachability;
- uncertainty.

### Verdict

Responsible for:

- AFFECTED;
- NOT_AFFECTED;
- UNKNOWN;
- confidence;
- evidence;
- blockers.

---

## 11. Dependency Intelligence

### Inputs

- `package.json`;
- `package-lock.json`;
- optional CycloneDX SBOM.

### Output

```ts
interface DependencyNode {
  id: string;
  name: string;
  version: string;
  ecosystem: "npm";
  direct: boolean;
  locations: string[];
  dependencyPaths: string[][];
  purl?: string;
}
```

The graph must support multiple installed versions of the same package.

---

## 12. Vulnerability Intelligence

Initial provider:

- OSV.

Provider abstraction:

```ts
interface VulnerabilityProvider {
  queryPackage(input: {
    ecosystem: string;
    name: string;
    version?: string;
  }): Promise<RawVulnerability[]>;
}
```

Normalization:

```ts
interface Vulnerability {
  id: string;
  aliases: string[];
  package: string;
  ecosystem: string;
  affectedVersions: VersionRange[];
  fixedVersions: string[];
  references: VulnerabilityReference[];
  severity?: Severity;
}
```

The verdict engine must not depend directly on OSV-specific JSON.

---

## 13. Vulnerability Behavior Model

MVP rule:

```yaml
id: GHSA-fixture-0001

package:
  name: fixture-lib

targets:
  - module: fixture-lib
    export: vulnerable
    kind: function
    confidence: 1.0
```

Future model:

```json
{
  "id": "CVE-XXXX",
  "package": "foo",
  "symbols": [
    {
      "module": "foo/parser",
      "export": "parseUnsafe"
    }
  ],
  "conditions": [
    {
      "type": "user_controlled_argument",
      "argument": 0
    }
  ]
}
```

The model should remain extensible enough to add:

- function/method targets;
- class/constructor targets;
- module-level behavior;
- argument preconditions;
- data-flow requirements;
- environment preconditions.

---

## 14. Vulnerable Symbol Sources

### MVP

Manual rules.

### Future

1. advisory references;
2. repository discovery;
3. security fix identification;
4. git diff;
5. AST diff;
6. changed functions;
7. semantic behavior extraction;
8. candidate rule generation;
9. confidence scoring;
10. human review.

LLM assistance may generate candidates, but deterministic analysis must verify
the final target against the source code.

---

## 15. JavaScript/TypeScript Scope

Supported in MVP:

- `.js`;
- `.jsx`;
- `.mjs`;
- `.cjs`;
- `.ts`;
- `.tsx`;
- ESM;
- CommonJS;
- Node.js resolution;
- TypeScript configuration.

Important syntax/semantics:

- `import`;
- `export`;
- `require`;
- `module.exports`;
- `exports.foo`;
- destructuring;
- aliases;
- member access;
- direct calls;
- method calls;
- constructors;
- callbacks;
- async functions;
- `await`;
- TypeScript path aliases;
- package `exports`;
- package `imports`;
- conditional exports.

---

## 16. Module Resolver

Abstraction:

```ts
interface ModuleResolver {
  resolve(
    specifier: string,
    importer: SourceFile,
    options?: ResolveOptions
  ): Promise<ResolvedModule | ResolutionFailure>;
}
```

The implementation must follow Node.js/TypeScript semantics through supported
compiler/runtime APIs where practical rather than implementing a simplistic
string-based resolver.

Tests must cover:

- relative imports;
- package imports;
- package subpaths;
- `main`;
- `exports`;
- conditional exports;
- ESM/CJS boundaries;
- `tsconfig` path mappings.

---

## 17. Symbol Resolution

Examples that should converge on the same semantic target:

```ts
import { vulnerable as v } from "foo";
v();
```

```js
const { vulnerable } = require("foo");
vulnerable();
```

```js
const foo = require("foo");
foo.vulnerable();
```

```js
import foo from "foo";
foo.vulnerable();
```

Where exact semantics cannot be established, return uncertainty.

---

## 18. Call Graph

Nodes:

- functions;
- methods;
- constructors;
- callbacks;
- module-level executable regions where needed.

Edges:

- direct call;
- method call;
- constructor call;
- callback invocation;
- imported function invocation.

Dynamic constructs:

```js
foo[method]()
```

```js
require(variable)
```

```js
dynamicImport(variable)
```

must not produce fabricated exact edges.

---

## 19. Entrypoints

MVP supports:

- configured entrypoints;
- package `main`;
- executable CLI entrypoints;
- explicitly selected files.

Framework discovery is future work.

Potential future integrations:

- Express;
- Fastify;
- NestJS;
- Next.js;
- serverless;
- workers;
- queues;
- cron.

---

## 20. Reachability

API:

```ts
interface ReachabilityEngine {
  analyze(
    graph: CallGraph,
    source: GraphNode,
    target: GraphNode
  ): ReachabilityResult;
}
```

Possible states:

```ts
type ReachabilityState =
  | "reachable"
  | "unreachable"
  | "unknown";
```

The result must include:

- source;
- target;
- path if known;
- unresolved edges encountered;
- blockers;
- coverage.

---

## 21. Dynamic JavaScript

MVP does not execute target applications.

Examples:

```js
foo[method]()
```

```js
require(variable)
```

```js
eval(input)
```

```js
import(variable)
```

must be represented as uncertainty.

Example:

```json
{
  "state": "unknown",
  "reason": "dynamic_member_access",
  "potentialTargets": [
    "foo.parseUnsafe",
    "foo.parseSafe"
  ]
}
```

---

## 22. Data Flow

A full taint engine is out of scope for MVP.

However, the internal model should allow future data-flow edges.

Example future representation:

```text
HTTP body
  |
  v
parseInput()
  |
  v
foo.parseUnsafe(input)
```

This prepares the architecture for vulnerability preconditions.

---

## 23. Verdict Engine

Example logic:

```text
dependency vulnerable?
    NO -> no finding
    YES
      |
      v
vulnerable target known?
    NO -> UNKNOWN
    YES
      |
      v
target reachable?
    YES -> AFFECTED
    NO
      |
      v
coverage sufficient?
    YES -> NOT_AFFECTED
    NO  -> UNKNOWN
```

This logic must be deterministic.

---

## 24. JSON Output

Example:

```json
{
  "schemaVersion": "0.6",
  "scan": {
    "id": "scan-123",
    "project": "."
  },
  "findings": [
    {
      "vulnerability": "GHSA-fixture-0001",
      "package": "fixture-lib",
      "version": "1.0.0",
      "verdict": "AFFECTED",
      "confidence": 1,
      "target": {
        "module": "fixture-lib",
        "symbol": "vulnerable"
      },
      "evidence": {
        "path": [
          "src/index.ts:4",
          "node_modules/fixture-lib/index.js:10"
        ]
      }
    }
  ],
  "coverage": {
    "files": 4,
    "modulesResolved": 4,
    "modulesUnresolved": 0,
    "functions": 12,
    "callsResolved": 10,
    "callsDynamic": 1
  },
  "diagnostics": [],
  "timings": {
    "parsingMs": 12,
    "resolutionMs": 5,
    "graphConstructionMs": 18,
    "reachabilityMs": 1,
    "providerMs": 340,
    "cacheHits": 0,
    "cacheMisses": 1,
    "totalMs": 362
  }
}
```

`diagnostics` (TASK-026) explains blockers behind `coverage`'s aggregate
counts — unresolved entrypoints, unresolved/dynamic call-graph edges,
vulnerability records that failed to normalize — as
`{source, message}` entries; always present, possibly empty.

`timings` (TASK-030) records the per-phase instrumentation § 30
requires. `parsingMs` is derived (`graphConstructionMs - resolutionMs`),
not independently measured — parsing and resolution are interleaved
within call-graph construction with no clean seam to isolate parsing
alone; see `src/performance/timing.ts`.

---

## 25. CLI

Required commands:

```text
vulntrace scan <path>
vulntrace scan <path> --format json
vulntrace scan <path> --cve <id>
vulntrace rules validate <file>
vulntrace version
```

Exit codes:

- `0`: scan completed; no AFFECTED findings;
- `1`: one or more AFFECTED findings;
- `2`: configuration/usage error;
- `3`: analysis failure;
- `4`: provider/network failure where configured as fatal.

Exact policy is defined in implementation tasks.

---

## 26. Configuration

Example:

```yaml
project:
  root: .

analysis:
  entrypoints:
    - src/index.ts

  include:
    - src/**/*.ts
    - src/**/*.js

  exclude:
    - node_modules/**
    - dist/**
    - coverage/**

vulnerabilities:
  providers:
    - osv
  cache:
    enabled: true

rules:
  files:
    - rules/vulntrace-rules.yml

output:
  format: json
```

---

## 27. SBOM Boundary

SBOM ingestion is intentionally a boundary.

MVP:

- package-lock-derived dependency graph;
- optional CycloneDX input.

Future:

- SPDX;
- external SBOM repositories;
- CI artifact ingestion.

---

## 28. Cache and Reproducibility

Cache candidates:

- OSV responses;
- parsed source;
- module resolution;
- AST index;
- call graph;
- normalized dependency graph.

Cache keys must include relevant inputs and tool version.

The analyzer must support offline/reproducible operation where cached data is
available.

---

## 29. Security Requirements

The analyzer must not execute target code.

It must not:

- run `npm install` in target projects;
- execute lifecycle scripts;
- load arbitrary target modules;
- invoke application entrypoints;
- trust target project configuration blindly.

Future dynamic analysis must use an explicit sandbox architecture.

All external data must be parsed defensively.

---

## 30. Performance

Initial target:

- under 30 seconds for a medium Node.js project on cold cache.

No premature optimization.

Performance instrumentation must record:

- parsing time;
- resolution time;
- graph construction time;
- reachability time;
- provider time;
- cache hit/miss.

---

## 31. Testing Strategy

Tests:

- unit;
- integration;
- fixture;
- end-to-end;
- contract/schema;
- performance smoke.

Fixtures must cover:

1. direct ESM;
2. CommonJS;
3. alias;
4. destructuring;
5. transitive dependency;
6. unreachable target;
7. dynamic property access;
8. TypeScript path mapping;
9. package exports;
10. conditional exports;
11. multiple package versions.

---

## 32. MVP Vertical Slice

The minimum complete path is:

```text
package-lock.json
       |
       v
dependency graph
       |
       v
OSV
       |
       v
normalized vulnerability
       |
       v
manual vulnerable-symbol rule
       |
       v
JS/TS source model
       |
       v
module/symbol resolution
       |
       v
call graph
       |
       v
reachability
       |
       v
verdict
       |
       v
evidence + JSON
```

This vertical slice is more important than broad feature coverage.

---

## 33. Future Research: Automatic Vulnerable Behavior Inference

Potential pipeline:

```text
CVE/GHSA
   |
   v
Advisory references
   |
   v
Repository
   |
   v
Security fix commit
   |
   v
Git diff
   |
   v
AST diff
   |
   v
Changed functions
   |
   v
Behavior candidates
   |
   v
Candidate vulnerable symbols
   |
   v
Rule generation
   |
   v
Static verification
```

Possible use of an LLM:

- summarize security fix;
- propose candidate symbols;
- propose preconditions;
- propose test cases.

LLM output must be treated as untrusted candidate metadata until verified.

---

## 34. Product Metrics

The MVP should measure:

- vulnerable dependencies discovered;
- vulnerabilities with known targets;
- AFFECTED findings;
- NOT_AFFECTED findings;
- UNKNOWN findings;
- unresolved modules;
- unresolved symbols;
- dynamic calls;
- evidence completeness;
- analysis duration.

Future benchmark metrics:

- precision of AFFECTED;
- precision of NOT_AFFECTED;
- UNKNOWN rate;
- false-negative rate;
- time to analyze.

---

## 35. Definition of Done

MVP is done when:

1. CLI scans a real Node.js project.
2. package-lock is parsed.
3. OSV vulnerabilities are normalized.
4. a manually defined vulnerable symbol is resolved.
5. ESM and CommonJS fixtures pass.
6. call graph is generated.
7. reachable target produces AFFECTED.
8. unreachable target produces NOT_AFFECTED.
9. unresolved/dynamic target produces UNKNOWN.
10. every finding contains evidence.
11. coverage is reported.
12. JSON output validates against schema.
13. tests are deterministic.
14. target code is never executed.
15. documentation matches implementation.

---

## 36. Design Principles

```text
Evidence > Guessing
Precision > Number of Findings
UNKNOWN > False Certainty
Vulnerability-Specific Reachability > Package Reachability
Deterministic Verdicts > LLM Verdicts
Narrow MVP > Broad Unfinished Platform
```
