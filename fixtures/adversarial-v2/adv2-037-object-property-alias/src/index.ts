import { dangerousOp } from "vt2-vuln-lib";

export function main() {
  const obj = { run: dangerousOp };
  return obj.run();
}
