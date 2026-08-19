const semver = require("semver"); // real semver@7.5.2, patched
const legacySemver = require("semver-vulnerable"); // real semver@7.5.1, npm-aliased, vulnerable

// GHSA-c2qf-rxjj-qqgw / CVE-2022-25883 (ReDoS in Range parsing).
// Same package name ("semver", confirmed by both packages' own
// package.json), two different real installed versions in this one
// dependency tree.
function isCompatible(userRange, version) {
  return new semver.Range(userRange).test(version);
}

function isLegacyCompatible(userRange, version) {
  return new legacySemver.Range(userRange).test(version);
}

module.exports = { isCompatible, isLegacyCompatible };
