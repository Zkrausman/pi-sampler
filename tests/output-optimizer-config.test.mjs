import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OUTPUT_OPTIMIZER_CONFIG,
  isOutputOptimizerEligibleTool,
  loadOutputOptimizerConfig,
  normalizeOutputOptimizerConfig,
} from "../extensions/output-optimizer/src/config.mjs";

test("project configuration permits bounded policy and custom tool opt-in", () => {
  const config = normalizeOutputOptimizerConfig({
    enabled: false,
    thresholdBytes: 12_000,
    telemetryEnabled: true,
    additionalToolNames: ["service_test_runner"],
  });
  assert.equal(config.enabled, false);
  assert.equal(config.thresholdBytes, 12_000);
  assert.equal(config.telemetryEnabled, true);
  assert.equal(config.redact, true);
  assert.equal(config.trustRequired, true);
  assert.equal(isOutputOptimizerEligibleTool({ toolName: "service_test_runner", details: { outputOptimizerEligible: true } }, config), true);
  assert.equal(isOutputOptimizerEligibleTool({ toolName: "service_test_runner", details: {} }, config), false);
});

test("project configuration loads from the trusted project path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "output-optimizer-"));
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "output-optimizer.json"), JSON.stringify({ thresholdBytes: 16_000 }));
    const loaded = await loadOutputOptimizerConfig(cwd);
    assert.equal(loaded.source, ".pi/output-optimizer.json");
    assert.equal(loaded.config.thresholdBytes, 16_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project configuration cannot relax safety or admit malformed tool names", () => {
  const invalid = (value) => assert.throws(() => normalizeOutputOptimizerConfig(value), (error) => error.code === "invalid_output_optimizer_config");
  invalid({ redact: false });
  invalid({ trustRequired: false });
  invalid({ thresholdBytes: 7_999 });
  invalid({ additionalToolNames: ["not-a-tool"] });
  assert.equal(isOutputOptimizerEligibleTool({ toolName: "bash", details: {} }, DEFAULT_OUTPUT_OPTIMIZER_CONFIG), true);
});
