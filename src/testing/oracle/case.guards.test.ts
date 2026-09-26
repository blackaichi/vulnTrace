import { describe, expect, it } from "vitest";
import type { OracleVariantResult } from "./case.js";
import type { LoudFixtureCheck } from "./loud-fixture.js";

/**
 * COMPILE-TIME structural guards for the case runner (task H-0 step 2/4).
 *
 * Deliberately placed HERE, under `src/testing/` (not the dedicated
 * `tests/oracle/` suite), because `tsconfig.json`'s `include` is `["src"]`
 * -- `npm run typecheck` (`tsc --noEmit`) only ever type-checks files
 * under `src/`, confirmed by `tsc --noEmit --listFiles`, which lists zero
 * files under `tests/`. The identical `@ts-expect-error` pattern
 * `src/cli/scan.module-load-closure.test.ts` already uses to make
 * `knownPackageRoots` un-omittable only works there for the same reason:
 * that file is under `src/` too. A `tests/oracle/` copy of this file
 * would compile-check nothing and silently assert nothing -- so this
 * file's location is itself part of the guarantee, not incidental.
 *
 * This file is otherwise ordinary: it runs under the DEFAULT `npm test`
 * (it matches `vitest.config.ts`'s `src/**\/*.test.ts` include, exactly
 * like its sibling `open-soundness-defect.test.ts`), and does no I/O.
 */
describe("OracleVariantResult: ground truth cannot be omitted (compile-time)", () => {
  it("a variant result missing `groundTruth` does not type-check", () => {
    // @ts-expect-error -- `groundTruth` is a REQUIRED field. If it is
    // ever made optional or removed, this object literal (which omits it
    // on purpose) stops being a type error, the `@ts-expect-error`
    // directive becomes "unused", and `npm run typecheck` fails.
    const incomplete: OracleVariantResult = {
      name: "x",
      loud: { specifier: "vuln-lib", exportedNames: [] },
      scan: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        output: undefined,
        findings: [],
        unreportedCandidates: [],
      },
    };
    expect(incomplete).toBeDefined();
  });
});

describe("LoudFixtureCheck: a case with no bound names does not type-check", () => {
  it("`boundNames: []` is not assignable", () => {
    // @ts-expect-error -- `boundNames` is a non-empty tuple
    // (`readonly [string, ...string[]]`); the empty array must never be
    // assignable, or a case could declare itself "loud" about nothing.
    const empty: LoudFixtureCheck["boundNames"] = [];
    expect(empty).toEqual([]);
  });
});
