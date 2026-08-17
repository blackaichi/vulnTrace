import { dangerousOp, safeOp } from "vt2-vuln-lib";

export function main() {
  return safeOp();
}

export function unused() {
  return dangerousOp();
}
