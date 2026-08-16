import { readOwnVersion } from "../shared/own-version.js";
import { type CliIo, defaultIo } from "./io.js";

/** `vulntrace version` (see docs/SDD.md § 25). */
export function runVersionCommand(io: CliIo = defaultIo): number {
  io.stdout(`vulntrace ${readOwnVersion()}\n`);
  return 0;
}
