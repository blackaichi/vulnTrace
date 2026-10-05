import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph } from "../domain/graph.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

/**
 * Task A-6 (docs/tasks/A-6-binder-resolution-authority.md): ADR 0008
 * invariant A2's "exact export with the whole member chain consumed"
 * (PRM-20), at the graph level where the edge is visible. Each refusal has
 * a named test that a mutation removing it fails; each group has controls
 * that still resolve, so a refusal that fired everywhere fails too.
 *
 * - THE CHAIN: a member read after the export binds to nothing, at every
 *   site that resolves a callee through the binder -- a call, a tag, a
 *   `new`, an `extends` base, an alias.
 * - `.call` / `.apply`: the one chain kept, for a call site only, for a
 *   function export only, and only while no prepared file may write a
 *   member of that name.
 *
 * The real-Node versions are in `tests/oracle/a6-binder-resolution-authority.*`.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** `pkg`: two plain functions, one carrying them as members, and a class. */
const PKG =
  `function parse(x) { return x; }\n` +
  `function safe(x) { return x; }\n` +
  `function api(x) { return safe(x); }\n` +
  `api.parse = parse;\n` +
  `api.Inner = class Inner {\n  constructor(x) { parse(x); }\n};\n` +
  `class Klass {\n  static run(x) { return parse(x); }\n}\n` +
  `module.exports = { parse, safe, api, Klass };\n`;

async function graphFor(
  files: Readonly<Record<string, string>>,
  entry = "src/index.js",
): Promise<CallGraph> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-a6-"));
  tempDirs.push(root);
  const all: Record<string, string> = {
    "node_modules/pkg/package.json": JSON.stringify({
      name: "pkg",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/pkg/index.js": PKG,
    ...files,
  };
  for (const [relative, content] of Object.entries(all)) {
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
function accountOf(graph: CallGraph, from = "main"): string[] {
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

/** An entry that binds `pkg`, then `function main() { body }`. */
function program(body: string, defs = `const lib = require("pkg");\n`): string {
  return `${defs}function main() {\n${body}\n}\nmain();\n`;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

describe("A-6: a member read after the export binds to nothing (PRM-20)", () => {
  it("a named binding's member call is not an edge to the export", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `api.parse("x");`,
        `const { api } = require("pkg");\n`,
      ),
    });
    expect(accountOf(graph)).toEqual(["unknown unsupported_receiver_binding"]);
  });

  it("a whole-module binding's second member is not an edge to the first", async () => {
    const graph = await graphFor({
      "src/index.js": program(`lib.api.parse("x");`),
    });
    expect(accountOf(graph)).toEqual(["unknown unsupported_receiver_binding"]);
  });

  it("a tag reads the chain like a callee", async () => {
    const graph = await graphFor({
      "src/index.js": program("lib.api.parse`x`;"),
    });
    expect(accountOf(graph)).not.toContain("resolved api");
    expect(accountOf(graph)).toContain("unknown unsupported_receiver_binding");
  });

  it("`new` of a member is not a construction of the export", async () => {
    const graph = await graphFor({
      "src/index.js": program(`new lib.api.Inner("x");`),
    });
    expect(accountOf(graph)).not.toContain("resolved api");
    expect(accountOf(graph)).toHaveLength(1);
    expect(accountOf(graph)[0]).toMatch(/^unknown /);
  });

  it("an `extends` base that is a member is not the export's constructor", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `new S("x");`,
        `const lib = require("pkg");\nclass S extends lib.api.Inner {}\n`,
      ),
    });
    expect(accountOf(graph, "S")).not.toContain("resolved api");
    expect(accountOf(graph, "S")).toHaveLength(1);
    expect(accountOf(graph, "S")[0]).toMatch(/^unknown /);
  });

  it("an alias of a member is not an alias of the export", async () => {
    const graph = await graphFor({
      "src/index.js": program(`const f = lib.api.parse;\nf("x");`),
    });
    expect(accountOf(graph)).toEqual(["unknown unsupported_callee_binding"]);
  });

  it("a receiver alias does not rebuild a chain into the export", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `const a = api;\na.parse("x");`,
        `const { api } = require("pkg");\n`,
      ),
    });
    expect(accountOf(graph)).toEqual(["unknown unsupported_receiver_binding"]);
  });

  it("controls: the export itself, its alias, and an imported class's static method still resolve", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `lib.parse("x");\nconst a = lib.api;\na("x");\nKlass.run("x");`,
        `const lib = require("pkg");\nconst { Klass } = require("pkg");\n`,
      ),
    });
    expect(accountOf(graph)).toEqual([
      "resolved parse",
      "resolved api",
      "resolved run",
    ]);
  });
});

// ---------------------------------------------------------------------------
// `.call` / `.apply`
// ---------------------------------------------------------------------------

describe("A-6: a single trailing .call / .apply", () => {
  it("resolves to the function export, on a whole-module and a named binding", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `lib.parse.call(null, "x");\nparse.apply(null, ["x"]);`,
        `const lib = require("pkg");\nconst { parse } = require("pkg");\n`,
      ),
    });
    expect(accountOf(graph)).toEqual(["resolved parse", "resolved parse"]);
  });

  it("is withdrawn when a file writes the function's own `call`", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `lib.safe.call = lib.parse;\nlib.safe.call(null, "x");`,
      ),
    });
    expect(accountOf(graph)).toContain("unknown receiver_member_written");
    expect(accountOf(graph)).not.toContain("resolved safe");
  });

  it("is withdrawn when ANOTHER prepared file writes `Function.prototype.call`", async () => {
    const graph = await graphFor({
      "src/index.js": program(
        `lib.parse.call(null, "x");`,
        `const lib = require("pkg");\nrequire("./patch.js");\n`,
      ),
      "src/patch.js": `Function.prototype.call = function () {};\n`,
    });
    expect(accountOf(graph)).toContain("unknown receiver_member_written");
    expect(accountOf(graph)).not.toContain("resolved parse");
  });

  it("is withdrawn on `apply` written, and not on `call` written (the member is the method's own name)", async () => {
    const applyWritten = await graphFor({
      "src/index.js": program(
        `lib.parse.apply(null, ["x"]);`,
        `const lib = require("pkg");\nconst o = {};\no.apply = 1;\n`,
      ),
    });
    expect(accountOf(applyWritten)).toContain(
      "unknown receiver_member_written",
    );
    const callWritten = await graphFor({
      "src/index.js": program(
        `lib.parse.apply(null, ["x"]);`,
        `const lib = require("pkg");\nconst o = {};\no.call = 1;\n`,
      ),
    });
    expect(accountOf(callWritten)).toEqual(["resolved parse"]);
  });

  it("is not an edge to a class export's constructor", async () => {
    const graph = await graphFor({
      "src/index.js": program(`lib.Klass.call(null, "x");`),
    });
    expect(accountOf(graph)).not.toContain("resolved Klass");
    expect(accountOf(graph)).toHaveLength(1);
    expect(accountOf(graph)[0]).toMatch(/^unknown /);
  });

  it("is a call-site answer only: `new` of it, and a value read of it, bind to nothing", async () => {
    const constructed = await graphFor({
      "src/index.js": program(`new lib.parse.call();`),
    });
    expect(accountOf(constructed)).not.toContain("resolved parse");
    const aliased = await graphFor({
      "src/index.js": program(`const c = lib.parse.call;\nc(null, "x");`),
    });
    expect(accountOf(aliased)).not.toContain("resolved parse");
  });
});
