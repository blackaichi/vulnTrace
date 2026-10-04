import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { resolveImportProvenanceDeclaration } from "./named-bindings.js";
import { indexSourceFile } from "./source-index.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task A-5a (docs/tasks/A-5a-resolution-authority.md): the refusals ADR
 * 0008 invariant A2 adds on the call-graph side, each by a named test, at
 * the graph level where the edge is visible. Each test is the one a
 * mutation removing that refusal fails (the task file lists them); each
 * group has a control that still resolves, so a refusal that fired
 * everywhere fails too.
 *
 * - VT-210 (PRM-16, PRM-17, RWF-071, the JSX factory): a higher-order
 *   parameter is resolved from its call sites only when they are ALL of
 *   them and the parameter holds only what they passed.
 * - PRM-104: a reassigned `function` declaration is not its declaration.
 * - PRM-15, the binding side: the import extraction binds a name only
 *   through the ambient `require`.
 *
 * The real-Node versions are in `tests/oracle/a5a-resolution-authority.*`.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function graphFor(
  files: Readonly<Record<string, string>>,
  entry = "src/index.js",
): Promise<CallGraph> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a5a-"));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({
    entryFiles: [path.join(root, entry)],
    resolver,
  });
}

/** What the edges out of the one node named `from` resolve to: `resolved <name>`, `possible <name>`, `unknown <reason>`. */
function accountOf(graph: CallGraph, from: string): string[] {
  const nodes = graph.nodes.filter((n) => n.name === from);
  expect(nodes, `exactly one node named ${from}`).toHaveLength(1);
  const nameOf = (id: string): string =>
    graph.nodes.find((n) => n.id === id)?.name ?? id;
  return graph.edges
    .filter((e) => e.from === nodes[0]!.id)
    .map((e) =>
      e.resolution.kind === "unknown"
        ? `unknown ${e.resolution.reason}`
        : `${e.resolution.kind} ${nameOf(e.resolution.target)}`,
    );
}

const HELPER = `function helper(x) { return x; }\nfunction other(x) { return x; }\n`;

// ---------------------------------------------------------------------------
// VT-210
// ---------------------------------------------------------------------------

describe("VT-210 resolves a higher-order parameter only from ALL its call sites (PRM-16)", () => {
  it("control: a file-local function, every call site passing one function, resolves", async () => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function each(fn, x) { return fn(x); }\neach(helper, 1);\neach(helper, 2);\n`,
    });
    expect(accountOf(graph, "each")).toEqual(["resolved helper"]);
  });

  it("control: a same-named function in a sibling scope is not a reference", async () => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function outer() { function each(f) { return f; } return each(other); }\nfunction each(fn, x) { return fn(x); }\neach(helper, 1);\nouter();\n`,
    });
    const helper = graph.nodes.find((n) => n.name === "helper");
    expect(
      graph.edges.some(
        (e) =>
          e.resolution.kind === "resolved" &&
          e.resolution.target === helper?.id,
      ),
    ).toBe(true);
  });

  it.each([
    [
      "an `export` modifier",
      `export function each(fn, x) { return fn(x); }\neach(helper, 1);\n`,
    ],
    [
      "`export default`",
      `export default function each(fn, x) { return fn(x); }\neach(helper, 1);\n`,
    ],
    [
      "a CommonJS export by shorthand",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\nmodule.exports = { each };\n`,
    ],
    [
      "a CommonJS export by member",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\nmodule.exports.each = each;\n`,
    ],
    [
      "an export specifier",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\nexport { each };\n`,
    ],
    [
      "an alias",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\nconst g = each;\n`,
    ],
    [
      "`.call`",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\neach.call(null, other, 1);\n`,
    ],
    [
      "`new`",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\nnew each(other, 1);\n`,
    ],
    [
      "a tag",
      "function each(fn, x) { return fn(x); }\neach(helper, 1);\neach`x`;\n",
    ],
    [
      "an argument to another call",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\n[1].forEach(each);\n`,
    ],
    [
      "a reassignment of the function's own name",
      `function each(fn, x) { return fn(x); }\neach(helper, 1);\nif (Math.random()) { each = other; }\n`,
    ],
  ])("refuses when the function escapes through %s", async (_label, tail) => {
    const graph = await graphFor(
      { "src/index.mjs": HELPER + tail },
      "src/index.mjs",
    );
    expect(accountOf(graph, "each")).not.toContain("resolved helper");
  });

  it("refuses in a file with a JSX site, whose factory call names no function (REMEDIATION-PLAN § 5a, A-3b additions)", async () => {
    const graph = await graphFor(
      {
        "src/index.jsx": `/** @jsx h */\n${HELPER}function h(tag, props) { return tag(props); }\nh(helper, null);\nconst el = <div />;\n`,
      },
      "src/index.jsx",
    );
    expect(accountOf(graph, "h")).not.toContain("resolved helper");
  });
});

describe("VT-210 refuses a parameter that may hold what no call site passed (PRM-17)", () => {
  it.each([
    ["a plain write", `fn = other;`],
    ["a compound write", `fn ||= other;`],
    ["a destructuring write", `[fn] = [other];`],
    ["a write in a closure", `(() => { fn = other; })();`],
    ["a sloppy-mode arguments alias", `arguments[0] = other;`],
    ["a direct eval", `eval("fn = other");`],
  ])("refuses under %s", async (_label, statement) => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function each(fn, x) { ${statement} return fn(x); }\neach(helper, 1);\n`,
    });
    expect(accountOf(graph, "each")).not.toContain("resolved helper");
  });

  it("refuses under a with statement", async () => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function each(fn, x, o) { with (o) { return fn(x); } }\neach(helper, 1, {});\n`,
    });
    expect(accountOf(graph, "each")).not.toContain("resolved helper");
  });
});

describe("VT-210 refuses a call site with a spread at or before the parameter's position (RWF-071)", () => {
  it("refuses a spread before the position", async () => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function each(x, fn) { return fn(x); }\neach(...[1, other], helper);\n`,
    });
    expect(accountOf(graph, "each")).not.toContain("resolved helper");
  });

  it("refuses a spread at the position", async () => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function each(fn, x) { return fn(x); }\neach(...[helper], 1);\n`,
    });
    expect(accountOf(graph, "each")).not.toContain("resolved helper");
  });

  it("control: a spread after the position does not move it", async () => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function each(fn, x) { return fn(x); }\neach(helper, ...[1]);\n`,
    });
    expect(accountOf(graph, "each")).toEqual(["resolved helper"]);
  });
});

// ---------------------------------------------------------------------------
// PRM-104
// ---------------------------------------------------------------------------

describe("a reassigned function declaration is not its declaration (PRM-104)", () => {
  it("control: an unwritten function declaration resolves", async () => {
    const graph = await graphFor({
      "src/index.js": `function run(x) { return x; }\nfunction main() { return run(1); }\nmain();\n`,
    });
    expect(accountOf(graph, "main")).toEqual(["resolved run"]);
  });

  it.each([
    ["a write before the call", `run = other;\n`],
    [
      "a deferred write in another function",
      `function setup() { run = other; }\n`,
    ],
    ["a compound write", `run ||= other;\n`],
  ])("refuses under %s", async (_label, write) => {
    const graph = await graphFor({
      "src/index.js": `function other(x) { return x; }\nfunction run(x) { return x; }\n${write}function main() { return run(1); }\nmain();\n`,
    });
    expect(accountOf(graph, "main")).not.toContain("resolved run");
    expect(accountOf(graph, "main")[0]).toMatch(/^unknown /);
  });
});

// ---------------------------------------------------------------------------
// PRM-15, the binding side
// ---------------------------------------------------------------------------

describe("the import extraction binds a name only through the ambient require (PRM-15)", () => {
  it('control: `const m = require("./util.js")` binds m', () => {
    const index = indexSourceFile(
      "/p/src/index.js",
      `const m = require("./util.js");\n`,
    );
    expect(index.imports).toEqual([
      expect.objectContaining({ specifier: "./util.js", localName: "m" }),
    ]);
  });

  it.each([
    [
      "a function-local function require",
      `function main() {\n  function require(n) { return n; }\n  const m = require("./util.js");\n  return m;\n}\n`,
    ],
    [
      "a parameter named require",
      `function main(require) {\n  const { parse } = require("./util.js");\n  return parse;\n}\n`,
    ],
    [
      "a bare-name write anywhere in the file",
      `require = (n) => n;\nconst m = require("./util.js");\n`,
    ],
  ])(
    "records only the load, with no bound name, under %s",
    (_label, source) => {
      const index = indexSourceFile("/p/src/index.js", source);
      const util = index.imports.filter((i) => i.specifier === "./util.js");
      expect(util).toHaveLength(1);
      expect(util[0]?.localName).toBeUndefined();
      expect(util[0]?.importedName).toBeUndefined();
    },
  );
});

describe("require provenance is read only through the ambient require (PRM-15)", () => {
  /** The provenance of the identifier `m` in `m.parse(...)`. */
  function provenanceOfM(source: string): string {
    const sourceFile = ts.createSourceFile(
      "/p/src/index.js",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    let reference: ts.Identifier | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "m" &&
        node.name.text === "parse"
      ) {
        reference = node.expression;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(reference).toBeDefined();
    return resolveImportProvenanceDeclaration(reference!).kind;
  }

  it("control: the ambient require is require provenance", () => {
    expect(
      provenanceOfM(`const m = require("./util.js");\nm.parse("x");\n`),
    ).toBe("require");
  });

  it("a function-local function require is not", () => {
    expect(
      provenanceOfM(
        `function main() {\n  function require(n) { return n; }\n  const m = require("./util.js");\n  m.parse("x");\n}\n`,
      ),
    ).not.toBe("require");
  });
});

// ---------------------------------------------------------------------------
// Receiver-bound documented invoking builtins (ADR 0008 § 4; the project
// owner's decision of 2026-10-04)
// ---------------------------------------------------------------------------

describe("a receiver-bound invoking builtin resolves only on a proven receiver", () => {
  const CB = `function cb(x) { return x; }\nfunction other(x) { return x; }\n`;

  it.each([
    ["map on a non-empty array literal", `[1, 2].map(cb);`],
    ["forEach on a one-element array literal", `[1].forEach(cb);`],
    ["reduce on two elements", `[1, 2].reduce(cb);`],
    ["reduce on one element with an initial value", `[1].reduce(cb, 0);`],
    ["then on Promise.resolve()", `Promise.resolve().then(cb);`],
    ["then on Promise.resolve(<primitive>)", `Promise.resolve(1).then(cb);`],
    ["finally on Promise.resolve()", `Promise.resolve().finally(cb);`],
    ["catch on Promise.reject()", `Promise.reject(1).catch(cb);`],
    [
      "then's second argument on Promise.reject()",
      `Promise.reject(1).then(other, cb);`,
    ],
  ])("resolves the callback: %s", async (_label, call) => {
    const graph = await graphFor({
      "src/index.js": `${CB}function main() { return ${call} }\nmain();\n`,
    });
    expect(accountOf(graph, "main")).toContain("resolved cb");
  });

  it.each([
    ["an empty array literal", `[].map(cb);`],
    ["a hole", `[, 1].map(cb);`],
    ["a spread element", `[...[]].map(cb);`],
    ["reduce on one element with no initial value", `[1].reduce(cb);`],
    ["a method the file writes", `[1].map(cb);\nArray.prototype.map = other;`],
    [
      "a method the file writes as a destructuring target",
      `[1].map(cb);\n[Array.prototype.map] = [other];`,
    ],
    [
      "a method the file writes as an object destructuring target",
      `[1].map(cb);\n({ k: Array.prototype.map } = { k: other });`,
    ],
    [
      "a method the file writes as a for-of head",
      `[1].map(cb);\nfor (Array.prototype.map of [other]) {}`,
    ],
    ["a receiver that is not a literal", `xs.map(cb);`],
    ["catch on Promise.resolve()", `Promise.resolve().catch(cb);`],
    [
      "then on Promise.resolve(<opaque value>)",
      `Promise.resolve(xs).then(cb);`,
    ],
    [
      "then's first argument on Promise.reject()",
      `Promise.reject(1).then(cb);`,
    ],
    [
      "a Promise the file declares",
      `Promise.resolve().then(cb);\nfunction Promise() {}`,
    ],
    [
      "a resolve the file writes",
      `Promise.resolve().then(cb);\nPromise.resolve = other;`,
    ],
  ])("never resolves the callback under %s", async (_label, call) => {
    const graph = await graphFor({
      "src/index.js": `${CB}const xs = [];\nfunction main() { return ${call} }\nmain();\n`,
    });
    expect(accountOf(graph, "main")).not.toContain("resolved cb");
  });
});

// ---------------------------------------------------------------------------
// Task A-5a's independent audit
// ---------------------------------------------------------------------------

describe("a write through a value-free wrapper is a write (the audit, finding 1)", () => {
  it.each([
    ["parentheses", `(fn) = other;`],
    ["a parenthesized destructuring target", `[(fn)] = [other];`],
    ["a parenthesized update", `(fn)++;`],
  ])("VT-210 refuses a parameter written through %s", async (_label, write) => {
    const graph = await graphFor({
      "src/index.js": `${HELPER}function each(fn, x) { ${write} return fn(x); }\neach(helper, 1);\n`,
    });
    expect(accountOf(graph, "each")).not.toContain("resolved helper");
  });

  it.each([
    ["a non-null assertion", `fn! = other;`],
    ["a type assertion", `(fn as any) = other;`],
  ])(
    "VT-210 refuses a parameter written through %s (TypeScript)",
    async (_label, write) => {
      const graph = await graphFor(
        {
          "src/index.ts": `${HELPER}function each(fn: any, x: any) { ${write} return fn(x); }\neach(helper, 1);\n`,
        },
        "src/index.ts",
      );
      expect(accountOf(graph, "each")).not.toContain("resolved helper");
    },
  );

  it("PRM-104 refuses a function declaration written through parentheses", async () => {
    const graph = await graphFor({
      "src/index.js": `function other(x) { return x; }\nfunction run(x) { return x; }\n(run) = other;\nfunction main() { return run(1); }\nmain();\n`,
    });
    expect(accountOf(graph, "main")).not.toContain("resolved run");
  });
});

describe("the ambient require is the CommonJS wrapper's, untouched (the audit, findings 2 and 3)", () => {
  /** Whether `const m = require("./util.js")` binds `m` in `source`, written at `file` under `root`. */
  function bindsM(
    source: string,
    file = "src/index.js",
    manifest?: string,
  ): boolean {
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a5a-req-"));
    tempDirs.push(root);
    if (manifest !== undefined) {
      writeFileSync(path.join(root, "package.json"), manifest);
    }
    const index = indexSourceFile(path.join(root, file), source);
    return index.imports.some(
      (i) => i.specifier === "./util.js" && i.localName === "m",
    );
  }
  const REQ = `const m = require("./util.js");\n`;

  it("control: a CommonJS file binds it", () => {
    expect(bindsM(REQ, "src/index.js", `{ "type": "commonjs" }`)).toBe(true);
    expect(bindsM(REQ)).toBe(true);
  });

  it("control: a `var`, a function or a block declaration of a wrapper name is valid CommonJS", () => {
    expect(bindsM(`var module = module;\n${REQ}`)).toBe(true);
    expect(bindsM(`function __dirname() {}\n${REQ}`)).toBe(true);
    expect(bindsM(`{ const module = 1; }\n${REQ}`)).toBe(true);
  });

  it("control: an await inside an async function is no module syntax", () => {
    expect(bindsM(`async function f() { await 0; }\n${REQ}`)).toBe(true);
  });

  it("control: `arguments` inside a non-arrow function is that function's", () => {
    expect(bindsM(`function f() { return arguments[0]; }\n${REQ}`)).toBe(true);
  });

  it.each([
    ["the wrapper's arguments at top level", `arguments[1] = null;\n${REQ}`],
    [
      "the wrapper's arguments in an arrow function",
      `const f = () => { arguments[1] = null; };\n${REQ}`,
    ],
    ["an import declaration", `import "./x.js";\n${REQ}`],
    ["an export declaration", `export const x = 1;\n${REQ}`],
    ["import.meta", `const u = import.meta.url;\n${REQ}`],
    ["a top-level await", `await 0;\n${REQ}`],
    ["a top-level const redeclaring `module`", `const module = 1;\n${REQ}`],
    ["a top-level let redeclaring `exports`", `let exports = 1;\n${REQ}`],
    ["a top-level class redeclaring `__dirname`", `class __dirname {}\n${REQ}`],
    [
      "a destructured top-level const redeclaring `__filename`",
      `const { a: __filename } = { a: "x" };\n${REQ}`,
    ],
    ["a top-level for await", `for await (const x of []) {}\n${REQ}`],
  ])("binds nothing under %s", (_label, source) => {
    expect(bindsM(source)).toBe(false);
  });

  it("binds nothing in an .mjs file", () => {
    expect(bindsM(REQ, "src/index.mjs")).toBe(false);
  });

  it('binds nothing under a package.json with "type": "module"', () => {
    expect(bindsM(REQ, "src/index.js", `{ "type": "module" }`)).toBe(false);
  });
});

describe("VT-210 skips a TypeScript `this` parameter (the audit, finding 4)", () => {
  it("reads the argument at the runtime position", async () => {
    const graph = await graphFor(
      {
        "src/index.ts": `${HELPER}function each(this: void, fn: any, x: any) { return fn(x); }\neach(other, helper);\n`,
      },
      "src/index.ts",
    );
    const account = accountOf(graph, "each");
    expect(account).toContain("resolved other");
    expect(account).not.toContain("resolved helper");
  });
});
