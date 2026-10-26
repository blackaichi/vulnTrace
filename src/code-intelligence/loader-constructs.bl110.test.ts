import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  classifyClosureWideningCall,
  findClosureWideningConstructs,
  listUsePassUpCount,
  loaderCapabilityResolutionCount,
} from "./loader-constructs.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * Task BL-110 (docs/tasks/BL-110-module-paths-allow-list.md): BL-096's
 * decision (ADR 0010, "Decision record -- BL-096"), an allow-list over the
 * uses of a `Module` instance's lookup list. The syntactic parent of every
 * expression that may be the list decides: a closed list of parents is
 * exempt, a parent that only selects the value passes the question up, and
 * every other parent is a `loader_capability_escape`. Real Node's answers
 * are in `tests/oracle/bl096-module-paths-read-only.test.ts`. These pin
 * the classifier's answer per rule, so each of the task's mutations is
 * caught by name:
 *
 * - (a) exempting every parent fails "... is loader_capability_escape";
 * - (b) taking a selection for exempt fails "a selection passes the
 *   question up";
 * - (c) exempting any `const` initializer fails "an alias that may hold
 *   another capability" (RWF-157);
 * - (d) dropping the `ambiguous` rule fails "an ambiguous route to the
 *   list";
 * - (e) restoring a read-only method fails "p.<method>, a method BL-092
 *   took for read-only" (the method rule, which the call graph reads) and
 *   "a method read as a value" (the use check); restoring it in both fails
 *   BL-092's "a read-only method" cases (`loader-constructs.bl092.test.ts`).
 */

function reasons(source: string, fileName = "/virtual/index.js"): string[] {
  const index = indexSourceFile(fileName, source);
  return findClosureWideningConstructs({
    index,
    model: buildModuleModel(index),
  }).map((construct) => construct.reason);
}

describe("a use of the lookup list outside the allow-list (task BL-110)", () => {
  it.each([
    ["a spread", "[...module.paths];\n"],
    ["a template", "`${module.paths}`;\n"],
    ["a string concatenation", 'module.paths + "";\n'],
    ["a unary plus", "+module.paths;\n"],
    ["a bitwise not", "~module.paths;\n"],
    ["a loose comparison with a string", 'module.paths == "x";\n'],
    ["a relational comparison", "module.paths < 1;\n"],
    ["the left of in", "module.paths in {};\n"],
    ["the left of instanceof (RWF-154)", "module.paths instanceof F;\n"],
    [
      "the right of instanceof",
      "try { x instanceof module.paths; } catch {}\n",
    ],
    ["a property key", "({})[module.paths];\n"],
    ["a computed name", "({ [module.paths]: 1 });\n"],
    ["await", "(async () => { await module.paths; })();\n"],
    ["a named member read", "module.paths.foo;\n"],
    ["a method read as a value", "const f = module.paths.includes;\n"],
    ["an element read", "module.paths[77777];\n"],
    [
      "++ on a const alias",
      "const p = module.paths;\ntry { p++; } catch (e) {}\n",
    ],
    [
      "an element of an array literal (PRM-105's form)",
      "[module.paths][0].shift();\n",
    ],
    [
      "a shorthand property (RWF-155)",
      "const p = module.paths;\n({ p }).p.shift();\n",
    ],
    ["a call argument", "f(module.paths);\n"],
    ["a return", "function g() { return module.paths; }\n"],
    ["a let", "let p = module.paths;\n"],
    ["an exported const alias", "export const p = module.paths;\n"],
    ["an export specifier", "const p = module.paths;\nexport { p };\n"],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });

  it("a `using` declaration is no alias: it looks up a disposer on the value", () => {
    expect(
      reasons("{\n  using p = module.paths;\n}\n", "/virtual/index.ts"),
    ).toContain("loader_capability_escape");
  });

  it("the head of a TypeScript `import a = p.x.y` chain is a read of the list (BL-096's audit, round 4)", () => {
    expect(
      reasons(
        "const p = module.paths;\nimport a = p.includes.foo;\n",
        "/virtual/index.ts",
      ),
    ).toContain("loader_capability_escape");
  });
});

describe("a method call on the lookup list, as the call graph classifies it (task BL-110)", () => {
  // The call graph reads `classifyClosureWideningCall`, which reaches
  // `modulePathsMethodReason`; the whole-file walk's use check is a second,
  // independent account of the same call, so this pins the method rule on
  // its own (mutation (e)).
  function callReason(source: string): string | undefined {
    const index = indexSourceFile("/virtual/index.js", source);
    const context = { index, model: buildModuleModel(index) };
    let reason: string | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && reason === undefined) {
        reason = classifyClosureWideningCall(node, context);
      }
      ts.forEachChild(node, visit);
    };
    visit(index.sourceFile);
    return reason;
  }

  it.each([
    "slice()",
    'includes("x")',
    'indexOf("x")',
    'join(":")',
    "at(0)",
    "values()",
  ])(
    "p.%s, a method BL-092 took for read-only, is loader_capability_escape",
    (call) => {
      expect(callReason(`const p = module.paths;\np.${call};\n`)).toBe(
        "loader_capability_escape",
      );
    },
  );

  it("a mutating method keeps loader_hook_mutation", () => {
    expect(callReason("const p = module.paths;\np.shift();\n")).toBe(
      "loader_hook_mutation",
    );
  });
});

describe("a selection passes the question up to its own parent (task BL-110)", () => {
  it.each([
    [
      "a conditional's branch, then a spread",
      "[...(c ? module.paths : [])];\n",
    ],
    ["either side of ||, then a template", "`${x || module.paths}`;\n"],
    ["either side of ??, then a template", "`${module.paths ?? x}`;\n"],
    ["the right of &&, then a spread", "[...(x && module.paths)];\n"],
    ["the right of a comma, then a spread", "[...(0, module.paths)];\n"],
    ["parentheses, then a member read", "(module.paths).foo;\n"],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });

  it.each([
    ["|| into ===", "(module.paths || 0) === 1;\n"],
    ["?? into ===", "(module.paths ?? 0) === 1;\n"],
    ["a conditional's branch into ===", "(c ? module.paths : 0) === 1;\n"],
    ["a comma's right into typeof", "typeof (0, module.paths);\n"],
  ])("%s stays complete", (_label, source) => {
    expect(reasons(source)).toEqual([]);
  });

  it("a type assertion is passed through in TypeScript", () => {
    expect(
      reasons("(module.paths as any) === 1;\n", "/virtual/index.ts"),
    ).toEqual([]);
    expect(
      reasons("[...(module.paths as string[])];\n", "/virtual/index.ts"),
    ).toContain("loader_capability_escape");
  });
});

describe("the exempt uses of the lookup list stay complete (task BL-110)", () => {
  it.each([
    [
      "a read of length",
      'module.paths.length;\nmodule.paths?.length;\nmodule.paths["length"];\n',
    ],
    ["for…in", "for (const i in module.paths) {}\n"],
    [
      "strict equality, typeof, void, !",
      "module.paths === 1;\nmodule.paths !== 1;\ntypeof module.paths;\nvoid module.paths;\n!module.paths;\n",
    ],
    ["the right of in", '"x" in module.paths;\n'],
    [
      "loose equality against null",
      "module.paths == null;\nnull != module.paths;\nmodule.paths == (null);\n",
    ],
    [
      "a test",
      "if (module.paths) {}\nwhile (module.paths) break;\ndo {} while (!module.paths);\nfor (; module.paths; ) break;\nmodule.paths ? 1 : 2;\nmodule.paths && 1;\n",
    ],
    [
      "a switch and a case value",
      "switch (module.paths) { case module.paths: break; }\n",
    ],
    ["a discarded value", "module.paths;\n(module.paths, 1);\n"],
    [
      "a const alias, then an exempt use",
      "const p = module.paths;\np.length;\nfor (const i in p) {}\n",
    ],
    [
      "another member of a module-cache entry",
      "require.cache[__filename].exports;\n",
    ],
  ])("%s stays complete", (_label, source) => {
    expect(reasons(source)).toEqual([]);
  });
});

describe("an alias is exempt only when its own name resolves to the list (task BL-110)", () => {
  it.each([
    [
      "an alias that may hold another capability (RWF-157)",
      "const p = Math.random() > 2 ? require : module.paths;\np.shift();\n",
    ],
    [
      "an alias that may hold another capability, through || (RWF-157)",
      "const p = (c && require) || module.paths;\np.shift();\n",
    ],
    [
      "a name another declaration shares (PRM-22)",
      "function f() { const p = []; return p; }\nconst p = module.paths;\np.shift();\n",
    ],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });
});

describe("an ambiguous route to the list (task BL-110; BL-096's audit, round 3)", () => {
  const deepModuleChain =
    "const m0 = module;\n" +
    Array.from({ length: 45 }, (_, i) => `const m${i + 1} = m${i};\n`).join("");
  const deepListChain =
    "const q0 = module.paths;\n" +
    Array.from({ length: 45 }, (_, i) => `const q${i + 1} = q${i};\n`).join("");

  it.each([
    ["the module cache's entry", "`${require.cache[__filename].paths}`;\n"],
    [
      "the module cache through Module",
      "`${module.constructor._cache[__filename].paths}`;\n",
    ],
    ["a computed key into module", '[module["pa" + "ths"]][0].shift();\n'],
    [
      "an alias chain of module past the depth budget",
      `${deepModuleChain}[m45.paths][0].shift();\n`,
    ],
    [
      "an alias chain of the list past the depth budget",
      `${deepListChain}[...q45];\n`,
    ],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });
});

describe("each selection is passed up through once, however deep the nesting (task BL-110's certification audit, finding 1; structural)", () => {
  function passUpsFor(source: string): number {
    const before = listUsePassUpCount();
    reasons(source);
    return listUsePassUpCount() - before;
  }
  const orChain = (n: number): string =>
    `[...(${Array.from({ length: n }, () => "module.paths").join(" || ")})];\n`;
  const conditionalChain = (n: number): string =>
    `[...(${"c ? module.paths : ".repeat(n)}module.paths)];\n`;

  it.each([
    ["a chain of ||", orChain],
    ["nested conditionals", conditionalChain],
  ])(
    "%s of n operands takes at most two pass-ups per operand",
    (_label, build) => {
      for (const n of [250, 1_000]) {
        // Each operand passes into its own selection, and each of the n
        // selections (with the parenthesis) is passed up through once more:
        // linear. Unremembered, the operands would pass n * n / 2 times.
        expect(passUpsFor(build(n))).toBeLessThanOrEqual(2 * n + 2);
      }
    },
  );
});

describe("a type position that no emit uses (task BL-110's certification audit, finding 4)", () => {
  it("a type query is no use of the list", () => {
    expect(
      reasons(
        "const p = module.paths;\nlet x: typeof p;\nlet z: typeof p.T;\nlet k: keyof typeof p;\n",
        "/virtual/index.ts",
      ),
    ).toEqual([]);
  });

  // With `experimentalDecorators` and `emitDecoratorMetadata`, TypeScript
  // emits a decorated member's type as a runtime expression: `@d x!: p.T`
  // reads `p.T`, and a bare `x: p` whose name an interface shares emits `p`
  // itself (BL-110's re-audits, measured against real Node). The compiler
  // options are not read, so every type reference stays a use.
  it.each([
    ["a bare type reference", "const p = module.paths;\nlet y: p;\n"],
    [
      "a decorated property typed by an interface merged with the alias",
      "const p = module.paths as unknown as { new (): unknown };\ninterface p {}\nfunction d(..._a: unknown[]) {}\nclass C { @d x!: p; }\n",
    ],
    [
      "a decorated class's constructor parameter typed by a merged interface",
      "const p = module.paths as unknown as { new (): unknown };\ninterface p {}\nfunction d(..._a: unknown[]) {}\n@d class C { constructor(x: p) {} }\n",
    ],
    [
      "a decorated method's return typed by a merged interface",
      "const p = module.paths as unknown as { new (): unknown };\ninterface p {}\nfunction d(..._a: unknown[]) {}\nclass C { @d m(): p { return undefined as any; } }\n",
    ],
    [
      "a parameter decorator's parameter type through a qualified name",
      "const p = module.paths;\nfunction d(..._a: any[]) {}\nclass A { constructor(@d x: p.T) {} }\n",
    ],
    [
      "a decorated property's type",
      "const p = module.paths;\nfunction d(..._a: any[]) {}\nclass A { @d x!: p.T; }\n",
    ],
    [
      "a decorated class's constructor parameter type",
      "const p = module.paths;\nfunction d(..._a: any[]) {}\n@d class A { constructor(x: p.T) {} }\n",
    ],
    [
      "a decorated method's return type",
      "const p = module.paths;\nfunction d(..._a: any[]) {}\nclass A { @d m(): p.T { return undefined as any; } }\n",
    ],
  ])(
    "%s through a qualified name is loader_capability_escape",
    (_label, source) => {
      expect(reasons(source, "/virtual/index.ts")).toContain(
        "loader_capability_escape",
      );
    },
  );
});

describe("the remembered answer is the answer for every use that passes it (task BL-110's re-audit, finding 2)", () => {
  function escapeColumns(source: string): number[] {
    const index = indexSourceFile("/virtual/index.js", source);
    return findClosureWideningConstructs({
      index,
      model: buildModuleModel(index),
    })
      .filter((construct) => construct.reason === "loader_capability_escape")
      .map((construct) => construct.location.column ?? -1)
      .sort((a, b) => a - b);
  }

  it.each([
    ["both operands of ||", "[...(module.paths || module.paths)];\n", [6, 22]],
    [
      "both branches of a conditional",
      "[...(c ? module.paths : module.paths)];\n",
      [10, 25],
    ],
  ])("%s are each loader_capability_escape", (_label, source, columns) => {
    expect(escapeColumns(source)).toEqual(expect.arrayContaining(columns));
  });
});

describe("resolution steps grow linearly with the file (task BL-110, structural)", () => {
  function stepsFor(uses: number): number {
    const source =
      "const p = module.paths;\n" +
      Array.from(
        { length: uses },
        (_, i) => `const v${i} = p.length + o${i}.k + f${i}(a${i});\n`,
      ).join("");
    const before = loaderCapabilityResolutionCount();
    reasons(source);
    return loaderCapabilityResolutionCount() - before;
  }

  it("four times the uses take at most four times the resolution steps, plus a constant", () => {
    const small = stepsFor(500);
    const large = stepsFor(2_000);
    expect(small).toBeGreaterThan(0);
    // Linear: no per-use step depends on the file's size.
    expect(large).toBeLessThanOrEqual(4 * small + 100);
  });
});
