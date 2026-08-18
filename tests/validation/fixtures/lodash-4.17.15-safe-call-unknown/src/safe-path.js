import _ from "lodash";

// Uses lodash, but only chunk() and uniq() -- neither is one of the three
// functions (trim/trimEnd/toNumber) GHSA-29mw-wpgm-hmr9 names as
// vulnerable. This genuinely never reaches the vulnerable code path.
export function groupUniqueIds(ids) {
  return _.chunk(_.uniq(ids), 10);
}
