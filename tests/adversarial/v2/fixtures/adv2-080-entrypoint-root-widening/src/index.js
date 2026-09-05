const runner = require("vt2-runner-lib");

// The ONLY path from this application to the vulnerable package. Nothing
// in this file calls it: it runs because this module is the configured
// entrypoint and an outside caller invokes the value it exports. That is
// precisely the case entrypoint ROOT selection exists to cover.
function main(userInput) {
  return runner.run(userInput);
}

// A resolvable local callable whose entire body is a single unconditional
// throw -- RWF-016's callee, unchanged. Its only job here is to make the
// export write below BYPASSABLE, so that export attribution is withdrawn.
function bail() {
  throw new Error("startup preconditions not met");
}

// A same-name decoy that returns nothing interesting, so that any root
// selection reaching for "the function whose name matches" has something
// wrong to land on. It changes no answer: rooting it merely adds a
// harmless traversal start point.
function run() {
  return "decoy";
}

// A nested helper that DOES reach the vulnerable package. Export ambiguity
// is no evidence whatsoever that it is exported -- nothing can export it,
// because nothing outside `outer` can name it. Root widening must stay at
// the module's own top-level callable surface and must NOT root this.
function outer() {
  function hidden(input) {
    return runner.run(input);
  }
  return hidden;
}

// A deferred write to `module.exports` inside a function nobody calls.
// This is itself one of the reasons attribution is withdrawn, and it is a
// second trap: an analyzer that "resolves" the ambiguity by picking a
// write would pick this one or the one below, and both are guesses.
function configure() {
  module.exports = run;
}
void configure;
void outer;

if (process.env.VT2_MODE === "strict") {
  bail();
}

// Reached on every run where VT2_MODE is not "strict" -- which is to say,
// on the default run. `main` really is this module's exported value there,
// really is callable by whoever requires this entrypoint, and really does
// reach the nested vt2-vuln-lib install's dangerousOp. Syntactically this
// is a bare identifier assigned by an unconditional top-level statement,
// last in the file; what makes its attribution ambiguous is only that the
// call above it can end module evaluation first (RWF-015/016) and that a
// deferred write exists (RWF-014).
module.exports = main;
