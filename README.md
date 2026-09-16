# pi-sampler

An opt-in Pi extension that makes complete assistant code blocks easy to copy one at a time. It does not execute commands, alter Pi's shared configuration, or send copied text back to the model.

## Use it

Try it for one Pi run:

```sh
pi --extension ./extension.js
```

From another directory, pass the path to this repository's `extension.js`. To install the local package into Pi settings, use `pi install /path/to/pi-sampler`; review/enable it with Pi's package configuration commands. Nothing in this repository auto-discovers or installs the extension.

After an assistant response contains fenced code blocks:

- Use the `[copy N]` control in the command-block panel when running Pi in fullscreen mode; in regular mode use the keyboard or slash command.
- Press `Ctrl+Alt+C` to choose a block from the latest response.
- Use `/copy-command 2` to copy a specific block; `/copy-command` opens the chooser when there is more than one.

The clipboard receives the code token text produced by Pi's Markdown lexer, so Markdown container indentation and parser-normalized text match the native rendering. A successful notice means Pi's clipboard helper accepted the request; a terminal or remote OSC52 consumer is not acknowledged. A helper error is reported instead of being silently ignored.

## Fence handling

The Markdown transformer runs only for assistant messages. It converts a paired fence written with exactly one backslash before each backtick back to a normal Markdown fence before Pi renders it, but only for standalone lines with at most three leading spaces. Complete fenced spans are protected first, so escaped marker examples inside an already-valid code sample remain literal. Escaped fences in blockquote/list containers, including standard four-space list continuation, are intentionally not normalized; normal raw backtick and tilde fences in those containers are still extracted with Pi's public Marked lexer semantics. Unclosed and double-escaped fences are left alone. Exactly-one-backslash syntax is intentionally ambiguous: it may be accidental model escaping or an intentional literal example, and the transformer cannot infer intent; double-escape a literal example.

Blocks are captured at `turn_end` in a TUI session and stored as Pi custom entries. They are not part of LLM context and survive session reloads/tree navigation.

## API and reproduction

The package entry point is `extension.js` (default export: `piSamplerCommandBlocks(pi)`). It uses Pi's public `registerMarkdownTransformer`, `registerEntryRenderer`, `appendEntry`, `registerShortcut`, and `registerCommand` APIs. The parser and persistence helpers are in `src/command-blocks.js`; the TUI panel is in `src/command-block-view.js`.

Manual reproduction:

1. Start a TUI run with only the extension enabled: `pi --no-extensions --extension ./extension.js` (PowerShell also accepts `./extension.js`).
2. Ask for two complete fenced blocks, including one labeled `sh` or `powershell`.
3. Verify the panel, `[copy N]` controls, `Ctrl+Alt+C`, and `/copy-command 2`. A response with no complete block must not expose an older response's blocks.

Validation evidence for this revision:

- **Actual:** the installed Pi 0.85.1 public `Marked` export tokenizes raw fences as `code`; exactly-one-backslash source as a literal paragraph; and the normalized source as `code`. The regression test compares nested/indented extraction against those tokens. This diagnoses source escaping, not a Pi/Pith renderer defect.
- **Actual:** `npm test` — 24 passed, 0 failed; `npm run check` passed.
- **Actual:** Pi 0.85.1 `--mode rpc --offline` smoke loading `./extension.js` succeeded, and `/copy-command` returned the expected no-block warning.
- **Not performed:** interactive TUI verification on Windows or inside Herdr, mouse-input acceptance, OSC52 delivery, and a real clipboard copy. Tests use injected clipboard writers and invoke no real clipboard command.

## Compatibility and limitations

The extension targets Pi 0.85.1's public APIs and public `pi-tui` components (`>=0.85.1 <0.86.0`) on Node `>=22.19.0`. It does not execute commands, modify Pi settings, or send custom entries to LLM context. Mouse controls are fullscreen-only; the shortcut and slash command remain available in regular mode and when `MouseRegion` is unavailable.

On Windows, clipboard behavior is entirely delegated to Pi's `copyToClipboard` helper (including its native/fallback behavior); this package invokes no OS clipboard command and requires the host clipboard to be available. Exactly-one-backslash Markdown fences are normalized only at the documented top-level boundary for display and copying; valid fenced code spans are protected, and unclosed, nested-container, or double-escaped fences are deliberately ignored.

There is no Herdr API or product integration. In a Herdr pane, load the extension explicitly as above; Herdr pane focus, terminal key handling, and host clipboard availability remain external constraints. Shared Pi/Herdr configuration and behavior are unchanged. No interactive Windows or Herdr acceptance run was performed for this package.
