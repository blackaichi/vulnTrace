"use strict";
// Every heritage form RWF-020 reasons about, measured under real `node` in
// this same process. Each entry runs its class definition inside a `try`
// and reports whether the DEFINITION completed, and if not, WHY -- because
// the "why" is the whole point: several forms throw for a reason that is
// NOT "the heritage call was definitely abrupt", and RWF-020 deliberately
// does not claim those.

function bail() {
  throw new Error("bail() always throws");
}

async function asyncBail() {
  throw new Error("asyncBail() rejects");
}

// `asyncBail()` RETURNS a rejected promise rather than throwing -- which is
// exactly the distinction RWF-020 draws -- and nothing in a heritage clause
// ever awaits it, so the rejection would take the process down on its own.
// Swallowing it here is not hiding anything: the rejection IS the evidence
// that the call completed normally.
process.on("unhandledRejection", (err) => {
  console.log("  (async callee's promise rejected later:", err.message + ")");
});

function* generatorBail() {
  throw new Error("generatorBail() body -- only runs when iterated");
}

function baseFactory() {
  return class Base {};
}

function notAConstructor() {
  return 1;
}

let conditional = false;
function conditionalBail() {
  if (conditional) {
    throw new Error("conditionalBail() threw this time");
  }
  return class Base {};
}

function measure(label, define) {
  let outcome;
  try {
    define();
    outcome = "COMPLETED";
  } catch (err) {
    outcome = "THREW: " + err.constructor.name + ": " + err.message;
  }
  console.log("  " + label.padEnd(46) + " -> " + outcome);
  return outcome;
}

function report() {
  measure("class C extends bail() {}", () => {
    class C extends bail() {}
    return C;
  });
  measure("const C = class extends bail() {}", () => {
    const C = class extends bail() {};
    return C;
  });
  measure("class C extends (bail()) {}", () => {
    class C extends bail() {}
    return C;
  });
  measure("class C extends baseFactory() {}   [control]", () => {
    class C extends baseFactory() {}
    return C;
  });
  measure("class C extends null {}            [control]", () => {
    class C extends null {}
    return C;
  });
  measure("class C extends asyncBail() {}     [DIFFERENT reason]", () => {
    class C extends asyncBail() {}
    return C;
  });
  measure("class C extends generatorBail() {} [DIFFERENT reason]", () => {
    class C extends generatorBail() {}
    return C;
  });
  measure("class C extends notAConstructor() {} [DIFFERENT reason]", () => {
    class C extends notAConstructor() {}
    return C;
  });
  conditional = false;
  measure("class C extends conditionalBail() {} [flag off]", () => {
    class C extends conditionalBail() {}
    return C;
  });
  conditional = true;
  measure("class C extends conditionalBail() {} [flag on]", () => {
    class C extends conditionalBail() {}
    return C;
  });
  conditional = false;
  measure("function configure() { class C extends bail() {} }", () => {
    function configure() {
      class C extends bail() {}
      return C;
    }
    return configure;
  });
  measure("class Outer { field = class extends bail() {}; }", () => {
    class Outer {
      field = class Inner extends bail() {};
    }
    return Outer;
  });
}

// Heritage is evaluated BEFORE any class element. This is the ordering
// claim RWF-020 rests on, and it is measured rather than asserted.
function reportOrder() {
  const seen = [];
  function trace(name) {
    seen.push(name);
    return name;
  }
  function throwingBase() {
    seen.push("heritage");
    throw new Error("throwingBase() always throws");
  }
  try {
    class C extends throwingBase() {
      [trace("computed key")] = 1;
      static x = trace("static field");
      static {
        trace("static block");
      }
    }
    console.log("  class definition COMPLETED (UNEXPECTED)");
  } catch (err) {
    console.log("  class definition threw:", err.message);
  }
  console.log("  evaluated, in order:", JSON.stringify(seen));
  console.log(
    "  -> heritage ran first and NOTHING else ran:",
    seen.length === 1 && seen[0] === "heritage",
  );

  // And with a HARMLESS heritage, the elements do run -- so the ordering
  // above is genuinely "heritage aborted it", not "elements never run".
  const seenOk = [];
  function traceOk(name) {
    seenOk.push(name);
    return name;
  }
  class D extends baseFactory() {
    [traceOk("computed key")] = 1;
    static y = traceOk("static field");
  }
  console.log("  with a harmless heritage:", JSON.stringify(seenOk), "on", D.name);
}

module.exports = { report, reportOrder };
