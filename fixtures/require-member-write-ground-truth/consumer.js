"use strict";

// The displacement shape, as a real program.
//
// `pkg.run` is a SAFE export. The program replaces it with a local wrapper
// that calls the vulnerable sink, and then calls `pkg.run()`. Real Node
// therefore reaches `danger#explode` on this load.
//
// An analyzer that keeps the require-bound attribution across the write
// answers "this call goes to pkg#run", which is (a) the wrong callable and
// (b) a RESOLVED answer where the honest answer is unresolved. (b) is the
// part that matters: a resolved edge carries no uncertainty blocker, so the
// reachable subgraph containing this call site reads as completely
// enumerated.

const pkg = require("pkg");
const danger = require("./danger");

const pkgCallsBefore = pkg.calls.slice();

function wrapper() {
  danger.explode();
  return "local#wrapper -> danger#explode";
}

const originalRun = pkg.run;
pkg.run = wrapper;

const via = pkg.run();

pkg.run = originalRun;

module.exports = {
  reached: danger.state.reached,
  via,
  pkgCalls: pkg.calls.slice(pkgCallsBefore.length),
};
