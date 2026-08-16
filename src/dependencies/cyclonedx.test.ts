import { describe, expect, it } from "vitest";
import {
  CycloneDxFileNotFoundError,
  CycloneDxSyntaxError,
  CycloneDxValidationError,
} from "./cyclonedx-errors.js";
import {
  buildDependencyGraphFromCycloneDx,
  loadCycloneDxFile,
  parseCycloneDx,
  parseCycloneDxText,
} from "./cyclonedx.js";

describe("parseCycloneDx: validation", () => {
  it("requires bomFormat to be the literal 'CycloneDX'", () => {
    expect(() =>
      parseCycloneDx({ bomFormat: "SPDX", specVersion: "1.5" }),
    ).toThrow(CycloneDxValidationError);
  });

  it("requires specVersion", () => {
    expect(() => parseCycloneDx({ bomFormat: "CycloneDX" })).toThrow(
      CycloneDxValidationError,
    );
  });

  it("defaults components/dependencies to empty arrays", () => {
    const sbom = parseCycloneDx({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
    });

    expect(sbom.components).toEqual([]);
    expect(sbom.dependencies).toEqual([]);
  });
});

describe("parseCycloneDxText", () => {
  it("throws CycloneDxSyntaxError for malformed JSON", () => {
    expect(() => parseCycloneDxText("{ not valid json")).toThrow(
      CycloneDxSyntaxError,
    );
  });
});

describe("loadCycloneDxFile", () => {
  it("throws CycloneDxFileNotFoundError for a missing file", () => {
    expect(() => loadCycloneDxFile("/does/not/exist/bom.json")).toThrow(
      CycloneDxFileNotFoundError,
    );
  });
});

describe("buildDependencyGraphFromCycloneDx", () => {
  it("maps direct and transitive npm components via the dependencies graph", () => {
    const sbom = parseCycloneDx({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      metadata: {
        component: { name: "root", version: "1.0.0", "bom-ref": "root" },
      },
      components: [
        {
          name: "foo",
          version: "1.0.0",
          purl: "pkg:npm/foo@1.0.0",
          "bom-ref": "pkg:npm/foo@1.0.0",
        },
        {
          name: "bar",
          version: "2.0.0",
          purl: "pkg:npm/bar@2.0.0",
          "bom-ref": "pkg:npm/bar@2.0.0",
        },
      ],
      dependencies: [
        { ref: "root", dependsOn: ["pkg:npm/foo@1.0.0"] },
        { ref: "pkg:npm/foo@1.0.0", dependsOn: ["pkg:npm/bar@2.0.0"] },
      ],
    });

    const graph = buildDependencyGraphFromCycloneDx(sbom);
    const byName = new Map(graph.map((node) => [node.name, node]));

    expect(graph).toHaveLength(2);

    const foo = byName.get("foo");
    expect(foo?.direct).toBe(true);
    expect(foo?.dependencyPaths).toEqual([["foo"]]);
    expect(foo?.locations).toEqual([]);
    expect(foo?.purl).toBe("pkg:npm/foo@1.0.0");

    const bar = byName.get("bar");
    expect(bar?.direct).toBe(false);
    expect(bar?.dependencyPaths).toEqual([["foo", "bar"]]);
  });

  it("excludes non-npm components rather than miscategorizing them", () => {
    const sbom = parseCycloneDx({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      metadata: { component: { name: "root", "bom-ref": "root" } },
      components: [
        {
          name: "requests",
          version: "2.31.0",
          purl: "pkg:pypi/requests@2.31.0",
          "bom-ref": "pkg:pypi/requests@2.31.0",
        },
        {
          name: "foo",
          version: "1.0.0",
          purl: "pkg:npm/foo@1.0.0",
          "bom-ref": "pkg:npm/foo@1.0.0",
        },
      ],
      dependencies: [
        {
          ref: "root",
          dependsOn: ["pkg:pypi/requests@2.31.0", "pkg:npm/foo@1.0.0"],
        },
      ],
    });

    const graph = buildDependencyGraphFromCycloneDx(sbom);

    expect(graph).toHaveLength(1);
    expect(graph[0]?.name).toBe("foo");
  });

  it("skips components with no version", () => {
    const sbom = parseCycloneDx({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        { name: "foo", purl: "pkg:npm/foo", "bom-ref": "pkg:npm/foo" },
      ],
    });

    expect(buildDependencyGraphFromCycloneDx(sbom)).toHaveLength(0);
  });

  it("honestly reports unknown topology when metadata.component is absent", () => {
    const sbom = parseCycloneDx({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        {
          name: "foo",
          version: "1.0.0",
          purl: "pkg:npm/foo@1.0.0",
          "bom-ref": "pkg:npm/foo@1.0.0",
        },
      ],
    });

    const graph = buildDependencyGraphFromCycloneDx(sbom);
    expect(graph).toHaveLength(1);
    expect(graph[0]?.direct).toBe(false);
    expect(graph[0]?.dependencyPaths).toEqual([]);
  });

  it("falls back to purl as the component ref when bom-ref is absent", () => {
    const sbom = parseCycloneDx({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      metadata: { component: { name: "root", "bom-ref": "root" } },
      components: [
        { name: "foo", version: "1.0.0", purl: "pkg:npm/foo@1.0.0" },
      ],
      dependencies: [{ ref: "root", dependsOn: ["pkg:npm/foo@1.0.0"] }],
    });

    const graph = buildDependencyGraphFromCycloneDx(sbom);
    expect(graph).toHaveLength(1);
    expect(graph[0]?.direct).toBe(true);
  });
});
