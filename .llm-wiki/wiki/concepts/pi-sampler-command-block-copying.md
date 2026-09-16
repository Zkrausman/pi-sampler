---
type: concept
title: Pi-sampler command block copying
created: 2026-09-16
updated: 2026-09-16
---

The opt-in `pi-sampler` package extracts only complete fenced code tokens through the public Marked lexer exported by `pi-tui`, so Pi's indentation and nested list/blockquote semantics remain aligned. It normalizes exactly-one-backslash fences only on standalone lines with at most three leading spaces, protects already-valid fenced spans, persists safe `{language, code}` data as a Pi custom entry, and never executes a block or adds it to model context.

Raw fences already tokenize as code; exactly-one-backslash source tokenizes as a literal paragraph until the display-only transformer unescapes a complete top-level pair. Escaped fences in blockquote/list containers, including standard four-space list continuation, remain literal by policy; normal raw nested fences remain supported. That spelling is intentionally ambiguous with literal examples, so double-escape intentional prose. Copying is explicit through the TUI panel, `Ctrl+Alt+C`, or `/copy-command <number>`; mouse controls are fullscreen-only, and a success notice means the Pi clipboard helper accepted the request rather than confirming remote/OSC52 delivery. Interactive Windows/Herdr and real-clipboard acceptance remain unverified.

The entry point is [extension.js](../../extension.js), the parser and persistence boundary are [src/command-blocks.js](../../src/command-blocks.js), and host clipboard behavior is documented in [README.md](../../README.md).
