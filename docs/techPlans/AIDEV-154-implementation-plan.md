# Implementation Plan: AIDEV-154

## Effort & Risk Analysis
*   **Complexity (T-Shirt):** M
*   **Estimated Effort:** 1-2 days
*   **Primary Risk:** A release that is either not legally attributable to its MIT-licensed upstream source or not independently installable because it retains a monorepo-only dependency or omits a required packed artifact.

## Expected File Changes
*   `[MODIFY]` `package.json`: Activate the repository’s exact `extensions/*` npm workspace configuration without changing existing root validation scripts.
*   `[MODIFY]` `.changeset/config.json`: Change the Changesets release access policy to match the approved public npm distribution policy for `@zkrausman/pi-answer`.
*   `[MODIFY]` `package-lock.json`: Regenerate the lockfile for the new workspace and its installable dependencies.
*   `[NEW]` `extensions/pi-answer/package.json`: Define version `0.1.0` of the pi-sampler-owned `@zkrausman/pi-answer` package, Pi entry point, installable dependencies, peer compatibility, public registry policy, and explicit packed files.
*   `[NEW]` `extensions/pi-answer/index.ts`: Faithfully copy the `pi-answer@0.1.9` `/answer` command implementation from the audited local baseline.
*   `[NEW]` `extensions/pi-answer/qna-adapter.ts`: Faithfully copy draft persistence and TUI answer-collection integration from the audited local baseline.
*   `[NEW]` `extensions/pi-answer/utils.ts`: Faithfully copy extraction settings, model preference, parsing, and answer-template logic from the audited local baseline.
*   `[NEW]` `extensions/pi-answer/README.md`: Document this fork’s normal installation, `/answer` behavior, settings, and upstream provenance.
*   `[NEW]` `extensions/pi-answer/CHANGELOG.md`: Record the pi-sampler `0.1.0` faithful-fork release and provenance boundary.
*   `[NEW]` `extensions/pi-answer/LICENSE`: Include the authoritative upstream MIT license text required for the copied source.
*   `[NEW]` `extensions/pi-answer/UPSTREAM-PROVENANCE.md`: Record the upstream repository/directory/release, immutable retrieval evidence, file hashes, attribution, and license source that make faithful-fork verification reproducible.
*   `[NEW]` `extensions/pi-answer/THIRD-PARTY-NOTICES.md`: Generated package compliance notice.
*   `[NEW]` `extensions/pi-answer/sbom.cdx.json`: Generated package SBOM.
*   `[MODIFY]` `scripts/validate-pi-extensions.mjs`: Replace entry-only temporary transpilation with a complete relative TypeScript module-graph/Pi-loader smoke harness so multi-file package extensions are actually loadable.
*   `[NEW]` `tests/pi-answer-package.test.mjs`: Verify the fork’s immutable upstream-provenance manifest, command contract, package metadata, packed artifact, attribution, and clean consumer installation behavior.
*   `[MODIFY]` `README.md`: Replace obsolete no-package guidance with the supported package’s installation, `/answer` usage, configuration, privacy disclosure, and attribution information.
*   `[MODIFY]` `docs/RELEASING.md`: Add the written contract, explicit recorded maintainer-approval gate, threat model, validation expectations, and approved release policy for this new package without reviving retired legacy extensions.
*   `[MODIFY]` `docs/PLATFORM-AND-TRADEMARKS.md`: Replace the obsolete zero-package statement with accurate package, non-affiliation, and third-party-mark guidance.
*   `[MODIFY]` `docs/PRIVACY.md`: Disclose that `/answer` transmits the selected assistant response to the user-configured extraction-model provider when the command is run, while preserving the no-hosted-service/telemetry boundary.
*   `[MODIFY]` `tests/release-documentation.test.mjs`: Replace zero-inventory assertions with assertions for the supported package and the updated release/platform/privacy boundaries.
*   `[NEW]` `.changeset/<generated-name>.md`: Declare the initial `0.1.0` release for `@zkrausman/pi-answer`.

## Step-by-Step Execution
1.  **Phase 1: Establish the approved distributable-package boundary**
    *   Step 1.1: Confirm that `@zkrausman/pi-answer` is available in the public npm registry and record the registry/ownership decision in the package metadata and release documentation; update `.changeset/config.json` from restricted to public access in the same reviewed contract change, and stop rather than silently choosing a different name or private registry.
    *   Step 1.2: Obtain and verify the authoritative MIT license text, copyright notice, and provenance from `sids/pi-extensions` for the copied `answer` source. Treat `@siddr/pi-shared-qna` as an external dependency, not copied source, and retain its own published license boundary in generated notices.
    *   Step 1.3: Update `docs/RELEASING.md` with the new-package contract: its purpose, maintained ownership, threat model (nested extraction calls send assistant text to the selected provider; global versus trusted-project settings; session draft storage; untrusted external dependencies), supported Pi peer range, validation evidence, publication registry/access, rollback, and non-compatibility with retired legacy packages.
    *   Step 1.4: Add a recorded maintainer-approval gate to the release contract: before any package source, workspace activation, or publication is implemented, verify the named maintainer’s AIDEV-154 Linear authorization record (comment `394bc3ab-fd02-4430-9666-22d671e73bff`) covers the final written contract, threat model, implementation plan, validation strategy, package name, and release policy. Link that immutable issue/comment evidence in the implementation PR; absent it, stop after the planning PR.
    *   Step 1.5: Reconcile the package’s MIT upstream attribution with the root Apache-2.0 contribution policy through explicit package-level licensing/provenance review, then add the root `extensions/*` workspace declaration and regenerate the root lockfile using the repository-supported npm workflow.
2.  **Phase 2: Create a faithful, installable fork**
    *   Step 2.1: Create `extensions/pi-answer` as `@zkrausman/pi-answer@0.1.0`, using an explicit `files` allowlist, a Pi `./index.ts` entry, no package lifecycle build scripts, and the intended public registry configuration.
    *   Step 2.2: Copy only the audited upstream implementation files (`index.ts`, `qna-adapter.ts`, and `utils.ts`) without behavioral edits; preserve the current model preference order, trusted-project settings guard, TUI-only constraint, extraction call via Pi’s model registry, and session-draft behavior.
    *   Step 2.3: Replace the non-installable upstream `workspace:^` shared-Q&A dependency with a normal, pinned published dependency compatible with the faithful baseline, and retain the appropriate Pi peer dependencies.
    *   Step 2.4: Add the upstream MIT license, clear source attribution/provenance in the package README and changelog, and generated third-party notices/SBOM. Do not vendor `node_modules`, the ignored local package lockfile, local Pi settings, credentials, or session data.
3.  **Phase 3: Document and test the consumer contract**
    *   Step 3.1: Update the root README and `docs/PLATFORM-AND-TRADEMARKS.md` with the `pi install npm:@zkrausman/pi-answer` command, `/answer` flow, TUI requirement, `answer` configuration block, extraction-model fallback behavior, upstream attribution/license link, and accurate non-affiliation language.
    *   Step 3.2: Update `docs/PRIVACY.md` to disclose the opt-in command’s assistant-text transfer to the selected extraction provider and clarify that pi-sampler does not operate that provider, collect telemetry, or retain consumer data. Update `tests/release-documentation.test.mjs` so CI protects these new public documentation boundaries rather than obsolete zero-package claims.
    *   Step 3.3: Add Node-test-runner coverage that checks the extension manifest’s public distribution contract, required packed files, upstream attribution/MIT text, command registration, and a versioned immutable source-provenance manifest (upstream repository, directory, release version, immutable artifact/source digest, retrieval date). Validate that manifest’s shape and referenced artifact; do not compare later feature-version source files to the `0.1.0` hashes, because AIDEV-163 and AIDEV-162 intentionally change them.
    *   Step 3.4: Modify the Pi extension validator to materialize/transpile and import the complete relative TypeScript module graph (or invoke Pi’s supported loader) rather than only a temporary entry module. Add a regression fixture proving an entry importing local `.ts` helpers is loaded and registers successfully. The AIDEV-154 multi-file extension must pass this harness before its command-registration evidence is accepted.
    *   Step 3.5: Add an isolated consumer-install scenario that packs the workspace package, installs that tarball with npm in a temporary project, and verifies its manifest, declared dependency graph, and Pi TypeScript entry are present without any `workspace:` protocol or local pi-sampler path. Run the complete-module-graph/Pi-loader smoke path in that consumer; do not directly import the TypeScript entry with plain Node.
    *   Step 3.6: Add a Pi-runtime unit/integration test with a stubbed model registry/UI that proves `/answer` remains TUI-only, chooses only an authenticated configured model or the active model, and sends only the selected last complete assistant message to `modelRegistry.complete`; assert that package installation/packing causes no extraction request, subprocess, telemetry, or network request.
    *   Step 3.7: Create a pending Changeset for the initial `0.1.0` release and regenerate deterministic compliance artifacts only after the final manifest is settled.
4.  **Phase 4: Validate, review, and release-ready handoff**
    *   Step 4.1: Install clean root dependencies with `npm ci`, then execute the repository tests, build, package/compliance/Pi validators, Changeset and DCO validation, and governance race tests.
    *   Step 4.2: Inspect `npm pack --dry-run --json --ignore-scripts` output and the isolated consumer installation to ensure package contents, runtime dependency resolution, and `/answer` registration are correct.
    *   Step 4.3: Perform a fresh-context adversarial review of the exact implementation commit; resolve all blocker/high findings, create the required commit-only review packet, and bind its clean attestation to the final implementation PR base SHA and final head SHA after the last push. Regenerate it whenever either commit changes.

## Test Matrix
*   **Target Command**: `npm test`
*   **Target Command**: `npm run build`
*   **Target Command**: `npm run validate:compliance`
*   **Target Command**: `npm run validate:pi-extensions`
*   **Target Command**: `npm run validate:packages`
*   **Target Command**: `npm run validate:changesets -- --base "$CHANGESET_BASE_REF" --head HEAD`
*   **Target Command**: `npm run validate:dco -- --base "$DCO_BASE_REF" --head HEAD`
*   **Target Command**: `cd governance && go test -race ./...`
*   **Validation Scenarios**:
    *   [ ] The packed `@zkrausman/pi-answer@0.1.0` artifact contains only declared package files, includes the Pi entry and attribution/compliance artifacts, and contains no native, local-state, or monorepo-only files.
    *   [ ] A clean temporary npm consumer can install the packed tarball and inspect its manifest/dependency graph and TypeScript Pi entry without resolving `workspace:` dependencies or any pi-sampler-local path.
    *   [ ] The complete-module-graph Pi smoke harness registers `/answer` for both the workspace and clean packed consumer; the immutable provenance manifest records the audited `0.1.0` baseline without constraining later intentional feature changes.
    *   [ ] Root README, release, platform, privacy, and package documentation provide accurate normal installation, TUI-only `/answer` operation, configuration, extraction-model behavior, assistant-text provider disclosure, non-affiliation, and upstream MIT attribution.
    *   [ ] A stubbed Pi runtime proves that command execution sends only the last complete assistant text through the selected authenticated extraction model; packing and installation make no network, telemetry, or subprocess request.
    *   [ ] The authoritative MIT license/provenance and versioned reproducible source-baseline evidence are present, and the generated notices/SBOM match the final manifest exactly.
    *   [ ] Changeset, DCO, package compliance, Pi extension, root test/build, release-documentation, and governance race validations pass against the PR base.
    *   [ ] The implementation PR links the recorded AIDEV-154 maintainer approval and contains an attestation computed from its final base/head commits.
