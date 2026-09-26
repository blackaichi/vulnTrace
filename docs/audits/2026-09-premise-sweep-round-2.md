---
Date: 2026-09
Commit audited: 62b52b90cb5fead842534e1743519ca3da411945
Method: read-only; real scan pipeline (`runScanCommand`) with a synthetic
OSV provider; ground truth from real Node v22.11.0 run on the same
fixtures; 81/81 (plus 111, 25, 7, 12, 4 and 5) loud-fixture assertions
passed across the case batches, 0 failures
Findings registered in: `tests/validation/FINDINGS.md` (PRM-101 …
PRM-116; PRM-60 … PRM-67, all settled FALSE except PRM-66, false only
for a versionless lock entry)

No line-wrapping or transcription damage was found in this report on
review: its body is plain structured text, tables and code listings that
render cleanly, and it was pasted in intact.
---

I've finished round 2. The verdict is CRITICAL_FINDINGS. I found 16 new false premises (PRM-101 to PRM-116), all reproduced end to end through the real scan pipeline and checked against real node. Of the eight round-1 unverified items (PRM-60 to PRM-67), all eight turned out FALSE. They include 3 new silent drops (PRM-64, 65, 66) and a new false NOT_AFFECTED that fires on ordinary code: a package reached only through export * from is certified family C even though its top-level code runs (PRM-101). The 16 new entries plus the 8 settled ones make 24 new fixes in total.

Checks I ran:
- Every priority-3 result comes from a final rerun of the generator printed below: 81/81 loud-fixture assertions passed, 0 failed.
- The other case batches passed as well: 111, 25, 7, 12, 4 and 5 loud assertions, 0 failures. The intake and module-paths scripts assert the loud property inline.
- The main checkout is unchanged: clean, HEAD still 62b52b9.

---

1. VERDICT

CRITICAL_FINDINGS

2. STATE

- SHA audited: 62b52b90cb5fead842534e1743519ca3da411945. main has not moved since round 1.
- Where I worked: I ran git worktree list first (32 entries, none touched). Then I made a fresh local clone, detached at that SHA, at /home/blackaichi/.claude/jobs/807a8c55/tmp/vt2. I did not create a worktree. The clone's only change is an untracked node_modules symlink pointing to the main checkout's node_modules, used read-only.
- Nothing changed: nothing committed, pushed, branched or edited in the repository. /data/workdir/claude/vulnTrace stays clean at 62b52b9.
- Scratch files are in …/tmp/repro2, …/tmp/agentC and …/tmp/agentD, all outside the repository.
- Delegated sweeps. Two read-only sweeps ran in the background:
  - C: module-model 2395–4509, resolved-target.ts, graph.ts.
  - D: analysis/cli/domain small files, verdict.ts 1–1040 and 1930–2086.

  Every suspect they raised that appears below as FALSE, I reproduced myself end to end.

3. PREMISE INVENTORY

Consequence abbreviations: FNA = false NOT_AFFECTED, FA = false AFFECTED.

ID: PRM-101
file:line: verdict.ts:479-486, 613-620 (branch 1022-1034)
Comment (verbatim, shortened): "If the target genuinely is reachable, its file would already have been discovered and indexed while building the graph … the only way it could still be reachable is through a
dynamic/unresolved construct" / "A phantom fed into reachability search is correct and intentional here"
Branch it justifies: Site B hands a phantom target to reachability, giving family C with no closure corroboration
If false: FNA
Status: FALSE
Evidence: r2-phantom-export-star-barrel: loaded only via export *, top-level code calls parse
────────────────────────────────────────
ID: PRM-102
file:line: verdict.ts:962 (and graphPackageInstances ~693-700)
Comment (verbatim, shortened): "Site B (VT-301B) -- the fallback taken when the call graph contains no [node of the advisory's package NAME]"
Branch it justifies: "no node of this name" treated as never traversed
If false: FNA
Status: FALSE (realism: lock entry without name, manifest name differs)
Evidence: r2-siteB-name-mismatch-forwarded
────────────────────────────────────────
ID: PRM-103
file:line: module-model.ts:538-540 (+4638-4645)
Comment (verbatim, shortened): "Last-write-wins is Node's real semantics for straight-line module-scope code and nothing else"
Branch it justifies: the final export write is authoritative
If false: FNA
Status: FALSE
Evidence: r2-cyclic-observer-*: a cyclic importer sees the intermediate value
────────────────────────────────────────
ID: PRM-104
file:line: named-bindings.ts:84-86; branch 1243-1244 (uncommented)
Comment (verbatim, shortened): "a function declaration needs no order check: hoisting is complete"
Branch it justifies: function binding returned with no isAssignedWithin check (the class and function-expression branches both have one)
If false: FNA
Status: FALSE
Evidence: r2-function-declaration-reassigned
────────────────────────────────────────
ID: PRM-105
file:line: loader-constructs.ts:2165-2175, 2184-2196
Comment (verbatim, shortened): "x.y / x[k] produce a MEMBER of the receiver, never the receiver itself" / "A call's value is whatever the callee returns -- never one of the operands by construction"
Branch it justifies: member access and call results are value-opaque in the escape sweep
If false: FNA (A)
Status: FALSE
Evidence: p2-60-literal-receiver, r2-esc-composite-method-receiver, r2-esc-function-in-array, r2-function-ctor-computed-key
────────────────────────────────────────
ID: PRM-106
file:line: loader-constructs.ts:1867-1872
Comment (verbatim, shortened): "Deliberately excludes the ambient require FUNCTION … there is no unknown-member surface on require itself worth failing closed on"
Branch it justifies: require.bind(…) is not a capability receiver
If false: FNA (A)
Status: FALSE
Evidence: p2-60-bind
────────────────────────────────────────
ID: PRM-107
file:line: loader-constructs.ts:2720-2744, 2760-2763
Comment (verbatim, shortened): "Deliberately this small, fully-enumerated method-name set -- never 'any method call on .paths'"
Branch it justifies: module.paths recognized only as a literal module.paths.<mutator>(…)
If false: FNA (B) + FA
Status: FALSE
Evidence: paths2: an alias, and Array.prototype.unshift.call
────────────────────────────────────────
ID: PRM-108
file:line: source-index.ts:396-405, code 435-437; symbol-binder.ts:269-271
Comment (verbatim, shortened): "Only the two common, unambiguous forms are unpacked…" / "loader-constructs.ts (text-keyed, but refusal-only by construction…)"
Branch it justifies: importedName falls back to the LOCAL name for a string or computed key; the loader classifier reads it
If false: FNA (A)
Status: FALSE
Evidence: r2-builtin-destructure-string-key
────────────────────────────────────────
ID: PRM-109
file:line: graph.ts:110-115, 307-314
Comment (verbatim, shortened): "unsupported_construct and dynamic_member_access can only ever reach a function value already in scope, from a module already loaded" / "none of them can introduce a module graph
construction never discovered"
Branch it justifies: unsupported_* reasons non-widening
If false: FNA
Status: FALSE (same premise as PRM-60)
Evidence: see PRM-60 in §5
────────────────────────────────────────
ID: PRM-110
file:line: html-report.ts:345-347, 748
Comment (verbatim, shortened): "The first reason string — the overview table's one-line summary." → fallback "no reason recorded"
Branch it justifies: summary reads only evidence.reasons[0]
If false: false reason
Status: FALSE
Evidence: HTML case: an UNKNOWN with no_vulnerable_symbol_rule renders "no reason recorded"
────────────────────────────────────────
ID: PRM-111
file:line: run.ts:84-88 (guard "--cve requires a value")
Comment (verbatim, shortened): (uncommented) only a non-string is rejected
Branch it justifies: --cve= passes ""
If false: silent drop
Status: FALSE
Evidence: intake --cve "": findings [], exit 0, empty stderr
────────────────────────────────────────
ID: PRM-112
file:line: call-graph walkFile (uncommented)
Comment (verbatim, shortened): —
Branch it justifies: instanceof → [Symbol.hasInstance] gets no edge
If false: FNA
Status: FALSE
Evidence: p3-symbol-hasInstance
────────────────────────────────────────
ID: PRM-113
file:line: (uncommented)
Comment (verbatim, shortened): —
Branch it justifies: for await → [Symbol.asyncIterator] gets no edge
If false: FNA
Status: FALSE
Evidence: p3-symbol-asyncIterator
────────────────────────────────────────
ID: PRM-114
file:line: (uncommented)
Comment (verbatim, shortened): —
Branch it justifies: Error.prepareStackTrace = fn + .stack read gets no edge
If false: FNA
Status: FALSE
Evidence: p3-prepareStackTrace
────────────────────────────────────────
ID: PRM-115
file:line: (uncommented)
Comment (verbatim, shortened): —
Branch it justifies: decorators (legacy and standard) get no edge
If false: FNA
Status: FALSE
Evidence: p3-ts-decorator-*
────────────────────────────────────────
ID: PRM-116
file:line: (uncommented)
Comment (verbatim, shortened): —
Branch it justifies: a JSX element gets no edge to its factory
If false: FNA
Status: FALSE
Evidence: p3-tsx-jsx-factory
────────────────────────────────────────
ID: (known)
file:line: call-graph PRM-17
Comment (verbatim, shortened): —
Branch it justifies: writes through the arguments[0] alias ignored
If false: FNA
Status: KNOWN PRM-17
Evidence: p3-arguments-alias. A fix that checks writes by name would miss this alias.
────────────────────────────────────────
ID: (known)
file:line: symbol-binder PRM-20
Comment (verbatim, shortened): —
Branch it justifies: lib.safe.call.call(lib.parse, …)
If false: FNA
Status: KNOWN PRM-20
Evidence: p3-call-call-chain
────────────────────────────────────────
ID: (known)
file:line: call-graph AUD-01
Comment (verbatim, shortened): —
Branch it justifies: Function.prototype.apply.call, Reflect.apply/construct, defineProperty get/set, Proxy trap, toJSON
If false: FNA
Status: KNOWN AUD-01
Evidence: p3 cases
────────────────────────────────────────
ID: (known)
file:line: round-1 iterator
Comment (verbatim, shortened): —
Branch it justifies: spread, destructuring, yield*, Array.from
If false: FNA
Status: KNOWN (round-1 Symbol.iterator)
Evidence: p3 cases
────────────────────────────────────────
ID: (known)
file:line: PRM-12/13
Comment (verbatim, shortened): —
Branch it justifies: new Readable({read(){…}}).on("data", () => {})
If false: FNA
Status: KNOWN PRM-12/13
Evidence: p3-stream-readable-options
────────────────────────────────────────
ID: (known)
file:line: loader-constructs.ts:162
Comment (verbatim, shortened): "UNBOUNDED-depth const-alias chain" via first-match lookup
Branch it justifies: two-hop vm alias hidden by an unrelated inner const v
If false: FNA (A)
Status: KNOWN PRM-21/22 (round-1 suspicion now confirmed)
Evidence: r2-vm-two-hop-family-A
────────────────────────────────────────
ID: (known)
file:line: sweep C S2
Comment (verbatim, shortened): —
Branch it justifies: module-scope exports.run() gets no edge
If false: FNA
Status: KNOWN AUD-02
Evidence: not re-proved
────────────────────────────────────────
ID: (known)
file:line: sweep C S4
Comment (verbatim, shortened): —
Branch it justifies: computed export key resolved scope-blind
If false: FNA
Status: KNOWN PRM-28
Evidence: not re-proved
────────────────────────────────────────
ID: T-1
file:line: loader-constructs.ts:1985-2004
Comment (verbatim, shortened): "Module + 1 is a string … a semantic guarantee of the operators"
Branch it justifies: primitive-result operators are opaque
If false: —
Status: TRUE
Evidence: ECMAScript semantics
────────────────────────────────────────
ID: T-2
file:line: loader-constructs.ts:2605-2621
Comment (verbatim, shortened): "module.exports = ... … an ordinary data assignment with no relationship to loader/resolution state"
Branch it justifies: safe write
If false: —
Status: TRUE (for loading; export-model effects are PRM-63)
Evidence: —
────────────────────────────────────────
ID: T-3
file:line: loader-constructs.ts:2626-2665
Comment (verbatim, shortened): reflection mutators matched by owner text Object/Reflect
Branch it justifies: —
If false: —
Status: TRUE (compensated)
Evidence: An aliased Reflect still passes the capability as an argument, which is flagged at 1698-1702.
────────────────────────────────────────
ID: T-4
file:line: loader-constructs.ts:2234-2246
Comment (verbatim, shortened): Exclusion 4: "every statement-level escape position inside it … is visited independently"
Branch it justifies: function values opaque
If false: —
Status: TRUE
Evidence: p2-60-call-result, getter and generator-yield were all caught
────────────────────────────────────────
ID: T-5
file:line: loader-constructs.ts:1431-1437
Comment (verbatim, shortened): Module() throws
Branch it justifies: —
If false: —
Status: TRUE (round 1)
Evidence: —
────────────────────────────────────────
ID: T-6
file:line: named-bindings.ts:1225-1236
Comment (verbatim, shortened): class TDZ plus reassignment refusal
Branch it justifies: —
If false: —
Status: TRUE
Evidence: —
────────────────────────────────────────
ID: T-7
file:line: named-bindings.ts:1330-1345
Comment (verbatim, shortened): the lodash freeParseInt refusal propagates
Branch it justifies: —
If false: —
Status: TRUE
Evidence: —
────────────────────────────────────────
ID: T-8
file:line: source-index.ts:95-110
Comment (verbatim, shortened): "can only ever reflect a syntax/parser failure"
Branch it justifies: early errors that are not parse diagnostics are not flagged
If false: nil
Status: TRUE-safe
Evidence: Node refuses to load such a file, so nothing runs.
────────────────────────────────────────
ID: T-9
file:line: source-index.ts:589-598
Comment (verbatim, shortened): numeric-key round-trip guard
Branch it justifies: —
If false: —
Status: TRUE
Evidence: —
────────────────────────────────────────
ID: T-10
file:line: graph.ts:288-356
Comment (verbatim, shortened): every reason classified; default fails closed
Branch it justifies: —
If false: —
Status: TRUE (sweep C)
Evidence: The partition is exhaustive; its justification is PRM-109.
────────────────────────────────────────
ID: T-11
file:line: module-model.ts 2425-4458 (cutoff machinery)
Comment (verbatim, shortened): a wrong "abrupt" only withdraws attribution; roots widen
Branch it justifies: —
If false: UNKNOWN only
Status: TRUE (sweep C: every consumer traced)
Evidence: Precision defects inside it are listed as U-3.
────────────────────────────────────────
ID: T-12
file:line: analysis-context.ts / scan-caches.ts / uncertainty.ts / rules-validate.ts / io.ts / errors.ts
Comment (verbatim, shortened): brand, memo gates, exhaustive maps
Branch it justifies: —
If false: —
Status: TRUE (sweep D)
Evidence: —
────────────────────────────────────────
ID: U-1
file:line: module-resolver.ts:272-330 attemptSiblingRuntimeFile
Comment (verbatim, shortened): "only after checking whether the package's own package.json names a different, authoritative entry point" (reads main, ignores exports)
Branch it justifies: —
If false: FNA?
Status: UNVERIFIED
Evidence: Only reached when the noDts resolution fails. I could not construct such a package.
────────────────────────────────────────
ID: U-2
file:line: resolved-target.ts:658-708
Comment (verbatim, shortened): last-/node_modules/-segment identity wins over KnownPackageRoots
Branch it justifies: project located under a node_modules ancestor
If false: FNA?
Status: UNVERIFIED (held end to end)
Evidence: My fixture gives UNKNOWN vulnerable_target_unresolved, not NOT_AFFECTED.
────────────────────────────────────────
ID: U-3
file:line: module-model.ts:2437-2442, 2473-2479, 2527-2530
Comment (verbatim, shortened): "normal is the safe default"
Branch it justifies: labeled break; try/catch return
If false: UNKNOWN (precision)
Status: UNVERIFIED (sweep C measured at model level)
Evidence: precision only
────────────────────────────────────────
ID: U-4
file:line: verdict.ts:915-918; analysis/index.ts:14
Comment (verbatim, shortened): "gate-eligible BY CONSTRUCTION"
Branch it justifies: buildModuleLoadClosure is re-exported
If false: FNA (latent)
Status: UNVERIFIED (latent)
Evidence: The package is private, and only scan.ts builds a context.

4. FALSE-PREMISE DETAIL

How to reproduce everything

- Directory layout: repro2/ contains the harness, the generators, the scripts and run-all.sh. vt2/ is the clone at 62b52b9 with node_modules.
- Commands, run from repro2/:
  - Generated cases: GEN=<generator> ./run-all.sh > results.txt, then node summarize.mjs results.txt. Generators, in order: allcases2.mjs, allcases2b.mjs, allcases2c.mjs, allcases2d.mjs, allcases2e.mjs, allcases2f.mjs, allcases2g.mjs.
  - Intake and identity: ../vt2/node_modules/.bin/vite-node --root ../vt2 intake2.ts.
  - Module paths: ../vt2/node_modules/.bin/vite-node --root ../vt2 paths2.ts.
- Pipeline: every case runs the real runScanCommand (noCache: true) with a synthetic provider that returns one advisory for the fixture package. Ground truth is real node v22.11.0 on the same fixture.
- Loud-fixture assertion: before every scan, the harness requires the package and exits 3 unless every bound name is a function.
- Controls: every case has a positive control (direct call → AFFECTED) and a negative control (no call to parse → NOT_AFFECTED).

harness.ts (round 1's harness, with the import repointed to ../vt2; complete)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { runScanCommand } from "../vt2/src/cli/scan.ts";

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

run-all.sh
#!/bin/sh
set -e
node "${GEN:-allcases2.mjs}"
for c in $(cat case-list.txt); do
  ../vt2/node_modules/.bin/vite-node --root ../vt2 harness.ts -- "case-$c.json" 2>&1 | grep -v '^$'
done

summarize.mjs
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\n");
let cur = null; const rows = [];
for (const l of lines) {
  if (l.startsWith("== ")) { cur = { h: l.slice(3), gt: [] }; rows.push(cur); continue; }
  if (!cur) continue;
  if (l.includes("loud-fixture:")) cur.loud = l.includes("LOUD-OK");
  else if (l.includes("analyzer:")) { const a = JSON.parse(l.split("analyzer: ")[1]); cur.a = `${a.verdict}${a.family !== "-" ? " " + a.family : ""}${a.unknownReasons ? " [" + a.unknownReasons.join(",") + "]" : ""} exit ${a.exit}`; }
  else if (l.includes("node ground truth:")) { const g = l.split("node ground truth: ")[1]; if (g) cur.gt.push(g); }
  else if (/^CALLED|^EXIT|^threw/.test(l)) cur.gt.push(l);
}
for (const r of rows) console.log(`${r.h} | ${r.loud ? "loud-ok" : "LOUD?"} | ${r.a} | GT: ${r.gt.join(", ") || "(nothing)"}`);

allcases2.mjs (priority 3; complete)
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("../vt2/node_modules/typescript");
const HIT = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n`;
const PS = HIT + `function parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\n`;
const LIB = { "index.js": PS + `module.exports = { parse, safe };\n` };
const spec = (id, variants, extra = {}) => ({ id, libName: "vuln-lib", libVersion: "1.0.0", libFiles: LIB, targetExport: "parse",
  boundNames: ["parse", "safe"], entry: "src/index.js", variants, ...extra });
const v = (name, src, more = {}) => ({ name, files: { "src/index.js": src }, ...more });
const L = `const lib = require("vuln-lib");\n`;
const cases = []; const add = (s) => cases.push(s);
const mech = (id, body, extra = {}) => add(spec(id, [
  v("case", L + body("parse")), v("positive-control", L + body("safe") + `lib.parse("x");\n`), v("negative-control", L + body("safe")) ], extra));
mech("p3-with-statement", (f) => `with (lib) {\n  ${f}("x");\n}\n`);
mech("p3-arguments-alias", (f) => `function helper(x) { return lib.safe(x); }\nfunction invoke(a) {\n  arguments[0] = lib.${f};\n  return a("x");\n}\ninvoke(helper);\n`);
mech("p3-call-call-chain", (f) => `lib.safe.call.call(lib.${f}, null, "x");\n`);
mech("p3-apply-call-chain", (f) => `Function.prototype.apply.call(lib.${f}, null, ["x"]);\n`);
mech("p3-reflect-apply", (f) => `Reflect.apply(lib.${f}, null, ["x"]);\n`);
mech("p3-reflect-construct", (f) => `function Ctor(x) { lib.${f}(x); }\nReflect.construct(Ctor, ["x"]);\n`);
mech("p3-defineProperty-getter", (f) => `const o = {};\nObject.defineProperty(o, "v", { get: function () { return lib.${f}("x"); } });\nconst read = o.v;\n`);
mech("p3-defineProperty-setter", (f) => `const o = {};\nObject.defineProperty(o, "v", { set: function (x) { lib.${f}(x); } });\no.v = "x";\n`);
mech("p3-literal-getter-held", (f) => `const o = { get v() { return lib.${f}("x"); } };\nconst read = o.v;\n`);
mech("p3-symbol-hasInstance", (f) => `class C { static [Symbol.hasInstance](x) { return !!lib.${f}("x"); } }\nconst isC = ({}) instanceof C;\n`);
mech("p3-symbol-asyncIterator", (f) => `const it = { async *[Symbol.asyncIterator]() { yield lib.${f}("x"); } };\nasync function run() { for await (const x of it) {} }\nrun();\n`);
const IT = (f) => `const it = { *[Symbol.iterator]() { yield lib.${f}("x"); } };\n`;
mech("p3-iter-spread", (f) => IT(f) + `const arr = [...it];\n`);
mech("p3-iter-destructuring", (f) => IT(f) + `const [first] = it;\n`);
mech("p3-iter-yield-star", (f) => IT(f) + `function* g() { yield* it; }\nfor (const x of g()) {}\n`);
mech("p3-iter-array-from", (f) => IT(f) + `const arr = Array.from(it);\n`);
mech("p3-proxy-trap", (f) => `const p = new Proxy({}, { get(t, k) { return lib.${f}(String(k)); } });\nconst read = p.anything;\n`);
mech("p3-toJSON", (f) => `const s = JSON.stringify({ toJSON() { return lib.${f}("x"); } });\n`);
mech("p3-finalization-registry", (f) => `const r = new FinalizationRegistry(() => lib.${f}("x"));\nr.register({}, 1);\nasync function drain() { for (let i = 0; i < 20; i++) { await new Promise((ok) => setTimeout(ok, 20)); global.gc(); } }\ndrain();\n`,
  { groundTruthCmd: ["node", "--expose-gc", "src/index.js"] });
mech("p3-atomics-waitAsync", (f) => `const ia = new Int32Array(new SharedArrayBuffer(4));\nconst w = Atomics.waitAsync(ia, 0, 0);\nw.value.then(() => lib.${f}("x"));\nAtomics.notify(ia, 0);\n`);
mech("p3-prepareStackTrace", (f) => `Error.prepareStackTrace = function (e, frames) { lib.${f}("x"); return ""; };\nconst st = new Error("e").stack;\n`);
mech("p3-eventemitter-emit", (f) => `const EventEmitter = require("events");\nconst e = new EventEmitter();\ne.on("go", lib.${f});\ne.emit("go", "x");\n`);
mech("p3-eventemitter-subclass", (f) => `const EventEmitter = require("events");\nclass Bus extends EventEmitter {\n  constructor() { super(); this.on("go", (x) => lib.${f}(x)); }\n}\nconst b = new Bus();\nb.emit("go", "x");\n`);
mech("p3-stream-readable-options", (f) => `const { Readable } = require("stream");\nnew Readable({ read() { lib.${f}("x"); this.push(null); } }).on("data", () => {});\n`);
mech("p3-stream-writable-options", (f) => `const { Writable } = require("stream");\nconst w = new Writable({ write(c, e, cb) { lib.${f}("x"); cb(); } });\nw.write("x");\n`);
const tsCase = (id, file, body, opts) => {
  const mk = (f, extra = "") => {
    const src = L.replace("const lib = require", "import lib = require") + body(f) + extra;
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, ...opts }, fileName: file }).outputText;
    return { [`src/${file}`]: src, "dist/index.js": js };
  };
  add(spec(id, [ { name: "case", files: mk("parse") }, { name: "positive-control", files: mk("safe", `lib.parse("x");\n`) }, { name: "negative-control", files: mk("safe") } ],
    { entry: `src/${file}`, groundTruthCmd: ["node", "dist/index.js"] }));
};
tsCase("p3-ts-decorator-legacy", "index.ts", (f) => `function logged(t: any) { lib.${f}("x"); return t; }\n@logged\nclass X {}\nexport { X };\n`, { experimentalDecorators: true });
tsCase("p3-ts-decorator-standard", "index.ts", (f) => `function logged(t: any, ctx: any) { lib.${f}("x"); return t; }\n@logged\nclass X {}\nexport { X };\n`, {});
tsCase("p3-tsx-jsx-factory", "index.tsx", (f) => `function h(tag: any, props: any) { return typeof tag === "function" ? tag(props) : tag; }\nfunction App() { return lib.${f}("x"); }\nconst el = <App />;\n`, { jsx: ts.JsxEmit.React, jsxFactory: "h" });
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

allcases2b.mjs (PRM-60, 61, 62, 63, 67 and priority-4 vm; complete)
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
const cases = []; const add = (s) => cases.push(s);
const NAME = `const NAME = ["vuln", "lib"].join("-");\n`;
const shapes = {
  "call-result": `function get() { return require; }\nconst lib = get()(NAME);\n`,
  "arrow-concise-body": `const get = () => require;\nconst lib = get()(NAME);\n`,
  "static-field": `class K { static r = require; }\nconst lib = K.r(NAME);\n`,
  "instance-field": `class K { r = require; }\nconst lib = new K().r(NAME);\n`,
  "this-receiver": `const o = { r: require, load(n) { return this.r(n); } };\nconst lib = o.load(NAME);\n`,
  "for-of-array": `let lib;\nfor (const r of [require]) { lib = r(NAME); }\n`,
  "indexed-receiver": `const table = [require];\nconst lib = table[0](NAME);\n`,
  "literal-receiver": `const lib = [require][0](NAME);\n`,
  "expression-receiver": `const lib = (true && { r: require }).r(NAME);\n`,
  "getter": `const o = { get r() { return require; } };\nconst lib = o.r(NAME);\n`,
  "map-storage": `const m = new Map([["r", require]]);\nconst lib = m.get("r")(NAME);\n`,
  "rest-param": `function load(...fs) { return fs[0](NAME); }\nconst lib = load(...[require]);\n`,
  "catch-param": `let lib;\ntry { throw require; } catch (r) { lib = r(NAME); }\n`,
  "promise-then": `Promise.resolve(require).then((r) => { r(NAME).parse("x"); });\nconst lib = { parse() {} };\n`,
  "generator-yield": `function* g() { yield require; }\nconst lib = g().next().value(NAME);\n`,
  "destructuring-default": `const { r = require } = {};\nconst lib = r(NAME);\n`,
  "property-assignment": `const box = {};\nbox.r = require;\nconst lib = box.r(NAME);\n`,
  "array-of": `const lib = Array.of(require)[0](NAME);\n`,
  "module-in-object": `const holder = { mod: module };\nconst lib = holder.mod.require(NAME);\n`,
  "bind": `const r2 = require.bind(null);\nconst lib = r2(NAME);\n`,
  "object-values": `const lib = Object.values({ require })[0](NAME);\n`,
  "iife-param": `const lib = (function (r) { return r(NAME); })(require);\n`,
};
for (const [id, body] of Object.entries(shapes)) add(spec(`p2-60-${id}`, [
  v("case", NAME + body + `lib.parse("x");\n`), v("positive-control", L + `lib.parse("x");\n`), v("negative-control", NAME + `const unused = NAME;\n`) ]));
const CORE = { "core.js": PS + `module.exports = { parse, safe };\n` };
const A = { "a.js": `const core = require("./core");\nexports.run = function (x) { return core.parse(x); };\n` };
const B = { "b.js": `exports.run = function (x) { return "b"; };\n` };
const lib61 = (index) => ({ ...CORE, ...A, ...B, "index.js": index });
const APP = { "src/index.js": L + `lib.run("x");\n` };
add(spec("p2-61-stale-exports-after-replace", [
  { name: "case", files: APP, libFiles: lib61(`const core = require("./core");\nmodule.exports = { run: require("./a").run, parse: core.parse, safe: core.safe };\nexports.run = require("./b").run;\n`) },
  { name: "positive-control", files: APP, libFiles: lib61(`const core = require("./core");\nmodule.exports = { run: require("./a").run, parse: core.parse, safe: core.safe };\n`) },
  { name: "negative-control", files: APP, libFiles: lib61(`const core = require("./core");\nmodule.exports = { run: require("./b").run, parse: core.parse, safe: core.safe };\n`) },
], { boundNames: ["parse", "safe", "run"] }));
add(spec("p2-61-replace-after-property", [
  { name: "case", files: APP, libFiles: lib61(`const core = require("./core");\nexports.run = require("./b").run;\nmodule.exports = { run: require("./a").run, parse: core.parse, safe: core.safe };\n`) },
  { name: "positive-control", files: APP, libFiles: lib61(`const core = require("./core");\nmodule.exports = { run: require("./a").run, parse: core.parse, safe: core.safe };\n`) },
  { name: "negative-control", files: APP, libFiles: lib61(`const core = require("./core");\nexports.run = require("./a").run;\nmodule.exports = { run: require("./b").run, parse: core.parse, safe: core.safe };\n`) },
], { boundNames: ["parse", "safe", "run"] }));
const ESMAPP = { "src/index.mjs": `import { run } from "vuln-lib";\nrun("x");\n` };
const esm = (tail) => ({ "index.js": PT + tail });
add(spec("p2-62-esm-let-reassigned", [
  { name: "case", files: ESMAPP, libFiles: esm(`export let run = function (x) { return safe(x); };\nrun = function (x) { return danger(x); };\nexport { parse, safe };\n`) },
  { name: "case-configure", files: ESMAPP, libFiles: esm(`export let run = function (x) { return safe(x); };\nexport function configure() { run = function (x) { return danger(x); }; }\nconfigure();\nexport { parse, safe };\n`) },
  { name: "positive-control", files: ESMAPP, libFiles: esm(`export let run = function (x) { return danger(x); };\nexport { parse, safe };\n`) },
  { name: "negative-control", files: ESMAPP, libFiles: esm(`export let run = function (x) { return safe(x); };\nexport { parse, safe };\n`) },
], { libIsEsm: true, entry: "src/index.mjs", boundNames: ["parse", "safe", "run"] }));
const PTC = [ { name: "positive-control", files: APP, libFiles: pt(`module.exports = { parse, safe, run: danger };\n`) },
  { name: "negative-control", files: APP, libFiles: pt(`module.exports = { parse, safe, run: safe };\n`) } ];
for (const [id, tail] of Object.entries({
  "bracket-whole": `module.exports = { parse, safe, run: safe };\nmodule["exports"] = { parse, safe, run: danger };\n`,
  "bracket-member": `module.exports = { parse, safe, run: safe };\nmodule["exports"].run = danger;\n`,
  "module-alias": `module.exports = { parse, safe, run: safe };\nconst m = module;\nm.exports = { parse, safe, run: danger };\n`,
  "computed-key": `module.exports = { parse, safe, run: safe };\nconst k = "exports";\nmodule[k] = { parse, safe, run: danger };\n`,
  "object-assign-module": `module.exports = { parse, safe, run: safe };\nObject.assign(module, { exports: { parse, safe, run: danger } });\n`,
  "reflect-set": `module.exports = { parse, safe, run: safe };\nReflect.set(module, "exports", { parse, safe, run: danger });\n`,
  "object-assign-exports": `module.exports = { parse, safe, run: safe };\nObject.assign(module.exports, { run: danger });\n`,
  "exports-bracket-literal": `module.exports = { parse, safe, run: safe };\nmodule.exports["run"] = danger;\n`,
})) add(spec(`p2-63-${id}`, [{ name: "case", files: APP, libFiles: pt(tail) }, ...PTC], { boundNames: ["parse", "safe", "run"] }));
const WRAPC = {
  "node_modules/wrap/package.json": JSON.stringify({ name: "wrap", version: "1.0.0", exports: { ".": { custom: "./vuln.js", default: "./safe.js" } } }),
  "node_modules/wrap/vuln.js": `const lib = require("vuln-lib");\nexports.run = function (x) { return lib.parse(x); };\n`,
  "node_modules/wrap/safe.js": `exports.run = function (x) { return "safe"; };\n`,
  "src/index.js": `const w = require("wrap");\nw.run("x");\n` };
add(spec("p2-67-conditions", [
  { name: "case", files: WRAPC, groundTruthCmd: ["node", "--conditions=custom", "src/index.js"] },
  { name: "contrast-default-node", files: WRAPC },
  { name: "positive-control", files: { ...WRAPC, "src/index.js": L + `lib.parse("x");\n` } },
  { name: "negative-control", files: { ...WRAPC, "node_modules/wrap/vuln.js": `exports.run = function (x) { return "vuln-file"; };\n` }, groundTruthCmd: ["node", "--conditions=custom", "src/index.js"] } ]));
const PRE = { "preload.mjs": `import lib from "vuln-lib";\nlib.parse("x");\n`, "src/index.js": `console.log("app");\n` };
add(spec("p2-67-import-preload", [
  { name: "case", files: PRE, groundTruthCmd: ["node", "--import", "./preload.mjs", "src/index.js"] },
  { name: "positive-control", files: { ...PRE, "src/index.js": L + `lib.parse("x");\n` } },
  { name: "negative-control", files: PRE } ]));
const VM = (inner) => L + `globalThis.__lib = lib;\n` + inner + `const v = require("vm");\nv.runInThisContext("__lib.parse('x')");\n`;
add(spec("p4-vm-scope-blind-alias", [
  v("case", VM(`function a() { const v = 1; return v; }\n`)), v("contrast-no-inner-const", VM("")),
  v("positive-control", L + `globalThis.__lib = lib;\nlib.parse("x");\n`),
  v("negative-control", L + `globalThis.__lib = lib;\nfunction a() { const v = 1; return v; }\nconst v = require("vm");\nv.runInThisContext("__lib.safe('x')");\n`) ]));
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

allcases2c.mjs (phantom, name mismatch, cyclic observer, Function constructor, two-hop vm, PRM-61 clean; complete)
import { writeFileSync } from "node:fs";
const HIT = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n`;
const PS = HIT + `function parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\n`;
const PT = PS + `function danger(x){ hit("run->danger"); return parse(x); }\n`;
const LIB = { "index.js": PS + `module.exports = { parse, safe };\n` };
const spec = (id, variants, extra = {}) => ({ id, libName: "vuln-lib", libVersion: "1.0.0", libFiles: LIB, targetExport: "parse",
  boundNames: ["parse", "safe"], entry: "src/index.js", variants, ...extra });
const v = (name, src, more = {}) => ({ name, files: { "src/index.js": src }, ...more });
const L = `const lib = require("vuln-lib");\n`;
const cases = []; const add = (s) => cases.push(s);
const TOPLIB = { "index.js": PS + `module.exports = { parse, safe };\nparse("top-level");\n` };
const QUIET = { "index.js": PS + `module.exports = { parse, safe };\n` };
add(spec("r2-phantom-export-star-barrel", [
  { name: "case", files: { "src/index.mjs": `import "./re.mjs";\n`, "src/re.mjs": `export * from "vuln-lib";\n` } },
  { name: "case-dependency-wrapper", files: { "src/index.mjs": `import { other } from "wrapper";\nother();\n`,
    "node_modules/wrapper/package.json": JSON.stringify({ name: "wrapper", version: "1.0.0", type: "module", exports: { ".": "./index.js" } }),
    "node_modules/wrapper/index.js": `export * from "vuln-lib";\nexport function other() { return 2; }\n` } },
  { name: "positive-control", files: { "src/index.mjs": `import "vuln-lib";\n` } },
  { name: "negative-control", files: { "src/index.mjs": `import "./re.mjs";\n`, "src/re.mjs": `export * from "vuln-lib";\n` }, libFiles: QUIET },
], { libFiles: TOPLIB, entry: "src/index.mjs" }));
const FORK = { ...LIB, "package.json": JSON.stringify({ name: "vuln-lib-fork", version: "1.0.0", main: "index.js" }) };
add(spec("r2-siteB-manifest-name-mismatch", [
  { name: "case", files: { "src/index.js": L + `lib.parse("x");\n` }, libFiles: FORK },
  { name: "positive-control", files: { "src/index.js": L + `lib.parse("x");\n` } },
  { name: "negative-control", files: { "src/index.js": L + `lib.safe("x");\n` }, libFiles: FORK } ]));
const cyc = (first, b) => ({ "index.js": PT + `module.exports = ${first};\nrequire("./b");\nmodule.exports = { run: safe, parse, safe };\n`, "b.js": b });
const B = (m) => `const p = require("./index");\np.${m}("x");\n`;
add(spec("r2-cyclic-observer-whole-module", [
  { name: "case", files: { "src/index.js": `require("vuln-lib");\n` }, libFiles: cyc(`{ run: danger, parse, safe }`, B("run")) },
  { name: "positive-control", files: { "src/index.js": `require("vuln-lib");\n` }, libFiles: cyc(`{ run: safe, parse, safe }`, B("parse")) },
  { name: "negative-control", files: { "src/index.js": `require("vuln-lib");\n` }, libFiles: cyc(`{ run: safe, parse, safe }`, B("run")) },
], { boundNames: ["parse", "safe", "run"] }));
const cycp = (first, b) => ({ "index.js": PT + `exports.parse = parse;\nexports.safe = safe;\nexports.run = ${first};\nrequire("./b");\nexports.run = safe;\n`, "b.js": b });
add(spec("r2-cyclic-observer-property", [
  { name: "case", files: { "src/index.js": `require("vuln-lib");\n` }, libFiles: cycp("danger", B("run")) },
  { name: "positive-control", files: { "src/index.js": `require("vuln-lib");\n` }, libFiles: cycp("safe", B("parse")) },
  { name: "negative-control", files: { "src/index.js": `require("vuln-lib");\n` }, libFiles: cycp("safe", B("run")) },
], { boundNames: ["parse", "safe", "run"] }));
const FSRC = (f) => `F('return process.mainModule.require("vuln-lib").${f}("x")')();\n`;
add(spec("r2-function-ctor-computed-key", [
  v("case", `const k = "constructor";\nconst F = (() => {})[k];\n` + FSRC("parse")),
  v("case-reflect-get", `const F = Reflect.get(function () {}, "constructor");\n` + FSRC("parse")),
  v("contrast-property-access", `const F = (function () {}).constructor;\n` + FSRC("parse")),
  v("positive-control", L + `lib.parse("x");\n`),
  v("negative-control", `const k = "constructor";\nconst F = (() => {})[k];\nF("return 1")();\n`) ]));
const VM2 = (inner) => L + `globalThis.__lib = lib;\n` + inner + `const v0 = require("vm");\nconst v = v0;\nv.runInThisContext("__lib.parse('x')");\n`;
add(spec("r2-vm-two-hop-scope-blind", [
  v("case", VM2(`function a() { const v = 1; return v; }\n`)), v("contrast-no-inner-const", VM2("")),
  v("positive-control", L + `lib.parse("x");\n`),
  v("negative-control", L + `globalThis.__lib = lib;\nfunction a() { const v = 1; return v; }\nconst v0 = require("vm");\nconst v = v0;\nv.runInThisContext("__lib.safe('x')");\n`) ]));
const CORE = { "core.js": PS + `module.exports = { parse, safe };\n` };
const A = { "a.js": `const core = require("./core");\nexports.run = function (x) { return core.parse(x); };\n` };
const Bf = { "b.js": `exports.run = function (x) { return "b"; };\n` };
const lib61 = (index) => ({ ...CORE, ...A, ...Bf, "index.js": index });
const APP = { "src/index.js": L + `lib.run("x");\n` };
add(spec("r2-61-replace-after-property-clean", [
  { name: "case", files: APP, libFiles: lib61(`const core = require("./core");\nexports.run = require("./b").run;\nmodule.exports = { run: require("./a").run, parse: core.parse, safe: core.safe };\n`) },
  { name: "positive-control", files: APP, libFiles: lib61(`const core = require("./core");\nmodule.exports = { run: require("./a").run, parse: core.parse, safe: core.safe };\n`) },
  { name: "negative-control", files: APP, libFiles: lib61(`const core = require("./core");\nmodule.exports = { run: require("./b").run, parse: core.parse, safe: core.safe };\n`) },
], { boundNames: ["parse", "safe", "run"] }));
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

allcases2d.mjs (sharpened name mismatch; vm family A; complete)
import { writeFileSync } from "node:fs";
const HIT = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n`;
const IMPL = HIT + `module.exports = function (x) { hit("parse"); return "p"; };\n`;
const SAFE = HIT + `function safe(x){ hit("safe"); return "s"; }\n`;
const spec = (id, variants, extra = {}) => ({ id, libName: "vuln-lib", libVersion: "1.0.0",
  libFiles: {}, targetExport: "parse", boundNames: ["parse", "safe"], entry: "src/index.js", variants, ...extra });
const L = `const lib = require("vuln-lib");\n`;
const cases = [];
const lib = (name) => ({ "impl.js": IMPL, "index.js": SAFE + `module.exports = { parse: require("./impl"), safe };\n`,
  "package.json": JSON.stringify({ name, version: "1.0.0", main: "index.js" }) });
cases.push(spec("r2-siteB-name-mismatch-forwarded", [
  { name: "case", files: { "src/index.js": L + `lib.parse("x");\n` }, libFiles: lib("vuln-lib-fork") },
  { name: "positive-control", files: { "src/index.js": L + `lib.parse("x");\n` }, libFiles: lib("vuln-lib") },
  { name: "negative-control", files: { "src/index.js": L + `lib.safe("x");\n` }, libFiles: lib("vuln-lib-fork") } ]));
const PS = HIT + `function parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\nmodule.exports = { parse, safe };\n`;
const VMA = (inner, f) => inner + `const v0 = require("vm");\nconst v = v0;\nv.runInThisContext("process.mainModule.require('vuln-lib').${f}('x')");\n`;
cases.push(spec("r2-vm-two-hop-family-A", [
  { name: "case", files: { "src/index.js": VMA(`function a() { const v = 1; return v; }\n`, "parse") } },
  { name: "contrast-no-inner-const", files: { "src/index.js": VMA("", "parse") } },
  { name: "positive-control", files: { "src/index.js": L + `lib.parse("x");\n` } },
  { name: "negative-control", files: { "src/index.js": `function a() { const v = 1; return v; }\nconst v0 = require("vm");\nconst v = v0;\n` } },
], { libFiles: { "index.js": PS } }));
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

allcases2e.mjs (escape-machinery gaps; complete)
import { writeFileSync } from "node:fs";
const HIT = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n`;
const PS = HIT + `function parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\nmodule.exports = { parse, safe };\n`;
const spec = (id, variants) => ({ id, libName: "vuln-lib", libVersion: "1.0.0", libFiles: { "index.js": PS },
  targetExport: "parse", boundNames: ["parse", "safe"], entry: "src/index.js", variants });
const v = (name, src) => ({ name, files: { "src/index.js": src } });
const L = `const lib = require("vuln-lib");\n`;
const NAME = `const NAME = ["vuln", "lib"].join("-");\n`;
const SRC = (f) => JSON.stringify(`process.mainModule.require("vuln-lib").${f}("x")`);
const cases = [];
const trio = (id, casebody, negbody) => cases.push(spec(id, [v("case", casebody), v("positive-control", L + `lib.parse("x");\n`), v("negative-control", negbody)]));
trio("r2-esc-composite-method-receiver", NAME + `const lib = [require].at(0)(NAME);\nlib.parse("x");\n`, NAME + `const r = [require].at(0);\n`);
trio("r2-esc-eval-in-object", `const t = { e: eval };\nt.e(${SRC("parse")});\n`, `const t = { e: eval };\nt.e("1 + 1");\n`);
trio("r2-esc-eval-in-array", `const t = [eval];\nt[0](${SRC("parse")});\n`, `const t = [eval];\nt[0]("1 + 1");\n`);
trio("r2-esc-function-in-array", `const F = [Function][0];\nF(${SRC("parse")})();\n`, `const F = [Function][0];\nF("return 1")();\n`);
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

allcases2f.mjs (reassigned function declaration; complete)
import { writeFileSync } from "node:fs";
const HIT = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n`;
const PS = HIT + `function parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\nmodule.exports = { parse, safe };\n`;
const spec = (id, variants) => ({ id, libName: "vuln-lib", libVersion: "1.0.0", libFiles: { "index.js": PS },
  targetExport: "parse", boundNames: ["parse", "safe"], entry: "src/index.js", variants });
const v = (name, src) => ({ name, files: { "src/index.js": src } });
const L = `const lib = require("vuln-lib");\n`;
const cases = [spec("r2-function-declaration-reassigned", [
  v("case", L + `function run(x) { return lib.safe(x); }\nrun = lib.parse;\nrun("x");\n`),
  v("case-deferred-write", L + `function run(x) { return lib.safe(x); }\nfunction setup() { run = lib.parse; }\nsetup();\nrun("x");\n`),
  v("positive-control", L + `function run(x) { return lib.parse(x); }\nrun("x");\n`),
  v("negative-control", L + `function run(x) { return lib.safe(x); }\nrun("x");\n`) ])];
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

allcases2g.mjs (string- and computed-key builtin destructuring; complete)
import { writeFileSync } from "node:fs";
const HIT = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n`;
const PS = HIT + `function parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\nmodule.exports = { parse, safe };\n`;
const W = `const lib = require("vuln-lib");\nlib.parse("x");\nprocess.exit(0);\n`;
const spec = (id, variants) => ({ id, libName: "vuln-lib", libVersion: "1.0.0", libFiles: { "index.js": PS },
  targetExport: "parse", boundNames: ["parse", "safe"], entry: "src/index.js", variants });
const v = (name, src) => ({ name, files: { "src/index.js": src, "src/worker.js": W } });
const cases = [spec("r2-builtin-destructure-string-key", [
  v("case", `const { "fork": f } = require("child_process");\nf(__dirname + "/worker.js");\n`),
  v("case-computed-key", `const { ["fork"]: f } = require("child_process");\nf(__dirname + "/worker.js");\n`),
  v("contrast-identifier-key", `const { fork: f } = require("child_process");\nf(__dirname + "/worker.js");\n`),
  v("positive-control", `require("./worker.js");\n`),
  v("negative-control", `const { "fork": f } = require("child_process");\n`) ])];
for (const c of cases) writeFileSync(`case-${c.id}.json`, JSON.stringify(c, null, 2));
writeFileSync("case-list.txt", cases.map((c) => c.id).join("\n") + "\n");

paths2.ts (complete)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runScanCommand } from "../vt2/src/cli/scan.ts";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const lib = (tag: string) => `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n + " [${tag}]"); }\nfunction parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\nmodule.exports = { parse, safe };\n`;
const RULES = `rules:\n  - id: GHSA-paths\n    package:\n      name: vuln-lib\n    targets:\n      - module: vuln-lib\n        export: parse\n        kind: function\n        confidence: 1.0\n`;
const BASE = {
  "package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "vuln-lib": "1.0.0", other: "1.0.0" } }),
  "package-lock.json": JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "app", version: "1.0.0", dependencies: { "vuln-lib": "1.0.0", other: "1.0.0" } },
    "node_modules/vuln-lib": { version: "1.0.0" },
    "node_modules/other": { version: "1.0.0", dependencies: { "vuln-lib": "1.0.0" } },
    "node_modules/other/node_modules/vuln-lib": { version: "1.0.0" } } }, null, 2),
  "node_modules/vuln-lib/package.json": JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
  "node_modules/vuln-lib/index.js": lib("top"),
  "node_modules/other/package.json": JSON.stringify({ name: "other", version: "1.0.0", main: "index.js" }),
  "node_modules/other/index.js": `module.exports = {};\n`,
  "node_modules/other/node_modules/vuln-lib/package.json": JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
  "node_modules/other/node_modules/vuln-lib/index.js": lib("nested"),
  "vulntrace.yml": `analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n`,
  "rules.yml": RULES,
};
const DIR = `const path = require("path");\nconst dir = path.join(__dirname, "..", "node_modules", "other", "node_modules");\n`;
const variants: Record<string, string> = {
  "case-alias": DIR + `const p = module.paths;\np.unshift(dir);\nconst lib = require("vuln-lib");\nlib.parse("x");\n`,
  "case-array-prototype-call": DIR + `Array.prototype.unshift.call(module.paths, dir);\nconst lib = require("vuln-lib");\nlib.parse("x");\n`,
  "contrast-direct": DIR + `module.paths.unshift(dir);\nconst lib = require("vuln-lib");\nlib.parse("x");\n`,
  "positive-control": `const lib = require("vuln-lib");\nlib.parse("x");\n`,
  "negative-control": DIR + `const p = module.paths;\np.unshift(dir);\nconst lib = require("vuln-lib");\nlib.safe("x");\n`,
};
for (const [name, src] of Object.entries(variants)) {
  const dir = path.join(HERE, "cases", "paths", name);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, c] of Object.entries({ ...BASE, "src/index.js": src })) { const p = path.join(dir, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, c); }
  const loud = (cwd: string, spec: string) => execFileSync("node", ["-e", `const m=require('${spec}');const miss=['parse','safe'].filter(n=>typeof m[n]!=='function');if(miss.length){process.exit(3)}console.log('LOUD-OK')`], { cwd, encoding: "utf8", env: { ...process.env, VT_SILENT: "1" } }).trim();
  const l1 = loud(dir, "vuln-lib"); const l2 = loud(dir, "./node_modules/other/node_modules/vuln-lib");
  const out: string[] = [];
  const exit = await runScanCommand({ projectPathArg: dir, noCache: true, io: { stdout: (t) => out.push(t), stderr: () => {} },
    provider: { queryPackage: async (q: any) => (q.name === "vuln-lib" ? [{ id: "GHSA-paths", aliases: [], affected: [{ package: { ecosystem: "npm", name: "vuln-lib" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "99.0.0" }] }] }], references: [] }] : []) } });
  const j = JSON.parse(out.join(""));
  const fam = (e: any) => (e?.confirmedAbsentFromModuleLoadClosure ? "A" : e?.confirmedAbsentInstance ? "B" : e?.confirmedUnreachableTarget ? "C" : "-");
  console.log(`== paths / ${name}  loud: top=${l1} nested=${l2}  exit=${exit}`);
  for (const f of j.findings) console.log(`   ${f.packageInstance}: ${f.verdict} ${fam(f.evidence)} ${f.unknownReasons ? JSON.stringify(f.unknownReasons.map((u: any) => u.reason)) : ""}`);
  console.log(`   GT: ${execFileSync("node", ["src/index.js"], { cwd: dir, encoding: "utf8" }).trim().replace(/\n/g, ", ")}`);
}

intake2.ts (PRM-64/65/66, --cve, nameless workspace, node_modules ancestor, HTML; complete)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runScanCommand } from "../vt2/src/cli/scan.ts";
import { OsvProvider } from "../vt2/src/vulnerabilities/osv-provider.ts";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PS = `function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\nfunction parse(x){ hit("parse"); return "p"; }\nfunction safe(x){ hit("safe"); return "s"; }\nmodule.exports = { parse, safe };\n`;
const APP = `const lib = require("vuln-lib");\nlib.parse("x");\n`;
const RULES = (id: string, pkg = "vuln-lib") => `rules:\n  - id: ${id}\n    package:\n      name: ${pkg}\n    targets:\n      - module: ${pkg}\n        export: parse\n        kind: function\n        confidence: 1.0\n`;
const YML = `analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n`;
const adv = (id: string, name: string, intro = "0", fixed = "99.0.0", aliases: string[] = []) => ({ id, aliases,
  affected: [{ package: { ecosystem: "npm", name }, ranges: [{ type: "SEMVER", events: [{ introduced: intro }, { fixed }] }] }], references: [] });
function write(dir: string, files: Record<string, string>, links: Record<string, string> = {}) {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, c] of Object.entries(files)) { const p = path.join(dir, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, c); }
  for (const [rel, target] of Object.entries(links)) { const p = path.join(dir, rel); mkdirSync(path.dirname(p), { recursive: true }); symlinkSync(target, p); }
}
function loud(dir: string, pkg = "vuln-lib") {
  const r = execFileSync("node", ["-e", `const m=require('${pkg}');const miss=['parse','safe'].filter(n=>typeof m[n]!=='function');if(miss.length){console.log('LOUD-FAIL',miss);process.exit(3)}console.log('LOUD-OK',Object.keys(m).join(','))`], { cwd: dir, encoding: "utf8", env: { ...process.env, VT_SILENT: "1" } }).trim();
  if (!r.includes("LOUD-OK")) throw new Error("loud fixture assertion failed");
  return r;
}
async function scan(dir: string, provider: any, extra: Record<string, unknown> = {}) {
  const out: string[] = []; const err: string[] = [];
  const exit = await runScanCommand({ projectPathArg: dir, noCache: true, provider, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, ...extra } as any);
  const text = out.join(""); let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { exit, json, text, err: err.join("") };
}
const gt = (dir: string, args = ["src/index.js"]) => { try { return execFileSync("node", args, { cwd: dir, encoding: "utf8" }).trim() || "(nothing)"; } catch (e: any) { return `EXIT!=0 ${String(e.stderr).split("\n")[0]}`; } };
const brief = (j: any) => ({ findings: j?.findings?.map((f: any) => [f.vulnerability, f.packageInstance, f.version ?? null, f.verdict, f.unknownReasons?.map((u: any) => u.reason)]),
  unreported: j?.unreportedCandidates?.map((u: any) => [u.packageInstance ?? u.package, u.reason, u.detail?.slice(0, 90)]) });
const lock = (packages: Record<string, unknown>, rootDeps: Record<string, string>, extraRoot: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0", dependencies: rootDeps, ...extraRoot }, ...packages } }, null, 2);
const STD = (extra: Record<string, string> = {}) => ({
  "package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "vuln-lib": "1.0.0" } }),
  "package-lock.json": lock({ "node_modules/vuln-lib": { version: "1.0.0" } }, { "vuln-lib": "1.0.0" }),
  "node_modules/vuln-lib/package.json": JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }),
  "node_modules/vuln-lib/index.js": PS, "src/index.js": APP, "vulntrace.yml": YML, "rules.yml": RULES("GHSA-page-1"), ...extra });
const root = path.join(HERE, "cases", "intake");
const log = (...a: unknown[]) => console.log(...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))));
{ // PRM-65
  const dir = path.join(root, "prm65"); write(dir, STD({ "rules.yml": RULES("GHSA-page-1") + RULES("GHSA-page-2").replace("rules:\n", "") }));
  const requests: string[] = [];
  const fetchImpl = (async (_u: string, init: any) => { requests.push(init.body); const body = JSON.parse(init.body);
    const page = body.page_token === "NEXT" ? { vulns: [adv("GHSA-page-2", "vuln-lib")] }
      : body.package.name === "vuln-lib" ? { vulns: [adv("GHSA-page-1", "vuln-lib")], next_page_token: "NEXT" } : { vulns: [] };
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  const r = await scan(dir, new OsvProvider({ fetchImpl }));
  log("== PRM-65 case", loud(dir)); log("  requests:", requests); log("  exit:", r.exit, brief(r.json)); log("  GT:", gt(dir));
  const fetchAll = (async (_u: string, init: any) => new Response(JSON.stringify(JSON.parse(init.body).package.name === "vuln-lib" ? { vulns: [adv("GHSA-page-1", "vuln-lib"), adv("GHSA-page-2", "vuln-lib")] } : { vulns: [] }), { status: 200 })) as typeof fetch;
  const c = await scan(dir, new OsvProvider({ fetchImpl: fetchAll })); log("== PRM-65 control"); log("  exit:", c.exit, brief(c.json));
}
{ // PRM-64 and --cve
  const dir = path.join(root, "prm64");
  write(dir, {
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    "package-lock.json": JSON.stringify({ name: "root", lockfileVersion: 3, requires: true, packages: {
      "": { name: "root", workspaces: ["packages/*"] }, "node_modules/app": { resolved: "packages/app", link: true },
      "node_modules/foo": { resolved: "packages/foo", link: true }, "node_modules/bar": { version: "1.0.0", dependencies: { foo: "1.0.0" } },
      "node_modules/bar/node_modules/foo": { version: "1.0.0" }, "packages/app": { version: "1.0.0", dependencies: { bar: "1.0.0" } }, "packages/foo": {} } }),
    "packages/foo/package.json": JSON.stringify({ name: "foo" }), "packages/foo/index.js": PS,
    "packages/app/package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { bar: "1.0.0" } }),
    "node_modules/bar/package.json": JSON.stringify({ name: "bar", version: "1.0.0" }), "node_modules/bar/node_modules/foo/package.json": JSON.stringify({ name: "foo", version: "1.0.0" }),
    "node_modules/bar/node_modules/foo/index.js": PS,
  }, { "node_modules/foo": "../packages/foo", "node_modules/app": "../packages/app" });
  const all = [adv("GHSA-x", "foo", "0", "2.0.0", ["CVE-X"]), adv("GHSA-y", "foo", "3.0.0", "3.1.0", ["CVE-Y"])];
  const queried: string[] = [];
  const osvLike = { queryPackage: async (q: any) => { queried.push(`${q.name}@${q.version ?? "<none>"}`); if (q.name !== "foo") return []; if (!q.version) return all;
    const [maj] = q.version.split(".").map(Number); return all.filter((a) => { const e = a.affected[0].ranges[0].events as any[]; return maj >= Number(e[0].introduced.split(".")[0]) && q.version < e[1].fixed; }); } };
  const r = await scan(dir, osvLike);
  log("== PRM-64 case", loud(dir, "foo")); log("  queried:", queried); log("  exit:", r.exit, brief(r.json));
  log("  control: an unversioned query for foo returns", (await osvLike.queryPackage({ name: "foo", ecosystem: "npm" })).map((a: any) => a.id));
  for (const f of ["CVE-Y", "", "cve-x", "CVE-NOPE"]) { const c = await scan(dir, osvLike, { cveFilter: f }); log(`== --cve ${JSON.stringify(f)}`); log("  exit:", c.exit, brief(c.json), "stderr:", c.err); }
}
for (const variant of ["versioned-lock", "versionless-lock"]) { // PRM-66
  const mk = (manifest: string) => ({
    "package.json": JSON.stringify({ name: "app", version: "1.0.0", workspaces: ["packages/*"] }),
    "package-lock.json": lock({ "node_modules/bad": { resolved: "packages/bad", link: true }, "packages/bad": variant === "versioned-lock" ? { name: "bad", version: "1.0.0" } : {} }, {}, { workspaces: ["packages/*"] }),
    "packages/bad/package.json": manifest, "packages/bad/index.js": PS,
    "src/index.js": `const b = require("../packages/bad/index.js");\nb.parse("x");\n`, "vulntrace.yml": YML, "rules.yml": RULES("GHSA-bad", "bad") });
  const prov = { queryPackage: async (q: any) => (q.name === "bad" ? [adv("GHSA-bad", "bad")] : []) };
  const dir = path.join(root, `prm66-${variant}`); write(dir, mk(`{"name": "bad", "version": "1.0.0",\n`), { "node_modules/bad": "../packages/bad" });
  const r = await scan(dir, prov); log(`== PRM-66 ${variant}`); log("  exit:", r.exit, brief(r.json)); log("  GT:", gt(dir));
  const cdir = path.join(root, `prm66-${variant}-control`); write(cdir, mk(JSON.stringify({ name: "bad", version: "1.0.0" })), { "node_modules/bad": "../packages/bad" });
  const c = await scan(cdir, prov); log(`== PRM-66 ${variant} control (valid manifest)`); log("  exit:", c.exit, brief(c.json));
}
{ // nameless workspace named like a real dependency
  const dir = path.join(root, "p4-nameless-workspace");
  write(dir, { ...STD(), "package.json": JSON.stringify({ name: "app", version: "1.0.0", workspaces: ["packages/*"], dependencies: { "vuln-lib": "1.0.0" } }),
    "package-lock.json": lock({ "node_modules/vuln-lib": { version: "1.0.0" }, "packages/vuln-lib": { version: "2.0.0" } }, { "vuln-lib": "1.0.0" }, { workspaces: ["packages/*"] }),
    "packages/vuln-lib/package.json": JSON.stringify({ version: "2.0.0" }), "packages/vuln-lib/index.js": `module.exports = { parse() {}, safe() {} };\n`, "rules.yml": RULES("GHSA-ws") });
  const r = await scan(dir, { queryPackage: async (q: any) => (q.name === "vuln-lib" ? [adv("GHSA-ws", "vuln-lib")] : []) });
  log("== P4 nameless workspace", loud(dir)); log("  exit:", r.exit, brief(r.json)); log("  GT:", gt(dir));
}
for (const where of ["nm-ancestor/node_modules/app", "nm-control/plain/app"]) { // identity under node_modules ancestor
  const dir = path.join(root, where);
  write(dir, {
    "package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "vuln-lib": "file:packages/vuln-lib" } }),
    "package-lock.json": lock({ "node_modules/vuln-lib": { resolved: "packages/vuln-lib", link: true }, "packages/vuln-lib": { name: "vuln-lib", version: "1.0.0" } }, { "vuln-lib": "file:packages/vuln-lib" }),
    "packages/vuln-lib/package.json": JSON.stringify({ name: "vuln-lib", version: "1.0.0", main: "index.js" }), "packages/vuln-lib/index.js": PS,
    "src/index.js": APP, "vulntrace.yml": YML, "rules.yml": RULES("GHSA-nm") }, { "node_modules/vuln-lib": "../packages/vuln-lib" });
  const r = await scan(dir, { queryPackage: async (q: any) => (q.name === "vuln-lib" ? [adv("GHSA-nm", "vuln-lib")] : []) });
  log(`== identity ${where}`, loud(dir)); log("  exit:", r.exit, brief(r.json)); log("  GT:", gt(dir));
}
{ // HTML "no reason recorded"
  const prov = { queryPackage: async (q: any) => (q.name === "vuln-lib" ? [adv("GHSA-html", "vuln-lib")] : []) };
  const dir = path.join(root, "html-no-reason"); write(dir, STD({ "rules.yml": RULES("GHSA-other-9999") }));
  const out = path.join(dir, "report.html"); const r = await scan(dir, prov, { format: "html", outputPath: out });
  const j = await scan(dir, prov); log("== HTML case", loud(dir)); log("  exit:", r.exit, "json:", brief(j.json));
  log("  html summary cells:", [...readFileSync(out, "utf8").matchAll(/<td class="summary">(.*?)<\/td>/g)].map((m) => m[1]));
  const d2 = path.join(root, "html-control"); write(d2, STD({ "rules.yml": RULES("GHSA-html") }));
  await scan(d2, prov, { format: "html", outputPath: path.join(d2, "report.html") });
  log("  control html summary cells:", [...readFileSync(path.join(d2, "report.html"), "utf8").matchAll(/<td class="summary">(.*?)<\/td>/g)].map((m) => m[1]));
}

Results for each FALSE entry

All results are measured. Every case below is reachable on main today. For "tests", I grepped src/ and tests/ for each reproduced shape.

PRM: 101
Case → analyzer: local barrel → NOT_AFFECTED C, exit 0; dependency wrapper → NOT_AFFECTED C
node ground truth: CALLED parse (top-level code)
Positive control: import "vuln-lib" → AFFECTED
Negative control: quiet library → NOT_AFFECTED C (correct)
Contrast: —
Tests: verdict.site-b-target-authority.integration.test.ts:375 asserts Site B's phantom NOT_AFFECTED for a truly unimported package (a legitimate case); nothing covers loaded-via-export *
────────────────────────────────────────
PRM: 102
Case → analyzer: NOT_AFFECTED C
node ground truth: CALLED parse
Positive control: manifest name vuln-lib → AFFECTED
Negative control: NOT_AFFECTED C
Contrast: my simpler shape (direct function export) was a correct AFFECTED
Tests: none
────────────────────────────────────────
PRM: 103
Case → analyzer: whole-module and property → NOT_AFFECTED C
node ground truth: CALLED run->danger, CALLED parse
Positive control: AFFECTED
Negative control: NOT_AFFECTED C
Contrast: —
Tests: none (FINDINGS:2157 is about throwing class keys)
────────────────────────────────────────
PRM: 104
Case → analyzer: direct and deferred write → NOT_AFFECTED C
node ground truth: CALLED parse
Positive control: AFFECTED
Negative control: NOT_AFFECTED C
Contrast: —
Tests: none
────────────────────────────────────────
PRM: 105/109 (= PRM-60)
Case → analyzer: [require][0], [require].at(0), [Function][0], Function via computed key, Reflect.get → NOT_AFFECTED A
node ground truth: CALLED parse
Positive control: AFFECTED
Negative control: NOT_AFFECTED A
Contrast: (function(){}).constructor → UNKNOWN function_constructor; 20 other shapes are held
Tests: none for these shapes
────────────────────────────────────────
PRM: 106
Case → analyzer: require.bind(null) → NOT_AFFECTED A
node ground truth: CALLED parse
Positive control: AFFECTED
Negative control: NOT_AFFECTED A
Contrast: —
Tests: none
────────────────────────────────────────
PRM: 107
Case → analyzer: alias and Array.prototype.unshift.call → nested instance NOT_AFFECTED B, top instance AFFECTED
node ground truth: CALLED parse [nested]
Positive control: top AFFECTED, nested B (correct)
Negative control: nested B (correct)
Contrast: direct module.paths.unshift → nested UNKNOWN
Tests: none
────────────────────────────────────────
PRM: 108
Case → analyzer: { "fork": f } and { ["fork"]: f } → NOT_AFFECTED A
node ground truth: CALLED parse (forked worker)
Positive control: AFFECTED
Negative control: NOT_AFFECTED A
Contrast: { fork: f } → UNKNOWN child_process_execution
Tests: none
────────────────────────────────────────
PRM: 110
Case → analyzer: UNKNOWN (no_vulnerable_symbol_rule) rendered as "no reason recorded"
node ground truth: JSON carries unknownReasons
Positive control: AFFECTED rendered as "vulnerable symbol resolved"
Negative control: —
Contrast: —
Tests: none
────────────────────────────────────────
PRM: 111
Case → analyzer: --cve "" → findings [], exit 0, empty stderr
node ground truth: provider did return GHSA-x
Positive control: no filter → findings present
Negative control: --cve CVE-NOPE → same empty result, no signal
Contrast: cve-x does not match CVE-X
Tests: none
────────────────────────────────────────
PRM: 112–116
Case → analyzer: NOT_AFFECTED C each
node ground truth: CALLED parse
Positive control: AFFECTED
Negative control: NOT_AFFECTED C
Contrast: —
Tests: none

Realism notes:
- PRM-102 needs a lockfile entry with no name whose manifest name differs. npm writes name for aliases, so this arises from hand-edited or other lockfiles.
- PRM-116 needs a JSX factory that invokes the component, which is the normal case for real renderers.

5. PRM-60 TO PRM-67

- PRM-60 FALSE (module-load-closure.ts:531-536; same premise at graph.ts:110-115 and 307-314): "their uncertainty is bounded to values and modules already discovered, so they could not load a new module even if it did."
  - 22 capability-routing shapes were tested. 20 are held: the closure goes incomplete, or loader_capability_escape fires.
  - literal-receiver and bind give a family-A false NOT_AFFECTED.
  - Four more do too: [require].at(0), [Function][0], and Function fetched by computed key or by Reflect.get.
  - Root causes are PRM-105 and PRM-106.
- PRM-61 FALSE (export-forwarding.ts:108-113 takes the first own binding):
  - Stale exports after module.exports is replaced gives family C. So does a property written before the replacement (clean negative control).
  - In the first run of that second shape, the original negative control produced a false AFFECTED: it hopped to a, while Node runs b.
- PRM-62 FALSE (module-model.ts:5000-5011): ESM function-expression export attribution now exists (positive control AFFECTED). export let run = …; run = … and a configure() reassignment both give family C.
- PRM-63 FALSE across shapes:
  - Compensated, giving UNKNOWN loader_capability_escape: module["exports"] = …, module[k] = …, Object.assign(module, …), Reflect.set(module, …).
  - Not compensated, giving family-C false NOT_AFFECTED: module["exports"].run = … and module.exports["run"] = … (PRM-30 mechanism), const m = module; m.exports = … (PRM-32 mechanism), and Object.assign(module.exports, { run }) (new shape).
- PRM-64 FALSE (silent drop) (package-instances.ts:657-662):
  - Queries were foo@1.0.0 only, so packages/foo is evaluated against GHSA-x alone.
  - GHSA-y, which an unversioned query returns, is never considered and nothing records it.
  - This rests on OSV's documented per-version filtering, which the synthetic provider models.
- PRM-65 FALSE (silent drop) (osv-provider.ts:13-18, not the cited ~340–349):
  - The real OsvProvider sends a single request with no page_token.
  - GHSA-page-2 appears nowhere, exit 1 on page 1 only. The unpaged control reports both.
  - Depends on OSV emitting next_page_token, which OSV documents for large result sets.
- PRM-66 FALSE only for a versionless lock entry (silent drop) (workspaces.ts:245-270):
  - Versioned lock: recorded as installed_manifest_untrusted. TRUE.
  - Versionless lock: findings [], unreported [], while the valid-manifest control is AFFECTED.
  - Node refuses to load the package (ERR_INVALID_PACKAGE_CONFIG), so there is no runtime exposure. It is still a contract violation.
- PRM-67 FALSE (false scope statement) (evidence.ts:302-309):
  - node --conditions=custom loads vuln.js and calls parse. node --import ./preload.mjs also calls parse.
  - Both scans give family-A NOT_AFFECTED, and neither flag is in SUPPORTED_MODEL_EXCLUSIONS.
  - Plain node on the same fixture calls nothing, so the verdict is right for default runtime settings. What is false is the disclosure.

6. IMPLICIT-INVOCATION TABLE

Every case has an AFFECTED positive control and a negative control that matches its ground truth.

┌────────────────────────────────────────────────┬─────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                   Mechanism                    │                   Result                    │                                              Analyzer / node                                               │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ with                                           │ held                                        │ UNKNOWN / CALLED parse                                                                                     │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ arguments aliasing                             │ reproduced, KNOWN PRM-17                    │ C / CALLED parse                                                                                           │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ .call.call chain                               │ reproduced, KNOWN PRM-20                    │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Function.prototype.apply.call                  │ reproduced, KNOWN AUD-01                    │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Reflect.apply / Reflect.construct              │ reproduced, KNOWN AUD-01                    │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ defineProperty getter / setter (function       │ reproduced, KNOWN AUD-01                    │ C / parse                                                                                                  │
│ expression)                                    │                                             │                                                                                                            │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ object-literal getter                          │ held (TRUE, round-1 PRM-46)                 │ AFFECTED                                                                                                   │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Symbol.hasInstance                             │ reproduced, new PRM-112                     │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Symbol.asyncIterator (for await)               │ reproduced, new PRM-113                     │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ spread, destructuring, yield*, Array.from      │ reproduced, KNOWN (round-1 iterator)        │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Proxy traps                                    │ reproduced, KNOWN AUD-01                    │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ toJSON                                         │ reproduced, KNOWN AUD-01                    │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FinalizationRegistry                           │ held                                        │ UNKNOWN. Node's callback did not fire in the run, even with --expose-gc and 20 GC cycles, but the analyzer │
│                                                │                                             │  does not claim NOT_AFFECTED.                                                                              │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Atomics.waitAsync                              │ held                                        │ AFFECTED                                                                                                   │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Error.prepareStackTrace                        │ reproduced, new PRM-114                     │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ EventEmitter emit / subclass                   │ held                                        │ UNKNOWN / AFFECTED                                                                                         │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ stream Readable({read})                        │ reproduced, KNOWN PRM-12/13                 │ C / parse                                                                                                  │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ stream Writable({write})                       │ held                                        │ UNKNOWN                                                                                                    │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ TS decorators (legacy, standard)               │ reproduced, new PRM-115; the analyzer does  │ C / parse (tsc output run in Node)                                                                         │
│                                                │ parse .ts                                   │                                                                                                            │
├────────────────────────────────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ JSX with a calling factory                     │ reproduced, new PRM-116; the analyzer does  │ C / parse                                                                                                  │
│                                                │ parse .tsx                                  │                                                                                                            │
└────────────────────────────────────────────────┴─────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

7. UNCOMMENTED FAIL-OPEN BRANCHES (priority-1 files)

- named-bindings.ts:1243-1244: a FunctionDeclaration binding is returned with no reassignment check (PRM-104).
- loader-constructs.ts:608-622 memberAccessOf: a numeric-literal key yields name: undefined. For a non-capability receiver such as an array literal, the result is undefined rather than failing closed (PRM-105).
- loader-constructs.ts resolveLoaderCapability: there is no kind for module.paths, so aliases and Array.prototype calls on it are lost (PRM-107).
- source-index.ts:433-437: importedName falls back to the local name (PRM-108).
- verdict.ts:1022-1034: the Site B phantom has no closure corroboration (PRM-101). The key is the package name, not the instance (PRM-102).
- html-report.ts:345-347: summaryOf ignores unknownReasons (PRM-110).
- run.ts:84-88: an empty --cve value is accepted (PRM-111).
- analysis/index.ts:14: buildModuleLoadClosure is exported (latent, U-4).
- module-model.ts 2481-2567: the abrupt-completion default normal. Precision only (U-3).

8. SUSPICIONS (not reproduced)

- U-1 attemptSiblingRuntimeFile: settle with a package where noDts resolution fails but a runtime sibling exists.
- U-2 identity under a node_modules ancestor: my fixture fails closed. Try a Site A shape, where a call graph node exists, or a workspace-linked member.
- U-3 labeled-break / try-catch cutoff: settle with an end-to-end AFFECTED control that turns UNKNOWN.
- U-4: needs a non-scan caller. None exists.
- eval stored in a composite and called (t.e(src)): held (UNKNOWN) in both forms I tried, although isAuthoritativeCapabilityValue excludes eval (loader-constructs ~1925-1938). Other composite shapes may slip through.
- FinalizationRegistry: the analyzer holds, but I could not get Node to run the callback.

9. COVERAGE

- Exhausted by me:
  - loader-constructs.ts 1759–3142 (1–1759 in round 1, so the whole file).
  - named-bindings.ts 978–1397 (1–980 in round 1, so the whole file).
  - source-index.ts 95–929 (1–94, the type declarations, not read).
- Exhausted by sweep C: graph.ts 1–446, resolved-target.ts 1–796, module-model.ts 2395–4509, plus the consumer regions listed in its report.
- Exhausted by sweep D:
  - analysis-context.ts, scan-caches.ts, uncertainty.ts
  - domain/coverage.ts, entrypoint.ts
  - cli/html-report.ts 1–1353, rules-validate.ts, io.ts, errors.ts
  - every index.ts
  - verdict.ts 1–1040 and 1930–2086
- Partial: module-resolver.ts (U-1 region only, re-read), run.ts (--cve guard), osv-provider.ts (1–111 read).
- Not reached:
  - module-model.ts 2240–2395
  - source-index.ts 1–94
  - sweep C's unread helper definitions (resolveExactLocalCallable, resolveInvocationTargetIdentity, isCaughtWithin)

10. FIX-LANE MAPPING

┌─────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
│                            Lane                             │                                  New FALSE findings                                   │
├─────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ A call graph                                                │ PRM-104, PRM-108 (origin; consumer in C), PRM-112, PRM-113, PRM-114, PRM-115, PRM-116 │
├─────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ E export model                                              │ PRM-103, PRM-61, PRM-62, PRM-63 (Object.assign(module.exports) shape)                 │
├─────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ C closure and resolution                                    │ PRM-60 / PRM-105 / PRM-109, PRM-106, PRM-107                                          │
├─────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ B intake, cache, output                                     │ PRM-64, PRM-65, PRM-66, PRM-110, PRM-111                                              │
├─────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ V (new lane: verdict and target resolution, verdict.ts)     │ PRM-101, PRM-102                                                                      │
├─────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ D (new lane: model disclosure, domain/evidence.ts and docs) │ PRM-67                                                                                │
└─────────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘

11. PROPOSED TASKS (not implemented)

- PRM-101: at Site B, issue a phantom-based family C only when the complete closure also lacks packageInstance (the same corroboration family B needs). Otherwise return UNKNOWN. Failing-first test: r2-phantom-export-star-barrel (both variants).
- PRM-102: choose Site A or B by whether any graph node belongs to the exact packageInstance, not by package name. Test: r2-siteB-name-mismatch-forwarded.
- PRM-103: withdraw export attribution (or add every earlier module-scope write as a candidate) when a require of a file that can reach this module back sits between the writes. Test: r2-cyclic-observer-*.
- PRM-104: apply isAssignedWithin(scope, name) to FunctionDeclaration bindings, as the class and function-expression branches already do. Test: r2-function-declaration-reassigned.
- PRM-105 / PRM-60 / PRM-109: in valueFlowOperandsOf, stop treating member access and call results as opaque when the receiver or callee contains or is a capability. Resolve numeric-literal element keys, and treat .bind/.at/array-method results of a capability as that capability. Correct the graph.ts and module-load-closure.ts comments. Tests: p2-60-literal-receiver, r2-esc-*, r2-function-ctor-computed-key.
- PRM-106: treat require as a capability receiver for unknown members (bind above all). Test: p2-60-bind.
- PRM-107: make module.paths a resolvable capability kind, so aliases and Array.prototype.<mutator>.call(module.paths, …) classify as loader_hook_mutation. Test: paths2 (both cases).
- PRM-108: record importedName from string-literal keys, and refuse computed keys in extractRequireBindings. Correct symbol-binder.ts:269-271. Test: r2-builtin-destructure-string-key.
- PRM-61: order the forwarding hop by module.exports replacement: a property written to a stale exports does not forward. Test: p2-61-*, r2-61-*.
- PRM-62: refuse ESM let/var export attribution when the binding is assigned anywhere. Test: p2-62-*.
- PRM-63: treat Object.assign(module.exports, …), bracket member writes and module-alias exports writes as export writes, or as attribution withdrawal. Test: p2-63-*.
- PRM-64: query without a version for versionless instances, or record an unreportedCandidates entry stating that only sibling-version advisories were evaluated. Test: intake PRM-64.
- PRM-65: follow next_page_token until exhausted, or fail closed. Test: intake PRM-65, using the real OsvProvider with a paging fetch.
- PRM-66: record an identity entry for a workspace whose manifest is malformed, even when it is versionless. Test: intake PRM-66 versionless-lock.
- PRM-67: add --import/--experimental-loader preloads and --conditions to SUPPORTED_MODEL_EXCLUSIONS, or model conditions. Test: p2-67-* (a disclosure assertion).
- PRM-110: fall back to the first unknownReasons entry in the HTML summary. Test: intake HTML.
- PRM-111: reject an empty --cve. Consider reporting when a filter matches nothing. Test: intake --cve "".
- PRM-112 / PRM-113: emit an unknown edge (or a resolved one to the method) for instanceof against a class with [Symbol.hasInstance], and for for await over values with [Symbol.asyncIterator]. Tests: p3-symbol-*.
- PRM-114: treat an assignment to Error.prepareStackTrace (and similar hook properties on builtins) as registering a callable. Test: p3-prepareStackTrace.
- PRM-115: model decorators as calls at class-definition time. Test: p3-ts-decorator-*.
- PRM-116: model JSX elements as calls to the configured factory (jsxFactory/jsxImportSource). Test: p3-tsx-jsx-factory.

12. PREMISES IN THE PROMPT I CHECKED

┌──────────────────────────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                Claim                                                 │                                               Result                                               │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ "Main may have moved since" round 1                                                                  │ Did not move. It is still 62b52b9.                                                                 │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ loader-constructs ~1760–3142, named-bindings ~980–1397, module-model ~2600–4400, verdict 1–1040 and  │ TRUE (region line counts confirmed).                                                               │
│ ~1930–end                                                                                            │                                                                                                    │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-60 at module-load-closure.ts ~576–580                                                            │ Off. The text is at 531–536.                                                                       │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-61 export-forwarding.ts ~92–113                                                                  │ TRUE.                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-62 module-model.ts ~5000–5011                                                                    │ TRUE.                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-64 package-instances.ts ~659–662                                                                 │ TRUE (657–662).                                                                                    │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-65 osv-provider.ts ~340–349                                                                      │ FALSE. The file has 111 lines; the comment is at 13–18. This error came from round 1's sweep, and  │
│                                                                                                      │ I carried it.                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-66 workspaces.ts ~245–281                                                                        │ TRUE.                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-67 evidence.ts ~302–309                                                                          │ TRUE.                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ loader-constructs.ts ~162 suspicion                                                                  │ TRUE location. Confirmed as FALSE end to end (PRM-21/22 mechanism).                                │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ scan.ts ~470–472 basename                                                                            │ TRUE location. Held end to end.                                                                    │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ "Round 1 reproduced coercion (toString/valueOf/Symbol.toPrimitive)"                                  │ Partly false. Round 1 reproduced toString coercion only.                                           │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PRM-11 listed as "FALSE, reproduced"                                                                 │ Imprecise. Round 1 classified it KNOWN (RWF-047); it was reproduced, not new.                      │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AUD-01…16 identifiers                                                                                │ Not in the repository. I took them on the prompt's authority.                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────┘

13. ACCEPTANCE

- yes: Nothing committed, pushed, branched or edited.
- yes: Every entry has file:line and a verbatim quote or "(uncommented)".
- yes: Every FALSE entry has a full inline reproduction, ground truth and both controls. PRM-110 and PRM-111 use output-level controls.
- yes: Every reproduction asserts the loud-fixture property. Totals: 81 + 111 + 25 + 7 + 12 + 4 + 5, plus the inline asserts in the intake and paths scripts, with 0 failures.
- yes: Section-3 items are marked KNOWN, not re-reported.
- yes: PRM-60 to PRM-67 are all settled FALSE. For PRM-66 the premise is TRUE for a versioned lock.
- yes: Every priority-3 mechanism has a result.
- yes (§9): Coverage states exactly what was exhausted, partial, or not reached.
- yes (§10): Every new FALSE finding is mapped to a fix lane.

result: Round 2 found 16 new false premises (PRM-101…116) and settled PRM-60 to PRM-67, all eight FALSE, each reproduced through the real scan against real Node. Most give a false NOT_AFFECTED; the worst fires on ordinary code (a package loaded only via export * is certified unreachable). OSV pagination, version-only queries and malformed workspace manifests cause three new silent drops. Nothing in the repository was changed.
