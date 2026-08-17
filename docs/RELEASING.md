# Release status

## M0: no active extension packages

The legacy self-evolution extension packages are retired. This repository has
zero supported or publishable Pi extension packages, so there is no consumer
installation procedure, package inventory, SBOM artifact, Changeset versioning,
or package release to perform.

The authoritative retirement decision and the M1–M5 replacement map are in
[LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md](LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md).
Historical package source and release evidence remain available in Git history
only; historical artifacts are not a supported compatibility line.

## Future releases

A future milestone may introduce a new package only after its written contract,
threat model, implementation, validation, and release policy are approved. It
must not reuse a retired implementation or imply compatibility with one. Until
then, package-oriented release steps are intentionally skipped when the
publishable-package inventory is zero.

## Repository validation

```powershell
npm test
npm run build
npm run validate:compliance
npm run validate:pi-extensions
npm run validate:packages
npm run validate:changesets -- --base <base-sha> --head HEAD
npm run validate:dco -- --base <base-sha> --head HEAD
```
