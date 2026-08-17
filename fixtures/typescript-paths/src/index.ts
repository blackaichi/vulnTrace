// NodeNext/ESM module resolution requires an explicit output extension on
// this specifier (".js", matching the compiled file this ".ts" source maps
// to) even though the path is resolved through a "paths" alias, not a
// relative import -- see VT-206's completion report. Omitting it is a
// common, easy mistake that fails resolution the same way it would for a
// plain relative "./wrapper" import in this same module system.
import { callVulnerable } from "@lib/wrapper.js";

export function main() {
  return callVulnerable();
}
