"use strict";
// The RWF-028 outcome matrix, MEASURED rather than asserted from memory.
//
// Every row below is a real CommonJS module, written to disk and loaded by
// real `node`. What is measured is the only thing that matters to the
// analyzer's soundness: did module evaluation reach the LATER EXPORT WRITE
// at the bottom of the file?
//
//   completes === false  ->  the later export never runs. VulnTrace MAY
//                            withdraw that write's authority.
//   completes === true   ->  the later export really is the module's
//                            value. Withdrawing it would be a false
//                            AFFECTED invented by this rule.
//
// `proven` is what VulnTrace's RWF-028 model claims about the row. A row
// with `proven: true` must have `completes: false` -- claiming a cutoff
// for a module that completes is unsound. The reverse is NOT an error:
// `proven: false` with `completes: false` is a row real node aborts and
// this analyzer declines to prove, which costs precision only. Those rows
// are labelled `precisionGap` so the gaps are documented by EXECUTION
// rather than by claim.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HEAD = [
  '"use strict";',
  "function safeFn() { return 'safe'; }",
  "function bail() { throw new Error('boom'); }",
  "",
].join("\n");

const TAIL = [
  "",
  "globalThis.__RWF028_REACHED = true;",
  "module.exports = safeFn;",
  "",
].join("\n");

const ROWS = [
  // ---------------- supported: proven, and genuinely fatal ----------------
  { name: "direct call (RWF-016 control)", body: "bail();", proven: true },
  { name: "C07 one-hop const alias", body: "const alias = bail;\nalias();", proven: true },
  {
    name: "C08 one wrapper hop",
    body: "function viaHelper() { bail(); }\nviaHelper();",
    proven: true,
  },
  {
    name: "C08 two wrapper hops",
    body: "function w1() { bail(); }\nfunction w2() { w1(); }\nw2();",
    proven: true,
  },
  { name: "C09 object shorthand member", body: "const h = { bail };\nh.bail();", proven: true },
  {
    name: "C09 explicit property alias",
    body: "const h = { run: bail };\nh.run();",
    proven: true,
  },
  {
    name: "C09 inline function-expression property",
    body: "const h = { run: function () { throw new Error('boom'); } };\nh.run();",
    proven: true,
  },
  {
    name: "C09 duplicate key, THROWING last",
    body: "const h = { bail: safeFn, bail };\nh.bail();",
    proven: true,
  },
  {
    name: "C10 throwing block shadow",
    body: "{\n  const bail = () => { throw new Error('boom'); };\n  bail();\n}",
    proven: true,
  },
  {
    name: "C10 throwing shadow, nested two blocks deep",
    body: "{\n  {\n    const bail = () => { throw new Error('boom'); };\n    bail();\n  }\n}",
    proven: true,
  },
  { name: "E01 new on an exact throwing function", body: "new bail();", proven: true },
  { name: "E01 new through an alias", body: "const alias = bail;\nnew alias();", proven: true },
  {
    name: "E01 new through an object member",
    body: "const h = { bail };\nnew h.bail();",
    proven: true,
  },
  {
    name: "optional CALL on a proven callee",
    body: "const h = { bail };\nh.bail?.();",
    proven: true,
  },
  {
    name: "RWF-026 required argument through an alias",
    body: "const alias = bail;\nString(alias());",
    proven: true,
  },

  // ---------------- refused, and genuinely NON-fatal ----------------
  // These complete. Proving any of them would be a false AFFECTED.
  { name: "alias of a SAFE callable", body: "const alias = safeFn;\nalias();", proven: false },
  {
    name: "alias reassigned to safe",
    body: "let alias = bail;\nalias = safeFn;\nalias();",
    proven: false,
  },
  {
    name: "conditional alias initializer (falsy)",
    body: "const alias = false ? bail : safeFn;\nalias();",
    proven: false,
  },
  {
    name: "wrapper with a surviving conditional path",
    body: "function helper(f) { if (f) { bail(); } }\nhelper(false);",
    proven: false,
  },
  {
    name: "wrapper with a RETURN path",
    body: "function helper(f) { if (f) { bail(); } return 1; }\nhelper(false);",
    proven: false,
  },
  {
    name: "wrapper that CATCHES",
    body: "function helper() { try { bail(); } catch {} }\nhelper();",
    proven: false,
  },
  {
    name: "wrapper that only DEFERS",
    body: "function helper() { return () => bail(); }\nhelper();",
    proven: false,
  },
  {
    name: "object binding reassigned",
    body: "let h = { bail };\nh = { bail: safeFn };\nh.bail();",
    proven: false,
  },
  {
    name: "object property overwritten",
    body: "const h = { bail };\nh.bail = safeFn;\nh.bail();",
    proven: false,
  },
  {
    name: "duplicate key, SAFE last",
    body: "const h = { bail, bail: safeFn };\nh.bail();",
    proven: false,
  },
  {
    name: "object mutated through an escaping reference",
    body: "const h = { bail };\nfunction patch(o) { o.bail = safeFn; }\npatch(h);\nh.bail();",
    proven: false,
  },
  {
    name: "SAFE inner shadow over a throwing outer",
    body: "{\n  const bail = () => 'safe';\n  bail();\n}",
    proven: false,
  },
  {
    name: "block binding reassigned to safe",
    body: "{\n  let b = bail;\n  b = safeFn;\n  b();\n}",
    proven: false,
  },
  { name: "new on a normal constructor", body: "function C() {}\nnew C();", proven: false },
  {
    name: "constructor binding reassigned",
    body: "let ctor = bail;\nctor = function Safe() {};\nnew ctor();",
    proven: false,
  },
  {
    name: "ASYNC callee -- rejected promise, not a synchronous throw",
    body: "async function ab() { throw new Error('boom'); }\nab().catch(() => {});",
    proven: false,
  },
  {
    name: "ASYNC callee through an alias",
    body: "async function ab() { throw new Error('boom'); }\nconst alias = ab;\nalias().catch(() => {});",
    proven: false,
  },
  {
    name: "GENERATOR callee -- body never starts",
    body: "function* gb() { throw new Error('boom'); }\ngb();",
    proven: false,
  },
  {
    name: "GENERATOR callee through an alias",
    body: "function* gb() { throw new Error('boom'); }\nconst alias = gb;\nalias();",
    proven: false,
  },
  {
    name: "abruptness CAUGHT at module scope",
    body: "const alias = bail;\ntry { alias(); } catch {}",
    proven: false,
  },
  {
    name: "deferred function body",
    body: "const alias = bail;\nfunction later() { alias(); }\nvoid later;",
    proven: false,
  },
  {
    name: "deferred arrow",
    body: "const h = { bail };\nconst cb = () => h.bail();\nvoid cb;",
    proven: false,
  },
  {
    name: "unrelated safe call in a file that declares a throwing callable",
    body: "safeFn();",
    proven: false,
  },

  // ------- refused, but genuinely fatal: DOCUMENTED PRECISION GAPS -------
  {
    name: "source binding rebound after alias capture",
    body: "let b = bail;\nconst alias = b;\nb = safeFn;\nalias();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "new on a non-constructable ARROW (TypeError before the body)",
    body: "const arrowBail = () => { throw new Error('boom'); };\nnew arrowBail();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "new on an ASYNC function (TypeError before the body)",
    body: "async function ab() { throw new Error('boom'); }\nnew ab();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "new on a GENERATOR function (TypeError before the body)",
    body: "function* gb() { throw new Error('boom'); }\nnew gb();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "object METHOD shorthand",
    body: "const h = { bail() { throw new Error('boom'); } };\nh.bail();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "class constructor body",
    body: "class C { constructor() { throw new Error('boom'); } }\nnew C();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "three wrapper hops (past the documented bound)",
    body: "function w1() { bail(); }\nfunction w2() { w1(); }\nfunction w3() { w2(); }\nw3();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "two alias hops (past the documented bound)",
    body: "const alias = bail;\nconst a2 = alias;\na2();",
    proven: false,
    precisionGap: true,
  },
  {
    name: "computed member on an exact literal",
    body: "const h = { bail };\nh['bail']();",
    proven: false,
    precisionGap: true,
  },
];

/**
 * Writes every row to a real module, loads it with real `node`, and
 * reports how many rows disagreed with their recorded expectation.
 */
function report() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rwf028-forms-"));
  let mismatches = 0;
  let proven = 0;
  let gaps = 0;

  ROWS.forEach((row, i) => {
    const file = path.join(dir, "row" + i + ".js");
    fs.writeFileSync(file, HEAD + row.body + TAIL);

    globalThis.__RWF028_REACHED = false;
    let error;
    try {
      require(file);
    } catch (err) {
      error = err;
    }
    const completes = globalThis.__RWF028_REACHED === true;

    // The soundness rule: a proven row must NOT complete.
    const sound = !(row.proven && completes);
    // The bookkeeping rule: `precisionGap` marks exactly the rows that are
    // fatal but unproven, so the gap list cannot silently drift.
    const gapLabelled = Boolean(row.precisionGap) === (!row.proven && !completes);

    if (row.proven) proven += 1;
    if (row.precisionGap) gaps += 1;

    if (!sound || !gapLabelled) {
      mismatches += 1;
      console.log(
        "  MISMATCH  " +
          row.name +
          " -> completes=" +
          completes +
          " proven=" +
          Boolean(row.proven) +
          " precisionGap=" +
          Boolean(row.precisionGap) +
          (error ? " (" + error.constructor.name + ": " + error.message + ")" : ""),
      );
    } else {
      console.log(
        "  ok  " +
          (completes ? "COMPLETES" : "ABORTS   ") +
          "  " +
          (row.proven ? "proven " : row.precisionGap ? "gap    " : "refused") +
          "  " +
          row.name,
      );
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(
    "  -- " +
      ROWS.length +
      " rows measured: " +
      proven +
      " proven cutoffs, " +
      gaps +
      " documented precision gaps",
  );
  return mismatches;
}

module.exports = { report, ROWS };
