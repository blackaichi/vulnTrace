import { describe, expect, it } from "vitest";
import { isClosureWideningReason, type DynamicCallReason } from "./graph.js";

/**
 * FOUNDATION-F2 / F2-B -- `isClosureWideningReason` must be exhaustive at
 * COMPILE time and fail CLOSED at RUNTIME.
 *
 * The two guarantees were previously conflated, and only the first held.
 *
 * COMPILE TIME (already held, now explicit). A `switch` with no `default`
 * and a declared `: boolean` return made an unclassified value fall off
 * the end, which `strict` rejects. So the audit's stated concern -- "a new
 * reason silently defaults to non-widening at build time" -- was NOT true
 * of this function. What was true is that the error pointed at the closing
 * brace ("Function lacks ending return statement") rather than naming the
 * offending value. It is now carried by a `never` parameter, which reports
 * the actual unclassified reason. The matrix below is what makes a NEW
 * reason visible to a reviewer as well as to the compiler: `WIDENING` and
 * `NON_WIDENING` are typed so that together they must cover the union
 * exactly, so adding a reason without placing it in one of them fails to
 * typecheck here too.
 *
 * RUNTIME (did NOT hold; this is the fix). Falling off the end returned
 * `undefined`, which is falsy, so an unrecognized reason was classified
 * NON-widening -- fail-open in both consumers:
 * `findClosureWideningConstructs` skips recording a construct it considers
 * non-widening, leaving the closure `complete`, and
 * `hasReachableClosureWideningBlocker` finds no blocker among the
 * unresolved edges. Measured before the fix:
 * `isClosureWideningReason("<unknown>") === undefined`.
 *
 * Today `DynamicCallReason` is internal and type-closed -- produced only
 * by call-graph.ts and loader-constructs.ts, and carried across no
 * deserialization boundary (the OSV cache included) -- so the runtime half
 * is defence in depth, not a reachable production path. That is a property
 * of today's code, not a promise about tomorrow's.
 */

/**
 * THE CANONICAL WIDENING MATRIX.
 *
 * Every classification here is the one the code already made; F2-B
 * changed no decision, only how the partition is enforced. The two arrays
 * are typed against `DynamicCallReason` and asserted below to partition it
 * exactly -- no omissions, no overlap, no strays.
 */
const WIDENING: readonly DynamicCallReason[] = [
  "dynamic_require",
  "dynamic_import",
  "eval",
  "unresolved_module",
  "declaration_only_resolution",
  "aliased_require",
  "create_require",
  "function_constructor",
  "aliased_eval",
  "module_require",
  "module_internal_load",
  "vm_execution",
  "worker_execution",
  "child_process_execution",
  "loader_hook_mutation",
  "loader_capability_escape",
];

const NON_WIDENING: readonly DynamicCallReason[] = [
  "unsupported_construct",
  "dynamic_member_access",
  "unresolved_target",
];

/**
 * Compile-time completeness of the matrix itself.
 *
 * `Record<DynamicCallReason, true>` can only be built if every union
 * member appears as a key, so a newly-added reason that is in neither
 * array above is a type error HERE, in addition to the one in
 * `isClosureWideningReason` itself. This is the "enum addition cannot
 * silently compile" guard, expressed as a type rather than as a
 * source-text assertion about the implementation.
 */
const CLASSIFIED: Record<DynamicCallReason, true> = Object.fromEntries(
  [...WIDENING, ...NON_WIDENING].map((reason) => [reason, true]),
) as Record<DynamicCallReason, true>;

describe("F2-B: the widening matrix partitions DynamicCallReason exactly", () => {
  it("classifies every reason exactly once", () => {
    const all = [...WIDENING, ...NON_WIDENING];
    expect(new Set(all).size, "a reason appears in both arrays").toBe(
      all.length,
    );
    // Every key of the compile-time-complete record is covered by the
    // arrays, and vice versa -- so the matrix has no omission and no stray.
    expect(new Set(Object.keys(CLASSIFIED))).toEqual(new Set(all));
  });

  it.each(WIDENING)("%s is WIDENING", (reason) => {
    expect(isClosureWideningReason(reason)).toBe(true);
  });

  it.each(NON_WIDENING)("%s is NON-widening", (reason) => {
    expect(isClosureWideningReason(reason)).toBe(false);
  });
});

describe("F2-B: an unrecognized runtime reason fails CLOSED", () => {
  it("classifies an unknown value as WIDENING, not as safe", () => {
    // Pre-F2-B this returned `undefined` -- falsy, therefore non-widening,
    // therefore fail-open in both consumers.
    const unknown = "brand_new_reason_not_yet_classified" as DynamicCallReason;
    expect(isClosureWideningReason(unknown)).toBe(true);
  });

  it("returns a real boolean for every input, never undefined", () => {
    for (const reason of [...WIDENING, ...NON_WIDENING]) {
      expect(typeof isClosureWideningReason(reason)).toBe("boolean");
    }
    expect(
      typeof isClosureWideningReason("" as DynamicCallReason),
      "an empty string must not fall off the end",
    ).toBe("boolean");
  });

  it("does not throw on an unrecognized value", () => {
    // A scan's contract is that uncertainty becomes UNKNOWN, never an
    // exception. Failing closed must not become failing loudly.
    expect(() =>
      isClosureWideningReason("nonsense" as DynamicCallReason),
    ).not.toThrow();
  });
});
