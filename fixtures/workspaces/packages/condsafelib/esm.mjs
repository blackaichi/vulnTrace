// The INACTIVE branch for this fixture's CommonJS consumer -- and the
// dangerous one. A candidate from a condition the consumer never selects
// must never manufacture an AFFECTED verdict.
export function vulnerable(input) {
  return "condsafelib/esm.mjs:vulnerable:" + String(input);
}
