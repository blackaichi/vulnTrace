import ts from "typescript";

/**
 * Compiles one TypeScript/TSX source with THIS REPOSITORY'S OWN
 * `typescript` package (task H-0 step 1: "TypeScript / TSX sources
 * compiled with the repository's own TypeScript for ground truth, when
 * Node cannot run the source directly") -- the same package
 * `src/code-intelligence/ts-project.ts` uses to analyze a scanned
 * project, so a case's real-Node ground truth is compiled by the exact
 * TypeScript semantics the analyzer itself is built against, never a
 * second, possibly-drifted copy.
 *
 * Returns only the emitted JavaScript text; the case decides where to
 * write it (see docs/audits/2026-09-premise-sweep-round-2.md's
 * `allcases2.mjs` `tsCase` helper, which this mirrors: source under
 * `src/`, compiled output under `dist/`, ground truth runs `dist/`).
 */
export function compileTypeScript(
  source: string,
  fileName: string,
  compilerOptions?: ts.CompilerOptions,
): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      ...compilerOptions,
    },
    fileName,
  });
  return result.outputText;
}
