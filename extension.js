import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { createCommandBlocksView } from "./src/command-block-view.js";
import {
	COMMAND_BLOCK_ENTRY_TYPE,
	COMMAND_BLOCK_SHORTCUT,
	copyCommandBlock,
	extractAssistantBlocks,
	findLatestPersistedCommandBlocks,
	formatBlockPreview,
	normalizeEscapedFences,
	readPersistedCommandBlocks,
	serializeCommandBlocks,
} from "./src/command-blocks.js";

function textFromError(error) {
	return error instanceof Error ? error.message : String(error);
}

function notify(ui, message, type) {
	ui?.notify(message, type);
}

function latestBlocks(ctx) {
	return findLatestPersistedCommandBlocks(ctx.sessionManager.getBranch());
}

async function copyOne(blocks, index, ui) {
	try {
		await copyCommandBlock(blocks, index, copyToClipboard);
		notify(ui, `Copy requested for command block ${index + 1}; Pi accepted the request, but end-to-end clipboard delivery is unconfirmed.`, "info");
		return true;
	} catch (error) {
		notify(ui, `Clipboard copy failed for command block ${index + 1}: ${textFromError(error)}`, "error");
		return false;
	}
}

function parseRequestedIndex(args, blockCount) {
	const value = args.trim();
	if (value === "") return undefined;
	if (!/^\d+$/.test(value)) throw new Error("Use /copy-command <number>.");

	const index = Number(value) - 1;
	if (!Number.isSafeInteger(index) || index < 0 || index >= blockCount) {
		throw new Error(`Command block ${value} does not exist in the latest response.`);
	}
	return index;
}

async function chooseBlock(ctx, blocks) {
	if (blocks.length === 1) return 0;
	if (!ctx.hasUI) return undefined;

	const options = blocks.map(
		(block, index) => `${index + 1}: ${block.language || "code"} — ${formatBlockPreview(block.code) || "(empty)"}`,
	);
	const selected = await ctx.ui.select("Copy command block", options);
	if (selected === undefined) return undefined;
	return options.indexOf(selected);
}

export default function piSamplerCommandBlocks(pi) {
	let currentUi;

	// This hook changes only display Markdown. Pi keeps the original assistant
	// message in the session and context.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant") return markdown;
		return normalizeEscapedFences(markdown);
	});

	pi.registerEntryRenderer(COMMAND_BLOCK_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const blocks = readPersistedCommandBlocks(entry.data);
		if (blocks.length === 0) return undefined;
		return createCommandBlocksView(blocks, theme, (index) => copyOne(blocks, index, currentUi), expanded);
	});

	pi.on("session_start", (_event, ctx) => {
		currentUi = ctx.ui;
	});

	// turn_end is the first supported lifecycle point after the assistant and
	// any tool results have been persisted. Appending here keeps the sampler
	// panel after the native transcript entry instead of inserting it mid-turn.
	pi.on("turn_end", (event, ctx) => {
		currentUi = ctx.ui;
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
		if (["aborted", "error", "length"].includes(event.message.stopReason)) return;

		const blocks = extractAssistantBlocks(event.message);
		if (blocks.length === 0) return;
		pi.appendEntry(COMMAND_BLOCK_ENTRY_TYPE, serializeCommandBlocks(blocks));
	});

	const copyLatest = async (ctx) => {
		const blocks = latestBlocks(ctx);
		if (blocks.length === 0) {
			notify(ctx.ui, "No command blocks are available in the latest response.", "warning");
			return;
		}

		let index;
		try {
			index = await chooseBlock(ctx, blocks);
		} catch (error) {
			notify(ctx.ui, textFromError(error), "error");
			return;
		}
		if (index === undefined || index < 0) return;
		await copyOne(blocks, index, ctx.ui);
	};

	pi.registerShortcut(COMMAND_BLOCK_SHORTCUT, {
		description: "Copy a command block from the latest response",
		handler: copyLatest,
	});

	pi.registerCommand("copy-command", {
		description: "Copy one command block from the latest response (usage: /copy-command <number>)",
		handler: async (args, ctx) => {
			const blocks = latestBlocks(ctx);
			if (blocks.length === 0) {
				notify(ctx.ui, "No command blocks are available in the latest response.", "warning");
				return;
			}

			let index;
			try {
				index = parseRequestedIndex(args, blocks.length);
				if (index === undefined) index = await chooseBlock(ctx, blocks);
			} catch (error) {
				notify(ctx.ui, textFromError(error), "error");
				return;
			}
			if (index === undefined || index < 0) return;
			await copyOne(blocks, index, ctx.ui);
		},
	});
}
