import { dangerousOp } from "vt2-vuln-lib";

export function main() {
  return [1, 2, 3].map(() => dangerousOp())[0];
}
