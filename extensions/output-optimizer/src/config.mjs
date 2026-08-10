import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILE = ".pi/output-optimizer.json";
const BUILTIN_COMMAND_TOOLS = new Set(["bash", "exec", "run_command"]);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const DEFAULT_OUTPUT_OPTIMIZER_CONFIG = Object.freeze({
  enabled: true,
  thresholdBytes: 8_000,
  redact: true,
  trustRequired: true,
  telemetryEnabled: false,
  additionalToolNames: Object.freeze([]),
});

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid_output_optimizer_config";
  throw error;
}

/** Validates only options that cannot relax the optimizer's safety invariants. */
export function normalizeOutputOptimizerConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("configuration must be an object");
  const allowed = new Set(["enabled", "thresholdBytes", "telemetryEnabled", "additionalToolNames"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) invalid(`unknown option: ${key}`);

  const enabled = raw.enabled ?? DEFAULT_OUTPUT_OPTIMIZER_CONFIG.enabled;
  if (typeof enabled !== "boolean") invalid("enabled must be a boolean");
  const thresholdBytes = raw.thresholdBytes ?? DEFAULT_OUTPUT_OPTIMIZER_CONFIG.thresholdBytes;
  if (!Number.isInteger(thresholdBytes) || thresholdBytes < 8_000 || thresholdBytes > 100_000) {
    invalid("thresholdBytes must be an integer from 8000 to 100000");
  }
  const telemetryEnabled = raw.telemetryEnabled ?? DEFAULT_OUTPUT_OPTIMIZER_CONFIG.telemetryEnabled;
  if (typeof telemetryEnabled !== "boolean") invalid("telemetryEnabled must be a boolean");
  const additionalToolNames = raw.additionalToolNames ?? [];
  if (!Array.isArray(additionalToolNames) || additionalToolNames.length > 32 || additionalToolNames.some((name) => typeof name !== "string" || !TOOL_NAME.test(name) || BUILTIN_COMMAND_TOOLS.has(name))) {
    invalid("additionalToolNames must contain at most 32 unique custom tool names");
  }
  if (new Set(additionalToolNames).size !== additionalToolNames.length) invalid("additionalToolNames must be unique");

  return Object.freeze({
    enabled,
    thresholdBytes,
    telemetryEnabled,
    additionalToolNames: Object.freeze([...additionalToolNames]),
    // Configuration cannot disable these safety properties.
    redact: true,
    trustRequired: true,
  });
}

export async function loadOutputOptimizerConfig(cwd) {
  try {
    const raw = JSON.parse(await readFile(join(cwd, CONFIG_FILE), "utf8"));
    return { config: normalizeOutputOptimizerConfig(raw), source: CONFIG_FILE, warning: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { config: DEFAULT_OUTPUT_OPTIMIZER_CONFIG, source: "defaults", warning: null };
    return { config: DEFAULT_OUTPUT_OPTIMIZER_CONFIG, source: "defaults", warning: error?.code ?? "invalid_output_optimizer_config" };
  }
}

export function isOutputOptimizerEligibleTool(event, config) {
  if (BUILTIN_COMMAND_TOOLS.has(event.toolName)) return true;
  return config.additionalToolNames.includes(event.toolName)
    && event.details?.outputOptimizerEligible === true;
}
