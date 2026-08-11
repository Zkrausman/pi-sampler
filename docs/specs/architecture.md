---
type: architecture
title: Project scaffolding and Stitch UI initialization
timestamp: 2026-08-10T23:45:00Z
status: initial
---

# Project scaffolding and Stitch UI initialization

## Runtime boundary

The repository root now hosts a minimal Vite application alongside the existing
npm workspaces. The root scripts provide local development (`npm run dev`), a
production build (`npm run build`), and preview (`npm run preview`). Existing
workspace, release, and Node test scripts remain unchanged.

`index.html` loads `src/main.tsx`, which mounts the root `App`. `App.tsx` is the
application boundary and wraps its content with the Stitch UI `ThemeProvider`.
The provider deliberately starts with only a `light` context value and a
`data-stitch-ui-theme` marker; components can consume that stable boundary as
the UI is introduced.

## Stitch UI package/API decision

The public npm package named `@stitch-ui/react` was evaluated at version
`1.0.1`. Its published type entry point exports `Box`, `Button`, `Container`,
`Flex`, `Grid`, and Popover components, but **does not export a
`ThemeProvider`**. It also declares React 17 peer dependencies, which do not
match the React 19 Vite scaffold. `@stitch-ui/core` is not published to the npm
registry.

Consequently, no external Stitch UI package is installed. The technically
necessary compatibility implementation is the local
`src/ui/ThemeProvider.tsx`, exported as `ThemeProvider` and used by
`src/App.tsx`. It is intentionally minimal rather than an attempted
reimplementation of the unavailable package API. Selecting a production design
system or a compatible published Stitch UI provider is a follow-up decision.

## Build dependencies

- `react` and `react-dom` render the application.
- `vite` serves and bundles it.
- `@vitejs/plugin-react` supplies React transforms and development refresh.
- TypeScript and React type definitions validate the application and Vite
  configuration before production builds.

The browser application has no access to extension credentials, delivery
profiles, or release configuration. Those existing monorepo concerns remain
outside the Vite runtime.
