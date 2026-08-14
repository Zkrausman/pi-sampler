# Releasing Pi extension packages

## Package inventory and distribution

The `pi-sampler` source repository is public. Source visibility and GitHub
Packages access are separate: viewing this repository does not authorize a
package download. The supported package workspaces below are configured to
publish to the GitHub Packages npm registry with restricted access. GitHub
evaluates the token against each package's access policy (including any
repository-linked permission inheritance), so consumers need package read
access even when they can read the source.

| Supported extension | Package | Current manifest version | Distribution |
| --- | --- | --- | --- |
| Conversation catalog | `@zkrausman/pi-conversation-catalog` | `0.5.8` | Supported -- GitHub Packages (restricted) |
| Delivery controller | `@zkrausman/pi-delivery-controller` | `0.2.0` | Supported -- GitHub Packages (restricted) |
| Ticket closeout summary | `@zkrausman/pi-ticket-closeout-summary` | `0.2.0` | Supported -- GitHub Packages (restricted) |
| Ticket cost | `@zkrausman/pi-ticket-cost` | `0.2.3` | Supported -- GitHub Packages (restricted) |
| Ticket lifecycle | `@zkrausman/pi-ticket-lifecycle` | `0.2.0` | Supported -- GitHub Packages (restricted) |
| Wiki delivery | `@zkrausman/pi-wiki-delivery` | `0.1.0` | Supported -- GitHub Packages (restricted) |

The output optimizer source remains in this repository only for history; it is
not a supported or publishable package:

| Extension | Package | Source version | Distribution |
| --- | --- | --- | --- |
| Output optimizer | `@zkrausman/pi-output-optimizer` | `0.1.0` | Withdrawn from GitHub Packages -- do not publish |

## Consumer setup

Use this procedure for every supported package. It configures only the
`@zkrausman` scope and keeps the token outside the consumer project's files.

1. Obtain GitHub Packages **read** access to the package from its owner. Public
   source access alone is insufficient.
2. In the consumer project's `.npmrc`, add the scoped registry and an
   environment-variable token reference:

   ```ini
   @zkrausman:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
   ```

3. Set `GITHUB_PACKAGES_TOKEN` in the shell or secret store used to run Pi. The
   token must be accepted by GitHub Packages and have read access to the package;
   do not put a token value in `.npmrc` or commit it.
4. Install the desired package in Pi project settings, for example:

   ```powershell
   pi install -l npm:@zkrausman/pi-delivery-controller
   ```

An unversioned npm source lets Pi show its package-update notice at session
start; run `pi update --extensions` after reviewing the release notes. Pin an
exact version for reproducible automation.

> `@zkrausman/pi-output-optimizer` was withdrawn from GitHub Packages; use
> `pith install --pi` for Pi output optimization. Do not publish it again.

Exact versions and Git commits are not advanced by `pi update --extensions`.
Update them deliberately in the consumer configuration.

## Maintainer release flow

1. Add a Changeset for every user-visible extension change:

   ```powershell
   npm run changeset
   ```

   Select only the affected package and choose patch, minor, or major according
   to semantic versioning. Pull-request CI requires this for every tracked
   publishable-package source, manifest, or documentation change. Repository-only
   maintenance needs no Changeset. For an intentional no-release package change,
   add a changed `.changeset/exemptions/<descriptive-name>.json` file containing
   exactly `packages` (the affected package names) and a non-empty `reason`; see
   [CONTRIBUTING.md](../CONTRIBUTING.md) for the machine-checked format.

2. Create the version PR locally after reviewing the pending bump:

   ```powershell
   npm run version-packages
   git add .
   git commit -m "chore: version Pi packages"
   git push
   ```

   The command updates package versions, changelogs, and the lockfile, and
   consumes the included Changeset files.
3. Merge the version PR.
4. In **Actions**, select **Release Pi packages**, choose the `main` branch in
   **Run workflow**, check the release-confirmation input, and dispatch it.
   The workflow rejects any ref other than `refs/heads/main` before checkout
   or publishing, reruns Node tests, the root build, governance tests, Pi
   extension entry-point validation, and publishable-package dry-run artifact
   checks before using `changeset publish` to publish only versions that are
   not already present in GitHub Packages.
5. Approve the resulting `production` environment deployment before the
   release job continues. `Zkrausman` is currently the sole required reviewer
   and may self-approve while they are the only maintainer. Add maintainers as
   required reviewers and revisit self-approval when that changes.

The release workflow uses `GITHUB_TOKEN`; repository Actions settings must
permit it to write packages. The version PR is intentionally created by a
maintainer, so the repository does not need to grant Actions permission to
create pull requests. Do not store registry tokens in this repository.
