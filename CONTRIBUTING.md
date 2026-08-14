# Contributing to pi-sampler

Thanks for improving pi-sampler. By submitting a pull request, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

## Before opening a pull request

- Keep changes focused and explain the user-facing behavior they change.
- Never commit credentials, session archives, generated delivery evidence, or consumer-owned configuration.
- Add or update tests for behavior changes.
- Update package documentation when installation, configuration, or commands change.
- Add a Changeset for every tracked source, package, or documentation change to a publishable extension. Repository-only maintenance is automatically exempt; PR titles and labels are not release-policy inputs.
- If a publishable-package change intentionally needs no release, add a changed file at `.changeset/exemptions/<descriptive-name>.json` with exactly a non-empty `reason` and the affected `packages`, for example:

  ```json
  {
    "packages": ["@zkrausman/pi-example"],
    "reason": "This correction changes development-only guidance and does not affect the published package."
  }
  ```

  The CI validator accepts an exemption only when that exemption file is added or modified in the same PR, so an older exemption cannot cover later package work.

## Local checks

```powershell
npm ci
npm test
npm run build
cd governance; go test -race ./...
```

Each extension is independently versioned. See [the release guide](docs/RELEASING.md) before changing package versions or publishing.

## Pull requests

Pull requests should describe the problem, approach, validation performed, and any compatibility or release impact. Keep generated or local-only files out of the change.

Report security issues through the process in [SECURITY.md](SECURITY.md), not through public issues or pull requests.
