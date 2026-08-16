# Privacy and local-data boundaries

pi-sampler is source code and local Pi-extension tooling. It does not provide a
repository-operated hosted service, account system, analytics endpoint, or
telemetry service. This statement describes the supported packages and
project-local tooling in this repository; it does not describe the privacy
practices of GitHub, npm, Pi, a model provider, or a consumer project.

## Data handled by the extensions

Extensions run with the permissions granted to the local Pi process. Their data
handling is feature-specific and documented in each extension README. A consumer
is responsible for reviewing an extension before enabling it and for choosing
its own project configuration, credentials, commands, work-item format, and
governance policy.

The project-local Pi Excalidraw extension reads and writes only approved local
`.excalidraw` files. Its tools do not call a network service or start a
subprocess. The conversation catalog's standalone viewer serves package-local
assets only through a temporary `127.0.0.1` listener; it makes no external
network request. The conversation catalog documentation describes separate
local session, note, and report storage boundaries. Other extensions can invoke
consumer-configured local commands or providers only where their documented
feature requires it; do not infer a repository-wide no-network guarantee from
the local Excalidraw tooling.

## Sensitive data

Do not commit credentials, tokens, session archives, customer data, or generated
delivery evidence. Keep package tokens in the consumer environment or secret
store, not in this repository or an `.npmrc` checked into a project. Review
extension output before sharing it outside the trusted project.

The withdrawn output-optimizer source is retained only for history and is not a
supported or distributed package. Its source includes an opt-in, in-memory
counter configuration; it is not a repository-operated telemetry service.

For a suspected vulnerability, follow [SECURITY.md](../SECURITY.md). This is not
a data-subject request channel and pi-sampler makes no statement here about the
retention or processing performed by third-party platforms.
