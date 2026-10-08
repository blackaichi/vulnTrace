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
  ALLOWED_PROOF_INPUT_CASTS,
  findProofInputCasts,
  type ProofInputCast,
} from "./proof-input-casts.js";

/**
 * ADR 0011 § 2's proof-input cast census, the structural gate of task V-4
 * (Foundation invariant `VT-INV-V-corroboration`). See
 * `proof-input-casts.ts` for what counts.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function key(cast: ProofInputCast): string {
  return `${cast.file} # ${cast.enclosing} # ${cast.brandedType}`;
}

describe("the proof-input cast census (ADR 0011 § 2, task V-4)", () => {
  it("finds a type assertion to a branded proof type only in its own producer, once each", () => {
    const found = findProofInputCasts(REPO_ROOT).map(key);
    expect(
      found,
      "a production type assertion reaches a branded proof type outside its producer: build the value through corroborateClosure, corroborateEvaluation, attributeTarget or an evidence constructor instead",
    ).toEqual(ALLOWED_PROOF_INPUT_CASTS.map(key));
  });

  it("cannot go blind: finds each kind of cast planted in a scratch tree, and nothing else", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "vulntrace-v4-casts-"));
    try {
      mkdirSync(path.join(scratch, "src/domain"), { recursive: true });
      mkdirSync(path.join(scratch, "src/analysis"), { recursive: true });
      mkdirSync(path.join(scratch, "src/testing"), { recursive: true });
      copyFileSync(
        path.join(REPO_ROOT, "src/domain/evidence.ts"),
        path.join(scratch, "src/domain/evidence.ts"),
      );
      writeFileSync(
        path.join(scratch, "src/analysis/verdict.ts"),
        [
          "declare const brand: unique symbol;",
          "export interface AttributedTarget { readonly [brand]: true; readonly id: string }",
          "export function attributeTarget(id: string): AttributedTarget {",
          "  return { id } as unknown as AttributedTarget;",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(scratch, "src/analysis/planted.ts"),
        [
          'import type { ConfirmedUnreachableTarget, Evidence } from "../domain/evidence.js";',
          'import type { AttributedTarget } from "./verdict.js";',
          "type Alias = ConfirmedUnreachableTarget;",
          "interface Wrapper { readonly proofs: readonly Evidence[] }",
          "export function direct(): unknown { return {} as unknown as ConfirmedUnreachableTarget; }",
          "export function aliased(): unknown { return {} as unknown as Alias; }",
          "export function container(): unknown { return {} as Wrapper; }",
          "export function mapped(): unknown { return new Map() as Map<string, AttributedTarget>; }",
          "export function angle(): unknown { return <Evidence>{ path: [] }; }",
          "export const notBranded = { path: [] } as { path: string[] };",
          'export const constant = ["a"] as const;',
          // The independent audit's blind shapes: mapped wrappers of a
          // container, and function types.
          "interface Finding { readonly verdict: string; readonly evidence?: Evidence }",
          "export function partial(): unknown { return {} as unknown as Partial<Finding>; }",
          "export function readonlyEvidence(): unknown { return {} as Readonly<Evidence>; }",
          'export function picked(): unknown { return {} as Pick<Finding, "evidence">; }',
          'export function omitted(): unknown { return {} as Omit<Finding, "verdict">; }',
          "export function fn(): unknown { return (() => ({})) as unknown as () => ConfirmedUnreachableTarget; }",
          "export function ctor(): unknown { return {} as unknown as new (p: AttributedTarget) => object; }",
          "export function symbolIndex(): unknown { return {} as { [k: symbol]: ConfirmedUnreachableTarget }; }",
          "",
        ].join("\n"),
      );
      // A production import of src/testing: its fixtures forge evidence
      // with no assertion in production code.
      writeFileSync(
        path.join(scratch, "src/analysis/imports-testing.ts"),
        'export { h } from "../testing/helper.js";\n',
      );
      // A test file and src/testing are not production: never scanned.
      writeFileSync(
        path.join(scratch, "src/analysis/planted.test.ts"),
        'import type { Evidence } from "../domain/evidence.js";\nexport const t = {} as Evidence;\n',
      );
      writeFileSync(
        path.join(scratch, "src/testing/helper.ts"),
        'import type { Evidence } from "../domain/evidence.js";\nexport const h = {} as Evidence;\n',
      );

      expect(findProofInputCasts(scratch).map(key)).toEqual([
        "src/analysis/imports-testing.ts # <module> # <src/testing import>",
        "src/analysis/planted.ts # direct # ConfirmedUnreachableTarget",
        "src/analysis/planted.ts # aliased # ConfirmedUnreachableTarget",
        "src/analysis/planted.ts # container # ConfirmedAbsentInstance",
        "src/analysis/planted.ts # mapped # AttributedTarget",
        "src/analysis/planted.ts # angle # ConfirmedAbsentInstance",
        "src/analysis/planted.ts # partial # ConfirmedAbsentInstance",
        "src/analysis/planted.ts # readonlyEvidence # ConfirmedAbsentInstance",
        "src/analysis/planted.ts # picked # ConfirmedAbsentInstance",
        "src/analysis/planted.ts # omitted # ConfirmedAbsentInstance",
        "src/analysis/planted.ts # fn # ConfirmedUnreachableTarget",
        "src/analysis/planted.ts # ctor # AttributedTarget",
        "src/analysis/planted.ts # symbolIndex # ConfirmedUnreachableTarget",
        "src/analysis/verdict.ts # attributeTarget # AttributedTarget",
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
