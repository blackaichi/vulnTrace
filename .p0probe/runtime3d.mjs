// P0-D runtime truth: the cutoff sits in the ENTRYPOINT, so the question
// is the RWF-021 one -- on the run where the cutoff branch is NOT taken,
// does the entrypoint publish a callable that really reaches the sink?
// If yes, any NOT_AFFECTED is false.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures3", "manifest.json"), "utf-8"),
);

delete process.env.FIXTURE_LIB_MODE; // branch NOT taken
for (const entry of manifest) {
  if (!entry.id.startsWith("D")) continue;
  const entryFile = path.join(entry.dir, "src", "index.cjs");
  const req = createRequire(entryFile);
  let result;
  try {
    const mod = req(entryFile);
    const fn = typeof mod === "function" ? mod : mod.main;
    result = typeof fn === "function" ? fn("x") : `no-callable(${typeof fn})`;
  } catch (err) {
    result = "THREW: " + String(err && err.message).slice(0, 50);
  }
  const reachesSink = String(result).startsWith("danger:");
  console.log(
    [
      reachesSink ? "REACHES-SINK" : "no-sink     ",
      entry.id.padEnd(34),
      String(result).slice(0, 40),
    ].join(" "),
  );
}
