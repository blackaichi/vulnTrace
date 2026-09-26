---
Date: 2026-09
Commit audited: ea5d25b62411ceb84dde36d6d67d1f3fd0315948
Method: read-only; real scan pipeline (`runScanCommand`) with a synthetic
OSV provider; ground truth from real Node v22.11.0 run on the same
fixtures
Findings registered in: `tests/validation/FINDINGS.md` (AUD-01 … AUD-16)

This copy was pasted in from a terminal session and suffered
line-wrapping damage in transit: several table cells and sentences are
cut mid-word or have text missing across a wrapped line boundary. Lost
text is **not reconstructed** — every place it was noticed is marked
`[text damaged in source]`, and the task report for the branch that
added this file lists every one. The box-drawing table in § 3 is
damaged throughout (cells are cut and merged across row boundaries in
nearly every row) and is left as received, with one blanket note before
it, rather than annotated cell by cell.
---

CRITICAL_FINDINGS

VulnTrace independent soundness audit: S1–S7

2. STATE

- What I audited: origin/main = ea5d25b62411ceb84dde36d6d67d1f3fd0315948. I worked in a fresh local clone in my job scratch dir (…/jobs/24bcbf75/tmp/audit), with its remote removed and the code compiled to .build/. Every reproduction is a real runScanCommand scan with a synthetic provider, and ground truth came from real node v22.11.0 on the same fixture. Scripts are in …/jobs/24bcbf75/tmp/repro/. That directory is deleted along with this job, so the minimal reproductions are also written out below.
- Nothing committed, pushed, edited or branched. I touched no worktree. The main checkout is clean.
- Main moved during the audit to 2e7aaaf (AGENTS.md rewrite, docs/tasks/, CLAUDE.md). That was parallel work, not mine, and it changes docs only. No src/ file changed, so every finding below still applies to current main.
- Sanity check: every finding has a positive control (the same fixture with a direct call gives AFFECTED) and a negative control (no call gives NOT_AFFECTED). The harness can therefore show both verdicts, and a wrong one is visible.

3. FINDINGS TABLE

┌────────┬─────────────────┬─────────────────────────────────────────┬──────────┬──────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│   ID   │     Surface     │              Failure class              │ Defect   │ Severity │                                                    Summary                                                    │
│        │                 │                                         │  class   │          │                                                                                                               │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-01 │ call graph      │ false NOT_AFFECTED                      │ B        │ Critical │ A callback passed to an ambient builtin (setTimeout, new Promise, process.nextTick, Array.from, …) gets no    │
│        │ (outside S1–S7) │                                         │          │        proves the target unreachable.                                                       │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-02 │ S6 / call graph │ false NOT_AFFECTED                      │ B        │ Critica.x() / module.exports.x() calls produce no edge, so family C proves the target       │
│        │                 │                                         │          │          │ unreachable.                                                                                                  │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-03 │ S5              │ false NOT_AFFECTED                      │ B        │ Critical │ process.getBuiltinModule('module'|'child_process'|'worker_threads') loads code while the ModuleLoadClosure    │
│        │                 │                                         │          │        lete, so family A fires.                                                             │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-04 │ S5              │ false NOT_AFFECTED                      │ B        │ Critica Runtime.evaluate with includeCommandLineAPI gets require; the closure stays         │
│        │                 │                                         │          │          │ complete and family A fires.                                                                                  │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-05 │ S1              │ silently dropped (recorded as a false   │ B        │ Critical │ semver.coerce strips prereleases, so a vulnerable installed prerelease (2.0.0-rc.1 < fixed: 2.0.0) is         │
│        │                 │ "not applicable"); also false AFFECTED  │          │        ot apply".                                                                           │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-06 │ S2              │ silently dropped                        │ —        │ Criticaes, so an advisory published after the first scan is never seen.                     │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-07 │ S2              │ silently dropped                        │ —        │ Criticae scanned project and is trusted as-is; a committed [] file suppresses advisories    │
│        │                 │                                         │          │          │ with zero provider queries.                                                                                   │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-08 │ S4              │ silently dropped                        │ —        │ Critical │ A package that is on disk and really loaded, but missing from package-lock.json, is never queried: no         │
│        │                 │                                         │          │                                                                                             │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-09 │ S1              │ silently dropped (false "not            │ B        │ High     │ A GIT-type range is compared as semver (coerce("3f2a…") = 3.0.0); an affected entry with no ranges gives a    │
│        │                 │ applicable")                            │          │          │ confident "not applicable".                                                                                   │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-10 │ S1              │ product                                 │ —        │ Medium   │ A malformed or unmatched OSV record goes only to diagnostics: it is not in unreportedCandidates and the scan  │
│        │                 │                                         │          │          │ exits 0.                                                                                                      │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-11 │ S3              │ product                                 │ —        │ Medium   │ One OSV record with id: "", even for an unrelated package, fails schema validation: exit 3 and the whole      │
│        │                 │                                         │          │          │ report (including real AFFECTEDs) is lost.                                                                    │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-12 │ S3              │ product                                 │ —        │ Medium   │ An all-UNKNOWN scan exits 0, the same as a clean one; there is no summary field or exit code for "could not   │
│        │                 │                                         │          │                                                                                             │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-13 │ S6              │ false AFFECTED                          │ B        │ Low    delled with Babel __esModule interop; Node gives module.exports.                     │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-14 │ S1              │ false AFFECTED                          │ —        │ Low    s ignored.                                                                           │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-15 │ S7              │ false UNKNOWN reason                    │ —        │ Low    whose rule targets only one package gets an UNKNOWN reason claiming the other        │
│        │                 │                                         │          │          │ package "was never traversed" (it was).                                                                       │
├────────┼─────────────────┼─────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-16 │ S2/S1/S3        │ docs                                    │ —        │ Low      │ README says the cache is "gitignored" and that "a cache entry from a different VulnTrace build is never       │
│        │                 │                                         │          │        sentences are false under AUD-05/06/09.                                              │
└────────┴─────────────────┴─────────────────────────────────────────┴──────────┴──────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

4. FINDING DETAIL

For every row, the analyzer result is from the real pipeline on ea5d25b, and ground truth is node src/index.js on the same fixture. Fixture shape: vuln-lib@1.0.0 exports danger and safe. The advisory is
GHSA-a, SEMVER introduced 0, fixed 1.0.1, and the rule targets vuln-lib#danger. The entryhing is reachable on main today. [text damaged in source]

AUD-01 (repro/s6cb.mjs). App:
const { danger, safe } = require('vuln-lib');
function main(){ safe(0); setTimeout(() => danger(1), 0); }
- Analyzer: NOT_AFFECTED (confirmedUnreachableTarget), exit 0.
- Node: prints DANGER:1.
- Same false result for: setTimeout(danger,0,1), new Promise(r=>{danger(1)}), process.nextTick, queueMicrotask, setImmediate, Array.from([1], v=>danger(v)), the JSON.parse reviver, Reflect.apply(danger,…),
  globalThis.__d=danger; globalThis.__d(1), process.on+emit, and a named local cb passed [text damaged in source]
- Held: Promise.resolve().then(cb), [1].map(cb) and Object.keys().forEach(cb) all give AFFECTED.
- Code: src/code-intelligence/call-graph.ts:1889-1891 (and :2159 for new) returns no edge [text damaged in source]_GLOBAL_IDENTIFIERS (:60-148). This happens before VT-213's inline-callback rescue(:1403-1446) runs, and a named function argument gets no edge of any kind. The comment's premise ("they can never be a vulnerable-rule target") ignores that builtins invoke their function arguments.
- Coverage: no test uses process.nextTick, queueMicrotask or setImmediate. setTimeout(  [text damaged in source] an only one test file.

AUD-02 (repro/s6min.mjs). Library:
exports.danger = realDanger;
exports.run = function run(x){ return exports.danger(x) };
- App: lib.run(1).
- Analyzer: family C NOT_AFFECTED, exit 0. callsResolved is 3 (the direct-call control ha [text damaged in source]
- Node: prints DANGER:1, and the final public danger is realDanger.
- Same false result for: module.exports = {danger, run(){ module.exports.danger() }}, mod [text damaged in source]xports['danger'](x).
- Held: the aliased api.danger() and this.danger() forms give UNKNOWN.
- Code: same early return as AUD-01; the root identifiers are exports and module.
- Not RWF-047: that record covers a consumer writing a member of a require-bound module object. This is the package calling its own exports, with a single write.

AUD-03 (repro/s5.mjs, repro/s5b.mjs).
function main(){ other.f(); return process.getBuiltinModule('module').createRequire(__fil [text damaged in source] }
- Analyzer: family A NOT_AFFECTED; the closure reports complete: true and has no vuln-lib. Exit 0.
- Node: prints DANGER:1.
- Same false result for: 'node:module', destructured getBuiltinModule, require('node:process').getBuiltinModule, a value stored and used later, an ESM entry, and getBuiltinModule('child_process') /
  ('worker_threads').
- Fail closed: only forms that also hit a generically flagged member (._load, runInThisContext).
- Code: builtin identity comes only from the specifier table in src/code-intelligence/lo [text damaged in source]atinModule does not appear anywhere in src, docs or tests, and is not in [text damaged in source]SUPPORTED_MODEL_EXCLUSIONS (src/domain/evidence.ts:302).
- Node versions: available from 20.16 / 22.3; engines is >=20.
- Coverage: the differential oracle has no case for it.

AUD-04 (repro/s5b.mjs, inspector_evaluate).
new (require('inspector').Session)()
// .connect(), then .post('Runtime.evaluate', {expression:"require('vuln-lib').danger(1)", includeCommandLineAPI:true}, …)
- Analyzer: family A NOT_AFFECTED, closure complete.
- Node: prints DANGER:1.
- Code: inspector is absent from the builtin table.

AUD-05 (repro/s1.mjs).
- Case: installed 2.0.0-rc.1, advisory fixed: 2.0.0 (or fixed: 2.0.0-rc.2). Node calls danger.
- Analyzer: no finding; unreportedCandidates says not_applicable "installed version … is [text damaged in source]; exit 0.
- Ground truth: semver.lt('2.0.0-rc.1','2.0.0') === true, which is SemVer precedence as OSV's SEMVER type uses it. The version is inside the range.
- Reverse direction (false AFFECTED): 1.5.0-beta.3 against last_affected 1.5.0-beta.2, and [text damaged in source]uced 1.5.0-beta.1, both give AFFECTED although the version is outside the range.
- Code: src/vulnerabilities/version-matching.ts:28 (coerce applied to the installed version and to every bound).
- Coverage: no test has a prerelease.

AUD-06 (repro/s2.mjs a). Default config, cache enabled.
- Scan 1: the provider returns [].
- Then: the provider starts returning GHSA-a.
- Scan 2: cacheHits: 1, zero provider queries, no finding, no diagnostic, exit 0.
- Control: --no-cache gives AFFECTED.
- Code: src/cache/osv-cache.ts:112-129. There is no TTL, no fetched-at timestamp and no staleness signal.

AUD-07 (repro/s2.mjs b).
- Setup: write [] to <project>/.vulntrace-cache/osv/<sha256({toolVersion:"0.1.0",ecosyste [text damaged in source]ey is fully predictable from public inputs.
- Result: zero queries, no finding, exit 0.
- Code: the default directory is <projectRoot>/.vulntrace-cache/osv (scan.ts, createCach [text damaged in source]ieStore.get casts the parsed JSON without validating it. Its comment's premise ("its shape [text damaged in source]is entirely controlled by VulnTrace itself") is false, because the directory belongs to the target project.
- Held: a truncated JSON file is treated as a miss. {}, 5 or true throws, and runCli turn [text damaged in source]

AUD-08 (repro/s4.mjs 4a, repro/s4c.mjs).
- Case 1: node_modules/vuln-lib@1.0.0 is on disk and required, but the lockfile lacks it. Result: findings: [], unreportedCandidates: [], diagnostics: [], exit 0. Node prints DANGER-top:1.
- Case 2: a nested copy node_modules/x/node_modules/vuln-lib@1.0.0 exists only on disk, [text damaged in source] ay is 1.0.1. The only output is not_applicable for the hoisted copy, while Node runs the [text damaged in source]nested vulnerable one.
- Code: the inventory is lockfile-only (buildDependencyGraph → buildPackageInstanceRegist [text damaged in source]ageInstances is never reconciled against the registry.

AUD-09 (repro/s1.mjs).
- GIT range: a record with only type: GIT and fixed: "3f2a9c1b0d" gives not_applicable for installed 5.0.0, because coerce turns the hash into 3.0.0.
- Empty entry: affected: [{package}] with no ranges and no versions gives not_applicable, not_affected for an empty list (version-matching.ts:100).
- Why it's wrong: a commit range cannot be ordered against an npm version, and an entry with no bounds cannot be interpreted; failing closed means indeterminate.
- Already known: the file's own comment admits the GIT case is "silently miscompared".

AUD-10.
- Case: event {introduced: 0} (a number) or ecosystem "NPM".
- Result: "skipping malformed vulnerability record" appears in diagnostics; there is no u [text damaged in source] the scan exits 0.
- Why it matters: a diagnostic exists, so this is not strictly silent. But it is the one no-finding path absent from the F3 channel that exists to account for exactly this.
- Code: scan.ts, the normalizeOsvVulnerability catch.

AUD-11 (repro/s3.mjs 2).
- Case: the provider returns a valid GHSA-a for vuln-lib plus a record with id: "" for other-lib.
- Result: exit 3, /findings/0/vulnerability: must NOT have fewer than 1 characters, and n [text damaged in source]lost.
- Cause: the normalizer accepts z.string() without .min(1).

AUD-12 (repro/s3.mjs 1). Two UNKNOWN findings (no rule) give exit 0. The README's "0 = no AFFECTED" is literally true, but a CI gate cannot tell a clean scan from an undecided one without parsing
findings[].verdict.

AUD-13 (repro/s6.mjs).
- Library: exports.__esModule = true; exports.default = realDanger; exports.danger = realDanger.
- ESM app: import def from 'vuln-lib'; typeof def === 'function' ? def(1) : def.safe(1).
- Node: def is module.exports (an object), so it prints safe.
- Analyzer: AFFECTED.

AUD-14. A record carrying withdrawn: "2026-01-01…" gives AFFECTED. The normalizer schema [text damaged in source]

AUD-15 (repro/s7.mjs).
- Case: GHSA-m affects both vuln-lib and other-lib; the rule targets only vuln-lib. The app calls vuln-lib.safe and other-lib.danger.
- Result: the other-lib finding is UNKNOWN (sound) with reason package_instance_absence_us [text damaged in source] vuln-lib "was never traversed". That is false; the true cause is that no rule target [text damaged in source]names other-lib.
- Related: a rule's package.name is never read (a mismatch is accepted silently).

AUD-16.
- README §Performance says the cache is "(gitignored)". That is only true of VulnTrace's own .gitignore, not the scanned project's.
- README also says a different build's entry "is never reused". The key is the package.js [text damaged in source]ed by every build.
- html-report.ts:995 says "Does not apply means the installed version is outside every affected range". That is false under AUD-05/09.
- html-report.ts:1305 says no findings means "no installed dependency matched a vulnerabi [text damaged in source]ovider returned". That is false under AUD-06/07/08.

5. SUSPICIONS (not reproduced)

- Event order: eventsToRanges assumes chronological events. [{fixed 1.3.0},{introduced 1. [text damaged in source]ted". To settle it, read the OSV spec text on event ordering; I had no network access.
- limit events: these are dropped, which widens ranges. This is precision only if GIT ranges are made indeterminate.
- An exception inside buildFinding: it would abort the whole scan (exit 3, no report) rat [text damaged in source]I found no input that throws. To settle it, fuzz buildFinding with odd manifests and [text damaged in source]exports shapes.
- Site B phantom target: if the package is in a complete closure but the call graph never [text damaged in source] on a phantom node. To settle it, look for a load path that the closure follows but the [text damaged in source]graph does not.
- Other ambient escapes: repl / node:test / wasi as eval surfaces, analogous to AUD-04. T [text damaged in source] require('module').builtinModules.
- ESM named import of CJS: where cjs-module-lexer does not detect the name, Node throws, and the analyzer may say AFFECTED (a false AFFECTED).

6. HELD (attacked; the control shows a failure would have been visible)

- S1
  - fixed, last_affected and versions lists behave correctly (control: 1.0.1 gives not_ap [text damaged in source]D).
  - Build metadata; scoped @scope/pkg; mixed-case JSONStream.
  - GHSA and CVE records aliasing each other give two findings, with no collapse.
  - A provider failing mid-scan gives exit 4 (loud, no partial report).
  - A lock/disk version conflict is reported as undetermined in unreportedCandidates.
- S2: truncated JSON is a miss; a wrong-shape entry gives exit 3; --no-cache bypasses the cache.
- S3
  - HTML and JSON agree: 1/1/1 finding articles per verdict against the JSON, and the not-applicable row renders in both.
  - Twin instances produce two findings.
  - The exit code is 1 exactly when some finding is AFFECTED.
- S4
  - Same-name/same-version twins: top copy NOT_AFFECTED, nested copy AFFECTED, both matching Node.
  - A lockfile entry missing on disk gives UNKNOWN.
  - npm alias; directory/manifest name mismatch; a file: link; a symlink to a store outside the project.
  - Dual exports import/require, including nested node and "." keys: AFFECTED, with a saf [text damaged in source]_AFFECTED.
- S5
  - 30 constructs fail closed: dynamic import() of any specifier shape, createRequire, mo [text damaged in source]quire, process.mainModule.require, require.resolve→require, Module._load,Module.prototype.require.call, require.call, Reflect.apply(require), .map(require), concatenated specifiers, eval, indirect eval, new Function, vm, Worker, child_process, require.cache writes,
    Proxy/bind/destructured require, and Module#_compile.
  - control_none shows family A does fire when nothing loads the package.
- S6
  - Double writes, reassignment and Object.assign with a direct call; defineProperty getters and values; export * ambiguity (UNKNOWN); a shadowing local export; re-export cycles (UNKNOWN); and the detached
    exports alias all match Node.
  - A renamed re-export was correctly NOT_AFFECTED (the public danger is stub). My first oracle wrongly flagged it; I rescored every S6 case against the final public export before listing anything.
- S7: a typo'd or unexported-subpath target gives UNKNOWN; the same typo with the package [text damaged in source]rect); a rule keyed by CVE alias matches.

7. COVERAGE

- Exhausted: S1, S2, S4 for npm lockfile layouts, S5.
- Substantially covered: S3 (all asks were checked; exception propagation was not reproduced), S6, S7.
- Not reached:
  - pnpm/yarn layouts: there is no package-lock.json, so the scan exits 3 before any analysis.
  - Workspaces beyond file: links.
  - Self-reference, case-sensitivity, "type": "module" beyond .mjs/.cjs.
  - Package bin entries.

8. TOP IMPROVEMENTS

1. Delete the "no edge" branch for ambient roots. Replace it with an explicit table of which arguments, and make everything else an unresolved edge. Evidence: AUD-01 and AUD-02 [text damaged in source]are both this one early return.
2. Generate the differential oracle from require('module').builtinModules × process.* [text damaged in source] capnd-picked cases. AUD-03 and AUD-04 were found by exactly that kind of sweep, done by hand.
3. Property-test version matching against uncoerced semver (with prereleases), and carry the OSV range type into VersionRange. Evidence: AUD-05 and AUD-09; there are no prerelease or GIT tests today.
4. Treat the advisory cache as untrusted, dated input: keep it outside the target tree,  [text damaged in source]galidate its schema, and record per-candidate cache age in the output. Evidence: AUD-06 and AUD-07.
5. Reconcile the closure's loadedPackageInstances against the registry, and add a machine [text damaged in source](a summary field and/or exit code). Evidence: AUD-08 and AUD-12.

9. PROPOSED TASKS

- AUD-01: In call-graph.ts, stop returning undefined for calls and constructions rooted i [text damaged in source]enever any argument is function-valued (inline, a named local, or an identifier). Either [text damaged in source]emit a resolved edge to the callback (for a modeled list: timers, nextTick, queueMicrotask, Promise executor, Array.from, the JSON.parse reviver, Reflect.apply, EventEmitter-style process.on), or an
  unresolved edge. Also drop global/globalThis stores from the exemption. Add real-Node t [text damaged in source] AUD-01.
- AUD-02: Treat exports.X(…), module.exports.X(…) and exports[lit](…) inside a module as calls on that module's own export object: resolve them through the module model's final export attribution, or emit an
  unresolved edge. Add the three minimal fixtures from s6min as real-Node cases.
- AUD-03: Model process.getBuiltinModule(spec) (every spelling, destructured, and via node:process) as a builtin source equivalent to require(spec) in loader-constructs.ts. A non-literal argument must widen
  the closure. Add oracle cases for module, child_process and worker_threads.
- AUD-04: Classify inspector / node:inspector / inspector/promises Session#post as an eval capability that widens the closure, or declare it in SUPPORTED_MODEL_EXCLUSIONS. Also audit the remaining builtins
  for eval or load surfaces.
- AUD-05: Replace semver.coerce with a strict semver.parse of the installed version and of each bound, comparing with full prerelease precedence. An unparseable value must give indeterminate. Add tests for
  both directions.
- AUD-06: Add fetchedAt and a configurable TTL to cache entries, treat an expired entry as a miss, and report cache age per candidate in the JSON output.
- AUD-07: Move the default cache out of the project root (for example to an XDG cache dir [text damaged in source]inst the provider envelope schema, and never read a cache that ships inside the scanned [text damaged in source]tree unless it is explicitly configured.
- AUD-08: After closure construction, emit an unreportedCandidates entry (stage: package_ [text damaged in source]nstance_not_in_lockfile) for every loaded instance missing from the registry. Optionally, [text damaged in source]query the provider for its manifest version.
- AUD-09: Carry range.type into VersionRange, make non-SEMVER/ECOSYSTEM ranges indetermin [text damaged in source]ry with neither ranges nor versions indeterminate rather than not_affected.
- AUD-10: Also record a rejected advisory record as an unreportedCandidates entry, classified with its package and query version.
- AUD-11: Require id to be non-empty in the normalizer (a failure becomes a skipped recor [text damaged in source]can never fail the whole scan's schema validation.
- AUD-12: Add summary: {affected, notAffected, unknown, unreported} to the output, and an opt-in exit code (or a documented one) for any UNKNOWN or undetermined candidate.
- AUD-13: Model Node's ESM→CJS default interop (default = module.exports, ignoring __esMo [text damaged in source] importers.
- AUD-14: Parse withdrawn, and report such records as unreportedCandidates with disposition withdrawn instead of analyzing them.
- AUD-15: Before instance matching, compare the finding's package name with each target's [text damaged in source]ther package should give UNKNOWN no_vulnerable_symbol_rule-style (the rule has no target [text damaged in source]for this package), and rules validate should flag a mismatched package.name.
- AUD-16: Correct the two README claims and the two HTML sentences to match the behaviour [text damaged in source]AUD-05/06/07/08/09 are fixed).

10. PREMISES

- Repository URL github.com/blackaichi/vulnTrace: true (matches origin).
- Cache keyed by {tool version, ecosystem, name, version}: true. "Tool version" is the package.json string 0.1.0, not a build identity.
- README "0 = no AFFECTED findings": true, and an all-UNKNOWN scan also exits 0.
- The listed authoritative docs and tests/binding-grammar/ exist: true.
- The 264-cell sweep: recorded as RWF-048; I read the record but did not rerun it.
- "RWF-047 is classified as class B": false on main. FINDINGS.md still marks it "OPEN QUESTION, deliberately not yet classified". A locked rwf-047-classification worktree exists.
- Three proof families; UNKNOWN reasons from exactly six categories: true.
- Same name and version at two paths are two instances: true, verified with twins.
- OSV is the only provider today: true (the config enum is ["osv"]).
- "Never a false NOT_AFFECTED, never a silently dropped finding": false. See AUD-01 through AUD-08.
- "Target code is never executed": not contradicted; the scan never ran fixture code. I d [text damaged in source]
- AGENTS.md being rewritten on another branch: true. It landed on main (ae5956f) during the audit, and I did not rely on either version.

If it helps, I can publish this report as a private shareable page.

result: VulnTrace audit at ea5d25b found critical soundness holes: 4 false-NOT_AFFECTED families (callbacks passed to builtins, a package calling its own exports.x(), process.getBuiltinModule, inspector) and
4 silent-drop paths (prerelease version matching, a cache that never expires, a cache truct, [text damaged in source] packages missing from the lockfile), plus 8 lesser findings; nothing was committed oredited.
