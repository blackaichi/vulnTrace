import * as lib from "vt2-vuln-lib";

export function main() {
  const fnName = process.argv[2] ?? "safeOp";
  const fns = lib as unknown as Record<string, () => unknown>;
  return fns[fnName]();
}
