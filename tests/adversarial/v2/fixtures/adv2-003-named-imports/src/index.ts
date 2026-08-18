import { dangerousOp, safeOp } from "vt2-vuln-lib";

export function main() {
  safeOp();
  return dangerousOp();
}
