import { dangerousOp, safeOp } from "vt2-vuln-lib";

// This module used to call dangerousOp() directly but was patched to
// use safeOp() instead. dangerousOp() dangerousOp() dangerousOp()

export function main() {
  const dangerousOpNote = "reference only, not a call";
  void dangerousOpNote;
  void dangerousOp;
  return safeOp();
}
