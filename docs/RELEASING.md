# Releasing Pi extension packages

Each extension is an independently versioned private npm package published to
GitHub Packages:

| Extension | Package | Initial version |
| --- | --- | --- |
| Output optimizer | `@zkrausman/pi-output-optimizer` | `0.1.0` |
| Delivery controller | `@zkrausman/pi-delivery-controller` | `0.1.0` |
| Wiki delivery | `@zkrausman/pi-wiki-delivery` | `0.1.0` |

## Consumer setup

A consumer with GitHub Packages read access configures npm once:

```ini
@zkrausman:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`GITHUB_PACKAGES_TOKEN` must be a read-only token with access to these private
packages. Then install a package in Pi project settings:

```powershell
pi install -l npm:@zkrausman/pi-output-optimizer
```

An unversioned npm source lets Pi show its package-update notice at session
start; run `pi update --extensions` after reviewing the release notes. Pin an
exact version for reproducible automation:

```text
npm:@zkrausman/pi-output-optimizer@0.1.0
```

Exact versions and Git commits are not advanced by `pi update --extensions`.
Update them deliberately in the consumer configuration.

## Maintainer release flow

1. Add a Changeset for every user-visible extension change:

   ```powershell
   npm run changeset
   ```

   Select only the affected package and choose patch, minor, or major according
   to semantic versioning.

2. Merge the changeset with its implementation and tests.
3. The release workflow opens/updates a version PR.
4. Merge that PR. The workflow publishes the packages to GitHub Packages and
   creates the associated release commits/tags.

The workflow uses `GITHUB_TOKEN`; repository Actions settings must permit it to
write packages and pull requests. Do not store registry tokens in this
repository.
