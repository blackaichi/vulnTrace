import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_BUILTIN_ARG_KINDS,
  OTHER_POSITION_FILLERS,
  probePosition,
  probeRetention,
  type BuiltinArgKind,
  type BuiltinCallShape,
} from "../../src/testing/oracle/builtin-probe.js";
import {
  TARGET_MARKER,
  admissionOracleCases,
  admittedPositions,
  classifyHook,
  type AdmittedPosition,
} from "./builtin-admission.cases.js";

/**
 * Task A-3a: the per-position half of the MECHANICAL ADMISSION test (see
 * `builtin-admission.test.ts` for the rule). Registered by more than one
 * test file -- `builtin-admission.globals.test.ts` and
 * `builtin-admission.modules.test.ts` -- so that no single vitest file
 * runs long enough to hit backlog BL-033's worker RPC timeout; the
 * table test checks that the two together cover every admitted position.
 */

/**
 * How many real-Node probe processes run at once. Unbounded (44 per
 * position survey), they saturated the machine and starved vitest's own
 * RPC (`Timeout calling "onTaskUpdate"`, backlog BL-033), failing the
 * suite with every test passing. A cap, not a config change.
 */
const MAX_CONCURRENT_PROBES = 4;

/** `items.map(run)`, at most {@link MAX_CONCURRENT_PROBES} at a time, results in order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_PROBES, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export interface Firing {
  readonly kind: BuiltinArgKind;
  readonly filler: string;
}

const surveys = new Map<string, Promise<ReadonlyMap<string, Firing>>>();

/** Every hook that fires at a position, with the first (kind, filler) it fired with. */
export function survey(
  shape: BuiltinCallShape,
  position: number,
): Promise<ReadonlyMap<string, Firing>> {
  const key = JSON.stringify([shape, position]);
  const cached = surveys.get(key);
  if (cached) {
    return cached;
  }
  const result = runSurvey(shape, position);
  surveys.set(key, result);
  return result;
}

async function runSurvey(
  shape: BuiltinCallShape,
  position: number,
): Promise<ReadonlyMap<string, Firing>> {
  const contexts = ALL_BUILTIN_ARG_KINDS.flatMap((kind) =>
    OTHER_POSITION_FILLERS.map((filler) => ({ kind, filler })),
  );
  const runs = await mapBounded(contexts, async ({ kind, filler }) => ({
    kind,
    filler,
    result: await probePosition(shape, position, kind, filler),
  }));
  const fired = new Map<string, Firing>();
  for (const { kind, filler, result } of runs) {
    for (const hook of result.fired) {
      if (!fired.has(hook)) {
        fired.set(hook, { kind, filler });
      }
    }
  }
  return fired;
}

/** The two halves the per-position tests are split into, by key scope. */
export const POSITION_GROUPS = {
  globals: (at: AdmittedPosition) => at.key.startsWith("global:"),
  modules: (at: AdmittedPosition) => at.key.startsWith("module:"),
} as const;

/** One macrotask turn before each test (backlog BL-033). */
export function yieldBeforeEachTest(): void {
  beforeEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/** Registers conditions (a), (b) and non-retention for every admitted position `include` selects. */
export function registerAdmittedPositionTests(
  include: (at: AdmittedPosition) => boolean,
): void {
  const selected = admittedPositions().filter(include);
  describe.each(
    selected.map(
      (at) => [`${at.behaviourKey} #${String(at.position)}`, at] as const,
    ),
  )("admitted: %s", (_name, at: AdmittedPosition) => {
    it("(a) fires only protocol members, accessor bodies and Proxy traps, in every context", async () => {
      const fired = await survey(at.shape, at.position);
      const unaccounted = [...fired.keys()].filter(
        (hook) => classifyHook(hook) === "other",
      );
      expect(unaccounted, `hooks ADR 0008 does not account for`).toEqual([]);
    });

    it("(b) every hook that fires has an oracle case that is never NOT_AFFECTED", async () => {
      const fired = await survey(at.shape, at.position);
      const cases = [...fired.entries()].flatMap(([hook, firing]) =>
        admissionOracleCases(at, hook, firing),
      );
      const results = await mapBounded(cases, async (kase) => ({
        kase,
        result: await runOracleCase(kase),
      }));
      for (const { kase, result } of results) {
        expect(
          result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
          `${String(kase.id)}: real Node runs the hook`,
        ).toBe(true);
        expect(
          result.variant.scan.findings[0]?.verdict,
          `${String(kase.id)}: never NOT_AFFECTED`,
        ).not.toBe("NOT_AFFECTED");
        expect(result.variant.scan.findings[0]?.verdict).toBeDefined();
      }
    }, 120_000);

    it("is non-retaining for every argument kind", async () => {
      const retained = (
        await mapBounded(ALL_BUILTIN_ARG_KINDS, async (kind) => ({
          kind,
          r: await probeRetention(at.shape, at.position, kind, `"x"`),
        }))
      ).filter(
        ({ r }) =>
          r.onResult.length > 0 ||
          JSON.stringify(r.onArgumentAfterCall) !==
            JSON.stringify(r.onArgumentWithoutCall),
      );
      expect(
        retained.map(({ kind, r }) => `${kind}: ${JSON.stringify(r)}`),
      ).toEqual([]);
    });
  });
}
