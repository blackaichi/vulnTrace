import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_BEHAVIOUR,
  NEVER_ADMITTED,
  RETURNS_PRIMITIVE,
  VERSION_DEPENDENT_BUILTIN_CALLABLES,
  builtinBehaviour,
  isAdmittedPosition,
  isKnownBuiltinCallable,
} from "../../src/code-intelligence/builtin-callables.js";
import { KNOWN_BUILTIN_CALLABLE_KEYS } from "../../src/code-intelligence/builtin-callables.data.js";
import {
  ALL_BUILTIN_ARG_KINDS,
  OTHER_POSITION_FILLERS,
  argumentSource,
} from "../../src/testing/oracle/builtin-probe.js";
import {
  admittedPositions,
  classifyHook,
  shapeOf,
} from "./builtin-admission.cases.js";
import {
  POSITION_GROUPS,
  survey,
  yieldBeforeEachTest,
} from "./builtin-admission.positions.js";

/**
 * Task A-3a: the MECHANICAL ADMISSION of the non-invoking allowlist (ADR
 * 0008, Amendment A-0 part A's condition, and the allowlist admission
 * ruling of 2026-09-27). Run in CI by `npm run test:oracle`.
 *
 * Every position `src/code-intelligence/builtin-callables.ts` admits must,
 * against real Node:
 *
 * - (a) fire, for every argument kind the H-0 probe knows and in every
 *   context of the other positions, only hooks ADR 0008 accounts for
 *   independently of the call: a protocol member, an accessor body or a
 *   Proxy trap. A throw is not a hook;
 * - (b) for each hook that fires, pass a generated oracle case: a
 *   vulnerable call inside the hook, reached through the builtin at the
 *   position, is never `NOT_AFFECTED`, and real Node does make the call;
 * - be non-retaining: nothing the call returns, and nothing it leaves on
 *   the argument, runs user code afterwards.
 *
 * A position cannot be admitted by editing the table alone: the
 * per-position tests fail until the probe, the oracle and the retention
 * check agree. They are registered by `builtin-admission.globals.test.ts`
 * and `builtin-admission.modules.test.ts`
 * (`builtin-admission.positions.ts`), split from this file only to keep
 * each vitest file short (backlog BL-033); this file holds the table
 * checks and the named outcomes, and checks that the two cover every
 * admitted position.
 */

yieldBeforeEachTest();

describe("the builtin table", () => {
  it("the per-position admission tests cover every admitted position (globals + modules files)", () => {
    const uncovered = admittedPositions().filter(
      (at) => !POSITION_GROUPS.globals(at) && !POSITION_GROUPS.modules(at),
    );
    expect(uncovered).toEqual([]);
  });

  it("no key that carries authority is version-dependent", () => {
    const authority = [
      ...Object.keys(BUILTIN_BEHAVIOUR).map((behaviourKey) =>
        behaviourKey.slice(behaviourKey.indexOf(" ") + 1),
      ),
      ...RETURNS_PRIMITIVE,
      ...[...NEVER_ADMITTED].map((behaviourKey) =>
        behaviourKey.slice(behaviourKey.indexOf(" ") + 1),
      ),
    ];
    expect(
      authority.filter((key) => key in VERSION_DEPENDENT_BUILTIN_CALLABLES),
    ).toEqual([]);
  });

  it("every version-dependent key is a known builtin callable", () => {
    expect(
      Object.keys(VERSION_DEPENDENT_BUILTIN_CALLABLES).filter(
        (key) => !isKnownBuiltinCallable(key),
      ),
    ).toEqual([]);
  });

  it("every known builtin callable exists, as a function, in the Node running this suite, or is a recorded version-dependent key", () => {
    const script = [
      `const keys = ${JSON.stringify(KNOWN_BUILTIN_CALLABLE_KEYS)};`,
      `const missing = [];`,
      `for (const key of keys) {`,
      `  const [scope, a, b] = key.split(":");`,
      `  let v = scope === "global" ? globalThis : require(a);`,
      `  const path = scope === "global" ? a : b;`,
      `  for (const p of path ? path.split(".") : []) { v = v == null ? undefined : v[p]; }`,
      `  if (typeof v !== "function") missing.push(key);`,
      `}`,
      `console.log(JSON.stringify(missing));`,
    ].join("\n");
    const out = execFileSync("node", ["-e", script], { encoding: "utf-8" });
    const missing = JSON.parse(out.trim()) as string[];
    expect(
      missing.filter((key) => !(key in VERSION_DEPENDENT_BUILTIN_CALLABLES)),
      `missing from Node ${process.version}; record them in VERSION_DEPENDENT_BUILTIN_CALLABLES only if no authority depends on them`,
    ).toEqual([]);
  });

  it("every behaviour entry names a known builtin callable", () => {
    const unknown = Object.keys(BUILTIN_BEHAVIOUR).filter(
      (behaviourKey) =>
        !isKnownBuiltinCallable(
          behaviourKey.slice(behaviourKey.indexOf(" ") + 1),
        ),
    );
    expect(unknown).toEqual([]);
  });

  it("new Proxy and Proxy.revocable are never admitted (Amendment A-0 part A, by name)", () => {
    expect([...NEVER_ADMITTED].sort()).toEqual([
      "call global:Proxy.revocable",
      "construct global:Proxy",
    ]);
    for (const behaviourKey of NEVER_ADMITTED) {
      const behaviour = BUILTIN_BEHAVIOUR[behaviourKey];
      expect(behaviour?.admitted, behaviourKey).toBeUndefined();
    }
  });

  it("every RETURNS_PRIMITIVE builtin returns a primitive (or throws) for every argument kind, in every context", () => {
    const script = [
      `const util = require("util");`,
      `const keys = ${JSON.stringify([...RETURNS_PRIMITIVE])};`,
      `const kinds = [${ALL_BUILTIN_ARG_KINDS.map((k) => argumentSource(k, () => "")).join(", ")}];`,
      `const fillers = [${OTHER_POSITION_FILLERS.join(", ")}];`,
      `const bad = [];`,
      `for (const key of keys) {`,
      `  let f = globalThis; for (const p of key.slice("global:".length).split(".")) f = f[p];`,
      `  for (const arg of kinds) for (const filler of fillers) for (const args of [[arg], [arg, filler], [filler, arg]]) {`,
      `    let r; try { r = f(...args); } catch { continue; }`,
      `    if ((typeof r === "object" && r !== null) || typeof r === "function") bad.push(key);`,
      `  }`,
      `}`,
      `console.log(JSON.stringify([...new Set(bad)]));`,
    ].join("\n");
    const out = execFileSync("node", ["-e", script], { encoding: "utf-8" });
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual([]);
  });

  it("no documented invoking position is also admitted", () => {
    const both = Object.entries(BUILTIN_BEHAVIOUR).flatMap(([k, b]) =>
      (b.invokes ?? [])
        .filter((p) => isAdmittedPosition(b, p.position))
        .map((p) => `${k}#${String(p.position)}`),
    );
    expect(both).toEqual([]);
  });
});

/**
 * REMEDIATION-PLAN § 5a's "mechanical admission" criterion names these
 * builtins as examples whose probe fires. Each one's outcome is asserted
 * here, with the hooks that decide it, so the report's admission table is
 * a measured fact. A protocol-member hook is accounted by condition (a);
 * its condition-(b) oracle case could not pass before task A-4 accounted
 * protocol members and accessors (the object's method had no incoming
 * edge), so task A-3a admitted no position firing one. Task A-4 re-probed
 * them: `JSON.parse` #0 and `JSON.stringify` #0 fire only protocol
 * members and accessor bodies, pass (b), retain nothing, and are admitted.
 */
describe("the admission outcome of the builtins the plan names", () => {
  const cases: readonly {
    readonly key: string;
    readonly position: number;
    readonly arity: number;
    readonly setup?: string;
    readonly callee?: string;
    readonly fires: readonly string[];
    readonly admitted: boolean;
  }[] = [
    {
      key: "global:console.log",
      position: 0,
      arity: 1,
      fires: ["inspectCustom"],
      admitted: false,
    },
    {
      key: "module:util:inspect",
      position: 0,
      arity: 1,
      fires: ["inspectCustom"],
      admitted: false,
    },
    {
      key: "module:util:format",
      position: 1,
      arity: 2,
      fires: ["inspectCustom"],
      admitted: false,
    },
    {
      key: "global:Object.keys",
      position: 0,
      arity: 1,
      fires: ["proxy:ownKeys"],
      admitted: true,
    },
    {
      key: "global:Object.getOwnPropertyNames",
      position: 0,
      arity: 1,
      fires: ["proxy:ownKeys"],
      admitted: true,
    },
    {
      key: "global:JSON.stringify",
      position: 0,
      arity: 1,
      fires: ["getter", "toJSON"],
      admitted: true,
    },
    {
      key: "global:Object.assign",
      position: 1,
      arity: 2,
      fires: ["getter"],
      admitted: false,
    },
    {
      key: "global:Object.entries",
      position: 0,
      arity: 1,
      fires: ["getter"],
      admitted: false,
    },
    {
      key: "global:JSON.parse",
      position: 0,
      arity: 1,
      fires: ["toString", "toPrimitive"],
      admitted: true,
    },
    {
      key: "global:JSON.parse",
      position: 1,
      arity: 2,
      fires: ["function"],
      admitted: false,
    },
  ];

  it.each(cases.map((c) => [`${c.key} #${String(c.position)}`, c] as const))(
    "%s",
    async (_name, c) => {
      const shape =
        c.key === "module:util:format"
          ? {
              ...shapeOf(c.key, "call", c.arity),
              callee: `((a, b) => __m.format("%o", b))`,
            }
          : shapeOf(c.key, "call", c.arity);
      const fired = await survey(shape, c.position);
      for (const hook of c.fires) {
        expect([...fired.keys()], `${c.key} fires ${hook}`).toContain(hook);
      }
      expect(
        isAdmittedPosition(builtinBehaviour(c.key, "call"), c.position),
      ).toBe(c.admitted);
      if (c.admitted) {
        expect(
          [...fired.keys()].filter((hook) => classifyHook(hook) === "other"),
        ).toEqual([]);
      }
    },
    60_000,
  );
});
