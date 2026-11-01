/**
 * The trust boundary over the runtime's built-in prototypes, disclosed
 * (task BL-113; docs/SOUNDNESS-CONTRACT.md § 1, "The trust boundary"; the
 * project owner's decision of 2026-10-27, ADR 0010 "Decision record --
 * BL-111").
 *
 * The contract amends what every NOT_AFFECTED claims, and the scope
 * disclosure is how a reader of a result learns it. The two must say the
 * same thing: a disclosure that dropped the boundary would let a
 * NOT_AFFECTED read as covering programs that pollute the runtime's
 * prototypes, and one that reworded it would drift from the contract that
 * defines it. So the contract quotes the disclosure's text, and this file
 * holds them together.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_PROTOTYPE_TRUST_BOUNDARY,
  SUPPORTED_MODEL_EXCLUSIONS,
} from "./evidence.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const HEADING = "### The trust boundary: the runtime's built-in prototypes";

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

describe("the built-in prototype trust boundary's disclosure", () => {
  it("is one entry of the declared model's exclusions, exactly once", () => {
    expect(
      SUPPORTED_MODEL_EXCLUSIONS.filter(
        (exclusion) => exclusion === BUILTIN_PROTOTYPE_TRUST_BOUNDARY,
      ),
    ).toHaveLength(1);
  });

  it("is quoted verbatim by the soundness contract's § 1", () => {
    const section = contractSection1();
    expect(section).toContain(HEADING);
    const boundary = section.slice(section.indexOf(HEADING));
    expect(quotations(boundary)[0]).toBe(BUILTIN_PROTOTYPE_TRUST_BOUNDARY);
  });

  it("names the built-in prototypes, and nothing it does not cover", () => {
    // The decided reach is the runtime's built-in prototypes (ADR 0010's
    // decision record, "Not decided here"): the entry must not widen it
    // to a global, a builtin module's exports or a constructor's own
    // properties, which only the project owner can decide.
    expect(BUILTIN_PROTOTYPE_TRUST_BOUNDARY).toMatch(
      /built-in prototype objects/,
    );
    for (const beyond of [
      /global/i,
      /exports/i,
      /constructor's own/i,
      /Module\.prototype/,
    ]) {
      expect(BUILTIN_PROTOTYPE_TRUST_BOUNDARY).not.toMatch(beyond);
    }
  });
});
