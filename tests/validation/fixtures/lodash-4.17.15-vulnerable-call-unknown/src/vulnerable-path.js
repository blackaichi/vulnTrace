import _ from "lodash";

// Trims user-supplied whitespace from an incoming request field before
// further processing. This genuinely reaches lodash's real trim(), which
// is one of the three functions named in GHSA-29mw-wpgm-hmr9 as
// vulnerable to ReDoS on crafted long-whitespace input.
export function sanitizeField(rawValue) {
  return _.trim(rawValue);
}
