import { execFileSync } from "node:child_process";

/**
 * THE LOUD-FIXTURE GUARANTEE (AGENTS.md § G, "Loud fixtures").
 *
 * A reproduction fixture that does not actually export the name(s) a
 * case's rule or probe attributes a call to can pass for the wrong
 * reason: a fabricated attribution against a name the package never
 * exports degrades to `unresolved_target` and reads as an honest
 * `UNKNOWN`, exactly the failure mode that let the RWF-046 array-hole
 * defect (`const [, run] = require("pkg")` resolving to `pkg#run`)
 * survive a green suite (see tests/binding-grammar/harness.ts's own
 * comment). "Twice in this project a loud-fixture claim stated in prose
 * was false" (task H-0's own words) is why this is asserted in REAL
 * NODE, every time, rather than trusted from the fixture author's
 * intent.
 *
 * `boundNames` is a non-empty tuple, not `readonly string[]`: a case with
 * no bound names literally does not type-check, so "forgot to declare
 * what this fixture is loud about" is a compile error, not a runtime gap.
 */
export interface LoudFixtureCheck {
  /** The bare specifier real Node resolves, e.g. `"vuln-lib"` or `"./node_modules/other/node_modules/vuln-lib"`. */
  readonly specifier: string;
  /** Every name the case's rule(s) or probe(s) attribute a call to. Must be non-empty. */
  readonly boundNames: readonly [string, ...string[]];
  /** `true` loads via dynamic `import()`; the default `require()`. */
  readonly esm?: boolean;
}

export class LoudFixtureViolation extends Error {
  constructor(
    readonly specifier: string,
    readonly missing: readonly string[],
  ) {
    super(
      `loud-fixture violation: ${specifier} does not export a FUNCTION for ${JSON.stringify(missing)} -- ` +
        `a fabricated attribution against these names would degrade to an honest-looking UNKNOWN instead of failing loudly`,
    );
    this.name = "LoudFixtureViolation";
  }
}

export interface LoudFixtureResult {
  readonly specifier: string;
  /** Every enumerable own key of the loaded module, sorted -- for diagnostics, not asserted on directly. */
  readonly exportedNames: readonly string[];
}

/**
 * Loads `check.specifier` in a REAL, separate Node process rooted at
 * `projectDir` and throws {@link LoudFixtureViolation} unless every one of
 * `check.boundNames` is, at that moment, a function. Returns the sorted
 * list of every name the module actually exports when the check passes.
 *
 * A separate process (not `vm`, not this process's own `require`) is
 * deliberate: it is the same real-Node ground truth every other part of
 * this harness rests on, it can load ESM without this process's own
 * module system getting in the way, and a crash in the probed module
 * (a fixture that throws at load time) surfaces as a normal thrown error
 * here rather than corrupting this process's module cache.
 */
export function assertLoudFixture(
  projectDir: string,
  check: LoudFixtureCheck,
): LoudFixtureResult {
  const boundNamesJson = JSON.stringify(check.boundNames);
  const specifierJson = JSON.stringify(check.specifier);
  const probe = check.esm
    ? `import(${specifierJson}).then(m => { ` +
      `const miss = ${boundNamesJson}.filter(n => typeof m[n] !== "function"); ` +
      `console.log(JSON.stringify({ miss, names: Object.keys(m).sort() })); ` +
      `}, e => { console.log(JSON.stringify({ error: String(e && e.message || e) })); })`
    : `try { ` +
      `const m = require(${specifierJson}); ` +
      `const miss = ${boundNamesJson}.filter(n => typeof m[n] !== "function"); ` +
      `console.log(JSON.stringify({ miss, names: Object.keys(m).sort() })); ` +
      `} catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); }`;

  let raw: string;
  try {
    raw = execFileSync("node", ["-e", probe], {
      cwd: projectDir,
      encoding: "utf-8",
      env: { ...process.env, VT_SILENT: "1" },
      timeout: 15_000,
    }).trim();
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new LoudFixtureViolation(check.specifier, [
      `<process failure: ${failure.stderr?.trim() ?? failure.stdout?.trim() ?? String(error)}>`,
    ]);
  }

  const lastLine = raw.split("\n").at(-1) ?? raw;
  const parsed = JSON.parse(lastLine) as {
    miss?: string[];
    names?: string[];
    error?: string;
  };
  if (parsed.error !== undefined) {
    throw new LoudFixtureViolation(check.specifier, [
      `<load failure: ${parsed.error}>`,
    ]);
  }
  if (parsed.miss && parsed.miss.length > 0) {
    throw new LoudFixtureViolation(check.specifier, parsed.miss);
  }
  return { specifier: check.specifier, exportedNames: parsed.names ?? [] };
}
