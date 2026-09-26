---
Date: 2026-09
Commit audited: 62b52b90cb5fead842534e1743519ca3da411945
Method: read-only; real scan pipeline (`runScanCommand`) with a synthetic
OSV provider; ground truth from real Node v22.11.0 run on the same
fixtures; 96/96 loud-fixture assertions passed
Findings registered in: `tests/validation/FINDINGS.md` (PRM-12 … PRM-38
FALSE; PRM-01 … PRM-10 are KNOWN aliases of AUD findings, recorded there;
PRM-11 is appended to RWF-047; PRM-40 … PRM-52 are TRUE and are not
findings)

No line-wrapping or transcription damage was found in this report on
review: its body is plain structured text and code listings, not a
box-drawing table, and it was pasted in intact.
---

VERDICT: CRITICAL_FINDINGS

I found 25 new false premises and reproduced each one through the real runScanCommand pipeline, checked against real node. 23 of them produce a false NOT_AFFECTED, and one (PRM-34) silently drops a vulnerable installed package from the report.

Checks behind this: all 96 fixture variants were regenerated from the single script in §4 and rerun, and all 96 loud-fixture assertions passed (0 failures). The main checkout is unchanged: git status is clean and HEAD is still 62b52b9.

---

1. VERDICT

CRITICAL_FINDINGS

2. STATE

- Commit audited: 62b52b90cb5fead842534e1743519ca3da411945. This is origin/main, which was equal to local main after git fetch origin --prune.
- Where I worked: I ran git worktree list first, then made a fresh local clone, detached at that commit, in /home/blackaichi/.claude/jobs/807a8c55/tmp/vt. I did not create a worktree. Its only change is an untracked node_modules symlink pointing to the main checkout's node_modules, used read-only.
- Nothing changed in the repository: nothing committed, pushed, branched on the remote, edited or turned into a PR. /data/workdir/claude/vulnTrace stays clean at 62b52b9.
- Existing worktrees untouched. A new worktree, scorecard-status-classifier, appeared during the run. It belongs to the other concurrent session, not me.
- Scratch files are in …/807a8c55/tmp/{repro,agentA,agentB}, all outside the repository.
- Two read-only background sweeps were delegated:
  - A: module-model.ts, CommonJS re-exports, export forwarding, resolver.
  - B: intake, cache, CLI, domain, dependencies.

  Nothing from them is marked FALSE here unless I reproduced it end to end myself.

3. PREMISE INVENTORY

Line numbers are at 62b52b9. Consequence abbreviations: FNA = false NOT_AFFECTED, FA = false AFFECTED.

ID: PRM-01
file:line: call-graph.ts:1879-1892 (doc 61-77)
Comment (verbatim, shortened): "Known ambient globals/builtins are the sole exception — they can never be a vulnerable-rule target"
Branch it justifies: a call rooted in a global name emits no edge
If false: FNA
Status: KNOWN AUD-01/02
Evidence: The check is by identifier text, so a local const JSON = {parse: lib.parse} is swallowed too. Same mechanism; not re-proved.
────────────────────────────────────────
ID: PRM-02
file:line: call-graph.ts:2158-2161
Comment (verbatim, shortened): (as PRM-01, for new)
Branch it justifies: new Promise(executor) / new Proxy(t, handler) emit no edge
If false: FNA
Status: KNOWN AUD-01
Evidence: —
────────────────────────────────────────
ID: PRM-03
file:line: osv-cache.ts:51-56
Comment (verbatim, shortened): "its shape is entirely controlled by VulnTrace itself"
Branch it justifies: cache entry trusted
If false: FNA
Status: KNOWN AUD-07
Evidence: —
────────────────────────────────────────
ID: PRM-04
file:line: osv-cache.ts:96-99
Comment (verbatim, shortened): "A cache hit never calls the wrapped provider at all, which is what makes repeated scans … reproducible"
Branch it justifies: cache hit reused forever
If false: missed advisories
Status: KNOWN AUD-06
Evidence: —
────────────────────────────────────────
ID: PRM-05
file:line: named-bindings.ts:1100
Comment (verbatim, shortened): "The refusal is NOT justified by 'a numeric key names no export'"
Branch it justifies: numeric-key refusal
If false: nil
Status: KNOWN RWF-046a/RWF-049
Evidence: Already corrected in code.
────────────────────────────────────────
ID: PRM-06
file:line: FINDINGS.md:15488
Comment (verbatim, shortened): "A non-identifier key resolves in NO position anywhere in the engine"
Branch it justifies: test-matrix framing
If false: nil
Status: KNOWN
Evidence: Superseded by named-bindings.ts:1106-1113.
────────────────────────────────────────
ID: PRM-07
file:line: version-matching.ts:17-25
Comment (verbatim, shortened): "semver (or semver-coercible …)… a GIT-type range … would be silently miscompared"
Branch it justifies: semver.coerce
If false: FNA
Status: KNOWN AUD-05/AUD-09
Evidence: —
────────────────────────────────────────
ID: PRM-08
file:line: version-matching.ts:86
Comment (verbatim, shortened): (uncommented) affectedVersions.length === 0 → not_affected
Branch it justifies: not_applicable
If false: drop
Status: KNOWN AUD-09
Evidence: —
────────────────────────────────────────
ID: PRM-09
file:line: osv-normalizer.ts:56
Comment (verbatim, shortened): (uncommented) id: z.string()
Branch it justifies: empty id accepted
If false: report fails
Status: KNOWN AUD-11
Evidence: —
────────────────────────────────────────
ID: PRM-10
file:line: scan.ts:1062
Comment (verbatim, shortened): (uncommented) exit 1 only when some finding is AFFECTED
Branch it justifies: exit code
If false: wrong exit
Status: KNOWN AUD-12
Evidence: —
────────────────────────────────────────
ID: PRM-11
file:line: commonjs-reexports.ts:120-121, 427-430
Comment (verbatim, shortened): "Property mutation (x.y = ...) is excluded: it changes the object, not the binding"
Branch it justifies: re-export origin ignores impl.run = danger
If false: FNA
Status: KNOWN RWF-047 (new surface)
Evidence: reexport-patched-sibling reproduces as FNA via the re-export path.
────────────────────────────────────────
ID: PRM-12
file:line: call-graph.ts:1963-1977, 2163-2168
Comment (verbatim, shortened): "a Node builtin (fs.readFile(...)…) is a known external runtime module, not uncertainty"
Branch it justifies: call or new whose callee is bound to a builtin emits no edge
If false: FNA
Status: FALSE
Evidence: builtin-callback
────────────────────────────────────────
ID: PRM-13
file:line: call-graph.ts:1403-1429, 1949-1961
Comment (verbatim, shortened): "is treated as invoking that argument, since that argument is unambiguously the only function value being handed to this call"
Branch it justifies: unattributable callee + one inline arrow → resolved edge to the arrow, displacing the unknown
If false: FNA
Status: FALSE
Evidence: inline-callback-displacement
────────────────────────────────────────
ID: PRM-14
file:line: call-graph.ts:1466-1477, 1495-1510 (used 2486-2507)
Comment (verbatim, shortened): "literal-vs-literal equality/inequality comparisons on numbers/strings"
Branch it justifies: ==/!= evaluated as ===/!==; branch pruned
If false: FNA
Status: FALSE
Evidence: loose-equality
────────────────────────────────────────
ID: PRM-15
file:line: call-graph.ts:1744-1748, also 1855-1868; loader-constructs.ts:1596-1611
Comment (verbatim, shortened): "A static require("literal") is import setup, already captured in the module model" / "a bundle that ships its own … function require(...) is calling its own definition … There
is no longer any name-based path"
Branch it justifies: static require("x") emits no edge; matched by text before the lexical authority runs
If false: FNA
Status: FALSE
Evidence: local-require-shadow
────────────────────────────────────────
ID: PRM-16
file:line: call-graph.ts:583-599, 691-702
Comment (verbatim, shortened): "same-file only … at the cost of only finding same-file callers" / "THE INVARIANT … only when EVERY authoritative call site is accounted for"
Branch it justifies: same-file call sites become the unique target of an exported higher-order parameter
If false: FNA
Status: FALSE
Evidence: higher-order-cross-file-callers
────────────────────────────────────────
ID: PRM-17
file:line: call-graph.ts:707-711 (and the invariant at 691-702)
Comment (verbatim, shortened): "No argument at this position means the parameter is undefined on that path … Such a site provably contributes no callable"
Branch it justifies: parameter reassignment inside the body is never checked
If false: FNA
Status: FALSE
Evidence: higher-order-reassigned-parameter (class C)
────────────────────────────────────────
ID: PRM-18
file:line: call-graph.ts:1530-1546
Comment (verbatim, shortened): "using the TypeScript type checker to determine the receiver's own apparent type"
Branch it justifies: static type used as the runtime receiver → resolved edge
If false: FNA
Status: FALSE
Evidence: checker-static-type-receiver (class B)
────────────────────────────────────────
ID: PRM-19
file:line: source-index.ts:280-285
Comment (verbatim, shortened): "an implicit constructor provably does nothing, and this entry can never acquire outgoing edges of its own"
Branch it justifies: derived-class default constructor node has no edge to super
If false: FNA
Status: FALSE
Evidence: implicit-super-constructor
────────────────────────────────────────
ID: PRM-20
file:line: symbol-binder.ts:364-367, 374-378 (and call-graph.ts:1658-1683)
Comment (verbatim, shortened): "A trailing property chain here (e.g. vulnerable.someMethod()) is a method call on the already-bound export's value … the chain is intentionally not consulted."
Branch it justifies: api.parse() → edge to api; lib.api.parse() → edge to api
If false: FNA
Status: FALSE
Evidence: named-binding-trailing-chain
────────────────────────────────────────
ID: PRM-21
file:line: loader-constructs.ts:806-812
Comment (verbatim, shortened): "A same-file const <name> = ... shadows the ambient global"
Branch it justifies: a whole-file const hides require/eval/process/module capabilities
If false: FNA (family A)
Status: FALSE
Evidence: wholefile-shadow-require-alias (class A)
────────────────────────────────────────
ID: PRM-22
file:line: local-aliases.ts:80-89; named-bindings.ts:13-15
Comment (verbatim, shortened): "the same acceptable imprecision resolveHigherOrderCallTarget … and findLocalFunctionNodeId already carry" / "sound enough for the loader constructs"
Branch it justifies: first-match, scope-blind alias lookup
If false: FNA
Status: FALSE
Evidence: Both cited precedents were removed as soundness defects; PRM-21 is the reproduction.
────────────────────────────────────────
ID: PRM-23
file:line: module-load-closure.ts:520-531; verdict.ts:1912-1916
Comment (verbatim, shortened): "traversal_truncated DOES NOT BLOCK either … a truncated closure is accompanied by a truncated graph and the correct guard engages anyway (verified directly)"
Branch it justifies: a truncated closure still allows families B/C
If false: FNA
Status: FALSE
Evidence: closure-truncation-hides-hook
────────────────────────────────────────
ID: PRM-24
file:line: module-load-closure.ts:196-198, 343-345; call-graph.ts:2219-2220, 2252-2254; loader set at loader-constructs.ts:57-65
Comment (verbatim, shortened): "builtin … not an uncertainty"
Branch it justifies: the cluster builtin is not a loader → closure complete
If false: FNA (A)
Status: FALSE (policy caveat in §4)
Evidence: cluster-fork
────────────────────────────────────────
ID: PRM-25
file:line: verdict.ts:1104-1113
Comment (verbatim, shortened): "A configured symbol narrows the root set … nothing to be incomplete about."
Branch it justifies: symbol root matched by node-name text; an unmatched symbol is still reported complete
If false: FNA and FA
Status: FALSE
Evidence: symbol-entry-unmaterialized, symbol-entry-name-match
────────────────────────────────────────
ID: PRM-26
file:line: module-model.ts:5992-6006
Comment (verbatim, shortened): "Dropping the fallback costs nothing that had provenance: every shape … now arrives here with a real localName"
Branch it justifies: index.functions.find(fn.name === localKey) takes the first match
If false: FNA
Status: FALSE
Evidence: export-map-first-match-class-method (class A)
────────────────────────────────────────
ID: PRM-27
file:line: module-model.ts:4732-4735, 4752, 4885-4886
Comment (verbatim, shortened): "Spread elements are skipped: their exported name cannot be determined statically" / "intentionally not unpacked"
Branch it justifies: a later string-key or getter override is ignored; the earlier value is still published
If false: FNA
Status: FALSE
Evidence: export-map-string-key-override, export-map-getter-override
────────────────────────────────────────
ID: PRM-28
file:line: module-model.ts:4684-4690
Comment (verbatim, shortened): "a same-file const binding initialized to one"
Branch it justifies: computed key resolved by first-match, scope-blind
If false: FNA
Status: FALSE
Evidence: export-map-computed-key-scope
────────────────────────────────────────
ID: PRM-29
file:line: module-model.ts:437-442, 536-540
Comment (verbatim, shortened): "last-write-wins map picks the last assignment in SOURCE order … Node's real semantics for straight-line module-scope code"
Branch it justifies: a deferred or configure-time write is ignored
If false: FNA
Status: FALSE
Evidence: export-map-configure-write (class C)
────────────────────────────────────────
ID: PRM-30
file:line: module-model.ts:5016-5031
Comment (verbatim, shortened): "the module's whole exported value comes from the ONE write that provably decides it"
Branch it justifies: literal unpacking wins over a later module.exports.run = …
If false: FNA
Status: FALSE
Evidence: export-map-literal-then-member-write
────────────────────────────────────────
ID: PRM-31
file:line: module-model.ts:5759-5764
Comment (verbatim, shortened): "an extra root can only make more code reachable"
Branch it justifies: a same-name decoy satisfies the root requirement
If false: FNA
Status: FALSE
Evidence: entry-root-decoy
────────────────────────────────────────
ID: PRM-32
file:line: module-model.ts:4506-4508 (and isCommonJsExportObject, ~5593-5623 per sweep A, line range not re-verified)
Comment (verbatim, shortened): "Every module.exports = X … write in the file"
Branch it justifies: this.run = … and const api = module.exports; api.run = … are invisible → zero roots, reported complete
If false: FNA
Status: FALSE
Evidence: entry-root-unseen-export-writes
────────────────────────────────────────
ID: PRM-33
file:line: module-resolver.ts:443-451; ts-project.ts:149-152
Comment (verbatim, shortened): "is what correctly handles package main, exports (including conditional exports …)" / "degrades to … best-effort defaults"
Branch it justifies: tsconfig module: commonjs → node10 resolution ignores exports
If false: FNA (A)
Status: FALSE
Evidence: tsconfig-commonjs-ignores-exports
────────────────────────────────────────
ID: PRM-34
file:line: package-lock.ts:56-60; dependency-graph.ts:167-172
Comment (verbatim, shortened): "npm always writes an explicit name for those" / "inherent to unversioned/local links"
Branch it justifies: a lock entry with no name and a non-node_modules path hits continue
If false: silent drop
Status: FALSE
Evidence: vendor-drop (real npm 10.9.0)
────────────────────────────────────────
ID: PRM-35
file:line: osv-cache.ts:55-57
Comment (verbatim, shortened): "losing it must never be able to abort an otherwise-successful scan"
Branch it justifies: only get() is guarded; a set() throw aborts
If false: wrong exit (4) / false diagnosis
Status: FALSE
Evidence: cache-set
────────────────────────────────────────
ID: PRM-36
file:line: scan.ts:882-899 (detail at 894-898)
Comment (verbatim, shortened): "no advisory was discovered for any sibling instance of this name"
Branch it justifies: the test reads the --cve-filtered list
If false: false reason
Status: FALSE
Evidence: versionless --cve
────────────────────────────────────────
ID: PRM-40
file:line: call-graph.ts:202-209
Comment (verbatim, shortened): "degrades gracefully … UNKNOWN over false certainty"
Branch it justifies: unreadable file → undefined
If false: FNA
Status: TRUE
Evidence: Covered twice: a call into it gets unresolved_target (1793-1802), and the closure records parse_failure, which blocks B/C (module-load-closure.ts:283-287, 587-589).
────────────────────────────────────────
ID: PRM-41
file:line: call-graph.ts:2222-2230
Comment (verbatim, shortened): "no edge is emitted for that specifier"
Branch it justifies: unpreparable target
If false: nil
Status: TRUE
Evidence: Same compensation as PRM-40; Node would also fail on an unreadable file.
────────────────────────────────────────
ID: PRM-42
file:line: call-graph.ts:344-354, 383-386, 405-410, 453-459
Comment (verbatim, shortened): re-export chase refusals (cycle, export *, .d.ts, own export)
Branch it justifies: return undefined
If false: —
Status: TRUE
Evidence: Each ends in an unresolved_target unknown edge (1793-1802).
────────────────────────────────────────
ID: PRM-43
file:line: call-graph.ts:617-643, 645-664, 742-749
Comment (verbatim, shortened): rest parameter, enclosing named function, non-identifier argument
Branch it justifies: refusals
If false: —
Status: TRUE
Evidence: Each ends in an unsupported unknown edge.
────────────────────────────────────────
ID: PRM-44
file:line: call-graph.ts:851-927
Comment (verbatim, shortened): last definition wins; spread/computed refuse; accessor counts
Branch it justifies: property lookup
If false: —
Status: TRUE
Evidence: Matches JavaScript object-literal semantics.
────────────────────────────────────────
ID: PRM-45
file:line: call-graph.ts:1141-1157
Comment (verbatim, shortened): "Thing() without new throws a TypeError"
Branch it justifies: class not callable
If false: —
Status: TRUE
Evidence: Refusal → unknown edge.
────────────────────────────────────────
ID: PRM-46
file:line: call-graph.ts:2404-2408
Comment (verbatim, shortened): "a field and an accessor are not pushed"
Branch it justifies: accessor bodies attributed to the enclosing owner
If false: —
Status: TRUE
Evidence: isFunctionLike (source-index.ts:807-822) excludes accessors, so this over-approximates.
────────────────────────────────────────
ID: PRM-47
file:line: loader-constructs.ts:1431-1437
Comment (verbatim, shortened): "Module(), module() … calling … throws"
Branch it justifies: no reason
If false: —
Status: TRUE
Evidence: node: all three throw TypeError.
────────────────────────────────────────
ID: PRM-48
file:line: loader-constructs.ts:1648-1654
Comment (verbatim, shortened): "Dynamic import() is always treated as uncertain"
Branch it justifies: widening
If false: —
Status: TRUE
Evidence: Fails closed.
────────────────────────────────────────
ID: PRM-49
file:line: reachability.ts:103-110
Comment (verbatim, shortened): "unreachable is only returned when … NO unresolved edges"
Branch it justifies: —
If false: —
Status: TRUE
Evidence: Code at 176-195.
────────────────────────────────────────
ID: PRM-50
file:line: verdict.ts:1122-1131
Comment (verbatim, shortened): "failing to parse it already records parse_failure"
Branch it justifies: incompleteness []
If false: —
Status: TRUE
Evidence: Closure catch at 283-287.
────────────────────────────────────────
ID: PRM-51
file:line: entrypoints.ts:180-183
Comment (verbatim, shortened): "Never throws … each failure becomes a diagnostic"
Branch it justifies: a missing configured entrypoint is dropped
If false: —
Status: TRUE (relative claim)
Evidence: entrypointRoots lists only the roots that exist.
────────────────────────────────────────
ID: PRM-52
file:line: call-graph.ts:1555-1558
Comment (verbatim, shortened): "both parses produce identical positions for identical syntax"
Branch it justifies: position bridge
If false: nil
Status: TRUE
Evidence: Same file text.
────────────────────────────────────────
ID: PRM-60
file:line: module-load-closure.ts:576-580
Comment (verbatim, shortened): non-widening reasons "could not load a new module even if it did"
Branch it justifies: not blocking
If false: FNA
Status: UNVERIFIED
Evidence: Settle with a differential of every unsupported_* subtype over loader-capable values.
────────────────────────────────────────
ID: PRM-61
file:line: export-forwarding.ts:92-113
Comment (verbatim, shortened): single "own" binding per name (first match) vs last-wins in mapExportsToFunctions
Branch it justifies: wrong hop
If false: FNA
Status: UNVERIFIED
Evidence: Measured at model level only (sweep A); needs a non-circular two-sibling fixture.
────────────────────────────────────────
ID: PRM-62
file:line: module-model.ts:5000-5011
Comment (verbatim, shortened): ESM local counted as provenance, with no reassignment refusal
Branch it justifies: stale let
If false: FNA
Status: UNVERIFIED
Evidence: End to end, even the positive control is UNKNOWN (ESM export {x} is not attributed today). The hazard appears once ESM attribution widens.
────────────────────────────────────────
ID: PRM-63
file:line: module-model.ts:4506 (bracket module["exports"])
Comment (verbatim, shortened): —
Branch it justifies: invisible whole-module write
If false: FNA
Status: UNVERIFIED
Evidence: Compensated: the closure flags loader_capability_escape → UNKNOWN.
────────────────────────────────────────
ID: PRM-64
file:line: package-instances.ts:659-662
Comment (verbatim, shortened): "they are still evaluated against whatever the siblings' queries return"
Branch it justifies: versionless instance
If false: drop
Status: UNVERIFIED
Evidence: Depends on OSV's per-version filtering (documented, not measurable offline).
────────────────────────────────────────
ID: PRM-65
file:line: osv-provider.ts:340-349
Comment (verbatim, shortened): "Only the outer envelope is validated"
Branch it justifies: next_page_token discarded
If false: drop
Status: UNVERIFIED
Evidence: Depends on OSV behaviour.
────────────────────────────────────────
ID: PRM-66
file:line: workspaces.ts:245-281
Comment (verbatim, shortened): malformed manifest → "not a package"
Branch it justifies: silent skip
If false: drop
Status: UNVERIFIED
Evidence: Sweep B; not run.
────────────────────────────────────────
ID: PRM-67
file:line: evidence.ts:302-309
Comment (verbatim, shortened): the "single source" of what the model leaves out
Branch it justifies: omits --import, --conditions
If false: false scope
Status: UNVERIFIED
Evidence: Disclosure claim.

4. FALSE-PREMISE DETAIL

How to reproduce everything

- Directory layout:
  - repro/ contains harness.ts, allcases.mjs and run-all.sh.
  - vt/ is the clone at 62b52b9, with node_modules.
- Commands: cd repro && ./run-all.sh > results.txt runs the 28 generated cases (96 variants). PRM-34 to PRM-36 have their own commands, given in their subsections.
- Pipeline: the harness calls the real runScanCommand (noCache: true) with a synthetic OSV provider. It returns one advisory for vuln-lib, SEMVER range introduced 0, fixed 99.0.0.
- Rules and config: rule target vuln-lib#parse, rule file rules.yml, config vulntrace.yml.
- Ground truth: real node v22.11.0, run on the same fixture.
- Loud-fixture assertion: before every scan, the harness requires the package and fails (exit 3) unless every bound name is a function. Result: 96/96 LOUD-OK.
- Controls: every case has a positive control (a direct call gives AFFECTED) and a negative control (no call to parse gives NOT_AFFECTED).

run-all.sh
#!/bin/sh
set -e
node allcases.mjs
for c in $(cat case-list.txt); do
  ../vt/node_modules/.bin/vite-node --root ../vt harness.ts -- "case-$c.json" 2>&1 | grep -v '^$'
done

harness.ts (complete)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { runScanCommand } from "../vt/src/cli/scan.ts";

interface Variant {
  readonly name: string;
  readonly files: Record<string, string>;
  readonly maxFiles?: number;
  readonly libFiles?: Record<string, string>;
  readonly groundTruthCmd?: readonly string[];
}
interface CaseSpec {
  readonly id: string; readonly libName: string; readonly libVersion: string;
  readonly libFiles: Record<string, string>; readonly targetExport: string;
  readonly boundNames: readonly string[]; readonly libIsEsm?: boolean;
  readonly entry: string | { file: string; symbol: string };
  readonly groundTruthCmd?: readonly string[]; readonly variants: readonly Variant[];
}
const spec: CaseSpec = JSON.parse(readFileSync(process.argv.at(-1)!, "utf8"));
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "cases", spec.id);

function writeProject(dir: string, v: Variant): void {
  rmSync(dir, { recursive: true, force: true });
  const w = (rel: string, content: string) => { const p = path.join(dir, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, content); };
  w("package.json", JSON.stringify({ name: "app", version: "1.0.0", dependencies: { [spec.libName]: spec.libVersion } }, null, 2));
  w("package-lock.json", JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "app", version: "1.0.0", dependencies: { [spec.libName]: spec.libVersion } },
    [`node_modules/${spec.libName}`]: { version: spec.libVersion } } }, null, 2));
  w(`node_modules/${spec.libName}/package.json`, JSON.stringify({ name: spec.libName, version: spec.libVersion, main: "index.js", ...(spec.libIsEsm ? { type: "module" } : {}) }, null, 2));
  for (const [rel, c] of Object.entries(v.libFiles ?? spec.libFiles)) w(`node_modules/${spec.libName}/${rel}`, c);
  for (const [rel, c] of Object.entries(v.files)) w(rel, c);
  w("rules.yml", `rules:\n  - id: GHSA-prm-${spec.id}\n    package:\n      name: ${spec.libName}\n    targets:\n      - module: ${spec.libName}\n        export: ${spec.targetExport}\n        kind: function\n        confidence: 1.0\n`);
  const ep = typeof spec.entry === "string" ? `    - ${spec.entry}\n` : `    - file: ${spec.entry.file}\n      symbol: ${spec.entry.symbol}\n`;
  const limits = v.maxFiles ? `  limits:\n    maxFiles: ${v.maxFiles}\n` : "";
  w("vulntrace.yml", `analysis:\n${limits}  entrypoints:\n${ep}rules:\n  files:\n    - rules.yml\n`);
}
async function scan(dir: string) {
  const out: string[] = []; const err: string[] = [];
  const exit = await runScanCommand({ projectPathArg: dir, noCache: true,
    provider: { queryPackage: (q) => Promise.resolve(q.name === spec.libName ? [{ id: `GHSA-prm-${spec.id}`, aliases: [],
      affected: [{ package: { ecosystem: "npm", name: spec.libName }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "99.0.0" }] }] }], references: [] }] : []) },
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) } });
  const json = JSON.parse(out.join("")); const f = json.findings[0]; const ev = f?.evidence ?? {};
  const family = ev.confirmedAbsentFromModuleLoadClosure ? "A" : ev.confirmedAbsentInstance ? "B" : ev.confirmedUnreachableTarget ? "C" : "-";
  return { exit, findings: json.findings.length, unreported: json.unreportedCandidates?.length ?? 0, verdict: f?.verdict, family,
    reasons: ev.reasons, unknownReasons: f?.unknownReasons?.map((u: { category: string; reason: string }) => `${u.category}/${u.reason}`), path: ev.path };
}
function groundTruth(dir: string, v: Variant): string {
  const entryFile = typeof spec.entry === "string" ? spec.entry : spec.entry.file;
  const cmd = v.groundTruthCmd ?? spec.groundTruthCmd ?? (typeof spec.entry === "string" ? ["node", entryFile]
    : ["node", "-e", `Promise.resolve(require('./${entryFile}').${spec.entry.symbol}()).catch(e=>console.log('threw',e.message))`]);
  try { return execFileSync(cmd[0]!, cmd.slice(1), { cwd: dir, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { const x = e as { stdout?: string; stderr?: string }; return `EXIT!=0 stdout=${x.stdout?.trim()} stderr=${x.stderr?.trim().split("\n")[0]}`; }
}
function assertLoud(dir: string): void {
  const probe = spec.libIsEsm
    ? `import('${spec.libName}').then(m=>{const miss=${JSON.stringify(spec.boundNames)}.filter(n=>typeof m[n]!=='function');if(miss.length){console.log('LOUD-FAIL',miss);process.exit(3)}console.log('LOUD-OK',Object.keys(m).sort().join(','))})`
    : `const m=require('${spec.libName}');const miss=${JSON.stringify(spec.boundNames)}.filter(n=>typeof m[n]!=='function');if(miss.length){console.log('LOUD-FAIL',miss);process.exit(3)}console.log('LOUD-OK',Object.keys(m).sort().join(','))`;
  const r = execFileSync("node", ["-e", probe], { cwd: dir, encoding: "utf8", env: { ...process.env, VT_SILENT: "1" } }).trim();
  console.log(`  loud-fixture: ${r.split("\n").at(-1)}`);
  if (!r.includes("LOUD-OK")) throw new Error("loud fixture assertion failed");
}
for (const v of spec.variants) {
  const dir = path.join(root, v.name); writeProject(dir, v);
  console.log(`== ${spec.id} / ${v.name}`); assertLoud(dir);
  console.log(`  analyzer: ${JSON.stringify(await scan(dir))}`);
  console.log(`  node ground truth: ${groundTruth(dir, v)}`);
}

allcases.mjs (complete). This file contains every fixture file's content.
import { writeFileSync } from "node:fs";
const HIT = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n`;
const PS = HIT + `function parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\n`;
const LIB = { "index.js": PS + `module.exports = { parse, safe };\n` };
const PT = PS + `function danger(x){ hit("run->danger"); return parse(x); }\n`;
const pt = (tail) => ({ "index.js": PT + tail });
const spec = (id, variants, extra = {}) => ({ id, libName: "vuln-lib", libVersion: "1.0.0", libFiles: LIB, targetExport: "parse",
  boundNames: ["parse", "safe"], entry: "src/index.js", variants, ...extra });
const v = (name, src, more = {}) => ({ name, files: { "src/index.js": src }, ...more });
const L = `const lib = require("vuln-lib");\n`;
const POS = v("positive-control", L + `lib.parse("x");\n`);
const NEG = v("negative-control", L + `lib.safe("x");\n`);
const cases = []; const add = (s) => cases.push(s);

add(spec("builtin-callback", [v("case", `const fs = require("fs");\n` + L + `fs.readFile(__filename, lib.parse);\n`), POS, NEG]));
add(spec("inline-callback-displacement", [
  v("case", L + `function pick() { return lib; }\npick().parse("x", () => 0);\n`),
  v("positive-control", L + `function pick() { return lib; }\npick();\nlib.parse("x", () => 0);\n`),
  v("negative-control", L + `function pick() { return lib; }\npick();\nlib.safe("x", () => 0);\n`)]));
add(spec("loose-equality", [
  v("case", L + `if (1 == "1") {\n  lib.parse("x");\n}\n`),
  v("positive-control", L + `if (1 === 1) {\n  lib.parse("x");\n}\n`),
  v("negative-control", L + `if (1 === 1) {\n  lib.safe("x");\n}\n`)]));
add(spec("tagged-template", [v("case", L + "lib.parse`x`;\n"), POS, NEG]));
add(spec("local-require-shadow", [
  v("case", "", { files: { "src/index.js": L + `function main() {\n  function require(name) { return lib.parse(name); }\n  return require("./util.js");\n}\nmain();\n`, "src/util.js": `module.exports = {};\n` } }),
  v("positive-control", "", { files: { "src/index.js": L + `function main() {\n  function load(name) { return lib.parse(name); }\n  return load("./util.js");\n}\nmain();\n`, "src/util.js": `module.exports = {};\n` } }),
  v("negative-control", "", { files: { "src/index.js": L + `function main() {\n  function require(name) { return lib.safe(name); }\n  return require("./util.js");\n}\nmain();\n`, "src/util.js": `module.exports = {};\n` } })]));
add(spec("implicit-method-invocation", [
  v("case-toString-coercion", L + `const o = { toString() { return lib.parse("x"); } };\nconst s = "" + o;\n`),
  v("case-thenable-await", L + `const t = { then(resolve) { resolve(lib.parse("x")); } };\nasync function run() { await t; }\nrun();\n`),
  v("case-iterator-for-of", L + `const it = { *[Symbol.iterator]() { yield lib.parse("x"); } };\nfor (const x of it) {}\n`),
  v("positive-control", L + `const o = { toString() { return "o"; } };\nconst s = "" + o;\nlib.parse("x");\n`),
  v("negative-control", L + `const o = { toString() { return lib.safe("x"); } };\nconst s = "" + o;\n`)]));
add(spec("implicit-super-constructor", [
  v("case", L + `class Base { constructor() { lib.parse("x"); } }\nclass Sub extends Base {}\nnew Sub();\n`),
  v("positive-control", L + `class Base { constructor() { lib.parse("x"); } }\nclass Sub extends Base {}\nnew Base();\n`),
  v("negative-control", L + `class Base { constructor() { lib.safe("x"); } }\nclass Sub extends Base {}\nnew Sub();\n`)]));
const HO = { "index.js": PS + `function each(fn, x) { return fn(x); }\nfunction init() { return each(safe, 1); }\nmodule.exports = { parse, safe, each, init };\n` };
add(spec("higher-order-cross-file-callers", [
  v("case", L + `lib.each(lib.parse, "x");\n`),
  v("contrast-no-same-file-caller", L + `lib.each(lib.parse, "x");\n`, { libFiles: { "index.js": PS + `function each(fn, x) { return fn(x); }\nfunction init() { return 1; }\nmodule.exports = { parse, safe, each, init };\n` } }),
  v("positive-control", L + `lib.each(lib.safe, "x");\nlib.parse("x");\n`),
  v("negative-control", L + `lib.each(lib.safe, "x");\n`)], { libFiles: HO, boundNames: ["parse", "safe", "each", "init"] }));
const HL = L + `function helper(x) { return lib.safe(x); }\n`;
add(spec("higher-order-reassigned-parameter", [
  v("case-default-by-or", HL + `function invoke(fn) { fn = fn || lib.parse; return fn("x"); }\ninvoke(helper);\ninvoke();\n`),
  v("case-plain-reassign", HL + `function invoke(fn) { fn = lib.parse; return fn("x"); }\ninvoke(helper);\n`),
  v("positive-control", HL + `function invoke(fn) { return fn("x"); }\ninvoke(helper);\nlib.parse("x");\n`),
  v("negative-control", HL + `function invoke(fn) { return fn("x"); }\ninvoke(helper);\n`)]));
const CK = L + `class Safe { run() { return lib.safe("x"); } }\nclass Danger { run() { return lib.parse("x"); } }\n`;
add(spec("checker-static-type-receiver", [
  v("case", CK + `let inst = new Safe();\nfunction swap() { inst = new Danger(); }\nswap();\ninst.run();\n`),
  v("positive-control", CK + `let inst = new Danger();\ninst.run();\n`),
  v("negative-control", CK + `let inst = new Safe();\ninst.run();\n`)]));
const API = { "index.js": PS + `function api(x){ hit("api"); return safe(x); }\napi.parse = parse;\nmodule.exports = { parse, safe, api };\n` };
add(spec("named-binding-trailing-chain", [
  v("case", `const { api } = require("vuln-lib");\napi.parse("x");\n`),
  v("case-whole-module-chain", L + `lib.api.parse("x");\n`),
  v("positive-control", `const { parse } = require("vuln-lib");\nparse("x");\n`),
  v("negative-control", `const { api } = require("vuln-lib");\napi("x");\n`)], { libFiles: API, boundNames: ["parse", "safe", "api"] }));
const SH = `function unrelated() { const require = (x) => x; return require; }\n`;
add(spec("wholefile-shadow-require-alias", [
  v("case", SH + `const r = require;\nconst name = ["vuln", "lib"].join("-");\nconst lib = r(name);\nlib.parse("x");\n`),
  v("contrast-no-shadow", `const r = require;\nconst name = ["vuln", "lib"].join("-");\nconst lib = r(name);\nlib.parse("x");\n`),
  v("positive-control", SH + L + `lib.parse("x");\n`),
  v("negative-control", SH + `const r = require;\nconst name = ["p", "ath"].join("");\nr(name);\n`)]));
const W = `const lib = require("vuln-lib");\nlib.parse("x");\nprocess.exit(0);\n`;
add(spec("cluster-fork", [
  v("case", "", { files: { "src/index.js": `const cluster = require("cluster");\nif (cluster.isPrimary) {\n  cluster.setupPrimary({ exec: __dirname + "/worker.js" });\n  cluster.fork();\n}\n`, "src/worker.js": W } }),
  v("contrast-child-process-fork", "", { files: { "src/index.js": `const cp = require("child_process");\ncp.fork(__dirname + "/worker.js");\n`, "src/worker.js": W } }),
  v("positive-control", "", { files: { "src/index.js": `require("./worker.js");\n`, "src/worker.js": W } }),
  v("negative-control", "", { files: { "src/index.js": `const cluster = require("cluster");\nif (cluster.isPrimary) {\n  cluster.setupPrimary({ exec: __dirname + "/worker.js" });\n}\n`, "src/worker.js": W } })]));
const TR = {
  "src/index.mjs": `import "./m.mjs";\n`,
  "src/m.mjs": `import "./a.cjs";\nexport * from "./r1.mjs";\nexport * from "./r2.mjs";\nexport * from "./r3.mjs";\nexport * from "./r4.mjs";\n`,
  "src/r1.mjs": `export const r1 = 1;\n`, "src/r2.mjs": `export const r2 = 2;\n`,
  "src/r3.mjs": `export const r3 = 3;\n`, "src/r4.mjs": `export const r4 = 4;\n`,
  "src/safe.cjs": `function parse(x) { return "local"; }\nmodule.exports = { parse };\n`,
  "src/hook.cjs": `const Module = require("module");\nconst orig = Module.prototype.require;\nModule.prototype.require = function (id) {\n  return orig.call(this, id === "./safe.cjs" ? "vuln-lib" : id);\n};\n`,
  "src/a.cjs": `require("./hook.cjs");\nconst lib = require("vuln-lib");\nlib.safe("x");\nconst s = require("./safe.cjs");\ns.parse("x");\n`,
};
const tv = (name, over = {}, maxFiles = 7) => ({ name, maxFiles, files: { ...TR, ...over } });
add(spec("closure-truncation-hides-hook", [
  tv("case"), tv("contrast-untruncated", {}, 10000),
  tv("positive-control", { "src/a.cjs": `require("./hook.cjs");\nconst lib = require("vuln-lib");\nlib.parse("x");\nconst s = require("./safe.cjs");\ns.parse("x");\n` }),
  tv("negative-control", { "src/hook.cjs": `const Module = require("module");\nconst orig = Module.prototype.require;\n` })], { entry: "src/index.mjs" }));
const SYM = { entry: { file: "src/index.js", symbol: "main" } };
add(spec("symbol-entry-unmaterialized", [
  v("case", L + `function run() { return lib.parse("x"); }\nmodule.exports = { main: run };\n`),
  v("positive-control", L + `function main() { return lib.parse("x"); }\nmodule.exports = { main };\n`),
  v("negative-control", L + `function main() { return lib.safe("x"); }\nmodule.exports = { main };\n`)], SYM));
add(spec("symbol-entry-name-match", [
  v("case", L + `function helper() { function main() { return 0; } return main; }\nfunction run() { return lib.parse("x"); }\nmodule.exports = { main: run, helper };\n`),
  v("case-false-affected", L + `function helper() { function main() { return lib.parse("x"); } return main; }\nfunction run() { return lib.safe("x"); }\nmodule.exports = { main: run, helper };\n`),
  v("positive-control", L + `function helper() { function inner() { return 0; } return inner; }\nfunction main() { return lib.parse("x"); }\nmodule.exports = { main, helper };\n`),
  v("negative-control", L + `function helper() { function main() { return 0; } return main; }\nfunction run() { return lib.safe("x"); }\nmodule.exports = { main: run, helper };\n`)], SYM));
const APP = { "src/index.js": L + `lib.run("x");\n` };
const pv = (name, tail) => ({ name, files: APP, libFiles: pt(tail) });
const PTC = [pv("positive-control", `module.exports = { parse, safe, run: danger };\n`), pv("negative-control", `module.exports = { parse, safe, run: safe };\n`)];
const ptBase = { boundNames: ["parse", "safe", "run"] };
for (const [id, tail] of Object.entries({
  "export-map-first-match-class-method": `class H { run(x) { return "decoy"; } }\nfunction run(x) { return danger(x); }\nmodule.exports = { parse, safe, run, H };\n`,
  "export-map-string-key-override": `module.exports = { parse, safe, run: safe, "run": danger };\n`,
  "export-map-getter-override": `module.exports = { parse, safe, run: safe, get run() { return danger; } };\n`,
  "export-map-computed-key-scope": `function helper() { const K = "other"; return K; }\nconst K = "run";\nmodule.exports = { parse, safe, run: safe, [K]: danger };\n`,
  "export-map-configure-write": `exports.parse = parse;\nexports.safe = safe;\nexports.configure = function () { exports.run = danger; };\nexports.run = safe;\nexports.configure();\n`,
  "export-map-literal-then-member-write": `module.exports = { parse, safe, run: safe };\nmodule.exports.run = danger;\n`,
  "export-map-bracket-module-exports": `module.exports = { parse, safe, run: safe };\nif (process.env.VT_NEVER_SET !== "1") module["exports"] = { parse, safe, run: danger };\n`,
})) add(spec(id, [pv("case", tail), ...PTC], ptBase));
const IMPL = `exports.run = function (x) { return "impl"; };\n`;
add(spec("reexport-patched-sibling", [
  { name: "case", files: APP, libFiles: { "impl.js": IMPL, "index.js": PT + `const impl = require("./impl");\nimpl.run = danger;\nexports.run = impl.run;\nexports.parse = parse;\nexports.safe = safe;\n` } },
  { name: "positive-control", files: APP, libFiles: { "impl.js": IMPL, "index.js": PT + `exports.run = danger;\nexports.parse = parse;\nexports.safe = safe;\n` } },
  { name: "negative-control", files: APP, libFiles: { "impl.js": IMPL, "index.js": PT + `const impl = require("./impl");\nexports.run = impl.run;\nexports.parse = parse;\nexports.safe = safe;\n` } }], ptBase));
const ENTRY_GT = { libFiles: pt(`module.exports = { parse, safe, run: danger };\n`), boundNames: ["parse", "safe", "run"], groundTruthCmd: ["node", "-e", "require('./src/index.js').run('x')"] };
add(spec("entry-root-decoy", [
  v("case", L + `class Cli { run() { return "decoy"; } }\nconst registry = { impl: function (u) { return lib.parse(u); } };\nexports.run = registry.impl;\n`),
  v("contrast-no-decoy", L + `const registry = { impl: function (u) { return lib.parse(u); } };\nexports.run = registry.impl;\n`),
  v("positive-control", L + `class Cli { run() { return "decoy"; } }\nexports.run = function (u) { return lib.parse(u); };\n`),
  v("negative-control", L + `class Cli { run() { return "decoy"; } }\nconst registry = { impl: function (u) { return lib.safe(u); } };\nexports.run = registry.impl;\n`)], ENTRY_GT));
add(spec("entry-root-unseen-export-writes", [
  v("case-this", L + `function run(u) { return lib.parse(u); }\nthis.run = run;\n`),
  v("case-exports-alias", L + `function run(u) { return lib.parse(u); }\nconst api = module.exports;\napi.run = run;\n`),
  v("positive-control", L + `function run(u) { return lib.parse(u); }\nexports.run = run;\n`),
  v("negative-control", L + `function run(u) { return lib.safe(u); }\nexports.run = run;\n`)], ENTRY_GT));
const WRAP = {
  "node_modules/wrap/package.json": JSON.stringify({ name: "wrap", version: "1.0.0", main: "./legacy.js", exports: { ".": { require: "./cjs/impl.cjs" } } }),
  "node_modules/wrap/legacy.js": `exports.run = function (x) { return "legacy"; };\n`,
  "node_modules/wrap/cjs/impl.cjs": `const lib = require("vuln-lib");\nexports.run = function (x) { return lib.parse(x); };\n`,
  "src/index.js": `const w = require("wrap");\nw.run("x");\n` };
const TSC = { "tsconfig.json": `{"compilerOptions":{"module":"commonjs","allowJs":true}}` };
add(spec("tsconfig-commonjs-ignores-exports", [
  { name: "case", files: { ...WRAP, ...TSC } }, { name: "contrast-no-tsconfig", files: { ...WRAP } },
  { name: "positive-control", files: { ...WRAP, ...TSC, "src/index.js": L + `lib.parse("x");\n` } },
  { name: "negative-control", files: { ...WRAP, ...TSC, "node_modules/wrap/cjs/impl.cjs": `exports.run = function (x) { return "impl"; };\n` } }]));
add(spec("esm-let-reassigned-export", [
  { name: "case", files: { "src/index.mjs": `import { run } from "vuln-lib";\nrun("x");\n` }, libFiles: pt(`let run = safe;\nrun = danger;\nexport { parse, safe, run };\n`) },
  { name: "positive-control", files: { "src/index.mjs": `import { run } from "vuln-lib";\nrun("x");\n` }, libFiles: pt(`const run = danger;\nexport { parse, safe, run };\n`) },
  { name: "negative-control", files: { "src/index.mjs": `import { run } from "vuln-lib";\nrun("x");\n` }, libFiles: pt(`const run = safe;\nexport { parse, safe, run };\n`) }],
  { libIsEsm: true, entry: "src/index.mjs", boundNames: ["parse", "safe", "run"] }));
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

Results for the generated cases

All figures are measured. Case columns show analyzer result, then node ground truth. Controls show analyzer result only.

┌──────────┬──────────────────────────────────────────────────────────┬─────────────────────────┬──────────────┬────────────────┬─────────────────────────────────────────────────────────────────────────┐
│   PRM    │                     Case → analyzer                      │    node ground truth    │  Positive    │   Negative     │                                Contrast                                 │
│          │                                                          │                         │   control    │    control     │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 12       │ builtin-callback → NOT_AFFECTED C, exit 0                │ CALLED parse            │ AFFECTED,    │ NOT_AFFECTED C │ —                                                                       │
│          │                                                          │                         │ exit 1       │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 13       │ inline-callback-displacement → NOT_AFFECTED C            │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 14       │ loose-equality → NOT_AFFECTED C                          │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 15       │ local-require-shadow → NOT_AFFECTED C                    │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 16       │ higher-order-cross-file-callers → NOT_AFFECTED C         │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ no same-file caller → UNKNOWN unsupported_callee_binding                │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 17       │ reassigned-parameter, both variants → NOT_AFFECTED C     │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 18       │ checker-static-type-receiver → NOT_AFFECTED C            │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 19       │ implicit-super-constructor → NOT_AFFECTED C              │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 20       │ trailing-chain: api.parse() and lib.api.parse() →        │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
│          │ NOT_AFFECTED C                                           │                         │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 21/22    │ wholefile-shadow → NOT_AFFECTED A                        │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED A │ no shadow → UNKNOWN capability_escape/aliased_require                   │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 23       │ closure-truncation (maxFiles: 7) → NOT_AFFECTED C        │ CALLED safe, CALLED     │ AFFECTED     │ NOT_AFFECTED   │ maxFiles 10000 → UNKNOWN loader_hook_mutation, module_internal_load     │
│          │                                                          │ parse                   │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 24       │ cluster-fork → NOT_AFFECTED A                            │ CALLED parse (forked    │ AFFECTED     │ NOT_AFFECTED A │ child_process.fork → UNKNOWN child_process_execution                    │
│          │                                                          │ worker)                 │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 25       │ symbol unmaterialized → NOT_AFFECTED C                   │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ name-match → NOT_AFFECTED C (CALLED parse); case-false-affected →       │
│          │                                                          │                         │              │                │ AFFECTED while node calls only safe                                     │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 26       │ first-match class method → NOT_AFFECTED C                │ CALLED run->danger,     │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
│          │                                                          │ CALLED parse            │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 27       │ string-key override and getter override → NOT_AFFECTED C │ CALLED run->danger,     │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
│          │                                                          │ CALLED parse            │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 28       │ computed-key scope → NOT_AFFECTED C                      │ CALLED run->danger,     │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
│          │                                                          │ CALLED parse            │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 29       │ configure write → NOT_AFFECTED C                         │ CALLED run->danger,     │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
│          │                                                          │ CALLED parse            │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 30       │ literal then member write → NOT_AFFECTED C               │ CALLED run->danger,     │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
│          │                                                          │ CALLED parse            │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 31       │ entry-root-decoy → NOT_AFFECTED C                        │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ no decoy → UNKNOWN entrypoint_root_incomplete                           │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 32       │ this.run and api = module.exports → NOT_AFFECTED C       │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 33       │ tsconfig commonjs → NOT_AFFECTED A                       │ CALLED parse            │ AFFECTED     │ NOT_AFFECTED A │ no tsconfig → AFFECTED                                                  │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ 11       │ reexport-patched-sibling → NOT_AFFECTED C                │ CALLED run->danger,     │ AFFECTED     │ NOT_AFFECTED   │ —                                                                       │
│ (KNOWN)  │                                                          │ CALLED parse            │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ n/r      │ bracket module["exports"] → UNKNOWN (closure flags       │ —                       │ —            │ —              │ not a false premise end to end                                          │
│          │ loader_capability_escape)                                │                         │              │                │                                                                         │
├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┼──────────────┼────────────────┼─────────────────────────────────────────────────────────────────────────┤
│ n/r      │ esm-let → UNKNOWN in every variant                       │ —                       │ —            │ —              │ the controls are invalid, so no conclusion                              │
└──────────┴──────────────────────────────────────────────────────────┴─────────────────────────┴──────────────┴────────────────┴─────────────────────────────────────────────────────────────────────────┘

Reachability today: every row above is reachable on main in the default configuration, except PRM-23, which needs analysis.limits.maxFiles set low relative to project size, and PRM-33, which needs a tsconfig with module: commonjs or equivalent node10 resolution.

Policy caveat on PRM-24: SUPPORTED_MODEL_EXCLUSIONS item 6 ("execution that begins somewhere other than the configured entrypoints") could be read to cover cluster workers. But child_process.fork of the same worker is treated as widening, so the model is inconsistent either way. Deciding which reading is intended is a policy call.

Existing tests:
- Three tests pin the false premise as the expected result, which AGENTS §G forbids:
  - PRM-20 is pinned by symbol-binder.test.ts:166 ("ignores a trailing method chain").
  - PRM-23 is pinned by verdict.negative-proof.test.ts:321 "case 10b", whose comment restates the false claim.
  - PRM-13 is pinned by call-graph.test.ts VT-213 "someUtterlyArbitraryMethodName", where the receiver obj is a parameter.
- Tests touch the mechanism but not the failing shape:
  - PRM-12: call-graph.test.ts:274 (builtins with no callback) and :380 (inline callback only).
  - PRM-16/17: the VT-210 suites.
  - PRM-18: VT-208.
  - PRM-19: source-index.test.ts:186.
  - PRM-25: VT-205 tests.
- I found no test for PRM-14, 15, 21, 24, 27–33, or tagged templates / implicit protocols.

PRM-34: silent drop (real npm lockfile)

D=…/repro/cases/vendor-drop; mkdir -p $D/case/vendor/lodash $D/case/src; cd $D/case
echo '{"name":"app","version":"1.0.0","dependencies":{"lodash":"file:vendor/lodash"}}' > package.json
echo '{"name":"lodash","version":"4.17.20","main":"index.js"}' > vendor/lodash/package.json
printf 'function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\nfunction parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\nmodule.exports = { parse, safe };\n' > vendor/lodash/index.js
printf 'const lib = require("lodash");\nlib.parse("x");\n' > src/index.js
printf 'analysis:\n  entrypoints:\n    - src/index.js\n' > vulntrace.yml
npm install --offline --no-audit --no-fund        # npm 10.9.0
cp -r $D/case $D/control-explicit-name            # then set packages["vendor/lodash"].name = "lodash"
cd …/repro && ../vt/node_modules/.bin/vite-node --root ../vt vendor.ts
The lockfile npm wrote contains "vendor/lodash": { "version": "4.17.20" } with no name, plus "node_modules/lodash": { "resolved": "vendor/lodash", "link": true }.

vendor.ts:
import { execFileSync } from "node:child_process";
import { runScanCommand } from "../vt/src/cli/scan.ts";
const adv = { id: "GHSA-prm-vendor", aliases: [], affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }], references: [] };
for (const v of ["case", "control-explicit-name"]) {
  const dir = `cases/vendor-drop/${v}`; const queried: string[] = []; const out: string[] = []; const err: string[] = [];
  const exit = await runScanCommand({ projectPathArg: dir, noCache: true, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    provider: { queryPackage: (q) => { queried.push(`${q.name}@${q.version}`); return Promise.resolve(q.name === "lodash" ? [adv] : []); } } });
  const j = JSON.parse(out.join(""));
  const loud = execFileSync("node", ["-e", "const m=require('lodash');const miss=['parse','safe'].filter(n=>typeof m[n]!=='function');if(miss.length){console.log('LOUD-FAIL',miss);process.exit(3)}console.log('LOUD-OK',Object.keys(m).join(','), require('lodash/package.json').version)"], { cwd: dir, encoding: "utf8", env: { ...process.env, VT_SILENT: "1" } }).trim();
  console.log(v, loud, queried, exit, JSON.stringify(j.findings.map((f: any) => [f.vulnerability, f.version, f.verdict])), JSON.stringify(j.unreportedCandidates), JSON.stringify(err.join("")), execFileSync("node", ["src/index.js"], { cwd: dir, encoding: "utf8" }).trim());
}

┌───────────────────────┬────────────────────────────┬────────────────────┬──────┬───────────────────────────────────────────────┬──────────────────────┬────────┬───────────────────┐
│        Variant        │        loud-fixture        │      queried       │ exit │                   findings                    │ unreportedCandidates │ stderr │ node ground truth │
├───────────────────────┼────────────────────────────┼────────────────────┼──────┼───────────────────────────────────────────────┼──────────────────────┼────────┼───────────────────┤
│ case                  │ LOUD-OK parse,safe 4.17.20 │ []                 │ 0    │ []                                            │ []                   │ ""     │ CALLED parse      │
├───────────────────────┼────────────────────────────┼────────────────────┼──────┼───────────────────────────────────────────────┼──────────────────────┼────────┼───────────────────┤
│ control-explicit-name │ —                          │ ["lodash@4.17.20"] │ 0    │ [GHSA-prm-vendor, 4.17.20, UNKNOWN (no rule)] │ —                    │ —      │ —                 │
└───────────────────────┴────────────────────────────┴────────────────────┴──────┴───────────────────────────────────────────────┴──────────────────────┴────────┴───────────────────┘

A negative control does not apply here, because the finding is the drop itself. Reachable on main: yes, for any file: dependency whose folder name equals its package name. No test covers it.

PRM-35: cache write aborts the scan

- Case: agentB/confirm-cache-set.ts runs runScanCommand with cacheDir pointing under a regular file (agentB/not-a-dir, empty) and a provider that returns [].
  - Result: exit 4, stderr vulnerability provider failure for foo@1.0.0: ENOTDIR … mkdir …/not-a-dir/osv.
- Control (cache-control.ts, identical except for a writable cacheDir): exit 0, empty stderr.
- Impact: the scan is aborted with a false diagnosis. No verdict is involved.

PRM-36: false reason under --cve

- Fixture agentB/versionless:
  - root {"name":"root","private":true,"workspaces":["packages/*"]}
  - packages/foo/package.json {"name":"foo"}
  - packages/app/package.json {"name":"app","version":"1.0.0","dependencies":{"bar":"1.0.0"}}
  - lockfile entries: node_modules/app → packages/app (link), node_modules/foo → packages/foo (link), node_modules/bar@1.0.0, node_modules/bar/node_modules/foo@1.0.0, packages/app@1.0.0, packages/foo:{}
- Provider: GHSA-x (alias CVE-X, foo, 0–2.0.0) and GHSA-y (alias CVE-Y, 3.0.0–3.1.0), filtered by the queried version.
- Control (no filter): queried foo@1.0.0; findings GHSA-x for both foo instances.
- Case (--cve CVE-Y): the unreported candidate for packages/foo says "no advisory was discovered for any sibling instance". False: GHSA-x was discovered.

5. UNCOMMENTED FAIL-OPEN BRANCHES in src/code-intelligence/

Each entry names the construct, what it emits, whether anything compensates, and my assessment. Every emission and non-emission of an edge happens in call-graph.ts, which I read in full. walkFile (2423-2524) classifies only CallExpression and NewExpression.

1. call-graph.ts:2466-2484, tagged template (tag\x`): no edge. Not compensated. **Reproduced as a family-C false NOT_AFFECTED** (tagged-template`).
2. Same site, implicit protocol calls:
   - The methods invoked are pushed as their own nodes, but nothing gets an edge to them.
   - Reproduced as false NOT_AFFECTED:
     - toString/valueOf/Symbol.toPrimitive via coercion;
     - then via await or promise resolution;
     - [Symbol.iterator] via for…of (the same applies to spread, destructuring, yield* and Array.from).
   - Not reproduced, same mechanism:
     - a getter defined as a function expression (Object.defineProperty(o,k,{get: function(){}}));
     - Symbol.hasInstance;
     - Symbol.asyncIterator;
     - Proxy handler traps (also PRM-02);
     - toJSON (reached through a global).
3. source-index.ts:280-285, used at call-graph.ts:1101-1110: a derived class's implicit constructor node has no edge to super() (PRM-19, reproduced).
4. Same site, decorators (@dec class X {}): no edge. UNVERIFIED, because Node 22 does not run decorators natively.
5. Same site, JSX elements: no edge. UNVERIFIED (the framework calls the component).
6. call-graph.ts:2486-2507, constant if: the pruned branch emits nothing. Commented (PRM-14). The premise fails for ==/!= across types.
7. call-graph.ts:1744-1748: static require (PRM-15).
8. call-graph.ts:1889-1892 and 2158-2161: known globals (KNOWN AUD-01/02). Also text-based, so a lexically shadowed global name is swallowed.
9. call-graph.ts:1975-1977 and 2166-2168: builtin (PRM-12). The new form was not reproduced separately (e.g. new stream.Readable({ read(){…} })).
10. call-graph.ts:2252-2254: builtin specifier, no module_load edge (PRM-24).
11. call-graph.ts:2284-2288: target not preparable. Compensated (PRM-41).
12. call-graph.ts:2466-2468: from undefined. Nil: the stack always holds the module node.
13. call-graph.ts:2704-2707: the limit break. Compensated: scan.ts:607 counts registered files, which are ≥ walked files.
14. Resolved-edge displacement. These emit a wrong resolved edge instead of the unknown one, which is equivalent for family C:
    - 1953-1961 inline callback (PRM-13);
    - 1916-1931 VT-210 (PRM-16, PRM-17);
    - 1899-1909 VT-208 (PRM-18);
    - 1756-1772 via bindCallee chain truncation (PRM-20);
    - every export → node lookup built from mapExportsToFunctions at 239-244 (PRM-26 to PRM-30);
    - 1869-1877 by way of the ladder's text-matched require.
15. loader-constructs.ts returning undefined: no widening reason, so the closure is complete (PRM-21, PRM-24). Its full escape machinery (1760-3142) was not read by me (see §7).

Gaps in this inventory. It is exhaustive for the emitting code (call-graph.ts). It is not exhaustive for which ECMAScript semantics invoke user code implicitly. I enumerated the protocol list above but did not systematically check:
- with
- arguments aliasing
- Function.prototype.call.call chains
- Reflect.apply/construct (a global, so the PRM-01 branch)
- FinalizationRegistry
- Atomics.waitAsync
- Error.prepareStackTrace (assigning to a global)

6. SUSPICIONS (not reproduced)

- Export forwarding picks the first matching binding while the export map picks the last (PRM-61). Would settle: a two-sibling fixture with no circular load.
- ESM reassigned let export (PRM-62). Would settle: rerun once ESM export {x} attribution exists.
- Scope-blind alias lookup in resolveWholeModuleBuiltin (loader-constructs.ts:162). Same mechanism as PRM-21, for vm/child_process aliases. Would settle: function a(){const v=1} const v=require("vm"); … v.runInThisContext(src).
- Getter defined via Object.defineProperty(…, {get: function(){…}}) is fail-open. Would settle: a harness case.
- Implicit super with explicit field initializers: over-approximation only; assessed as safe.
- module-resolver.ts attemptSiblingRuntimeFile ignores exports (sweep A: unclear).
- Versionless instance and OSV filtering (PRM-64), pagination (PRM-65), malformed workspace manifest (PRM-66): each needs OSV behaviour or a filesystem fixture.
- Nameless workspace identified by its basename (sweep B S7, scan.ts:470-472): no verdict-changing path found.
- --cve behaviours: an empty value is accepted, matching is case-sensitive, and a filter that matches nothing gives an empty report with exit 0 and no signal (likely AUD-16 family).
- SUPPORTED_MODEL_EXCLUSIONS omits --conditions (PRM-67). Would settle: a fixture with a custom condition that selects a different file.

7. COVERAGE

- Exhausted, read by me:
  - code-intelligence/call-graph.ts, symbol-binder.ts, local-aliases.ts
  - analysis/reachability.ts, analysis/entrypoints.ts, analysis/module-load-closure.ts
- Partial, read by me:
  - loader-constructs.ts: lines 1-1760 read; 1760-3142 not read.
  - named-bindings.ts: lines 1-980 read; 980-1397 not read.
  - source-index.ts: about 15% read (isFunctionLike, the implicit-constructor block, error paths).
  - verdict.ts: lines 1040-1300 and 1650-1930 read.
  - cache/osv-cache.ts: lines 40-130 read.
  - cli/scan.ts: lines 60-140, 560-640 and 880-900 read.
- Swept by delegated sweep A (every FALSE listed from it was reproduced by me):
  - Read in full: commonjs-reexports.ts, export-forwarding.ts, package-entry.ts, module-resolver.ts, unsupported-construct.ts, ts-project.ts.
  - module-model.ts: 1-2600 and 4400-6104 full; 2600-3440 code only; 3440-4400 skimmed.
- Swept by delegated sweep B (FALSE items reproduced by me; KNOWN mapping spot-checked):
  - Read in full: vulnerabilities/*, cache/osv-cache.ts, cli/{scan,output,run,args}.ts, domain/{evidence,uncertainty,verdict,vulnerability,target}.ts, dependencies/*, rules/*.
  - Partial: domain/resolved-target.ts, cli/html-report.ts, domain/graph.ts.
- Not reached:
  - analysis/analysis-context.ts, analysis/scan-caches.ts, analysis/uncertainty.ts
  - verdict.ts 1-1040 and 1930-2086
  - the rest of html-report.ts and graph.ts
  - domain/{coverage,entrypoint}.ts
  - cli/{rules-validate,io,version,errors}.ts
  - all index.ts files

8. INPUT FOR THE NEXT FIXES

Call-graph fix (AUD-01/02 and the fail-open inventory):
- PRM-12 (builtin callee), PRM-24 (builtin loaders, e.g. cluster).
- PRM-13 (inline-callback displacement), PRM-15 (text-matched require).
- PRM-16 and PRM-17 (VT-210 invariant), PRM-18 (VT-208 static types), PRM-19 (implicit super).
- PRM-20 (chain truncation in bindCallee).
- PRM-21/22 (whole-file shadow in the loader classifier).
- PRM-23 (closure truncation not blocking C).
- PRM-25 (symbol roots by name).
- PRM-26 to PRM-32 (export map and root derivation).
- Fail-open items 1, 2 and 6 in §5.
- The three pinned tests in §4 must change together with their fixes.

Intake and cache (AUD-05/06/07/09/10/11/14):
- PRM-34 (lockfile name omission → silent drop). The highest-priority intake item.
- PRM-35 (cache write aborts the scan; adjacent to AUD-07).
- PRM-36 (--cve false reason).
- PRM-33 (resolver ignores exports under node10; affects which file is "installed code").
- Suspicions PRM-64, 65, 66, 67.

9. PROPOSED TASKS (not implemented)

- PRM-12, builtin callee is not uncertainty. A builtin-bound call or new that receives a function-valued argument, or any argument the analyzer cannot prove non-callable, must emit an unknown edge (or a resolved callback edge when the argument resolves) rather than nothing. Keep the no-edge path only for builtin calls with no possibly-callable argument. Failing-first test: builtin-callback.
- PRM-13, inline callback must not displace the callee. When the callee is unattributable, emit the callee's unknown edge in addition to the resolved callback edge. Failing-first test: inline-callback-displacement. Fix the pinned VT-213 test.
- PRM-14, constant folding. Restrict evaluateConstantBoolean to ===/!== or to same-type operands. Otherwise return undefined for ==/!=. Test: loose-equality.
- PRM-15, lexical require. Make isStaticRequireCall (and the source-index import extraction) require that require resolves to no lexical declaration. A shadowed require(...) must go through the ordinary callee ladder. Test: local-require-shadow.
- PRM-16, VT-210 exported functions. Refuse higher-order resolution when the enclosing function escapes the file (exported, assigned, or passed as a value), because importers' call sites are unaccounted for. Test: higher-order-cross-file-callers.
- PRM-17, VT-210 reassigned parameter. Refuse when the parameter name is assigned anywhere in its function (isAssignedWithin). Test: higher-order-reassigned-parameter.
- PRM-18, VT-208 static types. Accept a checker-derived receiver only when the receiver binding is provably single-valued (a const initialized by new C(), never reassigned). Otherwise emit unknown. Test: checker-static-type-receiver.
- PRM-19, implicit derived constructor. For a class with an extends clause and no explicit constructor, the synthesized node must get an edge to the resolved base constructor, or an unknown edge when the base is unresolvable. Test: implicit-super-constructor.
- PRM-20, trailing chain. bindCallee must not resolve x.y() to x (named binding) or lib.a.b() to a. Return a non-import result so the ladder ends in unknown, unless a member model exists. Test: named-binding-trailing-chain. Replace symbol-binder.test.ts:166.
- PRM-21/22, scope-aware loader provenance. Replace resolveSingleAssignmentValue in loader-constructs.ts with the lexical authority in named-bindings.ts, both for shadowing and for alias chasing. Correct the local-aliases.ts and named-bindings.ts:13-15 comments. Test: wholefile-shadow-require-alias.
- PRM-23, truncation. Make traversal_truncated block families B/C, or compute the closure over a superset of graph files. Test: closure-truncation-hides-hook. Replace "case 10b".
- PRM-24, builtin loaders. Decide the policy for cluster (fork, setupPrimary/setupMaster) and for other builtins that execute code. Either classify them as child_process_execution or name them in SUPPORTED_MODEL_EXCLUSIONS. Test: cluster-fork.
- PRM-25, symbol entrypoints. Resolve {file, symbol} through export attribution and root-candidate machinery, not node-name text. If the symbol does not materialize, report entrypoint_root_incomplete. Correct the FINDINGS P0-Z limitation text. Tests: both symbol-entry-* cases, including the false-AFFECTED variant.
- PRM-26, export → function mapping. Replace the name find in mapExportsToFunctions with declaration-identity resolution of localName at the export site. Test: export-map-first-match-class-method.
- PRM-27, literal unpacking. When a later property with the same name is a string-literal key, accessor or spread, or a computed key could collide, refuse the earlier binding for that name, or refuse all names on a spread. Tests: the string-key and getter cases.
- PRM-28, computed key. Resolve computed keys through the lexical authority rather than a whole-file first const. Test: export-map-computed-key-scope.
- PRM-29, property writes. Refuse a property export when any write to the same export name exists in a function body or deferred position, mirroring the whole-module rule. Test: export-map-configure-write.
- PRM-30, write ordering. Order literal-unpacked bindings and later member writes to module.exports.* by source position (last wins), or refuse on conflict. Test: export-map-literal-then-member-write.
- PRM-31, root witnesses. Root-requirement materialization must use declaration identity, not n.name. Test: entry-root-decoy.
- PRM-32, export surfaces. Recognize module-scope this.X =, aliases of module.exports/exports, and Object.defineProperty(this, …). Otherwise mark roots incomplete when such writes exist. Test: entry-root-unseen-export-writes.
- PRM-33, resolver mode. Force Node16/NodeNext resolution (or resolvePackageJsonExports) for runtime resolution, whatever the project tsconfig says. Alternatively, flag node10 resolution as closure-incomplete. Test: tsconfig-commonjs-ignores-exports.
- PRM-34, lockfile identity. For a nameless non-node_modules lock entry, derive the name from the linked node_modules/<name> entry's resolved, or from the package's own manifest. If it still cannot be named, emit an unreportedCandidates identity record instead of continue. Correct the package-lock.ts:56-60 comment. Test: vendor-drop, with the real npm lockfile.
- PRM-35, cache writes. Guard set() so a failure degrades to a diagnostic and never exits 4. Test: cache-set plus its writable control.
- PRM-36, --cve wording. Compute the "no advisory discovered" condition from the unfiltered discovery set, or word the detail as "none matched the filter". Test: versionless --cve CVE-Y.

10. PREMISES IN THE PROMPT I CHECKED

┌─────────────────────────────────────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                            Claim                                            │                                                   Result                                                    │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ call-graph.ts, around line 1889, says such identifiers "can never be a vulnerable-rule      │ TRUE: the comment is at 1886, the branch at 1889-1892.                                                      │
│ target"                                                                                     │                                                                                                             │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ osv-cache.ts says "its shape is entirely controlled by VulnTrace itself"                    │ TRUE (line 54).                                                                                             │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ The cache directory lives inside the scanned project's tree                                 │ TRUE: scan.ts:366-367 defaults to <projectRoot>/.vulntrace-cache/osv.                                       │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ named-bindings.ts RWF-046a "a numeric key names no export" is false and since corrected     │ TRUE: line 1100 now says the premise is false.                                                              │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FINDINGS prose "a non-identifier key resolves in no position anywhere in the engine" is     │ TRUE: the prose is still at FINDINGS.md:15488 (append-only) and is contradicted by                          │
│ false                                                                                       │ named-bindings.ts:1106-1113.                                                                                │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ module-load-closure is a scope item under src/code-intelligence/                            │ FALSE: the file is src/analysis/module-load-closure.ts.                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ The other listed files and directories exist; scripts/scorecard-sources.mjs exists          │ TRUE.                                                                                                       │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ RWF-047 is "member write on a module object keeps its static attribution"                   │ TRUE (OPEN-DEBTS D-16).                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ The AUD-01…16 identifiers                                                                   │ UNVERIFIED: none appears anywhere in the repository. I took them on the prompt's authority.                 │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Setup: git worktree list run first; no worktree touched                                     │ Done.                                                                                                       │
├─────────────────────────────────────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A concurrent session is active                                                              │ TRUE: a new worktree, scorecard-status-classifier, appeared during the run.                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

11. ACCEPTANCE

- [x] yes: Nothing committed, pushed, branched on the remote or edited.
- [x] yes, with two exceptions: Every inventory entry has file:line at 62b52b9 and the comment quoted verbatim. The exceptions are the rows for uncommented branches, which are marked "(uncommented)", and PRM-32's isCommonJsExportObject range, which is taken from sweep A and not re-verified.
- [x] yes: Every FALSE entry has a full inline reproduction with analyzer result, ground truth and both controls. PRM-34 has only a positive-style control, because a negative control does not apply to a drop. PRM-35 and PRM-36 have a control run.
- [x] yes: Every reproduction asserts the loud-fixture property (96/96 LOUD-OK, plus the vendor case).
- [x] yes: Section-3 items are marked KNOWN, not re-reported as new.
- [x] partial, gaps stated in §5: The uncommented fail-open inventory is exhaustive for the edge-emitting code, not for every implicit-invocation semantic.
- [x] yes (§7): The coverage section states which files were exhausted, partial, or not reached.

This report is long enough that a shareable page would be easier to pass around. I can publish it as a private artifact if you'd like.

result: I found 25 new false code-comment premises and reproduced each through the real scan pipeline against real Node. Twenty-three give a false NOT_AFFECTED (PRM-12…33); PRM-34 silently drops a file:-vendored package whose npm lock entry has no name; PRM-35/36 give a wrong exit code and a false reason. Three existing tests pin a false premise as the expected result. Nothing in the repository was changed.
