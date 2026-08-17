# Privacy and local-data boundaries

pi-sampler is source code and local human/AI productivity tooling. It does not
provide a repository-operated hosted service, account system, analytics endpoint,
or telemetry service. This statement does not describe the privacy practices of
GitHub, npm, Pi, a model provider, or a consumer project.

## Local tooling

Pi Excalidraw reads and writes approved local `.excalidraw` files. Its tools do
not call a network service or start a subprocess. The optional local SQLite
workspace is documented in [PI-EXCALIDRAW-WORKSPACE.md](PI-EXCALIDRAW-WORKSPACE.md).

The retired self-evolution extensions have no active runtime in this repository;
see [the retirement record](LEGACY-SELF-EVOLUTION-EXTENSIONS-RETIRED.md).

## Sensitive data

Do not commit credentials, tokens, session archives, customer data, or generated
delivery evidence. For a suspected vulnerability, follow
[SECURITY.md](../SECURITY.md). This is not a data-subject request channel and
pi-sampler makes no statement here about the retention or processing performed
by third-party platforms.
