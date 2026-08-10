import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_OUTPUT_OPTIMIZER_CONFIG, isOutputOptimizerEligibleTool, loadOutputOptimizerConfig } from "./config.mjs";
import { optimizeOutput } from "./compactor.mjs";

export type OutputOptimizerTelemetry = { piCalls: number; bytesIn: number; bytesOut: number; compressedCalls: number };
let telemetry: OutputOptimizerTelemetry = { piCalls: 0, bytesIn: 0, bytesOut: 0, compressedCalls: 0 };
export function getOutputOptimizerTelemetry() { return { ...telemetry }; }
export function resetOutputOptimizerTelemetry() { telemetry = { piCalls: 0, bytesIn: 0, bytesOut: 0, compressedCalls: 0 }; }
function exitCode(details: any) { return typeof details?.exitCode === "number" ? details.exitCode : typeof details?.exit_code === "number" ? details.exit_code : typeof details?.code === "number" ? details.code : 0; }
function commandOf(event: any) { return typeof event.input?.command === "string" ? event.input.command : typeof event.input?.cmd === "string" ? event.input.cmd : ""; }
function outputOf(event: any, details: any) { if (Array.isArray(event.content)) return event.content.map((item: any) => typeof item.text === "string" ? item.text : "").join("\n"); if (typeof event.content === "string") return event.content; return typeof details.output === "string" ? details.output : typeof details.stdout === "string" ? details.stdout + (details.stderr ? `\n${details.stderr}` : "") : ""; }

export default function outputOptimizer(pi: ExtensionAPI) {
  let config: any = DEFAULT_OUTPUT_OPTIMIZER_CONFIG, source = "defaults", warning: string | null = null;
  pi.on("session_start", async (_event, ctx) => { config = DEFAULT_OUTPUT_OPTIMIZER_CONFIG; source = "defaults"; warning = null; if (!ctx.isProjectTrusted()) return; const loaded = await loadOutputOptimizerConfig(ctx.cwd); config = loaded.config; source = loaded.source; warning = loaded.warning; });
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!isOutputOptimizerEligibleTool(event, config)) return;
    const details = event.details ?? {}, rawBypass = Boolean(event.input?.output_raw ?? event.input?.raw) || commandOf(event).includes("--output-raw");
    const result = optimizeOutput({ command: commandOf(event), output: outputOf(event, details), exitCode: exitCode(details), config, rawBypass, cancelled: Boolean(details.cancelled), trusted: ctx.isProjectTrusted() });
    if (result.transformed) { telemetry.piCalls++; telemetry.bytesIn += Buffer.byteLength(outputOf(event, details)); telemetry.bytesOut += Buffer.byteLength(result.output); telemetry.compressedCalls++; }
    if (result.output !== outputOf(event, details)) return { content: [{ type: "text" as const, text: result.output }], details: { ...details, outputOptimized: result.transformed, outputReason: result.reason, outputClass: result.kind } };
  });
  pi.registerTool({ name: "output_optimizer_status", label: "Output Optimizer Status", description: "Reports output-optimization policy and count-only telemetry.", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, ctx: any) { const tel = getOutputOptimizerTelemetry(); return { content: [{ type: "text", text: `Output optimizer: enabled=${config.enabled}, threshold=${config.thresholdBytes}, maxOutput=${config.maxOutputBytes}, trusted=${ctx.isProjectTrusted()}, config=${source}, calls=${tel.piCalls}${warning ? `, configWarning=${warning}` : ""}` }], details: { config, source, warning, telemetry: tel } }; } });
  pi.registerTool({ name: "output_optimizer_raw", label: "Output Optimizer Raw", description: "Shows the per-call raw-output bypass.", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "Use bash with output_raw: true to preserve full command output (except mandatory secret redaction)." }], details: { rawHint: "output_raw:true" } }; } });
}
