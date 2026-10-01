import { describe, expect, it } from "vitest";
import {
  ALL_BUILTIN_ARG_KINDS,
  callExpressionAt,
  probeBuiltinArgKind,
  probeBuiltinInvocation,
  probePosition,
  probeRetention,
  type BuiltinCallShape,
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

  it("JSON.stringify(arg) enumerates a plain-object Proxy (ownKeys), which the callable proxy kind cannot show", () => {
    // Task A-0: JSON.stringify returns early for a callable, so the
    // callable `proxy` kind fires only the `get` for "toJSON".
    const callable = probeBuiltinArgKind("JSON.stringify(__ARG__)", "proxy");
    expect(callable.fired).not.toContain("proxy:ownKeys");
    const plain = probeBuiltinArgKind(
      "JSON.stringify(__ARG__)",
      "proxyPlainObject",
    );
    expect(plain.fired).toContain("proxy:ownKeys");
    expect(plain.fired).toContain("proxy:get");
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

/**
 * Task A-3a: what the allowlist admission ruling (ADR 0008, 2026-09-27)
 * requires of the probe itself.
 */
describe("the probe reports a throw apart from a hook, and sees deferred hooks (task A-3a)", () => {
  it("a builtin that throws with no hook firing reports `threw`, not a hook", () => {
    // JSON.parse coerces a function argument with the builtin
    // Function.prototype.toString (no user hook) and throws on the text.
    const result = probeBuiltinArgKind("JSON.parse(__ARG__)", "function");
    expect(result.fired).toEqual([]);
    expect(result.ranUserCode).toBe(false);
    expect(result.threw).toMatch(/JSON/);
  });

  it("a hook that fires before the builtin throws is still a hook, and the throw is still reported", () => {
    const result = probeBuiltinArgKind("JSON.parse(__ARG__)", "toString");
    expect(result.fired).toEqual(["toString"]);
    expect(result.threw).toBeDefined();
  });

  it("a hook the builtin schedules for later (a thenable's `then`) is observed", () => {
    const result = probeBuiltinArgKind("Promise.resolve(__ARG__)", "then");
    expect(result.fired).toContain("then");
  });
});

describe("probePosition and probeRetention (task A-3a)", () => {
  const isArray: BuiltinCallShape = {
    setup: "",
    callee: "Array.isArray",
    form: "call",
    arity: 1,
  };
  const freeze: BuiltinCallShape = {
    setup: "",
    callee: "Object.freeze",
    form: "call",
    arity: 1,
  };

  it("probes one position with a filler at every other position", async () => {
    const result = await probePosition(
      { setup: "", callee: "Object.is", form: "call", arity: 2 },
      1,
      "valueOf",
      "{}",
    );
    expect(result.fired).toEqual([]);
    expect(callExpressionAt(freeze, 0, "__arg", `"x"`)).toBe(
      "Object.freeze(__arg)",
    );
  });

  it("a builtin returning its argument retains it (operations on the result run its getter)", async () => {
    const retention = await probeRetention(freeze, 0, "getter", `"x"`);
    expect(retention.onResult).toContain("getter");
  });

  it("a builtin returning a boolean retains nothing, and leaves the argument as it was", async () => {
    const retention = await probeRetention(isArray, 0, "getter", `"x"`);
    expect(retention.onResult).toEqual([]);
    expect(retention.onArgumentAfterCall).toEqual(
      retention.onArgumentWithoutCall,
    );
  });
});
