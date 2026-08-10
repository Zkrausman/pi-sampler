import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OUTPUT_OPTIMIZER_CONFIG, normalizeOutputOptimizerConfig } from "../extensions/output-optimizer/src/config.mjs";
import { byteLength, classifyCommand, optimizeOutput } from "../extensions/output-optimizer/src/compactor.mjs";

const config = normalizeOutputOptimizerConfig({ thresholdBytes: 1_024, maxOutputBytes: 2_048 });
const run = (command, output, options = {}) => optimizeOutput({ command, output, config, ...options });

test("small and unknown successful output stay intact", () => {
  assert.equal(run("go test ./...", "ok\n").output, "ok\n");
  const unknown = "line\n".repeat(100);
  assert.equal(run("custom-report", unknown).output, unknown);
});
test("failures, diffs, and raw bypass stay lossless except redaction", () => {
  const raw = "token=secret\n" + "ERROR: failed\n" + "x\n".repeat(100);
  assert.equal(run("go test ./...", raw).transformed, false);
  assert.match(run("go test ./...", raw).output, /\[REDACTED\]/);
  const diff = "diff --git a/a b/a\n" + "x\n".repeat(100);
  assert.equal(run("git diff", diff).output, diff);
  const bypass = "x\n".repeat(100);
  assert.equal(run("rg todo", bypass, { rawBypass: true }).output, bypass);
});
test("command classes are deterministic and respect the UTF-8 budget", () => {
  const fixtures = {
    "go test ./...": "ok package/a\nwarning: slow test\n" + "ok package/b\n".repeat(200) + "PASS\n",
    "npm install": "added 12 packages\nnpm warn deprecated x\n" + "progress\n".repeat(200),
    "git status": "On branch main\nnothing to commit\n" + "file\n".repeat(200),
    "rg TODO": "src/a.ts:1: TODO one\n".repeat(200),
    "ls -la": "file.txt\n".repeat(200),
    "npm list": "dependency-a\n".repeat(200),
  };
  for (const [command, output] of Object.entries(fixtures)) {
    const result = run(command, output);
    assert.equal(result.transformed, true, command);
    assert.ok(byteLength(result.output) <= config.maxOutputBytes, command);
    assert.match(result.output, /use output_raw: true/);
    assert.equal(result.output, run(command, output).output, command);
  }
});
test("classification and data caps select actionable records", () => {
  assert.equal(classifyCommand("git log --oneline"), "git");
  assert.equal(classifyCommand("rg needle"), "search");
  const warnings = Array.from({ length: 40 }, (_, i) => `warning: ${i}`).join("\n");
  const output = `PASS\n${warnings}\n` + "item\n".repeat(200);
  const result = run("go test ./...", output);
  assert.ok((result.output.match(/warning:/g) ?? []).length <= config.caps.warnings);
});
test("Unicode is not split while obeying the output byte budget", () => {
  const output = "é😀 useful item\n".repeat(500);
  const result = run("ls", output);
  assert.ok(byteLength(result.output) <= config.maxOutputBytes);
  assert.equal(result.output.includes("�"), false);
});
test("threshold and output budget are independent", () => {
  const highThreshold = normalizeOutputOptimizerConfig({ thresholdBytes: 10_000, maxOutputBytes: 1_024 });
  const output = "item\n".repeat(500);
  assert.equal(optimizeOutput({ command: "ls", output, config: highThreshold }).transformed, false);
  assert.equal(DEFAULT_OUTPUT_OPTIMIZER_CONFIG.maxOutputBytes, 12_000);
});
