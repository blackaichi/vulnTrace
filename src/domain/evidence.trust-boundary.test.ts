/**
 * The trust boundary over the runtime's built-in objects, disclosed (tasks
 * BL-113 and BL-126; docs/SOUNDNESS-CONTRACT.md § 1, "The trust boundary";
 * the project owner's decisions of 2026-10-27 and 2026-11-03, ADR 0010
 * "Decision record -- BL-111" and "Decision record -- BL-122").
 *
 * The contract amends what every NOT_AFFECTED claims, and the scope
 * disclosure is how a reader of a result learns it. The two must say the
 * same thing: a disclosure that dropped the boundary would let a
 * NOT_AFFECTED read as covering programs that pollute or monkey-patch the
 * runtime's objects, and one that reworded it would drift from the
 * contract that defines it. So the contract quotes the disclosure's text,
 * and this file holds them together.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_OBJECT_TRUST_BOUNDARY,
  LOADER_OBJECT_EXCLUSION,
  SUPPORTED_MODEL_EXCLUSIONS,
} from "./evidence.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const HEADING = "### The trust boundary: the runtime's built-in objects";

/** SOUNDNESS-CONTRACT § 1: from its heading up to § 2. */
function contractSection1(): string {
  const text = readFileSync(
    path.join(ROOT, "docs", "SOUNDNESS-CONTRACT.md"),
    "utf-8",
  );
  const start = text.indexOf("\n## 1. ");
  const end = text.indexOf("\n## 2. ");
  expect(start, "the contract has a § 1").toBeGreaterThanOrEqual(0);
  expect(end, "the contract has a § 2 after § 1").toBeGreaterThan(start);
  return text.slice(start, end);
}

/** `text` with every run of whitespace as one space, for prose spanning lines. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The text of every `> ` quotation in `section`, one line each. */
function quotations(section: string): string[] {
  const quotes: string[] = [];
  let current: string[] = [];
  for (const line of section.split("\n")) {
    if (line.startsWith(">")) {
      current.push(line.replace(/^>\s?/, "").trim());
    } else if (current.length > 0) {
      quotes.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) quotes.push(current.join(" "));
  return quotes;
}

describe("the built-in object trust boundary's disclosure", () => {
  it("is one entry of the declared model's exclusions, exactly once", () => {
    for (const entry of [
      BUILTIN_OBJECT_TRUST_BOUNDARY,
      LOADER_OBJECT_EXCLUSION,
    ]) {
      expect(
        SUPPORTED_MODEL_EXCLUSIONS.filter((exclusion) => exclusion === entry),
      ).toHaveLength(1);
    }
  });

  it("is quoted verbatim by the soundness contract's § 1", () => {
    const section = contractSection1();
    expect(section).toContain(HEADING);
    const boundary = section.slice(section.indexOf(HEADING));
    expect(quotations(boundary)[0]).toBe(BUILTIN_OBJECT_TRUST_BOUNDARY);
  });

  it("names every kind of built-in object (W-all), and any change to one", () => {
    // The decided reach (ADR 0010, "Decision record -- BL-122"): every
    // built-in object -- the intrinsics (prototypes, constructors' own
    // properties, namespaces, the global object), Node's own constructors
    // and prototypes, the builtin modules' exports and what the runtime
    // holds in them.
    for (const kind of [
      /^any change to the runtime's built-in objects/,
      /Object\.prototype/,
      /standard constructors with their prototypes and own properties/,
      /JSON, Math, the global object/,
      /Node's own constructors and prototypes \(URL, Buffer, EventEmitter\)/,
      /the exports of Node's builtin modules \(fs, path, process, console\)/,
      /the objects the runtime holds in them/,
      /monkey-patch/,
    ]) {
      expect(BUILTIN_OBJECT_TRUST_BOUNDARY).toMatch(kind);
    }
    // "A change" is not narrowed (the same decision; narrowing it is backlog
    // BL-131's question): the entry must not restrict it to some members
    // or some kinds of value, which only the project owner can decide.
    for (const narrowing of [
      /\bfunction\b/i,
      /\baccessor\b/i,
      /\breplac/i,
      /\bmembers?\b/i,
      /\bthat (?:Node|the loader)/i,
    ]) {
      expect(BUILTIN_OBJECT_TRUST_BOUNDARY).not.toMatch(narrowing);
    }
  });

  it("keeps Node's module loader objects inside the declared model", () => {
    // ADR 0010, "Proposed decision -- BL-122": under every (W-...) option
    // the loader objects stay modeled and inside the claim, and the text
    // must say so, since `Module` is a builtin constructor and `module` a
    // builtin module.
    const loaderObjects =
      "(Module, Module.prototype, module objects, require and its registries)";
    expect(BUILTIN_OBJECT_TRUST_BOUNDARY).toContain(
      `Node's module loader objects ${loaderObjects} are not covered and stay inside the declared model`,
    );
    // Their exclusion is only what the scan never analyzed, and names no
    // other built-in object: a change to `fs` or `URL.prototype` is the
    // boundary's wherever it originates.
    expect(LOADER_OBJECT_EXCLUSION).toContain(loaderObjects);
    expect(LOADER_OBJECT_EXCLUSION).toMatch(/code this scan never analyzed$/);
    for (const other of [/\bfs\b/, /\bpath\b/, /URL/, /global/i, /built-in/i]) {
      expect(LOADER_OBJECT_EXCLUSION).not.toMatch(other);
    }
    expect(SUPPORTED_MODEL_EXCLUSIONS).not.toContain(
      "loader monkey-patching originating in code this scan never analyzed",
    );
    const section = contractSection1();
    expect(section).toContain(
      "**What it does not cover: Node's module loader objects.**",
    );
    // The section names each loader object it keeps inside the claim, and
    // claims no route through them is handled (BL-126's audit, round 1).
    const loader = flat(
      section.slice(
        section.indexOf("**What it does not cover: Node's module loader"),
        section.indexOf("**What it is not.**"),
      ),
    );
    for (const name of [
      "`Module._load`",
      "`Module._resolveFilename`",
      "`Module.prototype`",
      "`module.paths`",
      "`require.main`",
      "`require.cache`",
      "`require.extensions`",
      "a false `NOT_AFFECTED` through one of them is an open defect",
    ]) {
      expect(loader).toContain(name);
    }
  });

  it("states the contract's own definitions without narrowing them", () => {
    // The parts of the section the disclosure does not quote, held here so
    // that narrowing them fails (BL-126's audit, round 1, L3).
    const section = flat(contractSection1());
    expect(BUILTIN_OBJECT_TRUST_BOUNDARY).toMatch(
      /made by any code the program runs/,
    );
    for (const phrase of [
      "A built-in object is one of the following, and nothing else",
      "Adding, assigning, redefining or deleting a property of one of them, under any key, data or accessor",
      "or changing its [[Prototype]] or its extensibility",
      "Not narrowed by key, value or purpose",
      "Node's loader objects (below) are none of them",
      "Not built-in objects: an object the program creates",
      "a module's `exports` object (the CommonJS top-level `this`), an ES module's namespace object and its `import.meta`. A change to those is inside the claim.",
      "It narrows what a `NOT_AFFECTED` claims, and nothing else",
    ]) {
      expect(section).toContain(phrase);
    }
  });
});
