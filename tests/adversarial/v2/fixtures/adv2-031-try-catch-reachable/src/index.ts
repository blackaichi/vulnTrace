import { dangerousOp } from "vt2-vuln-lib";

function riskyStep(input: string) {
  if (input === "bad") {
    throw new Error("bad input");
  }
}

export function main(input: string) {
  try {
    riskyStep(input);
    return dangerousOp();
  } catch {
    return "recovered";
  }
}
