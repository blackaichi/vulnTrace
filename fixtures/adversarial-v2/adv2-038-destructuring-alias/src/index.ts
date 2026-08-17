import * as lib from "vt2-vuln-lib";

export function main() {
  const { dangerousOp: doIt } = lib;
  return doIt();
}
