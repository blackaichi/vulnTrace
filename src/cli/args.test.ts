import { describe, expect, it } from "vitest";
import { parseFlags } from "./args.js";

describe("parseFlags", () => {
  it("collects bare tokens as positionals", () => {
    const { positionals, flags } = parseFlags(["scan", "."]);

    expect(positionals).toEqual(["scan", "."]);
    expect(flags).toEqual({});
  });

  it("parses --flag value pairs", () => {
    const { flags } = parseFlags(["--format", "json", "--cve", "GHSA-xxxx"]);

    expect(flags).toEqual({ format: "json", cve: "GHSA-xxxx" });
  });

  it("parses --flag=value form", () => {
    const { flags } = parseFlags(["--format=json"]);

    expect(flags).toEqual({ format: "json" });
  });

  it("treats a trailing --flag with no following value as boolean true", () => {
    const { flags } = parseFlags(["--pretty"]);

    expect(flags).toEqual({ pretty: true });
  });

  it("treats a --flag immediately followed by another --flag as boolean true", () => {
    const { flags } = parseFlags(["--pretty", "--format", "json"]);

    expect(flags).toEqual({ pretty: true, format: "json" });
  });

  it("mixes positionals and flags in any order", () => {
    const { positionals, flags } = parseFlags([
      "scan",
      ".",
      "--format",
      "json",
      "--pretty",
    ]);

    expect(positionals).toEqual(["scan", "."]);
    expect(flags).toEqual({ format: "json", pretty: true });
  });
});
