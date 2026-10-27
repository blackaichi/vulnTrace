// BL-114: BL-111's loader inventory (scripts/bl111-loader-writes-options/),
// repeated per Node release. Usage:
//
//   node scripts/bl114-loader-inventory-releases/run.mjs <out-dir> <node-binary>...
//
// For each binary (the first is the baseline the others are compared with):
//   <out-dir>/v<version>/   BL-111's setup.sh output (natives/, proj/, names.json)
//   <out-dir>/v<version>.json  the probe's output, workload with --require-esm
//   <out-dir>/v<version>.gadgets.txt  gadgets.cjs and gadgets-releases.cjs
// Then prints, per release, the inherited accesses the probe recorded that
// the baseline did not, and those it no longer records, with line and
// column numbers dropped (the loader's source moves between releases).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bl111 = resolve(here, "..", "bl111-loader-writes-options");
const [outDir, ...binaries] = process.argv.slice(2);
if (!outDir || binaries.length === 0) {
  console.error("usage: run.mjs <out-dir> <node-binary>...");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/** `get Object.prototype source <object> @ defaultLoadSync node:internal/modules/esm/load` */
function normalize(line) {
  const id = line.split("\t")[1];
  return id.replace(/:\d+:\d+\)?$/, "").replace(/ \(?node:/, " node:");
}

function runRelease(bin) {
  const env = { ...process.env, PATH: dirname(bin) + delimiter + process.env.PATH };
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  const dir = join(outDir, version);
  execFileSync("bash", [join(bl111, "setup.sh"), dir], { env, stdio: ["ignore", "ignore", "inherit"] });
  const probe = execFileSync(
    bin,
    ["--no-warnings", join(bl111, "probe-inherited.cjs"), join(dir, "proj"), join(dir, "names.json"), "--require-esm"],
    { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(join(outDir, `${version}.json`), probe);
  const gadgets = [join(bl111, "gadgets.cjs"), join(here, "gadgets-releases.cjs")]
    .map((script) => execFileSync(bin, [script], { env, encoding: "utf8" }))
    .join("");
  writeFileSync(join(outDir, `${version}.gadgets.txt`), gadgets);
  const parsed = JSON.parse(probe);
  return { version, parsed, hits: new Set(parsed.hits.map(normalize)), gadgets };
}

const releases = binaries.map(runRelease);
const [base] = releases;
for (const r of releases) {
  console.log(`## ${r.version}`);
  console.log(`accessors installed: ${r.parsed.installed}; failed: ${r.parsed.failed.length}`);
  console.log(`workload: ${JSON.stringify(r.parsed.results)}`);
  console.log(`distinct inherited accesses: ${r.hits.size}`);
  if (r !== base) {
    const added = [...r.hits].filter((h) => !base.hits.has(h)).sort();
    const gone = [...base.hits].filter((h) => !r.hits.has(h)).sort();
    console.log(`not in ${base.version} (${added.length}):`);
    for (const h of added) console.log(`  + ${h}`);
    console.log(`in ${base.version} only (${gone.length}):`);
    for (const h of gone) console.log(`  - ${h}`);
  }
  console.log("gadgets:");
  console.log(r.gadgets.replace(/^/gm, "  ").trimEnd());
  console.log();
}
