import { afterAll, describe, expect, it } from "vitest";
import { cleanupAll, describe1, pkgScaffold, scan } from "./harness.js";

afterAll(cleanupAll);

const LIB = {
  "node_modules/vlib/package.json": JSON.stringify({
    name: "vlib",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/vlib/index.js":
    "function vulnerable(){return 'boom';}\n" +
    "function safe(){return 'ok';}\n" +
    "module.exports = { vulnerable, safe };\n",
};

describe("P0-Z harness smoke", () => {
  it("reachable -> AFFECTED", async () => {
    const r = await scan({
      files: {
        ...pkgScaffold("app", "vlib", "1.0.0"),
        ...LIB,
        "src/index.js":
          "const v = require('vlib');\nmodule.exports.main = () => v.vulnerable();\n",
      },
      entrypoints: ["src/index.js"],
      pkgName: "vlib",
      targets: [{ module: "vlib", export: "vulnerable" }],
    });
    console.log("SMOKE reachable:", describe1(r.findings[0]), r.stderr);
    expect(r.findings[0]?.verdict).toBe("AFFECTED");
  });

  it("unreachable -> NOT_AFFECTED with a proof family", async () => {
    const r = await scan({
      files: {
        ...pkgScaffold("app", "vlib", "1.0.0"),
        ...LIB,
        "src/index.js":
          "const v = require('vlib');\nmodule.exports.main = () => v.safe();\n",
      },
      entrypoints: ["src/index.js"],
      pkgName: "vlib",
      targets: [{ module: "vlib", export: "vulnerable" }],
    });
    console.log("SMOKE unreachable:", describe1(r.findings[0]), r.stderr);
    expect(r.findings[0]?.verdict).toBe("NOT_AFFECTED");
  });

  it("dynamic -> never NOT_AFFECTED", async () => {
    const r = await scan({
      files: {
        ...pkgScaffold("app", "vlib", "1.0.0"),
        ...LIB,
        "src/index.js":
          "const n = process.env.M;\nconst v = require(n);\nmodule.exports.main = () => v.safe();\n",
      },
      entrypoints: ["src/index.js"],
      pkgName: "vlib",
      targets: [{ module: "vlib", export: "vulnerable" }],
    });
    console.log("SMOKE dynamic:", describe1(r.findings[0]), r.stderr);
    expect(r.findings[0]?.verdict).not.toBe("NOT_AFFECTED");
  });
});
