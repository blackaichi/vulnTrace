import { Lib } from "vt2-vuln-lib";

export function main() {
  const instance = new Lib();
  return instance.runSafe();
}
