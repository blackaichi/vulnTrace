"use strict";
// The NEGATIVE control, deliberately identical to a.js except that every
// heritage value here is VALID, so no class definition aborts:
//
//   * `extends makeBase()`      -- returns a class
//   * `extends makeCtor()`      -- returns an ordinary function
//   * `extends makeNull()`      -- returns null, which `extends` ACCEPTS
//   * `extends maybeBase(true)` -- two returns, one of them invalid: not
//                                  definitely anything, and at runtime this
//                                  call happens to hand back a class
//   * a `class ... extends notAConstructor() {}` inside `configure()`,
//     which nothing calls at module scope, so its heritage is deferred
//
// Evaluating these class definitions runs the factories and nothing else,
// so module evaluation continues and the LATER (safe) export really is
// authoritative. Withdrawing authority here would be a false refusal --
// which is the failure mode RWF-022 is most exposed to.

function dangerousOp(input) {
  return "EXPLODED:" + input;
}

function notAConstructor() {
  return 1;
}

function makeBase() {
  return class Base {};
}

function makeCtor() {
  return function Ctor() {};
}

function makeNull() {
  return null;
}

function maybeBase(flag) {
  if (flag) {
    return makeBase();
  }
  return 1;
}

function configure() {
  class Deferred extends notAConstructor() {}
  return Deferred;
}

module.exports = dangerousOp;

class ExtendsClass extends makeBase() {}
class ExtendsFunction extends makeCtor() {}
class ExtendsNull extends makeNull() {}
class ExtendsMaybe extends maybeBase(true) {}

function safeOp(input) {
  return "safe:" + input;
}

safeOp.classes = {
  ExtendsClass,
  ExtendsFunction,
  ExtendsNull,
  ExtendsMaybe,
};
safeOp.configure = configure;
module.exports = safeOp;
