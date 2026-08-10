import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILE = ".pi/output-optimizer.json";
const BUILTIN_COMMAND_TOOLS = new Set(["bash", "exec", "run_command"]);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_CAPS = Object.freeze({ errors: 20, warnings: 10, flatList: 20, inventory: 50 });

export const DEFAULT_OUTPUT_OPTIMIZER_CONFIG = Object.freeze({
  enabled: true, thresholdBytes: 8_000, maxOutputBytes: 12_000, telemetryEnabled: false,
  additionalToolNames: Object.freeze([]), caps: DEFAULT_CAPS, redact: true, trustRequired: true,
});
function invalid(message) { const error = new Error(message); error.code = "invalid_output_optimizer_config"; throw error; }
function boundedInteger(value, name, min, max) { if (!Number.isInteger(value) || value < min || value > max) invalid(`${name} must be an integer from ${min} to ${max}`); return value; }

export function normalizeOutputOptimizerConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("configuration must be an object");
  const allowed = new Set(["enabled", "thresholdBytes", "maxOutputBytes", "telemetryEnabled", "additionalToolNames", "caps"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) invalid(`unknown option: ${key}`);
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") invalid("enabled must be a boolean");
  const thresholdBytes = boundedInteger(raw.thresholdBytes ?? 8_000, "thresholdBytes", 1_024, 1_000_000);
  const maxOutputBytes = boundedInteger(raw.maxOutputBytes ?? 12_000, "maxOutputBytes", 1_024, 100_000);
  const telemetryEnabled = raw.telemetryEnabled ?? false;
  if (typeof telemetryEnabled !== "boolean") invalid("telemetryEnabled must be a boolean");
  const additionalToolNames = raw.additionalToolNames ?? [];
  if (!Array.isArray(additionalToolNames) || additionalToolNames.length > 32 || new Set(additionalToolNames).size !== additionalToolNames.length || additionalToolNames.some((name) => typeof name !== "string" || !TOOL_NAME.test(name) || BUILTIN_COMMAND_TOOLS.has(name))) invalid("additionalToolNames must contain at most 32 unique custom tool names");
  const capsRaw = raw.caps ?? {};
  if (!capsRaw || typeof capsRaw !== "object" || Array.isArray(capsRaw) || Object.keys(capsRaw).some((key) => !Object.hasOwn(DEFAULT_CAPS, key))) invalid("caps must contain only errors, warnings, flatList, and inventory");
  const caps = Object.freeze(Object.fromEntries(Object.entries(DEFAULT_CAPS).map(([key, fallback]) => [key, boundedInteger(capsRaw[key] ?? fallback, `caps.${key}`, 1, 100)])));
  return Object.freeze({ enabled, thresholdBytes, maxOutputBytes, telemetryEnabled, additionalToolNames: Object.freeze([...additionalToolNames]), caps, redact: true, trustRequired: true });
}
export async function loadOutputOptimizerConfig(cwd) { try { const raw = JSON.parse(await readFile(join(cwd, CONFIG_FILE), "utf8")); return { config: normalizeOutputOptimizerConfig(raw), source: CONFIG_FILE, warning: null }; } catch (error) { if (error?.code === "ENOENT") return { config: DEFAULT_OUTPUT_OPTIMIZER_CONFIG, source: "defaults", warning: null }; return { config: DEFAULT_OUTPUT_OPTIMIZER_CONFIG, source: "defaults", warning: error?.code ?? "invalid_output_optimizer_config" }; } }
export function isOutputOptimizerEligibleTool(event, config) { if (BUILTIN_COMMAND_TOOLS.has(event.toolName)) return true; return config.additionalToolNames.includes(event.toolName) && event.details?.outputOptimizerEligible === true; }
