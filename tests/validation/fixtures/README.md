# Real-world validation fixtures (scaffold)

Each subdirectory here will be one real-world reproduction project for a
`tests/validation/cases/` entry: a real `package.json` and
`package-lock.json` pinning the actual vulnerable package version, plus
the minimum application source needed to either reach or not reach the
real vulnerable symbol — mirroring how `tests/adversarial/v1/fixtures/`
and `tests/adversarial/v2/fixtures/` are structured, but against a real
dependency and a real advisory instead of a synthetic one.

Empty for now — see `../README.md`.
