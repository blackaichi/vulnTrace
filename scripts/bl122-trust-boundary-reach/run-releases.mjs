// Task BL-122 — `probe-reach.cjs` repeated per Node release. Usage:
//
//   node scripts/bl122-trust-boundary-reach/run-releases.mjs <out-dir> <node-binary>...
//
// For each binary, writes `<out-dir>/v<version>.txt` (the probe's output)
// and then prints one table: every member any release touched, and the
// releases that touched it. A fixture is written per release under
// `<out-dir>/fixture-v<version>`.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [outDir, ...binaries] = process.argv.slice(2);
if (!outDir || binaries.length === 0) {
  console.error("usage: run-releases.mjs <out-dir> <node-binary>...");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const probe = join(dirname(fileURLToPath(import.meta.url)), "probe-reach.cjs");
const byMember = new Map();
const versions = [];
for (const bin of binaries) {
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  versions.push(version);
  const out = execFileSync(
    bin,
    ["--no-deprecation", "--no-warnings", probe, join(outDir, `fixture-${version}`)],
    { encoding: "utf8" },
  );
  writeFileSync(join(outDir, `${version}.txt`), out);
  for (const line of out.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      if (line.includes("workload ok: false")) console.error(`${version}: workload failed`);
      continue;
    }
    const member = line.split("\t")[0];
    if (!byMember.has(member)) byMember.set(member, new Set());
    byMember.get(member).add(version);
  }
}
const all = (set) => (set.size === versions.length ? "all" : [...set].join(", "));
console.log(`| member | releases (of ${versions.join(", ")}) |`);
console.log(`| --- | --- |`);
for (const [member, set] of [...byMember].sort(([a], [b]) => (a < b ? -1 : 1))) {
  console.log(`| \`${member}\` | ${all(set)} |`);
}
