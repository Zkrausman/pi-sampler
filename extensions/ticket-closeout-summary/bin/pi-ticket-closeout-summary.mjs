#!/usr/bin/env node
import { readCloseoutSummary, renderCloseoutMarkdown } from "../src/index.mjs";

function usage() { return "Usage: pi-ticket-closeout-summary --receipt <absolute-path> [--format json|markdown]"; }
function argumentsFor(values) {
  let receipt; let format = "json"; let formatSeen = false;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--receipt" && receipt === undefined && index + 1 < values.length && !values[index + 1].startsWith("--")) { receipt = values[++index]; continue; }
    if (value === "--format" && !formatSeen && index + 1 < values.length && ["json", "markdown"].includes(values[index + 1])) { format = values[++index]; formatSeen = true; continue; }
    throw new Error(usage());
  }
  if (!receipt) throw new Error(usage());
  return { receipt, format };
}
try {
  const options = argumentsFor(process.argv.slice(2)); const summary = await readCloseoutSummary(options.receipt);
  process.stdout.write(options.format === "markdown" ? renderCloseoutMarkdown(summary) : `${JSON.stringify(summary)}\n`);
} catch (error) { process.stderr.write(`${error?.message || "closeout_summary_failed"}\n`); process.exitCode = 1; }
