import { Marked } from "@earendil-works/pi-tui";

export const COMMAND_BLOCK_ENTRY_TYPE = "pi-sampler-command-blocks";
export const COMMAND_BLOCK_SHORTCUT = "ctrl+alt+c";

const BACKTICK = "`";
const MAX_PREVIEW_LENGTH = 72;
const FENCED_CODE_START = /^ {0,3}(?:`{3,}|~{3,})/;
const markdownParser = new Marked();

/**
 * Split Markdown into lines without losing the line ending on each line.
 * This is used only to locate paired assistant-escaped fence syntax. Block
 * extraction itself delegates to the same public Marked lexer Pi TUI exports.
 */
function splitLines(markdown) {
	if (markdown.length === 0) return [];

	const lines = [];
	let start = 0;
	while (start < markdown.length) {
		let contentEnd = start;
		while (contentEnd < markdown.length && markdown[contentEnd] !== "\n" && markdown[contentEnd] !== "\r") {
			contentEnd += 1;
		}

		if (contentEnd === markdown.length) {
			lines.push({
				content: markdown.slice(start, contentEnd),
				start,
				contentEnd,
				lineIndex: lines.length,
				eol: "",
			});
			break;
		}

		const eolEnd = markdown[contentEnd] === "\r" && markdown[contentEnd + 1] === "\n" ? contentEnd + 2 : contentEnd + 1;
		lines.push({
			content: markdown.slice(start, contentEnd),
			start,
			contentEnd,
			lineIndex: lines.length,
			eol: markdown.slice(contentEnd, eolEnd),
		});
		start = eolEnd;
	}

	return lines;
}

/**
 * Parse only the intentionally supported top-level spelling: one backslash
 * before each backtick on a standalone line with at most three spaces. This
 * deliberately does not guess at blockquote/list containers; raw nested
 * fences are handled by Marked during extraction.
 */
function parseEscapedFenceLine(content) {
	const indent = /^ {0,3}/.exec(content)?.[0] ?? "";
	const position = indent.length;
	const rest = content.slice(position);
	if (!rest.startsWith("\\`")) return undefined;

	let length = 0;
	while (rest.slice(length * 2, length * 2 + 2) === "\\`") length += 1;
	if (length < 3) return undefined;

	const info = rest.slice(length * 2);
	if (info.includes(BACKTICK)) return undefined;
	return {
		style: "escaped",
		char: BACKTICK,
		length,
		info,
		markerStart: position,
		markerEnd: position + length * 2,
	};
}

function isEscapedClosingFence(fence, opening) {
	return fence && fence.style === opening.style && fence.char === opening.char && fence.length >= opening.length && fence.info.trim() === "";
}

function lineNumberAt(markdown, offset) {
	let line = 0;
	for (let index = 0; index < offset; index += 1) {
		if (markdown[index] === "\n") line += 1;
	}
	return line;
}

/** Return source lines occupied by complete fenced code tokens from Marked. */
function protectedFenceLines(markdown) {
	const normalized = markdown.replace(/\r\n?|\r/g, "\n");
	const protectedLines = new Set();
	let searchFrom = 0;

	visitTokens(markdownParser.lexer(markdown), (token) => {
		if (!isCompleteFencedCodeToken(token)) return;
		const raw = token.raw.replace(/\r\n?|\r/g, "\n");
		const start = normalized.indexOf(raw, searchFrom);
		if (start < 0) return;

		const end = start + raw.length;
		for (let line = lineNumberAt(normalized, start); line <= lineNumberAt(normalized, Math.max(start, end - 1)); line += 1) {
			protectedLines.add(line);
		}
		searchFrom = end;
	});

	return protectedLines;
}

function findEscapedFencePairs(markdown) {
	const lines = splitLines(markdown);
	const protectedLines = protectedFenceLines(markdown);
	const pairs = [];

	for (let openingIndex = 0; openingIndex < lines.length; openingIndex += 1) {
		if (protectedLines.has(openingIndex)) continue;
		const opening = parseEscapedFenceLine(lines[openingIndex].content);
		if (!opening) continue;

		for (let closingIndex = openingIndex + 1; closingIndex < lines.length; closingIndex += 1) {
			if (protectedLines.has(closingIndex)) continue;
			const closing = parseEscapedFenceLine(lines[closingIndex].content);
			if (!isEscapedClosingFence(closing, opening)) continue;

			pairs.push({ opening: { ...opening, line: lines[openingIndex] }, closing: { ...closing, line: lines[closingIndex] } });
			openingIndex = closingIndex;
			break;
		}
	}

	return pairs;
}

function languageFromInfo(info) {
	const trimmed = info.trim();
	return trimmed ? trimmed.split(/\s+/, 1)[0].toLowerCase() : "";
}

/**
 * Convert paired top-level assistant-escaped fences into ordinary Markdown
 * fences. Valid fenced code spans are protected before the narrow rewrite.
 * Only fence syntax is changed; prose and command body bytes are preserved.
 * This deliberately cannot distinguish accidental model escaping from an
 * intentional literal example, so callers should double-escape literal
 * examples when they must remain prose.
 */
export function normalizeEscapedFences(markdown) {
	const replacements = [];
	for (const pair of findEscapedFencePairs(markdown)) {
		for (const fence of [pair.opening, pair.closing]) {
			const line = fence.line;
			const start = line.start + fence.markerStart;
			const end = line.start + fence.markerEnd;
			replacements.push({
				start,
				end,
				text: fence.char.repeat(fence.length),
			});
		}
	}

	if (replacements.length === 0) return markdown;

	return replacements
		.sort((left, right) => right.start - left.start)
		.reduce((result, replacement) => result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end), markdown);
}

function visitTokens(tokens, visit) {
	for (const token of tokens ?? []) {
		if (!token || typeof token !== "object") continue;
		visit(token);
		if (Array.isArray(token.tokens)) visitTokens(token.tokens, visit);
		if (Array.isArray(token.items)) visitTokens(token.items, visit);
	}
}

function isCompleteFencedCodeToken(token) {
	if (token?.type !== "code" || typeof token.raw !== "string" || !FENCED_CODE_START.test(token.raw)) return false;

	const lines = token.raw.replace(/\r\n?|\r/g, "\n").split("\n");
	while (lines.at(-1) === "") lines.pop();
	if (lines.length < 2) return false;

	const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]);
	const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1));
	return Boolean(opening && closing && opening[1][0] === closing[1][0] && closing[1].length >= opening[1].length);
}

/**
 * Find the same fenced code tokens Pi's Markdown component receives. Pi TUI
 * replaces tabs with three spaces before lexing, and Marked normalizes line
 * endings/Markdown container indentation; using its token text keeps copied
 * content aligned with what the renderer displays.
 */
export function extractFencedBlocks(markdown, { includeEscaped = false } = {}) {
	if (typeof markdown !== "string") return [];
	const source = (includeEscaped ? normalizeEscapedFences(markdown) : markdown).replace(/\t/g, "   ");
	const blocks = [];

	visitTokens(markdownParser.lexer(source), (token) => {
		if (!isCompleteFencedCodeToken(token)) return;
		blocks.push({
			index: blocks.length,
			language: languageFromInfo(typeof token.lang === "string" ? token.lang : ""),
			code: typeof token.text === "string" ? token.text : "",
		});
	});

	return blocks;
}

/** Extract only the text parts that Pi's assistant renderer sends to Markdown. */
export function getMessageTextParts(message) {
	if (!message || typeof message !== "object") return [];
	if (typeof message.content === "string") return [message.content];
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((content) => content?.type === "text" && typeof content.text === "string").map((content) => content.text);
}

/** Extract completed command/code blocks from an assistant message. */
export function extractAssistantBlocks(message) {
	return getMessageTextParts(message).flatMap((text) => extractFencedBlocks(normalizeEscapedFences(text)));
}

/** Keep only the JSON-safe data needed by a durable custom entry. */
export function serializeCommandBlocks(blocks) {
	return {
		version: 1,
		blocks: blocks.map((block) => ({
			language: typeof block.language === "string" ? block.language : "",
			code: typeof block.code === "string" ? block.code : "",
		})),
	};
}

/** Validate/recover command blocks loaded from a session entry. */
export function readPersistedCommandBlocks(data) {
	if (!data || typeof data !== "object" || !Array.isArray(data.blocks)) return [];
	return data.blocks.flatMap((block, index) => {
		if (!block || typeof block !== "object" || typeof block.code !== "string") return [];
		return [
			{
				index,
				language: typeof block.language === "string" ? block.language : "",
				code: block.code,
			},
		];
	});
}

/**
 * Find the persisted panel belonging to the latest assistant response. This
 * deliberately ignores panels belonging to older responses, including when
 * the newest response contains no complete code blocks.
 */
export function findLatestPersistedCommandBlocks(entries) {
	if (!Array.isArray(entries)) return [];

	let latestAssistantIndex = -1;
	for (let index = 0; index < entries.length; index += 1) {
		if (entries[index]?.type === "message" && entries[index].message?.role === "assistant") {
			latestAssistantIndex = index;
		}
	}
	if (latestAssistantIndex < 0) return [];

	for (let index = entries.length - 1; index > latestAssistantIndex; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== COMMAND_BLOCK_ENTRY_TYPE) continue;
		const blocks = readPersistedCommandBlocks(entry.data);
		if (blocks.length > 0) return blocks;
	}
	return [];
}

/** Copy exactly one block through an injected clipboard writer. */
export async function copyCommandBlock(blocks, index, writeClipboard) {
	if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
		throw new RangeError(`Command block ${index + 1} does not exist`);
	}
	if (typeof writeClipboard !== "function") throw new TypeError("A clipboard writer is required");

	const block = blocks[index];
	await writeClipboard(block.code);
	return block;
}

/** Create a safe, single-line label without changing the copied bytes. */
export function formatBlockPreview(code, maxLength = MAX_PREVIEW_LENGTH) {
	const sanitized = String(code)
		.replace(/\x1b\][^\x07]*(?:\x07|$)/g, "?")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "?")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?")
		.replace(/\r\n|\r|\n/g, " ↵ ");
	if (sanitized.length <= maxLength) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Safe display form for expanded code; the clipboard path never calls this. */
export function sanitizeBlockForDisplay(code) {
	return String(code)
		.replace(/\x1b\][^\x07]*(?:\x07|$)/g, "?")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "?")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
}
