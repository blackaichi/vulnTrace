"use strict";

// THE CANONICAL P1-A4 CASE.
//
// A private workspace package with NO `version`. npm writes its lockfile
// entry without one, so it forms no DependencyNode and never reaches
// `KnownPackageRoots` through dependency provenance -- unlike its
// versioned siblings, which do. The repository's own `workspaces`
// declaration is the ONLY authority that can give it an identity.
//
// Its public export is FORWARDED, which is what makes the difference
// observable: without an instance to anchor at, the advisory's name is not
// bindable in this file at all (it is a forward, not a definition), so
// nothing can be proved about it either way.
exports.vulnerable = require("./impl").internal;
