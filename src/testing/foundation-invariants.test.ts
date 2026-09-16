import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FOUNDATION_INVARIANTS,
  LIVE_SIGNALS,
} from "./foundation-invariants.js";

/**
 * FOUNDATION F6 — the invariant map, kept honest.
 *
 * `foundation-invariants.ts` is only worth having if it cannot quietly
 * become wrong. A map naming a deleted test, or naming a test the gate
 * does not execute, is worse than no map: it reports coverage that is not
 * there. Everything below exists to make those two states fail loudly.
 *
 * This file asserts about the SHAPE of the gate, never about analyzer
 * behaviour — the invariants themselves are owned by the files the map
 * names, which is the entire point of the map.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const FOUNDATION_CONFIG = path.join(REPO_ROOT, "vitest.foundation.config.ts");

/** The `include` entries of the Foundation config, read as text. */
function foundationIncludes(): readonly string[] {
  const source = readFileSync(FOUNDATION_CONFIG, "utf-8");
  const block = /include:\s*\[([\s\S]*?)\]/.exec(source);
  const body = block?.[1];
  if (body === undefined) {
    throw new Error("vitest.foundation.config.ts has no include array");
  }
  return [...body.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((entry): entry is string => entry !== undefined);
}

describe("the Foundation invariant map is well-formed", () => {
  it("names at least one owner for every invariant", () => {
    for (const entry of FOUNDATION_INVARIANTS) {
      expect(
        entry.owners.length,
        `invariant "${entry.id}" has no deterministic owner`,
      ).toBeGreaterThan(0);
    }
  });

  it("uses unique invariant ids", () => {
    const ids = FOUNDATION_INVARIANTS.map((entry) => entry.id);
    expect(new Set(ids).size, `duplicate invariant id in the map`).toBe(
      ids.length,
    );
  });

  it("states every invariant and its rationale in full sentences", () => {
    // A one-word entry would satisfy every structural check above while
    // telling a reader nothing, which is the failure mode a map like this
    // actually has.
    for (const entry of FOUNDATION_INVARIANTS) {
      expect(
        entry.invariant.length,
        `invariant "${entry.id}" is not actually stated`,
      ).toBeGreaterThan(40);
      expect(
        entry.note.length,
        `invariant "${entry.id}" does not say why these owners`,
      ).toBeGreaterThan(40);
    }
  });

  it("lists no owner twice within one invariant", () => {
    for (const entry of FOUNDATION_INVARIANTS) {
      expect(
        new Set(entry.owners).size,
        `invariant "${entry.id}" lists the same owner twice`,
      ).toBe(entry.owners.length);
    }
  });

  it("covers every Foundation task that established invariants", () => {
    const covered = new Set(
      FOUNDATION_INVARIANTS.map((entry) => entry.foundation),
    );
    for (const foundation of ["F2", "F3", "F4", "F5", "F6", "VT-CONTRACT"]) {
      expect(
        covered.has(foundation as never),
        `no invariant in the map is owned by ${foundation}`,
      ).toBe(true);
    }
  });
});

describe("every named owner exists and is gated", () => {
  const owners = [
    ...new Set(FOUNDATION_INVARIANTS.flatMap((entry) => entry.owners)),
  ].sort();

  it.each(owners)("%s exists on disk", (owner) => {
    expect(
      existsSync(path.join(REPO_ROOT, owner)),
      `the invariant map names "${owner}", which does not exist`,
    ).toBe(true);
  });

  it.each(owners)("%s is executed by the Foundation gate", (owner) => {
    // THE anti-drift assertion. An owner the map claims but the gate does
    // not run is coverage that exists only on paper.
    expect(
      foundationIncludes(),
      `"${owner}" owns a Foundation invariant but vitest.foundation.config.ts ` +
        `does not include it, so \`npm run test:foundation\` never runs it`,
    ).toContain(owner);
  });

  it("is a strict subset of what `npm test` runs", () => {
    // The fast gate must never be able to disagree with the full suite.
    // `vitest.config.ts` includes `src/**/*.test.ts` and excludes exactly
    // one file; every Foundation owner must be inside that set.
    for (const owner of foundationIncludes()) {
      expect(
        owner.startsWith("src/") && owner.endsWith(".test.ts"),
        `"${owner}" is in the Foundation gate but outside \`npm test\`'s include`,
      ).toBe(true);
      expect(
        owner,
        `"${owner}" is excluded from \`npm test\`, so the two gates could disagree`,
      ).not.toBe("src/cli/scan-performance.test.ts");
    }
  });

  it("includes nothing the map does not account for", () => {
    // The other direction: a file in the gate that owns no stated
    // invariant is either an undocumented owner or dead weight.
    expect(new Set(foundationIncludes())).toEqual(new Set(owners));
  });
});

describe("deterministic and live signals are distinguished", () => {
  it("classifies the live and environmental signals separately", () => {
    const ids = LIVE_SIGNALS.map((signal) => signal.id);
    expect(ids).toContain("live-osv-validation");
    expect(ids).toContain("wall-clock-performance");
  });

  it("no live signal is the owner of any invariant", () => {
    // F6 § 15: live validation is integration evidence, never the sole
    // deterministic oracle. Structurally: nothing under `tests/` — which
    // is where the network-dependent and research suites live — may appear
    // as an owner.
    const owners = FOUNDATION_INVARIANTS.flatMap((entry) => entry.owners);
    for (const owner of owners) {
      expect(
        owner.startsWith("tests/"),
        `"${owner}" is a live/environmental suite and cannot own an invariant`,
      ).toBe(false);
    }
  });

  it("states why each live signal is not a deterministic owner", () => {
    for (const signal of LIVE_SIGNALS) {
      expect(
        signal.why.length,
        `live signal "${signal.id}" is classified with no reason given`,
      ).toBeGreaterThan(60);
      expect(signal.command).toMatch(/^npm run /);
    }
  });
});

describe("the wall-clock thresholds are documented, not merely present", () => {
  /**
   * F6 § 11, the threshold-ratchet policy, implemented as the lightest
   * thing that can actually stop a ratchet: the guard file's thresholds
   * are pinned HERE, in a different file, so raising one to make CI green
   * is a two-file change that cannot be mistaken for a tweak — and this
   * test names the record that a change must justify.
   */
  const PINNED_THRESHOLDS: ReadonlyArray<{
    readonly constant: string;
    readonly ms: number;
  }> = [
    { constant: "REGRESSION_THRESHOLD_MS", ms: 5_000 },
    { constant: "SINGLE_FILE_THRESHOLD_MS", ms: 20_000 },
    { constant: "CATASTROPHIC_REGRESSION_CEILING_MS", ms: 10_000 },
  ];

  it.each(PINNED_THRESHOLDS)(
    "$constant is still $ms ms",
    ({ constant, ms }) => {
      const source = readFileSync(
        path.join(REPO_ROOT, "src/cli/scan-performance.test.ts"),
        "utf-8",
      );
      const literal = new RegExp(`${constant}\\s*=\\s*([0-9_]+)`).exec(
        source,
      )?.[1];
      expect(
        literal,
        `${constant} no longer exists in src/cli/scan-performance.test.ts, so ` +
          `the threshold it names is no longer pinned anywhere`,
      ).toBeDefined();
      const actual = Number((literal ?? "").replaceAll("_", ""));
      expect(
        actual,
        `WALL-CLOCK THRESHOLD CHANGED.\n` +
          `  invariant: performance thresholds are not raised to make CI green (F6 s 11)\n` +
          `  case:      ${constant} in src/cli/scan-performance.test.ts\n` +
          `  expected:  ${ms}\n` +
          `  actual:    ${actual}\n\n` +
          `These are COARSE catastrophic-regression ceilings, not a complexity\n` +
          `contract -- the complexity contract is the operation-count gate in\n` +
          `analysis/scan-caches.f5-multiplier.test.ts, which has no threshold to\n` +
          `tune. If a ceiling genuinely must move, change it here too and record\n` +
          `the measurement and the justification in tests/validation/FINDINGS.md,\n` +
          `as RWF-038 s "CI gate remediation" does. Do not raise it because a run\n` +
          `was slow.`,
      ).toBe(ms);
    },
  );
});
