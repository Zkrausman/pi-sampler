# Shared Pi policy

Only this README and `policy.json` are versioned under `.pi/`. Package installations, OAuth/browser state, sessions, caches, credentials, logs, and generated extension files are local-only and ignored. Install approved packages into a local `.pi/npm` directory according to `policy.json`; do not commit the installation tree or lock files containing private registry data.
