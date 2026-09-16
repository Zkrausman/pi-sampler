import assert from "node:assert/strict";
import test from "node:test";
import { Marked } from "@earendil-works/pi-tui";
import {
	copyCommandBlock,
	extractAssistantBlocks,
	extractFencedBlocks,
	findLatestPersistedCommandBlocks,
	formatBlockPreview,
	normalizeEscapedFences,
	readPersistedCommandBlocks,
	serializeCommandBlocks,
} from "../src/command-blocks.js";

const slash = String.fromCharCode(92);
const tick = String.fromCharCode(96);
const rawFence = (info = "") => tick.repeat(3) + info;
const escapedFence = (depth = 1, info = "") => slash.repeat(depth) + tick + slash.repeat(depth) + tick + slash.repeat(depth) + tick + info;
const marked = new Marked();

function markedCodeTokens(tokens, result = []) {
	for (const token of tokens ?? []) {
		if (token?.type === "code" && typeof token.raw === "string" && /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw)) {
			result.push(token);
		}
		if (Array.isArray(token?.tokens)) markedCodeTokens(token.tokens, result);
		if (Array.isArray(token?.items)) markedCodeTokens(token.items, result);
	}
	return result;
}

function codeBlock(info, code, close = rawFence()) {
	return `${rawFence(info)}\n${code}\n${close}`;
}

test("extracts a normal text fence without changing command bytes", () => {
	const source = `Before\n\n${codeBlock("text", "echo  two spaces\n$HOME") }\n\nAfter`;
	const blocks = extractFencedBlocks(source);

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].language, "text");
	assert.equal(blocks[0].code, "echo  two spaces\n$HOME");
});

test("reproduces the Pi/Marked diagnosis for raw and one-backslash fences", () => {
	const raw = codeBlock("text", "echo hello");
	const escaped = `${escapedFence(1, "text")}\necho hello\n${escapedFence(1)}`;

	assert.deepEqual(markedCodeTokens(marked.lexer(raw)).map(({ lang, text }) => ({ lang, text })), [{ lang: "text", text: "echo hello" }]);
	assert.equal(markedCodeTokens(marked.lexer(escaped)).length, 0);
	assert.equal(marked.lexer(escaped)[0]?.type, "paragraph");

	const normalized = normalizeEscapedFences(escaped);
	assert.equal(normalized, `${rawFence("text")}\necho hello\n${rawFence()}`);
	assert.deepEqual(markedCodeTokens(marked.lexer(normalized)).map(({ lang, text }) => ({ lang, text })), [{ lang: "text", text: "echo hello" }]);
	assert.deepEqual(extractAssistantBlocks({ role: "assistant", content: escaped }).map(({ language, code }) => ({ language, code })), [{ language: "text", code: "echo hello" }]);
});

test("leaves double-escaped fences and prose alone", () => {
	const doubleEscaped = `${escapedFence(2, "text")}\necho hello\n${escapedFence(2)}`;
	assert.equal(normalizeEscapedFences(doubleEscaped), doubleEscaped);
	assert.equal(normalizeEscapedFences(`The literal marker ${escapedFence(1, "text")} is prose.`), `The literal marker ${escapedFence(1, "text")} is prose.`);
});

test("does not rewrite escaped marker examples inside valid fenced code", () => {
	const outerFence = tick.repeat(4);
	const innerOpening = escapedFence(1, "sh");
	const innerClosing = escapedFence(1);
	const source = `${outerFence}markdown\n${innerOpening}\necho nested\n${innerClosing}\n${outerFence}`;

	assert.equal(normalizeEscapedFences(source), source);
	assert.deepEqual(extractFencedBlocks(source).map(({ language, code }) => ({ language, code })), [{
		language: "markdown",
		code: `${innerOpening}\necho nested\n${innerClosing}`,
	}]);
});

test("documents the narrow top-level escaped-fence normalization boundary", () => {
	const escapedList = `- item\n    ${escapedFence(1, "sh")}\n    echo listed\n    ${escapedFence(1)}`;
	const escapedQuote = `> ${escapedFence(1, "sh")}\n> echo quoted\n> ${escapedFence(1)}`;
	assert.equal(normalizeEscapedFences(escapedList), escapedList);
	assert.equal(normalizeEscapedFences(escapedQuote), escapedQuote);

	const rawList = `- item\n    ${rawFence("sh")}\n    echo listed\n    ${rawFence()}`;
	assert.deepEqual(extractFencedBlocks(rawList).map(({ language, code }) => ({ language, code })), [{ language: "sh", code: "echo listed" }]);
});

test("follows Pi/Marked for spaced fences, tilde fences, tabs, and CRLF", () => {
	const source = `  ${rawFence(" text")}\r\n  echo hi\r\n\r\n  ${rawFence()}\r\n`;
	const blocks = extractFencedBlocks(source);

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].language, "text");
	assert.equal(blocks[0].code, "echo hi\n");

	const tilde = `~~~powershell\nWrite-Output ok\n~~~~\n`;
	assert.deepEqual(extractFencedBlocks(tilde).map((block) => block.code), ["Write-Output ok"]);

	const tabbed = `${rawFence("sh")}\n\techo hi\n${rawFence()}`;
	assert.deepEqual(extractFencedBlocks(tabbed).map((block) => block.code), ["   echo hi"]);
});

test("matches Pi/Marked fenced tokens in indentation, blockquotes, and lists", () => {
	const sources = [
		`  ${rawFence("text")}\n  echo indented\n  ${rawFence()}`,
		`> ${rawFence("text")}\n> echo quoted\n> ${rawFence()}`,
		`- item\n    ${rawFence("sh")}\n    echo listed\n    ${rawFence()}`,
	];

	for (const source of sources) {
		const expected = markedCodeTokens(marked.lexer(source)).map((token) => ({
			language: (token.lang || "").trim().split(/\s+/, 1)[0].toLowerCase(),
			code: token.text,
		}));
		const actual = extractFencedBlocks(source).map(({ language, code }) => ({ language, code }));
		assert.deepEqual(actual, expected);
	}
});

test("does not expose an unclosed fence as a copy target", () => {
	assert.deepEqual(extractFencedBlocks(`${rawFence("text")}\necho unfinished`), []);
});

test("extracts only assistant text parts and supports escaped fences", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "ignore this" },
			{ type: "text", text: codeBlock("text", "first") },
			{ type: "text", text: `${escapedFence(1, "text")}\nsecond\n${escapedFence(1)}` },
		],
	};

	assert.deepEqual(
		extractAssistantBlocks(message).map(({ code }) => code),
		["first", "second"],
	);
});

test("serializes and validates only the clipboard data needed by a session entry", () => {
	const blocks = extractFencedBlocks(codeBlock("text", "echo exact"));
	const data = serializeCommandBlocks(blocks);

	assert.deepEqual(data, { version: 1, blocks: [{ language: "text", code: "echo exact" }] });
	assert.deepEqual(readPersistedCommandBlocks(data), [{ index: 0, language: "text", code: "echo exact" }]);
	assert.deepEqual(readPersistedCommandBlocks({ blocks: [{ code: "ok" }, { language: 3, code: null }] }), [{ index: 0, language: "", code: "ok" }]);
});

test("uses only the persisted panel for the latest assistant response", () => {
	const oldAssistant = { type: "message", message: { role: "assistant" } };
	const oldPanel = {
		type: "custom",
		customType: "pi-sampler-command-blocks",
		data: { blocks: [{ language: "sh", code: "old" }] },
	};
	const newAssistant = { type: "message", message: { role: "assistant" } };
	const newPanel = {
		type: "custom",
		customType: "pi-sampler-command-blocks",
		data: { blocks: [{ language: "ps1", code: "new" }] },
	};

	assert.deepEqual(findLatestPersistedCommandBlocks([oldAssistant, oldPanel, newAssistant]), []);
	assert.deepEqual(findLatestPersistedCommandBlocks([oldAssistant, oldPanel, newAssistant, newPanel]), [
		{ index: 0, language: "ps1", code: "new" },
	]);
});

test("copies exactly the selected block through an injected writer", async () => {
	const blocks = extractFencedBlocks(`${codeBlock("text", "first\n") }\n\n${codeBlock("text", "second  ")}`);
	const copied = [];
	const result = await copyCommandBlock(blocks, 1, async (text) => copied.push(text));

	assert.equal(result.code, "second  ");
	assert.deepEqual(copied, ["second  "]);
});

test("surfaces injected clipboard failures and rejects invalid indexes", async () => {
	const blocks = extractFencedBlocks(codeBlock("text", "echo fail"));
	await assert.rejects(() => copyCommandBlock(blocks, 0, async () => {
		throw new Error("stub clipboard unavailable");
	}), /stub clipboard unavailable/);
	await assert.rejects(() => copyCommandBlock(blocks, 1, async () => {}), /Command block 2 does not exist/);
});

test("preview sanitizes terminal controls without changing copied content", () => {
	const code = "echo ok\u001b]52;c;secret\u0007\nnext";
	assert.equal(formatBlockPreview(code), "echo ok? ↵ next");
});
