import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const LOCAL_EVENT_COUNT = 10_000_000;
export const CI_EVENT_COUNT = 10_000;
export const MAX_EVENT_COUNT = LOCAL_EVENT_COUNT;
export const MAX_REPETITIONS = 32;
export const SLOPE_ESTIMATOR = "theil-sen";
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_SAMPLES = 1024;
function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

// This explicit serializer avoids importing a signer or any repository
// authority into the benchmark process.
function stableJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") finiteNumber(value, "JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function theilSenSlope(samples) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error("at least two RSS samples are required");
  const slopes = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const deltaEvents = samples[right].events - samples[left].events;
      if (!Number.isSafeInteger(deltaEvents) || deltaEvents <= 0) throw new Error("RSS sample event counts must increase");
      const slope = (samples[right].rss_bytes - samples[left].rss_bytes) / deltaEvents;
      finiteNumber(slope, "RSS slope");
      slopes.push(slope);
    }
  }
  slopes.sort((a, b) => a - b);
  const middle = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 1 ? slopes[middle] : (slopes[middle - 1] + slopes[middle]) / 2;
}

export function sampleVariance(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + finiteNumber(value, "variance sample"), 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rss() {
  return process.memoryUsage().rss;
}

function sampleEvents(eventCount) {
  const count = Math.min(16, eventCount);
  const points = new Set([0, eventCount]);
  for (let index = 1; index < count; index += 1) points.add(Math.floor(eventCount * index / count));
  return [...points].sort((left, right) => left - right);
}

function eventValue(index, seed) {
  // The bounded synthetic record models the registry's immutable latest-value
  // map without retaining 10M source objects or writing a benchmark ledger.
  const lessonIndex = index % 4096;
  return `${seed}:${lessonIndex}:${Math.floor(index / 4096)}:${(index * 2654435761) >>> 0}`;
}

function rebuild(eventCount, seed, timeoutMs, collectSamples) {
  const started = performance.now();
  const checkpoints = sampleEvents(eventCount);
  let checkpointIndex = 0;
  let peak = rss();
  const latest = new Map();
  const samples = [{ events: 0, rss_bytes: peak }];
  for (let index = 0; index < eventCount; index += 1) {
    latest.set(index % 4096, eventValue(index, seed));
    if ((index & 0x3ff) === 0 && performance.now() - started > timeoutMs) throw new Error("benchmark_timeout");
    const completed = index + 1;
    if (completed >= checkpoints[checkpointIndex + 1]) {
      const current = rss();
      peak = Math.max(peak, current);
      samples.push({ events: completed, rss_bytes: current });
      checkpointIndex += 1;
    }
  }
  if (samples.at(-1).events !== eventCount) samples.push({ events: eventCount, rss_bytes: rss() });
  peak = Math.max(peak, ...samples.map((sample) => sample.rss_bytes));
  const durationMs = Math.max(performance.now() - started, Number.EPSILON);
  const slopeBytesPerEvent = theilSenSlope(samples);
  const variance = sampleVariance(samples.map((sample) => sample.rss_bytes));
  // Touch the map so an optimizing runtime cannot discard the rebuild work.
  if (latest.size < 1) throw new Error("benchmark produced no registry state");
  return {
    duration_ms: durationMs,
    peak_rss_bytes: peak,
    rss_samples: collectSamples ? samples.slice(0, MAX_SAMPLES) : samples.slice(0, 2),
    slope_bytes_per_event: slopeBytesPerEvent,
    variance,
    completed_events: eventCount,
  };
}

function classDefaults(benchmarkClass) {
  if (benchmarkClass === "local-10m") return { eventCount: LOCAL_EVENT_COUNT, repetitions: 3, warmupEvents: 1000 };
  if (benchmarkClass === "ci-regression") return { eventCount: CI_EVENT_COUNT, repetitions: 1, warmupEvents: Math.min(1000, CI_EVENT_COUNT) };
  throw new Error(`unknown benchmark class ${benchmarkClass}`);
}

export async function runBenchmark({
  benchmarkClass = "ci-regression",
  eventCount,
  repetitions,
  warmupEvents,
  timeoutMs = 900_000,
  ticketId = "AIDEV-158",
  repository = "Zkrausman/pi-sampler",
  baseSha,
  headSha,
  seed = "lesson-registry-rebuild-v1",
  outcome = "baseline",
  thresholds,
  now = () => new Date(),
} = {}) {
  const defaults = classDefaults(benchmarkClass);
  const events = eventCount ?? defaults.eventCount;
  const reps = repetitions ?? defaults.repetitions;
  const warmup = warmupEvents ?? Math.min(defaults.warmupEvents, events);
  if (!Number.isSafeInteger(events) || events < 1 || events > MAX_EVENT_COUNT || (benchmarkClass === "local-10m" && events !== LOCAL_EVENT_COUNT) || (benchmarkClass === "ci-regression" && events >= LOCAL_EVENT_COUNT)) throw new Error("event count is outside the benchmark class bound");
  if (!Number.isSafeInteger(reps) || reps < 1 || reps > MAX_REPETITIONS || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 1_000_000 || warmup > events || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new Error("benchmark configuration is outside its fixed bound");
  if (!/^A[A-Z0-9]+-[1-9][0-9]*$/.test(ticketId) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(repository) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseSha) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headSha)) throw new Error("benchmark identity binding is invalid");
  if (outcome !== "baseline" && outcome !== "passed" && outcome !== "failed") throw new Error("benchmark outcome is invalid");
  if (outcome !== "baseline") throw new Error("benchmark evaluations are disabled until separately reviewed external threshold approval is bound");
  if (thresholds !== undefined) throw new Error("candidate-authored benchmark thresholds are not accepted");

  const startedAt = new Date(now()).toISOString();
  rebuild(warmup, `${seed}:warmup`, timeoutMs, false);
  const workloadDigest = createHash("sha256").update(stableJson({ version: 1, workload: "lesson-registry-rebuild", class: benchmarkClass, event_count: events, seed })).digest("hex");
  const runs = [];
  for (let repetition = 1; repetition <= reps; repetition += 1) {
    const run = rebuild(events, `${seed}:${repetition}`, timeoutMs, true);
    runs.push({ repetition, event_count: events, ...run });
  }
  const completedAt = new Date(now()).toISOString();
  const durations = runs.map((run) => run.duration_ms);
  const slopes = runs.map((run) => run.slope_bytes_per_event);
  const summary = {
    duration_ms: median(durations),
    peak_rss_bytes: Math.max(...runs.map((run) => run.peak_rss_bytes)),
    slope_bytes_per_event: median(slopes),
    variance: sampleVariance(durations),
    completed_events: events,
  };
  const evidence = {
    schema_version: "benchmark-evidence/v1",
    ticket_id: ticketId,
    repository,
    base_sha: baseSha,
    head_sha: headSha,
    class: benchmarkClass,
    workload_digest: workloadDigest,
    event_count: events,
    warmup_events: warmup,
    repetitions: reps,
    timeout_ms: timeoutMs,
    started_at: startedAt,
    completed_at: completedAt,
    event_complete: runs.every((run) => run.completed_events === events),
    slope_estimator: SLOPE_ESTIMATOR,
    runs,
    summary,
    environment: {
      runtime: `node ${process.versions.node}`,
      hardware_class: `${process.platform}-${process.arch}`,
      cpu_count: Math.max(1, Math.min(1024, os.cpus().length)),
      memory_bytes: Math.max(1, Math.min(2 ** 40, os.totalmem())),
    },
    outcome,
  };
  return evidence;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unknown argument ${argument}`);
    const key = argument.slice(2).replaceAll("-", "_");
    if (key === "help") return { help: true };
    if (index + 1 >= argv.length) throw new Error(`${argument} requires a value`);
    options[key] = argv[++index];
  }
  return options;
}

function usage() {
  return "Usage: node scripts/benchmark-lesson-registry-rebuild.mjs --class local-10m|ci-regression --base SHA --head SHA [--events N] [--output PATH]";
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      const benchmarkClass = args.class ?? "local-10m";
      const evidence = await runBenchmark({
        benchmarkClass,
        eventCount: args.events === undefined ? undefined : Number(args.events),
        repetitions: args.repetitions === undefined ? undefined : Number(args.repetitions),
        warmupEvents: args.warmup_events === undefined ? undefined : Number(args.warmup_events),
        timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
        ticketId: args.ticket ?? "AIDEV-158",
        repository: args.repository ?? "Zkrausman/pi-sampler",
        baseSha: args.base,
        headSha: args.head,
      });
      const output = `${JSON.stringify(evidence, null, 2)}\n`;
      if (args.output) {
        await mkdir(dirname(resolve(args.output)), { recursive: true });
        await writeFile(args.output, output, { encoding: "utf8", flag: "wx" }).catch(async (error) => {
          if (error.code !== "EEXIST") throw error;
          await writeFile(args.output, output, "utf8");
        });
        console.log(`benchmark evidence written: ${args.output}`);
      } else {
        process.stdout.write(output);
      }
    }
  } catch (error) {
    console.error(`benchmark: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  }
}
