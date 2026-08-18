import * as lib from "vt2-vuln-lib";

export function main(key: string) {
  const fns = lib as unknown as Record<string, () => unknown>;
  return fns[key]();
}
