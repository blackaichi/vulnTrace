"use strict";
// The NEGATIVE control, deliberately parallel to a.js: every factory here
// also has TWO endings, but each one has at least ONE ending that leaves the
// class definition able to complete. Every class below really is defined,
// module evaluation continues, and the LATER (safe) export really IS
// authoritative.
//
// Withdrawing authority for ANY of these would be an overreach -- reporting
// a class definition that demonstrably completes as fatal -- and is the
// failure mode RWF-027 is most exposed to. These are run with the flag value
// that takes the GOOD path, and entry.js asserts each class was bound.

function dangerousOp(input) {
  return "EXPLODED:" + input;
}

// throw + constructable.
function throwOrBase(flag) {
  if (flag) {
    throw new Error("boom");
  }
  return Base;
}

// invalid + constructable.
function invalidOrBase(flag) {
  if (flag) {
    return 1;
  }
  return Base;
}

// invalid + VALID NULL. `class C extends null {}` is legal, and `null` must
// never be folded in with the non-constructable values.
function invalidOrNull(flag) {
  if (flag) {
    return 1;
  }
  return null;
}

// throw + valid null.
function throwOrNull(flag) {
  if (flag) {
    throw new Error("boom");
  }
  return null;
}

// A nested-if whose VALID leaf is two levels down.
function nestedWithValidLeaf(a, b) {
  if (a) {
    if (b) return Base;
    throw new Error("boom");
  }
  return 2;
}

class Base {}

module.exports = dangerousOp;

class ExtendsThrowOrBase extends throwOrBase(false) {}
class ExtendsInvalidOrBase extends invalidOrBase(false) {}
class ExtendsInvalidOrNull extends invalidOrNull(false) {}
class ExtendsThrowOrNull extends throwOrNull(false) {}
class ExtendsNestedValid extends nestedWithValidLeaf(true, true) {}

function safeOp(input) {
  return "safe:" + input;
}

safeOp.classes = {
  ExtendsThrowOrBase,
  ExtendsInvalidOrBase,
  ExtendsInvalidOrNull,
  ExtendsThrowOrNull,
  ExtendsNestedValid,
};
module.exports = safeOp;
