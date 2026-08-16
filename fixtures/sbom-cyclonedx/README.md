# Fixture: sbom-cyclonedx

A minimal CycloneDX 1.5 SBOM describing the same dependency shape as the
`direct-esm` fixture (one direct npm dependency, `fixture-lib@1.0.0`), used
to test the SBOM ingestion boundary (TASK-008) independently of
package.json/package-lock.json parsing.

This is not one of the JS/TS semantic-behavior fixtures required by
docs/SDD.md § 31 — it exists solely to exercise CycloneDX mapping with a
realistic document shape.

The fixture must not execute during static analysis.
