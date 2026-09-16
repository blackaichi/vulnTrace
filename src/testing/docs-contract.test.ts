import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateScanOutput } from "../cli/output.js";
import {
  cleanupCorpus,
  config,
  installedLib,
  materialize,
  normalizeDeep,
  providerFor,
  rule,
  scanProject,
  under,
} from "./foundation-corpus.js";

/**
 * FOUNDATION F7 — THE DOCUMENTATION CONTRACT.
 *
 * Documentation decays in three specific, mechanical ways, and this file
 * owns all three:
 *
 * 1. **A generated number goes stale.** `docs/SCORECARD.md` is produced
 *    from committed sources; if a source moves and the file is not
 *    regenerated, the scorecard states something the repository no longer
 *    believes. `--check` fails here rather than in a reader's head.
 * 2. **A link or a command rots.** A documented `npm run` target that does
 *    not exist, or a relative link to a file nobody committed, is a defect
 *    the first new contributor hits. (`docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md`
 *    was cited by six files and had never existed — exactly this failure,
 *    found by adding this check.)
 * 3. **An example stops being real.** An example JSON blob typed by hand
 *    into a document is a claim about output that nothing validates. The
 *    three examples in `docs/SOUNDNESS-CONTRACT.md` are GENERATED here by
 *    running the real analyzer over a real project, validated against
 *    `schemas/result.schema.json`, and byte-compared to what the document
 *    shows.
 *
 * DELIBERATELY NOT IN THE FOUNDATION GATE. `npm run test:foundation` owns
 * SOUNDNESS invariants, and a stale document is not one: adding a docs
 * check there would dilute the meaning of a red Foundation gate. This runs
 * under `npm test`, which is where the rest of the non-invariant coverage
 * lives.
 *
 * To re-generate the examples and the scorecard after an intentional
 * change:  `UPDATE_DOCS=1 npx vitest run src/testing/docs-contract.test.ts`
 */

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOUNDNESS_DOC = path.join(ROOT, "docs/SOUNDNESS-CONTRACT.md");
const UPDATE = process.env.UPDATE_DOCS === "1";

afterAll(() => {
  cleanupCorpus();
});

// ====================================================================
// 1. THE SCORECARD IS CURRENT
// ====================================================================

describe("docs/SCORECARD.md tracks its sources", () => {
  it("is not stale", () => {
    if (UPDATE) {
      execFileSync(process.execPath, ["scripts/generate-scorecard.mjs"], {
        cwd: ROOT,
      });
    }
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/generate-scorecard.mjs", "--check"],
        { cwd: ROOT, stdio: "pipe" },
      ),
    ).not.toThrow();
  });
});

// ====================================================================
// 2. LINKS AND COMMANDS RESOLVE
// ====================================================================

describe("documentation references resolve", () => {
  it("names no npm script and no file that does not exist", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/check-docs.mjs"], {
        cwd: ROOT,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});

// ====================================================================
// 3. THE WORKED EXAMPLES ARE REAL OUTPUT
// ====================================================================

/** The advisory every example project is scanned against. */
const ADVISORY = {
  packageName: "vuln-lib",
  id: "GHSA-f7-0001",
  fixed: "9.0.0",
} as const;

const APP_LOCK = JSON.stringify({
  name: "app",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": { name: "app", version: "1.0.0" },
    "node_modules/vuln-lib": { version: "1.0.0" },
  },
});

/** The shared shell of an example project; only `src/index.js` differs. */
const project = (entrypointSource: string): Record<string, string> => ({
  "vulntrace.yml": config(["src/index.js"]),
  "rules.yml": `rules:\n${rule(ADVISORY.id, "vuln-lib")}`,
  "package.json": JSON.stringify({
    name: "app",
    version: "1.0.0",
    dependencies: { "vuln-lib": "1.0.0" },
  }),
  "package-lock.json": APP_LOCK,
  ...under("node_modules/vuln-lib", installedLib("vuln-lib", "1.0.0")),
  "src/index.js": entrypointSource,
});

const EXAMPLES = [
  {
    key: "affected",
    /** Calls the vulnerable export directly: a concrete reachable path. */
    source:
      'const { danger } = require("vuln-lib");\n' +
      "function main(x) {\n  return danger(x);\n}\n" +
      "module.exports = { main };\n",
  },
  {
    key: "not-affected",
    /**
     * Loads the instance and calls it — on its SAFE export. Family C is
     * the family worth showing: family A's premise is that nothing loads
     * the package, which reads as "the tool found nothing" to someone
     * skimming, while this one exhibits a positive unreachability proof
     * over a target that was genuinely resolved.
     */
    source:
      'const { safe } = require("vuln-lib");\n' +
      "function main(x) {\n  return safe(x);\n}\n" +
      "module.exports = { main };\n",
  },
  {
    key: "unknown",
    /**
     * A dynamic member dispatch the call graph cannot resolve sits between
     * the entrypoint and the package, so no negative proof completes and
     * no path is established either.
     */
    source:
      'const lib = require("vuln-lib");\n' +
      "function main(name, x) {\n  return lib[name](x);\n}\n" +
      "module.exports = { main };\n",
  },
] as const;

/**
 * Strips the genuinely environmental things — the temp root, the scan's
 * random id, and elapsed milliseconds — and NOTHING else.
 *
 * Package instance paths survive byte for byte (they are already emitted
 * relative to the project root), because collapsing them is precisely how
 * an example would stop demonstrating instance exactness.
 */
function presentable(output: unknown, root: string): unknown {
  const normalized = normalizeDeep(output, root, "project") as Record<
    string,
    unknown
  >;
  const scan = normalized.scan as Record<string, unknown> | undefined;
  return {
    ...normalized,
    ...(scan === undefined
      ? {}
      : {
          scan: {
            ...scan,
            ...("id" in scan
              ? { id: "00000000-0000-0000-0000-000000000000" }
              : {}),
            ...("startedAt" in scan
              ? { startedAt: "2026-01-01T00:00:00.000Z" }
              : {}),
            ...("durationMs" in scan ? { durationMs: 0 } : {}),
          },
        }),
    ...(normalized.timings === undefined
      ? {}
      : {
          timings: Object.fromEntries(
            Object.entries(normalized.timings as Record<string, unknown>).map(
              ([key, value]) => [key, typeof value === "number" ? 0 : value],
            ),
          ),
        }),
  };
}

const BLOCK = (key: string) => ({
  open: `<!-- example:${key} -->`,
  close: `<!-- /example:${key} -->`,
});

function replaceBlock(document: string, key: string, body: string): string {
  const { open, close } = BLOCK(key);
  const start = document.indexOf(open);
  const end = document.indexOf(close);
  if (start < 0 || end < 0) {
    throw new Error(`docs/SOUNDNESS-CONTRACT.md: no ${open} block`);
  }
  return (
    document.slice(0, start + open.length) +
    `\n\n\`\`\`json\n${body}\n\`\`\`\n\n` +
    document.slice(end)
  );
}

function readBlock(document: string, key: string): string {
  const { open, close } = BLOCK(key);
  const start = document.indexOf(open);
  const end = document.indexOf(close);
  if (start < 0 || end < 0) {
    throw new Error(`docs/SOUNDNESS-CONTRACT.md: no ${open} block`);
  }
  const section = document.slice(start + open.length, end);
  const fence = section.match(/```json\n([\s\S]*?)\n```/);
  if (fence?.[1] === undefined) {
    throw new Error(`docs/SOUNDNESS-CONTRACT.md: ${open} holds no json fence`);
  }
  return fence[1];
}

describe("docs/SOUNDNESS-CONTRACT.md's examples are real analyzer output", () => {
  for (const example of EXAMPLES) {
    it(`${example.key}: matches a fresh scan, and validates against the schema`, async () => {
      const root = materialize(`docs-${example.key}`, project(example.source));
      const { provider } = providerFor([ADVISORY]);
      const { output } = await scanProject(root, provider);

      // The example is only worth showing if the real output is valid.
      expect(validateScanOutput(output)).toEqual([]);

      const rendered = JSON.stringify(presentable(output, root), null, 2);

      if (UPDATE) {
        writeFileSync(
          SOUNDNESS_DOC,
          replaceBlock(
            readFileSync(SOUNDNESS_DOC, "utf-8"),
            example.key,
            rendered,
          ),
        );
      }

      expect(readBlock(readFileSync(SOUNDNESS_DOC, "utf-8"), example.key)).toBe(
        rendered,
      );
    });
  }

  it("shows all three verdicts, and a NOT_AFFECTED that exposes its proof", () => {
    const document = readFileSync(SOUNDNESS_DOC, "utf-8");
    const verdicts = EXAMPLES.map((example) => {
      const parsed = JSON.parse(readBlock(document, example.key)) as {
        findings: { verdict: string; evidence?: Record<string, unknown> }[];
      };
      return parsed.findings.map((finding) => finding.verdict);
    });
    expect(verdicts.flat().sort()).toEqual(
      ["AFFECTED", "NOT_AFFECTED", "UNKNOWN"].sort(),
    );

    const notAffected = JSON.parse(readBlock(document, "not-affected")) as {
      findings: { evidence: Record<string, unknown> }[];
    };
    const proved = notAffected.findings[0];
    expect(proved).toBeDefined();
    // F7 § 33: the NOT_AFFECTED example must expose its proof family, not
    // merely assert the verdict.
    expect(
      Object.keys(proved?.evidence ?? {}).filter((key) =>
        key.startsWith("confirmed"),
      ),
    ).toHaveLength(1);
  });
});
