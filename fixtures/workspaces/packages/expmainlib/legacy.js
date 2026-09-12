"use strict";

// The superseded `main`, exporting the advisory's literal name and really
// loaded at runtime -- but not reachable through the package name under
// any importer. The P1-A4 false-AFFECTED case for a WORKSPACE package.
function vulnerable(input) {
  return "expmainlib/legacy.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
