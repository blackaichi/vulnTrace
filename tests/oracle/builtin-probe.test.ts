import { describe, expect, it } from "vitest";
import {
  ALL_BUILTIN_ARG_KINDS,
  probeBuiltinArgKind,
  probeBuiltinInvocation,
} from "../../src/testing/oracle/builtin-probe.js";

/**
 * Self-test for the builtin probe (task H-0 step 3): proves the tool
 * detects real invocation for every argument kind the project's
 * non-invoking-builtin allowlist policy (docs/REMEDIATION-PLAN.md
 * decision 1) requires proof against, and correctly reports NONE of
 * them for a builtin that provably never runs user code.
 *
 * No allowlist entry is decided here (task H-0 boundary) -- this only
 * proves the measuring instrument works.
 */
describe("probeBuiltinInvocation: detects every listed real-Node invocation surface", () => {
  it("Math.max(arg) invokes valueOf on a coerced object argument", () => {
    const result = probeBuiltinArgKind("Math.max(__ARG__)", "valueOf");
    expect(result.ranUserCode).toBe(true);
    expect(result.fired).toContain("valueOf");
  });

  it("JSON.stringify(arg) invokes an own enumerable getter", () => {
    const result = probeBuiltinArgKind("JSON.stringify(__ARG__)", "getter");
    expect(result.ranUserCode).toBe(true);
    expect(result.fired).toContain("getter");
  });

  it("JSON.stringify(arg) invokes toJSON", () => {
    const result = probeBuiltinArgKind("JSON.stringify(__ARG__)", "toJSON");
    expect(result.ranUserCode).toBe(true);
    expect(result.fired).toContain("toJSON");
  });

  it("console.log(arg) invokes util.inspect.custom", () => {
    const result = probeBuiltinArgKind("console.log(__ARG__)", "inspectCustom");
    expect(result.ranUserCode).toBe(true);
    expect(result.fired).toContain("inspectCustom");
  });

  it("util.inspect(arg) invokes util.inspect.custom", () => {
    const result = probeBuiltinArgKind(
      "util.inspect(__ARG__)",
      "inspectCustom",
    );
    expect(result.ranUserCode).toBe(true);
    expect(result.fired).toContain("inspectCustom");
  });

  it("Object.keys(arg) triggers a Proxy's ownKeys trap", () => {
    const result = probeBuiltinArgKind("Object.keys(__ARG__)", "proxy");
    expect(result.ranUserCode).toBe(true);
    expect(result.fired).toContain("proxy:ownKeys");
  });

  it("Array.isArray(arg) runs no user code, for every argument kind", () => {
    const results = probeBuiltinInvocation(
      "Array.isArray(__ARG__)",
      ALL_BUILTIN_ARG_KINDS,
    );
    for (const kind of ALL_BUILTIN_ARG_KINDS) {
      expect(
        results[kind].ranUserCode,
        `argKind ${kind} unexpectedly ran user code: fired ${JSON.stringify(results[kind].fired)}`,
      ).toBe(false);
    }
  });

  it("rejects a callTemplate missing the __ARG__ placeholder", () => {
    expect(() => probeBuiltinArgKind("Math.max(1)", "valueOf")).toThrow(
      /__ARG__/,
    );
  });
});
