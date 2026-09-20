// Part 4's ESM half, in its own process because it needs module (strict,
// ESM) code. Prints one JSON object; `entry.js` asserts on it.
import * as ns from "esmpkg";
import cjsDefault from "pkg";

function patched() {
  return "local#patched";
}

let namespaceWriteThrew = false;
let namespaceWriteError = null;
try {
  // A Module Namespace Exotic Object is sealed and every binding is
  // non-writable, so this is a TypeError in ESM's implicit strict mode.
  ns.run = patched;
} catch (e) {
  namespaceWriteThrew = true;
  namespaceWriteError = e.constructor.name;
}

// The namespace export is untouched, so the call still reaches the export.
const namespaceRunStillReachesExport = ns.run();

// The DEFAULT import of a CommonJS module is `module.exports` itself: an
// ordinary, mutable object. The same write succeeds here.
const originalRun = cjsDefault.run;
cjsDefault.run = patched;
const cjsDefaultWritePatched = cjsDefault.run();
cjsDefault.run = originalRun;

process.stdout.write(
  JSON.stringify({
    namespaceWriteThrew,
    namespaceWriteError,
    namespaceRunStillReachesExport,
    cjsDefaultWritePatched,
  }),
);
