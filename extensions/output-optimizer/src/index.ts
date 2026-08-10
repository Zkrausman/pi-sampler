/**
 * Transform-only: never spawns/re-runs commands. Hooks Pi's bash tool_result lifecycle
 * via pi.on("tool_result"). Implements local output-optimization semantics so this
 * extension does not reimplement the optimizer as a library callout boundary — the
 * optimization behavior is implemented locally so the extension has no consumer-repository dependency.
 *
 * Safety: raw is preserved for errors/diffs/small; raw bypass flag respected;
 * project trust required for non-trivial transform; redaction before telemetry;
 * telemetry is disabled by default and stores counts only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_OUTPUT_OPTIMIZER_CONFIG,
  isOutputOptimizerEligibleTool,
  loadOutputOptimizerConfig,
} from "./config.mjs";

export type OutputOptimizerConfig = {
  enabled: boolean;
  thresholdBytes: number;
  redact: boolean;
  rawBypass?: boolean;
  trustRequired?: boolean;
  telemetryEnabled?: boolean;
  additionalToolNames?: readonly string[];
};

const SECRET_RE = /(api[_-]?key|secret|password|token)\s*[:=]\s*["']?[^"'\s;]+["']?/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9_\-\.]+/gi;
const TOKEN_PATTERNS = [/ghp_[A-Za-z0-9_]+/g, /gho_[A-Za-z0-9_]+/g, /sk-[A-Za-z0-9\-]+/g];
const ERROR_RE = /\[FAIL\]|FAILED|ERROR|panic|traceback|exception|fatal/i;
const DIFF_RE = /(^diff --git|^@@ |^--- |^\+\+\+ )/m;

const SENSITIVE_PATH_MARKERS = [
  ".env",
  "/credentials/",
  "/oauth/",
  "/secrets/",
  "/sessions/",
  "authorization:",
];

export function shouldRedact(s: string): boolean {
  const low = s.toLowerCase();
  for (const m of SENSITIVE_PATH_MARKERS) if (low.includes(m.toLowerCase())) return true;
  const copy = s.replace(SECRET_RE, "").replace(BEARER_RE, "");
  let hit = SECRET_RE.test(s) || BEARER_RE.test(s);
  SECRET_RE.lastIndex = 0; BEARER_RE.lastIndex = 0;
  if (hit) return true;
  for (const re of TOKEN_PATTERNS) { if (re.test(s)) { re.lastIndex = 0; return true; } re.lastIndex = 0; }
  return copy !== s ? true : false;
}

export function redact(s: string): string {
  let out = s;
  out = out.replace(SECRET_RE, (_m, p1: string) => `${String(p1).split(/[:=]/)[0].trim()}=[REDACTED]`);
  out = out.replace(BEARER_RE, "Bearer [REDACTED]");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function extractCommand(event: { input?: unknown; toolName: string }): string {
  const inp: any = (event as any).input ?? (event as any).args ?? {};
  if (typeof inp.command === "string") return inp.command;
  if (typeof inp.cmd === "string") return inp.cmd;
  return "";
}

export function extractExitCode(details: unknown): number {
  const d: any = details ?? {};
  if (typeof d.exitCode === "number") return d.exitCode;
  if (typeof d.exit_code === "number") return d.exit_code;
  if (typeof d.code === "number") return d.code;
  return 0;
}

export function shouldPreserveRaw(output: string, exitCode: number): boolean {
  if (exitCode !== 0) return true;
  if (ERROR_RE.test(output)) return true;
  if (DIFF_RE.test(output)) return true;
  return false;
}

export function shouldCompress(output: string, cfg: OutputOptimizerConfig): boolean {
  if (!cfg.enabled) return false;
  if (cfg.rawBypass) return false;
  if (output.length < (cfg.thresholdBytes || 8000)) return false;
  return true;
}

export function compressLargeOutput(output: string): string {
  const lines = output.split("\n");
  let head = 60, tail = 60;
  if (lines.length > 400) { head = 80; tail = 80; }
  if (lines.length <= head + tail + 1) {
    // byte truncate middle
    const threshold = 8000;
    const keep = threshold - 80 < 200 ? 200 : threshold - 80;
    const half = Math.floor(keep / 2);
    return output.slice(0, half) + "\n... [middle truncated by Output Optimizer]\n" + output.slice(output.length - half);
  }
  const middleStart = head, middleEnd = lines.length - tail;
  const hotKeywords = ["warn", "info", "test", "ok", "pass"];
  const hotSet = new Set<number>();
  for (let i = middleStart; i < middleEnd; i++) {
    const low = lines[i].toLowerCase();
    for (const k of hotKeywords) if (low.includes(k)) { hotSet.add(i); break; }
  }
  const result: string[] = [];
  result.push(...lines.slice(0, head));
  let keptHot = 0;
  for (let i = middleStart; i < middleEnd && keptHot < 10; i++) {
    if (hotSet.has(i)) {
      const start = Math.max(middleStart, i - 1);
      const end = Math.min(middleEnd - 1, i + 1);
      for (let j = start; j <= end; j++) result.push(lines[j]);
      keptHot++;
    }
  }
  const removed = (middleEnd - middleStart) - (result.length - head);
  if (removed > 0) result.push(`... [${removed} lines removed by Output Optimizer] ...`);
  result.push(...lines.slice(lines.length - tail));
  return result.join("\n");
}

export function piOptimizeTransform(
  command: string,
  output: string,
  exitCode: number,
  cfg: OutputOptimizerConfig,
  opts?: { cancelled?: boolean; isTrusted?: boolean },
): { output: string; compressed: boolean; reason: string; redacted: boolean } {
  const cancelled = opts?.cancelled ?? false;
  if (cancelled) return { output, compressed: false, reason: "cancelled", redacted: false };
  if (cfg.trustRequired && opts?.isTrusted === false) return { output, compressed: false, reason: "untrusted", redacted: false };
  if (cfg.rawBypass) return { output, compressed: false, reason: "raw_bypass", redacted: false };
  if (!output) return { output, compressed: false, reason: "empty", redacted: false };
  if (shouldPreserveRaw(output, exitCode)) return { output: cfg.redact ? redact(output) : output, compressed: false, reason: exitCode !== 0 ? "exit_nonzero" : "lossless_marker", redacted: cfg.redact && shouldRedact(output) };
  if (!shouldCompress(output, cfg)) return { output: cfg.redact ? redact(output) : output, compressed: false, reason: "below_threshold", redacted: cfg.redact && shouldRedact(output) };
  const compressed = compressLargeOutput(output);
  const finalOut = cfg.redact ? redact(compressed) : compressed;
  return { output: finalOut, compressed: true, reason: "compressed", redacted: cfg.redact && shouldRedact(output) };
}

// Telemetry counters (counts only, no raw). Disabled by default.
export type OutputOptimizerTelemetry = { piCalls: number; bytesIn: number; bytesOut: number; compressedCalls: number };
let telemetry: OutputOptimizerTelemetry = { piCalls: 0, bytesIn: 0, bytesOut: 0, compressedCalls: 0 };
let telemetryEnabled = false;
export function getOutputOptimizerTelemetry(): OutputOptimizerTelemetry { return { ...telemetry }; }
export function resetOutputOptimizerTelemetry(): void { telemetry = { piCalls: 0, bytesIn: 0, bytesOut: 0, compressedCalls: 0 }; }
export function setTelemetryEnabled(v: boolean): void { telemetryEnabled = v; }
export function isTelemetryEnabled(): boolean { return telemetryEnabled; }
export function recordTelemetry(inputLen: number, outputLen: number, compressed: boolean): void {
  if (!telemetryEnabled) return;
  telemetry.piCalls++; telemetry.bytesIn += inputLen; telemetry.bytesOut += outputLen;
  if (compressed) telemetry.compressedCalls++;
}

export default function outputOptimizer(pi: ExtensionAPI) {
  let activeConfig: OutputOptimizerConfig = DEFAULT_OUTPUT_OPTIMIZER_CONFIG;
  let configSource = "defaults";
  let configWarning: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    activeConfig = DEFAULT_OUTPUT_OPTIMIZER_CONFIG;
    configSource = "defaults";
    configWarning = null;
    setTelemetryEnabled(false);
    if (!ctx.isProjectTrusted()) return;
    const loaded = await loadOutputOptimizerConfig(ctx.cwd);
    activeConfig = loaded.config;
    configSource = loaded.source;
    configWarning = loaded.warning;
    setTelemetryEnabled(activeConfig.telemetryEnabled ?? false);
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!isOutputOptimizerEligibleTool(event, activeConfig)) return;
    const command = extractCommand(event);
    const details: any = event.details ?? {};
    const exitCode: number = extractExitCode(details);
    const cancelled: boolean = Boolean(details.cancelled);

    // Raw bypass flag: bash tool param output_raw or env-driven
    const rawBypass: boolean = Boolean((event.input as any)?.output_raw ?? (event.input as any)?.raw ?? false)
      || (typeof command === "string" && command.includes("--output-raw"));
    if (rawBypass) return;

    // Content extraction: pi bash tool returns content array or details.output
    let output: string = "";
    if (Array.isArray(event.content)) {
      output = event.content.map((c: any) => (typeof c.text === "string" ? c.text : "")).join("\n");
    } else if (typeof event.content === "string") {
      output = event.content;
    }
    if (!output && typeof details.output === "string") output = details.output;
    if (!output && typeof details.stdout === "string") output = details.stdout + (details.stderr ? "\n" + details.stderr : "");

    const isTrusted: boolean = typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
    const cfg: OutputOptimizerConfig = {
      ...activeConfig,
      rawBypass,
      telemetryEnabled: isTelemetryEnabled(),
    };

    if (!cfg.enabled) return;
    if (cfg.trustRequired && !isTrusted) return;
    if (cancelled) return;

    const res = piOptimizeTransform(command, output, exitCode, cfg, { cancelled, isTrusted });
    if (!res.compressed) {
      // Still potentially redact if needed and ensure no raw secret flows to details.redacted mirror
      if (res.redacted && cfg.redact) {
        // Replace content with redacted lossless form
        const redactedOnly = redact(output);
        return { content: [{ type: "text" as const, text: redactedOnly }], details: { ...details, outputOptimized: false, outputRedacted: true } };
      }
      return;
    }

    // Apply transform: replace content; keep isError/parallels.
    recordTelemetry(output.length, res.output.length, true);
    return {
      content: [{ type: "text" as const, text: res.output }],
      details: { ...details, outputOptimized: true, outputReason: res.reason, outputRedacted: res.redacted },
    };
  });

  pi.registerTool({
    name: "output_optimizer_status",
    label: "Output Optimizer Status",
    description: "Reports output-optimization state (trust/threshold/telemetry counts). No raw output.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const trusted = typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
      const tel = getOutputOptimizerTelemetry();
      return {
        content: [{ type: "text", text: `Output optimizer: enabled=${activeConfig.enabled}, threshold=${activeConfig.thresholdBytes}, trusted=${trusted}, config=${configSource}, telemetryEnabled=${isTelemetryEnabled()}, calls=${tel.piCalls}, bytesIn=${tel.bytesIn}, bytesOut=${tel.bytesOut}${configWarning ? `, configWarning=${configWarning}` : ""}` }],
        details: { trusted, configSource, configWarning, config: activeConfig, telemetryEnabled: isTelemetryEnabled(), telemetry: tel },
      };
    },
  });

  pi.registerTool({
    name: "output_optimizer_raw",
    label: "Output Optimizer Raw",
    description: "Escape hatch: instructs next bash callers that unoptimized output should be used (sets output_raw hint). No raw persistence.",
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    async execute(_id: string, _params: unknown) {
      // No state mutation globally; callers opt in per tool_call via output_raw: true.
      return {
        content: [{ type: "text", text: "Use bash with output_raw: true to bypass Pi optimization for that call." }],
        details: { rawHint: "output_raw:true on next bash tool call" },
      };
    },
  });
}
