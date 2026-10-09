import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_BRAND_ASSERTIONS,
  ALLOWED_RESOLUTION_CALLS,
  BRAND_FILE,
  findRuntimeResolution,
  type BrandAssertion,
  type ResolutionCall,
} from "./runtime-resolution-census.js";

/**
 * ADR 0010 § 2's runtime-resolution census, the structural gate of task
 * C-1 (Foundation invariant `VT-INV-C-runtime-resolution`). See
 * `runtime-resolution-census.ts` for what counts.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function callKey(call: ResolutionCall): string {
  return `${call.file} # ${call.enclosing} # ${call.api} # ${call.branded ? "branded" : "UNBRANDED"}`;
}

function assertionKey(assertion: BrandAssertion): string {
  return `${assertion.file} # ${assertion.enclosing}`;
}

describe("the runtime-resolution census (ADR 0010 § 2, task C-1)", () => {
  it("every TypeScript resolution call in production receives Node's branded options, and only the producer asserts the brand", () => {
    const found = findRuntimeResolution(REPO_ROOT);
    expect(
      found.calls.map(callKey),
      "a production call reaches TypeScript's module resolution outside module-resolver.ts's runtime path, or with options not built by nodeResolutionOptions: resolve through createModuleResolver instead (ADR 0010 invariant C2)",
    ).toEqual(ALLOWED_RESOLUTION_CALLS.map(callKey));
    expect(
      found.assertions.map(assertionKey),
      "a production type assertion produces NodeResolutionOptions outside nodeResolutionOptions",
    ).toEqual(ALLOWED_BRAND_ASSERTIONS.map(assertionKey));
  });

  it("cannot go blind: finds each kind of call and assertion planted in a scratch tree", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "vulntrace-c1-census-"));
    try {
      mkdirSync(path.join(scratch, "src/code-intelligence"), {
        recursive: true,
      });
      mkdirSync(path.join(scratch, "src/analysis"), { recursive: true });
      mkdirSync(path.join(scratch, "src/testing"), { recursive: true });
      copyFileSync(
        path.join(REPO_ROOT, BRAND_FILE),
        path.join(scratch, BRAND_FILE),
      );
      copyFileSync(
        path.join(REPO_ROOT, "src/code-intelligence/ts-project.ts"),
        path.join(scratch, "src/code-intelligence/ts-project.ts"),
      );
      copyFileSync(
        path.join(REPO_ROOT, "src/code-intelligence/ts-project-errors.ts"),
        path.join(scratch, "src/code-intelligence/ts-project-errors.ts"),
      );
      writeFileSync(
        path.join(scratch, "src/analysis/planted.ts"),
        [
          'import ts from "typescript";',
          'import type { NodeResolutionOptions } from "../code-intelligence/module-resolver.js";',
          "export function direct(o: ts.CompilerOptions): unknown {",
          '  return ts.resolveModuleName("x", "/a.js", o, ts.sys);',
          "}",
          "export function aliased(o: ts.CompilerOptions): unknown {",
          "  const r = ts.resolveModuleName;",
          '  return r("x", "/a.js", o, ts.sys);',
          "}",
          "export function format(o: ts.CompilerOptions): unknown {",
          '  return ts.getImpliedNodeFormatForFile("/a.js", undefined, ts.sys, o);',
          "}",
          "export function program(): unknown {",
          '  return ts.createProgram(["/a.ts"], {});',
          "}",
          "export function cached(c: ts.ModuleResolutionCache): unknown {",
          '  return ts.resolveModuleNameFromCache("x", "/a.js", c);',
          "}",
          "export function forged(o: ts.CompilerOptions): NodeResolutionOptions {",
          "  return o as NodeResolutionOptions;",
          "}",
          "export function laundered(o: NodeResolutionOptions): unknown {",
          '  return ts.resolveModuleName("x", "/a.js", o, ts.sys);',
          "}",
          "",
        ].join("\n"),
      );
      // A test file and src/testing are not production: never scanned.
      writeFileSync(
        path.join(scratch, "src/analysis/planted.test.ts"),
        'import ts from "typescript";\nexport const p = ts.createProgram([], {});\n',
      );
      writeFileSync(
        path.join(scratch, "src/testing/helper.ts"),
        'import ts from "typescript";\nexport const p = ts.createProgram([], {});\n',
      );

      const found = findRuntimeResolution(scratch);
      expect(found.calls.map(callKey)).toEqual([
        "src/analysis/planted.ts # direct # resolveModuleName # UNBRANDED",
        "src/analysis/planted.ts # aliased # resolveModuleName # UNBRANDED",
        "src/analysis/planted.ts # format # getImpliedNodeFormatForFile # UNBRANDED",
        "src/analysis/planted.ts # program # createProgram # UNBRANDED",
        "src/analysis/planted.ts # cached # resolveModuleNameFromCache # UNBRANDED",
        // Branded options, but outside module-resolver.ts's runtime path:
        // the census lists it, and the production allowlist does not.
        "src/analysis/planted.ts # laundered # resolveModuleName # branded",
        ...ALLOWED_RESOLUTION_CALLS.map(callKey),
      ]);
      expect(found.assertions.map(assertionKey)).toEqual([
        "src/analysis/planted.ts # forged",
        ...ALLOWED_BRAND_ASSERTIONS.map(assertionKey),
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
