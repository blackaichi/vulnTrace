"use strict";

// One of TWO workspace packages both declaring `"name": "dup"`. This is an
// invalid workspace configuration; VulnTrace must not pick a winner by
// traversal or declaration order (P1-A4 § DUPLICATE PACKAGE NAMES).
function vulnerable(input) {
  return "dupa/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
