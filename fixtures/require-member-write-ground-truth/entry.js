"use strict";

// RWF-047 runtime ground truth. Run directly: `node entry.js`.
// Every claim is ASSERTED; the process exits non-zero if any is false.
//
// The question this fixture answers is NOT "what does VulnTrace say" -- it is
// "what does Node actually do", so that the analyzer's answer can be called
// wrong relative to a ground truth someone established rather than argued.

const assert = require("node:assert");

const results = [];
function row(shape, observed) {
  results.push({ shape, observed });
  return observed;
}

// ---------------------------------------------------------------------------
// Part 1 -- the two DIRECTIONS, in their minimal form.
// ---------------------------------------------------------------------------

// Direction 1 (the false-AFFECTED direction). The program overwrites the
// export before calling it. `pkg#run` -- the name the advisory would carry --
// is NEVER EXECUTED.
{
  const mod = require("pkg");
  const before = mod.calls.length;
  const originalRun = mod.run;
  function patched() {
    return "local#patched";
  }
  mod.run = patched;
  const got = mod.run();

  assert.strictEqual(got, "local#patched");
  assert.strictEqual(mod.run, patched);
  assert.notStrictEqual(mod.run, originalRun);
  // The decisive assertion: the vulnerable body never ran.
  assert.strictEqual(mod.calls.length, before);
  assert.ok(!mod.calls.includes("pkg#run"));
  row("D1 const mod = require('pkg'); mod.run = patched; mod.run()", got);

  mod.run = originalRun; // restore -- the require cache is process-wide.
}

// Direction 2 (the false-NOT_AFFECTED direction). The same write, read the
// other way round: the name the program CALLS is the local one, and the
// local one is what executes. An analyzer that attributes this call to
// `pkg#run` is not merely imprecise -- it is pointing at a DIFFERENT callable
// from the one the runtime invokes, in both directions of the swap.
{
  const mod = require("pkg");
  function dangerous() {
    return "local#dangerous";
  }
  const originalRun = mod.run;
  mod.run = dangerous;
  const got = mod.run();

  assert.strictEqual(got, "local#dangerous");
  // `pkg#run` is still a perfectly real, still-callable export. It is simply
  // not what `mod.run()` reaches any more. This is what makes the stale
  // attribution RESOLVE rather than dangle.
  assert.strictEqual(typeof originalRun, "function");
  assert.strictEqual(originalRun(), "pkg#run");
  row("D2 same write, vulnerable local: mod.run() reaches the LOCAL", got);

  mod.run = originalRun;
  mod.calls.length = 0;
}

// The require cache is process-wide: the write is visible to every other
// consumer of the same module instance. This is why monkey-patching works at
// all, and it is what makes the displacement in Part 3 reach across files.
{
  const a = require("pkg");
  const b = require("pkg");
  assert.strictEqual(a, b, "same module instance from the require cache");
  const originalRun = a.run;
  function patched() {
    return "local#patched";
  }
  a.run = patched;
  assert.strictEqual(b.run, patched);
  assert.strictEqual(b.run(), "local#patched");
  row("D3 the write is visible through a SECOND require of the same module", "shared");
  a.run = originalRun;
}

// ---------------------------------------------------------------------------
// Part 2 -- the widened shapes. Each row records what Node does, so the
// analyzer's behaviour on the same shape can be called right or wrong.
// ---------------------------------------------------------------------------

// W2 -- Object.defineProperty. A plain data property on a CommonJS exports
// object is configurable and writable, so this redefines it.
{
  const mod = require("pkg");
  const originalRun = mod.run;
  const descriptor = Object.getOwnPropertyDescriptor(mod, "run");
  assert.strictEqual(descriptor.configurable, true);
  assert.strictEqual(descriptor.writable, true);

  function patched() {
    return "local#definedProperty";
  }
  Object.defineProperty(mod, "run", {
    value: patched,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  const got = mod.run();
  assert.strictEqual(got, "local#definedProperty");
  assert.ok(!mod.calls.includes("pkg#run"));
  row("W2 Object.defineProperty(mod, 'run', { value: patched })", got);

  Object.defineProperty(mod, "run", {
    value: originalRun,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

// W3 -- delete. The property is configurable, so the delete SUCCEEDS and the
// subsequent call is a TypeError. `pkg#run` is not called; nothing is.
{
  const mod = require("pkg");
  const originalRun = mod.run;
  const deleted = delete mod.run;
  assert.strictEqual(deleted, true);
  assert.strictEqual(mod.run, undefined);

  let threw = null;
  try {
    mod.run();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof TypeError, "calling the deleted member throws");
  assert.ok(!mod.calls.includes("pkg#run"));
  row("W3 delete mod.run; mod.run()", `TypeError: ${threw.message}`);

  mod.run = originalRun;
}

// W4 -- a write through an ALIAS. `const m2 = mod` copies the REFERENCE; the
// object is the same object, so the write lands on it.
{
  const mod = require("pkg");
  const originalRun = mod.run;
  const m2 = mod;
  assert.strictEqual(m2, mod);
  function patched() {
    return "local#viaAlias";
  }
  m2.run = patched;
  const got = mod.run();
  assert.strictEqual(got, "local#viaAlias");
  assert.ok(!mod.calls.includes("pkg#run"));
  row("W4 const m2 = mod; m2.run = patched; mod.run()", got);
  mod.run = originalRun;
}

// W5 -- the write happens INSIDE a called function, not at module scope. The
// object is reached through the closure; the effect is identical.
{
  const mod = require("pkg");
  const originalRun = mod.run;
  function patched() {
    return "local#viaInstaller";
  }
  function install() {
    mod.run = patched;
  }
  install();
  const got = mod.run();
  assert.strictEqual(got, "local#viaInstaller");
  assert.ok(!mod.calls.includes("pkg#run"));
  row("W5 function install() { mod.run = patched } install(); mod.run()", got);
  mod.run = originalRun;
}

// W9 -- writing a DIFFERENT member. The control for the widening: `mod.run`
// is untouched, so `mod.run()` really does reach `pkg#run`. An analyzer that
// refuses this one is imprecise; an analyzer that resolves it is CORRECT.
{
  const mod = require("pkg");
  mod.calls.length = 0;
  const originalExecute = mod.execute;
  mod.execute = function patched() {
    return "local#patched";
  };
  const got = mod.run();
  assert.strictEqual(got, "pkg#run");
  assert.deepStrictEqual(mod.calls, ["pkg#run"]);
  row("W9 mod.execute = patched; mod.run()  [negative control]", got);
  mod.execute = originalExecute;
  mod.calls.length = 0;
}

// ---------------------------------------------------------------------------
// Part 3 -- the DISPLACEMENT chain, executed. This is the link the
// false-NOT_AFFECTED direction turns on: the stale attribution does not merely
// name the wrong target, it makes an UNRESOLVED call look RESOLVED, so the
// reachable subgraph reads as completely enumerated.
// ---------------------------------------------------------------------------
{
  const observed = require("./consumer.js");
  // consumer.js monkey-patches `pkg.run` with a function whose body calls a
  // vulnerable sink, then calls `pkg.run()`. Real Node reaches the sink.
  assert.strictEqual(observed.reached, true, "the sink really is executed");
  assert.strictEqual(observed.via, "local#wrapper -> danger#explode");
  // And `pkg#run`, the target the stale attribution names, did not run.
  assert.ok(!observed.pkgCalls.includes("pkg#run"));
  row("P3 displacement: patched wrapper reaches danger#explode", observed.via);
}

// ---------------------------------------------------------------------------
// Part 4 -- ESM. A namespace object is SEALED and its bindings are
// non-writable, so the same write is a TypeError in module (strict) code.
// The DEFAULT import of a CommonJS module is an ordinary mutable object and
// behaves exactly like the require case. These two differ, and the difference
// is the reason Part 4 exists.
// ---------------------------------------------------------------------------
const esm = require("node:child_process").spawnSync(
  process.execPath,
  [require("node:path").join(__dirname, "esm-probe.mjs")],
  { encoding: "utf8" },
);
assert.strictEqual(esm.status, 0, `esm-probe.mjs failed: ${esm.stderr}`);
const esmRows = JSON.parse(esm.stdout);
assert.strictEqual(esmRows.namespaceWriteThrew, true);
assert.strictEqual(esmRows.namespaceWriteError, "TypeError");
assert.strictEqual(esmRows.namespaceRunStillReachesExport, "esmpkg#run");
assert.strictEqual(esmRows.cjsDefaultWritePatched, "local#patched");
row("W7 ESM `import * as mod`; mod.run = patched", "TypeError (namespace is sealed)");
row("W8 ESM default import of CJS; mod.run = patched", esmRows.cjsDefaultWritePatched);

// ---------------------------------------------------------------------------
for (const r of results) {
  console.log(`  ${r.shape}\n    -> ${r.observed}`);
}
console.log("RWF-047 ground truth: all assertions passed");
