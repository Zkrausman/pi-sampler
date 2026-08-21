import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBenchmark, sampleVariance, theilSenSlope } from "../scripts/benchmark-lesson-registry-rebuild.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

test("lesson-registry benchmark records the shared bounded metrics", async () => {
  const evidence = await runBenchmark({ benchmarkClass: "ci-regression", eventCount: 128, repetitions: 2, warmupEvents: 16, baseSha: BASE_SHA, headSha: HEAD_SHA });

  assert.equal(evidence.schema_version, "benchmark-evidence/v1");
  assert.equal(evidence.class, "ci-regression");
  assert.equal(evidence.event_count, 128);
  assert.equal(evidence.event_complete, true);
  assert.equal(evidence.slope_estimator, "theil-sen");
  assert.equal(evidence.outcome, "baseline");
  assert.equal("thresholds" in evidence, false);
  assert.equal(evidence.runs.length, 2);
  assert.deepEqual(evidence.runs.map((run) => run.completed_events), [128, 128]);
  assert.ok(Number.isFinite(evidence.summary.slope_bytes_per_event));
  assert.ok(Number.isFinite(evidence.summary.variance));
  assert.equal(evidence.base_sha, BASE_SHA);
  assert.equal(evidence.head_sha, HEAD_SHA);
  assert.equal(evidence.environment.memory_bytes, Math.max(1, Math.min(2 ** 40, os.totalmem())));
  assert.notEqual(evidence.environment.memory_bytes, 256);
  assert.equal(theilSenSlope([{ events: 0, rss_bytes: 100 }, { events: 10, rss_bytes: 200 }]), 10);
  assert.equal(sampleVariance([10, 10]), 0);
});

test("the local class cannot be substituted with a smaller CI workload", async () => {
  await assert.rejects(
    runBenchmark({ benchmarkClass: "local-10m", eventCount: 128, repetitions: 1, baseSha: BASE_SHA, headSha: HEAD_SHA }),
    /event count is outside the benchmark class bound/,
  );
});

test("benchmark configuration remains bounded", async () => {
  await assert.rejects(
    runBenchmark({ benchmarkClass: "ci-regression", eventCount: 1_000_000_000, baseSha: BASE_SHA, headSha: HEAD_SHA }),
    /event count is outside the benchmark class bound/,
  );
});

test("declared benchmark wrapper injects immutable bindings", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "aidev158-benchmark-test-"));
  const output = join(outputRoot, "ci.json");
  try {
    await execFileAsync(process.execPath, [join(root, "scripts/run-lesson-registry-benchmark.mjs"), "--class", "ci-regression", "--events", "128", "--repetitions", "1", "--output", output], {
      cwd: root,
      env: { ...process.env, AIDEV_BENCHMARK_BASE_SHA: BASE_SHA, AIDEV_BENCHMARK_HEAD_SHA: HEAD_SHA },
    });
    const evidence = JSON.parse(await readFile(output, "utf8"));
    assert.equal(evidence.base_sha, BASE_SHA);
    assert.equal(evidence.head_sha, HEAD_SHA);
    assert.notEqual(evidence.base_sha, "0".repeat(40));
    assert.notEqual(evidence.head_sha, "0".repeat(40));
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("benchmark requires immutable bindings and blocks self-authored pass thresholds", async () => {
  await assert.rejects(
    runBenchmark({ benchmarkClass: "ci-regression", eventCount: 128, repetitions: 1 }),
    /benchmark identity binding is invalid/,
  );
  await assert.rejects(
    runBenchmark({
      benchmarkClass: "ci-regression",
      eventCount: 128,
      repetitions: 1,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      outcome: "passed",
      thresholds: { max_duration_ms: 1_800_000, max_peak_rss_bytes: 2 ** 40, max_slope_bytes_per_event: 2 ** 40, max_variance: 2 ** 40 },
    }),
    /separately reviewed external threshold approval/,
  );
});
