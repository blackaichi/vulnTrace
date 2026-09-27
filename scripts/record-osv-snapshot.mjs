#!/usr/bin/env node
/**
 * D-03 — records the real OSV answers the hermetic test suites replay.
 *
 * Run after `npm run build` (imports the compiled `dist/`, same pattern as
 * `scripts/rwf-045-corpus.mjs`). Requires live network access to
 * `https://api.osv.dev`. Writes two committed fixture files:
 *
 *   tests/validation/osv-snapshot.json
 *     Every `(ecosystem, name, version)` query the real pipeline issues
 *     for each case in tests/validation/cases/cases.json, recorded by
 *     running the actual `runScanCommand` against each fixture with a
 *     recording provider wrapped around a real `OsvProvider` -- not
 *     guessed by hand from cases.json, so it is exactly the query set
 *     production code issues (including every dependency in a fixture's
 *     node_modules, not only the named vulnerable package -- see
 *     advisoryQueryVersions in src/dependencies/package-instances.ts).
 *
 *   src/vulnerabilities/osv-provider.fixtures.json
 *     The two response envelopes osv-provider.integration.test.ts needs:
 *     a real "lodash" (no version) response, and a real response for a
 *     fabricated, definitely-nonexistent package name.
 *
 * Re-run this whenever a validation fixture or case changes, or to
 * refresh the snapshot against current OSV data:
 *
 *   npm run build && node scripts/record-osv-snapshot.mjs && \
 *     npx prettier --write tests/validation/osv-snapshot.json \
 *       src/vulnerabilities/osv-provider.fixtures.json
 *
 * The prettier pass is required: this script's own JSON.stringify output
 * does not match this project's prettier config byte-for-byte (line
 * width), and `npm run format` is a gate.
 *
 * Usage: node scripts/record-osv-snapshot.mjs
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScanCommand } from "../dist/cli/scan.js";
import { OsvProvider } from "../dist/vulnerabilities/osv-provider.js";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXTURES_ROOT = path.join(ROOT, "tests", "validation", "fixtures");
const CASES_PATH = path.join(
  ROOT,
  "tests",
  "validation",
  "cases",
  "cases.json",
);
const SNAPSHOT_PATH = path.join(
  ROOT,
  "tests",
  "validation",
  "osv-snapshot.json",
);
const PROVIDER_FIXTURES_PATH = path.join(
  ROOT,
  "src",
  "vulnerabilities",
  "osv-provider.fixtures.json",
);

function snapshotKey(query) {
  return query.version
    ? `${query.ecosystem}:${query.name}@${query.version}`
    : `${query.ecosystem}:${query.name}`;
}

/**
 * Recursively sorts object keys so two structurally identical OSV answers
 * compare equal regardless of the key order the backend happened to
 * serialize them in. Confirmed live: repeated queries for the same
 * package/version return byte-identical content with different nested key
 * order (e.g. inside `affected`/`references`) -- not a real disagreement.
 */
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** Wraps a real OsvProvider, recording every query and its raw answer. */
function recordingProvider(real, sink) {
  return {
    async queryPackage(input) {
      const key = snapshotKey(input);
      const results = await real.queryPackage(input);
      if (sink.has(key)) {
        const existing = sink.get(key);
        if (
          JSON.stringify(canonicalize(existing)) !==
          JSON.stringify(canonicalize(results))
        ) {
          throw new Error(
            `record-osv-snapshot: conflicting answers recorded for ${key} ` +
              `(two fixtures query the same package/version and got ` +
              `content-different results -- OSV data moved mid-recording, ` +
              `or a fixture is wrong)`,
          );
        }
        // Key order differed but content is identical -- keep the
        // first-recorded copy; no update needed.
        return results;
      }
      sink.set(key, results);
      return results;
    },
  };
}

function copyFixtureToTempDir(fixtureDir, caseId) {
  const dest = mkdtempSync(path.join(tmpdir(), `vulntrace-osv-record-${caseId}-`));
  cpSync(fixtureDir, dest, { recursive: true, dereference: false });
  return dest;
}

function fakeIo() {
  return { io: { stdout: () => {}, stderr: (t) => process.stderr.write(t) } };
}

async function recordValidationSnapshot() {
  const cases = JSON.parse(readFileSync(CASES_PATH, "utf-8"));
  const answers = new Map();
  const real = new OsvProvider();
  const provider = recordingProvider(real, answers);

  for (const testCase of cases) {
    const sourceFixtureDir = path.join(FIXTURES_ROOT, testCase.dir);
    const fixtureDir = copyFixtureToTempDir(sourceFixtureDir, testCase.id);
    try {
      const { io } = fakeIo();
      process.stderr.write(`recording ${testCase.id} (${testCase.package}@${testCase.version})...\n`);
      await runScanCommand({
        projectPathArg: fixtureDir,
        configPathOverride: path.join(fixtureDir, "vulntrace.yml"),
        noCache: true,
        provider,
        io,
      });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }

  // src/cli/scan.integration.test.ts queries lodash@4.17.4 directly (a
  // known-old historically-vulnerable version, no cases.json fixture uses
  // it) -- recorded into the same snapshot rather than a separate file,
  // since it is the same SnapshotOsvProvider/VulnerabilityProvider
  // interface that test uses.
  process.stderr.write("recording scan.integration.test.ts's lodash@4.17.4...\n");
  await provider.queryPackage({
    ecosystem: "npm",
    name: "lodash",
    version: "4.17.4",
  });

  const sorted = Object.fromEntries(
    [...answers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(sorted, null, 2) + "\n");
  process.stderr.write(
    `wrote ${SNAPSHOT_PATH} (${Object.keys(sorted).length} distinct queries)\n`,
  );
}

async function recordProviderFixtures() {
  const real = new OsvProvider();

  const lodash = await real.queryPackage({ ecosystem: "npm", name: "lodash" });
  const nonexistentName = "vulntrace-integration-test-nonexistent-fixture";
  const nonexistent = await real.queryPackage({
    ecosystem: "npm",
    name: nonexistentName,
  });

  if (nonexistent.length !== 0) {
    throw new Error(
      `record-osv-snapshot: expected an empty result for a fabricated ` +
        `nonexistent package name (${nonexistentName}), got ` +
        `${nonexistent.length} -- OSV's contract for an unknown package may ` +
        `have changed; this is itself a finding, not something to route ` +
        `around silently (see the D-03 task file's STOP conditions)`,
    );
  }

  const fixtures = {
    lodashNoVersion: { vulns: lodash },
    nonexistentPackage: { name: nonexistentName, vulns: nonexistent },
  };
  writeFileSync(
    PROVIDER_FIXTURES_PATH,
    JSON.stringify(fixtures, null, 2) + "\n",
  );
  process.stderr.write(`wrote ${PROVIDER_FIXTURES_PATH}\n`);
}

await recordValidationSnapshot();
await recordProviderFixtures();
