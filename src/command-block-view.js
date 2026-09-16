import * as tui from "@earendil-works/pi-tui";
import { formatBlockPreview, sanitizeBlockForDisplay } from "./command-blocks.js";

const { Box, MouseRegion, Spacer, Text } = tui;

function copyControl(text, onClick) {
	const control = new Text(text, 0, 0);
	// MouseRegion was added to pi-tui's public component surface. Keep the
	// feature optional so an older host still has the keyboard command path.
	if (typeof MouseRegion !== "function") return control;
	return new MouseRegion(control, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		void onClick();
		return { handled: true, render: true };
	});
}

/**
 * Render a small, TUI-only affordance below the native assistant message.
 * The native transcript remains owned by Pi; this panel only owns its copy
 * controls and is durable as a custom session entry.
 */
export function createCommandBlocksView(blocks, theme, onCopy, expanded = false) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", "Command blocks"), 0, 0));
	box.addChild(new Text(theme.fg("dim", "Use Ctrl+Alt+C or /copy-command; mouse copy controls are available only in fullscreen mode."), 0, 0));
	box.addChild(new Spacer(1));

	blocks.forEach((block, index) => {
		const label = `[copy ${index + 1}] ${block.language || "code"} — ${formatBlockPreview(block.code) || "(empty)"}`;
		box.addChild(copyControl(theme.fg("accent", label), () => onCopy(index)));

		if (expanded) {
			const displayedCode = sanitizeBlockForDisplay(block.code) || "(empty block)";
			box.addChild(new Text(displayedCode, 2, 0));
		}

		if (index < blocks.length - 1) box.addChild(new Spacer(1));
	});

	return box;
}
