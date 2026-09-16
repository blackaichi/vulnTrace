import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph, DynamicCallReason } from "../domain/graph.js";
import { isClosureWideningReason } from "../domain/graph.js";
import { UNCERTAINTY_REASON_CATEGORY } from "../domain/uncertainty.js";
import { buildCallGraph } from "./call-graph.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";
import {
  UNSUPPORTED_CONSTRUCT_REASONS,
  classifyUnsupportedConstruct,
} from "./unsupported-construct.js";

/**
 * P1-B1 -- the focused, per-subtype tests for the `unsupported_construct`
 * decomposition.
 *
 * WHAT EACH TEST HAS TO PROVE. Asserting `category === "unmodeled_construct"`
 * proves nothing here: that was already true of the single token this work
 * replaces, and it would keep passing if the classifier returned one
 * constant. Every case below therefore asserts the EXACT subtype, and every
 * major subtype is paired with a NEAR NEIGHBOUR -- a construct that looks
 * similar and must NOT map to it -- so a classifier that over-reaches fails
 * rather than silently widening a bucket.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-p1b1-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function graphFor(root: string, entryFiles: string[]): Promise<CallGraph> {
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles, resolver });
}

/**
 * Parses ONE call/`new` expression and hands its callee to the classifier,
 * exactly as `call-graph.ts` does at its two fallbacks.
 *
 * Deliberately source-text driven: the subtype vocabulary is a claim about
 * SYNTAX THE ANALYZER SEES, so a test that hand-built AST nodes could
 * assert a shape the parser never actually produces.
 */
function reasonFor(source: string): DynamicCallReason {
  const file = ts.createSourceFile(
    "probe.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let callee: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      callee === undefined &&
      (ts.isCallExpression(node) || ts.isNewExpression(node))
    ) {
      callee = node.expression;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  if (!callee) {
    throw new Error(`no call expression in probe source: ${source}`);
  }
  return classifyUnsupportedConstruct(callee);
}

describe("P1-B1 classifyUnsupportedConstruct: each subtype is gated on its own shape", () => {
  it("names an unattributable bare callee a callee-binding gap", () => {
    expect(reasonFor("isArray(x);")).toBe("unsupported_callee_binding");
  });

  it("names an unattributable receiver a receiver-binding gap", () => {
    expect(reasonFor("stack.set(k, v);")).toBe("unsupported_receiver_binding");
  });

  it("names a `this` receiver a this-receiver gap", () => {
    expect(reasonFor("this.parse(text);")).toBe("unsupported_this_receiver");
  });

  it("names an indexed receiver an indexed-receiver gap", () => {
    expect(reasonFor("funcs[index].apply(this, args);")).toBe(
      "unsupported_indexed_receiver",
    );
  });

  it("names a call-result receiver a call-result gap", () => {
    expect(reasonFor('require("path").join(a, b);')).toBe(
      "unsupported_call_result_receiver",
    );
  });

  it("names an inline-constructed receiver a literal-receiver gap", () => {
    expect(reasonFor("/[^.]+$/.exec(value);")).toBe(
      "unsupported_literal_receiver",
    );
  });

  it("names an operator-produced receiver an expression-receiver gap", () => {
    expect(reasonFor('(value || "").trim();')).toBe(
      "unsupported_expression_receiver",
    );
  });

  it("names a callee that is not a name at all a computed-callee gap", () => {
    expect(reasonFor("(function () {})();")).toBe(
      "unsupported_computed_callee",
    );
    expect(reasonFor("factory()();")).toBe("unsupported_computed_callee");
    expect(reasonFor("(Map || ListCache)();")).toBe(
      "unsupported_computed_callee",
    );
  });
});

describe("P1-B1 near-neighbour controls: a similar shape must not borrow another subtype", () => {
  /**
   * The single most important control in this file. `stack['delete']()`
   * and `stack.delete()` are the SAME modeling gap spelled two ways -- the
   * binder reads both property names statically and fails on both for the
   * same reason -- so they must share a subtype. Splitting them would be a
   * taxonomy describing TypeScript's grammar rather than this analyzer's
   * gaps (P1-B1 § 3 design principle D).
   */
  it("treats a string-literal element access exactly as the dotted form", () => {
    expect(reasonFor("stack['delete'](k);")).toBe(
      "unsupported_receiver_binding",
    );
    expect(reasonFor("stack.delete(k);")).toBe("unsupported_receiver_binding");
  });

  it("does not let a statically-named chain become an indexed receiver", () => {
    expect(reasonFor("this.options.tagValueProcessor(a, b);")).toBe(
      "unsupported_this_receiver",
    );
    expect(reasonFor("comp.operator.startsWith('<');")).toBe(
      "unsupported_receiver_binding",
    );
  });

  it("distinguishes a call-result receiver from an inline-constructed one", () => {
    expect(reasonFor("makeRe().test(v);")).toBe(
      "unsupported_call_result_receiver",
    );
    expect(reasonFor("new Parser().parse(v);")).toBe(
      "unsupported_literal_receiver",
    );
  });

  it("distinguishes an operator receiver from a call-result receiver", () => {
    expect(reasonFor("(a ? x : y).run();")).toBe(
      "unsupported_expression_receiver",
    );
    expect(reasonFor("(await load()).run();")).toBe(
      "unsupported_call_result_receiver",
    );
  });

  /**
   * Parentheses, non-null assertions and `as` casts are spellings, not
   * semantics: each of these is the same gap as the unwrapped form.
   */
  it("sees through spellings that carry no semantics", () => {
    expect(reasonFor("(run)();")).toBe("unsupported_callee_binding");
    expect(reasonFor("run!();")).toBe("unsupported_callee_binding");
    expect(reasonFor("(obj as any).run();")).toBe(
      "unsupported_receiver_binding",
    );
    expect(reasonFor("(obj!).run();")).toBe("unsupported_receiver_binding");
  });

  /**
   * PRECEDENCE. `this[key].m()` has two unmodeled steps. The rule is that
   * the step nearest the call wins, because modeling `this` alone would
   * still not attribute the value whose member is called.
   */
  it("lets the unmodeled step nearest the call decide", () => {
    expect(reasonFor("this[LRU_LIST].toArray();")).toBe(
      "unsupported_indexed_receiver",
    );
    expect(reasonFor("this.list.toArray();")).toBe("unsupported_this_receiver");
  });

  it("shares one subtype between a construction and a call of the same name", () => {
    expect(reasonFor("new Ctor(options);")).toBe("unsupported_callee_binding");
    expect(reasonFor("Ctor(options);")).toBe("unsupported_callee_binding");
  });
});

describe("P1-B1 the generic floor stays reachable and safe", () => {
  /**
   * P1-B1 § 32/§ 33. A shape nobody classified -- here `super()`, which no
   * corpus occurrence exercised and which therefore deliberately got no
   * subtype of its own -- must land on the retained generic token. Not a
   * crash, not a new category, and above all not a shape that quietly
   * disappears.
   */
  it("routes an unmeasured shape to the retained generic token", () => {
    expect(reasonFor("class A extends B { constructor() { super(); } }")).toBe(
      "unsupported_construct",
    );
  });

  it("never throws, whatever the callee shape", () => {
    for (const source of [
      "super.method();",
      "(x, y)();",
      "(yield fn)();",
      "(#brand in obj ? a : b)();",
    ]) {
      expect(() => reasonFor(source)).not.toThrow();
    }
  });
});

describe("P1-B1 the decomposition is observational, not semantic", () => {
  it("classifies every subtype as unmodeled_construct, exactly as the token it refines", () => {
    for (const reason of UNSUPPORTED_CONSTRUCT_REASONS) {
      expect(UNCERTAINTY_REASON_CATEGORY[reason]).toBe("unmodeled_construct");
    }
  });

  /**
   * The soundness half. `isClosureWideningReason` is read by the proof
   * rules; if any subtype answered differently from the token it replaced,
   * this decomposition would have moved a soundness boundary while
   * claiming to be a reporting change.
   */
  it("classifies every subtype non-widening, exactly as the token it refines", () => {
    expect(isClosureWideningReason("unsupported_construct")).toBe(false);
    for (const reason of UNSUPPORTED_CONSTRUCT_REASONS) {
      expect(isClosureWideningReason(reason)).toBe(false);
    }
  });
});

describe("P1-B1 the subtype reaches a real call-graph edge", () => {
  it("emits the specific subtype, not the generic token, on the built graph", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "export function run(handler) {\n  handler.execute();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const unresolved = graph.edges.filter(
      (edge) => edge.resolution.kind === "unknown",
    );
    expect(unresolved.length).toBeGreaterThan(0);
    expect(
      unresolved.map((edge) =>
        edge.resolution.kind === "unknown" ? edge.resolution.reason : "",
      ),
    ).toContain("unsupported_receiver_binding");
  });

  /**
   * SCOPE/SHADOWING CONTROL (P1-B1 § 16). These two files are
   * syntactically identical at the call site -- `helper.execute()` -- and
   * differ only in what `helper` BINDS TO. The resolvable one must produce
   * no unsupported edge at all; only the unbound one may.
   */
  it("does not label a call whose receiver is locally bound and resolvable", async () => {
    const root = tempProject();
    write(
      root,
      "src/helper.ts",
      "export const helper = { execute() { return 1; } };\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import { helper } from "./helper.js";\n' +
        "export function run() {\n  helper.execute();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const reasons = graph.edges
      .filter((edge) => edge.resolution.kind === "unknown")
      .map((edge) =>
        edge.resolution.kind === "unknown" ? edge.resolution.reason : "",
      );
    expect(reasons).not.toContain("unsupported_receiver_binding");
  });

  /**
   * § 34: an occurrence that ALREADY has a precise reason keeps it. A
   * dynamic property in callee position is `dynamic_member_access`
   * (`value_uncertainty`) and must not be absorbed into this family, which
   * would move it to another category and change the counts this task is
   * required to keep reconciled.
   */
  it("leaves dynamic_member_access untouched in callee position", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "export function run(obj, key) {\n  obj[key]();\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const reasons = graph.edges
      .filter((edge) => edge.resolution.kind === "unknown")
      .map((edge) =>
        edge.resolution.kind === "unknown" ? edge.resolution.reason : "",
      );
    expect(reasons).toContain("dynamic_member_access");
    for (const reason of reasons) {
      expect(UNSUPPORTED_CONSTRUCT_REASONS).not.toContain(reason);
    }
  });

  it("still emits no edge at all for a known ambient global", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "export function run() {\n  console.log('x');\n}\n",
    );

    const graph = await graphFor(root, [entry]);

    const reasons = graph.edges
      .filter((edge) => edge.resolution.kind === "unknown")
      .map((edge) =>
        edge.resolution.kind === "unknown" ? edge.resolution.reason : "",
      );
    for (const reason of reasons) {
      expect(UNSUPPORTED_CONSTRUCT_REASONS).not.toContain(reason);
    }
  });
});
