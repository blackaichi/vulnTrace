import { dangerousOp } from "vt2-vuln-lib";

export function main() {
  return Promise.resolve().then(() => dangerousOp());
}
