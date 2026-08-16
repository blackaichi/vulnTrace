import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import {
  buildDependencyGraphFromCycloneDx,
  loadCycloneDxFile,
} from "./cyclonedx.js";

describe("CycloneDX SBOM ingestion against a real fixture", () => {
  it("loads and maps fixtures/sbom-cyclonedx/bom.json", () => {
    const sbom = loadCycloneDxFile(fixturePath("sbom-cyclonedx", "bom.json"));

    expect(sbom.bomFormat).toBe("CycloneDX");

    const graph = buildDependencyGraphFromCycloneDx(sbom);

    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({
      name: "fixture-lib",
      version: "1.0.0",
      ecosystem: "npm",
      direct: true,
      locations: [],
      dependencyPaths: [["fixture-lib"]],
      purl: "pkg:npm/fixture-lib@1.0.0",
    });
  });
});
