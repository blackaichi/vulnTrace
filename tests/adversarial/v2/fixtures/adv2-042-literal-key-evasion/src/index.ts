import * as lib from "vt2-vuln-lib";

const KEY = "dangerousOp";

export function main() {
  const fns = lib as unknown as Record<string, () => unknown>;
  const fn = fns[KEY];
  return fn();
}
