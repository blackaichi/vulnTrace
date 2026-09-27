// Runtime ground truth, real node: for each probe, require() the library
// with the dangerous branch taken and observe whether module evaluation
// ENDED at the construct (so the later `module.exports = safeOp` never
// ran) or COMPLETED (so safeOp is authoritative).
//
// A cyclic consumer that grabbed the export before the construct would
// hold `dangerousOp` -- which is exactly why an "ended" module must never
// license a NOT_AFFECTED proof over the dangerous branch.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "manifest.json"), "utf-8"),
);

// B03's `async` callee rejects; the rejection is a probe artifact of the
// heritage check, not part of what is being measured.
process.on("unhandledRejection", () => {});

process.env.FIXTURE_LIB_MODE = "fast";
const rows = [];

for (const entry of manifest) {
  const libIndex = path.join(entry.dir, "node_modules", "fixture-lib", "index.js");
  const req = createRequire(libIndex);
  let observed;
  let detail = "";
  try {
    const value = req(libIndex);
    // Module evaluation completed. Which export won?
    observed = value && value.name === "dangerousOp" ? "ENDED-EXPORTS-DANGEROUS" : "COMPLETED";
    detail = typeof value === "function" ? value.name : typeof value;
  } catch (err) {
    // Evaluation threw: the later safe write never ran.
    observed = "ENDED";
    detail = String(err && err.message).slice(0, 60);
  }
  const endsEval = observed !== "COMPLETED";
  rows.push({
    id: entry.id,
    expectedEndsEval: entry.endsEval,
    runtimeEndsEval: endsEval,
    observed,
    detail,
    agrees: endsEval === entry.endsEval,
  });
}

for (const r of rows) {
  console.log(
    [
      r.agrees ? "ok " : "MISMATCH",
      r.id.padEnd(28),
      `expect=${String(r.expectedEndsEval).padEnd(5)}`,
      `runtime=${String(r.runtimeEndsEval).padEnd(5)}`,
      r.observed.padEnd(24),
      r.detail,
    ].join(" "),
  );
}
fs.writeFileSync(
  path.join(HERE, "runtime-truth.json"),
  JSON.stringify(rows, null, 2),
);
const bad = rows.filter((r) => !r.agrees);
console.log(`\n${rows.length} probes, ${bad.length} expectation mismatches`);
