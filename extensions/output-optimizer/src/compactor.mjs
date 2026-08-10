const FAILURE_RE = /\[FAIL\]|\bFAILED\b|\bERROR\b|panic|traceback|exception|fatal/i;
const DIFF_RE = /(^diff --git|^@@ |^--- |^\+\+\+ )/m;
const WARNING_RE = /\bwarn(?:ing)?\b|\bdeprecated\b/i;
const SUMMARY_RE = /\b(pass(?:ed)?|success|ok|test suites?|tests? completed|coverage|added|removed|changed|up to date|audited|found|total|on branch|nothing to commit|ahead|behind)\b/i;

export function byteLength(text) { return Buffer.byteLength(text, "utf8"); }
export function redact(text) {
  return text
    .replace(/(api[_-]?key|secret|password|token)\s*[:=]\s*["']?[^"'\s;]+["']?/gi, (_m, key) => `${key}=[REDACTED]`)
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:ghp|gho|sk)-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

export function classifyCommand(command = "") {
  const lower = command.trim().toLowerCase().replace(/^env\s+(?:[\w.-]+=\S+\s+)*/, "").replace(/^(?:command|time)\s+/, "");
  if (/\bgit\s+diff\b/.test(lower)) return "diff";
  if (/\b(go\s+test|npm\s+(?:test|run\s+test)|pnpm\s+(?:test|run\s+test)|yarn\s+test|pytest|vitest|jest|cargo\s+test)\b/.test(lower)) return "test";
  if (/\b(npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|update|outdated|list|audit)\b/.test(lower)) return "package";
  if (/\bgit\s+(?:status|log|branch|ls-files)\b/.test(lower)) return "git";
  if (/\b(rg|grep|git\s+grep)\b/.test(lower)) return "search";
  if (/\b(ls|dir|find|tree)\b/.test(lower)) return "list";
  if (/\b(?:npm|pnpm|yarn)\s+(?:list|why)\b/.test(lower)) return "inventory";
  return "unknown";
}

export function shouldPreserveRaw(output, exitCode, rawBypass = false) {
  return rawBypass || exitCode !== 0 || FAILURE_RE.test(output) || DIFF_RE.test(output);
}

function clipUtf8(text, budget) {
  if (byteLength(text) <= budget) return text;
  const suffix = "…";
  let out = "";
  for (const char of text) {
    if (byteLength(out + char + suffix) > budget) break;
    out += char;
  }
  return out + suffix;
}

function unique(items) { return [...new Set(items.map((line) => line.trim()).filter(Boolean))]; }
function selectLines(lines, kind, caps) {
  const summary = lines.filter((line) => SUMMARY_RE.test(line)).slice(-20);
  const warnings = lines.filter((line) => WARNING_RE.test(line)).slice(0, caps.warnings);
  const ordinary = lines.filter((line) => !SUMMARY_RE.test(line) && !WARNING_RE.test(line));
  const dataCap = kind === "inventory" ? caps.inventory : caps.flatList;
  const selected = kind === "test" || kind === "package" || kind === "git"
    ? [...summary, ...warnings, ...ordinary.slice(0, dataCap)]
    : [...warnings, ...ordinary.slice(0, dataCap)];
  return unique(selected);
}

function fit(lines, header, maxOutputBytes, omitted) {
  const recovery = `… [${omitted} lines omitted; use output_raw: true for full output]`;
  const chosen = [header];
  for (const line of lines) {
    const candidate = `${chosen.join("\n")}\n${line}`;
    if (byteLength(candidate) + byteLength(`\n${recovery}`) <= maxOutputBytes) chosen.push(line);
    else break;
  }
  const omittedCount = Math.max(omitted - (chosen.length - 1), 0);
  const marker = `… [${omittedCount} lines omitted; use output_raw: true for full output]`;
  let output = chosen.join("\n");
  if (omittedCount > 0) output += `\n${marker}`;
  return clipUtf8(output, maxOutputBytes);
}

export function optimizeOutput({ command, output, exitCode = 0, config, rawBypass = false, cancelled = false, trusted = true }) {
  const redacted = redact(output);
  if (cancelled) return { output: redacted, transformed: false, reason: "cancelled", kind: "none" };
  if (!trusted) return { output: redacted, transformed: false, reason: "untrusted", kind: "none" };
  if (!config.enabled) return { output: redacted, transformed: false, reason: "disabled", kind: "none" };
  if (shouldPreserveRaw(output, exitCode, rawBypass)) return { output: redacted, transformed: false, reason: rawBypass ? "raw_bypass" : exitCode !== 0 ? "exit_nonzero" : "lossless_marker", kind: "none" };
  if (byteLength(output) < config.thresholdBytes) return { output: redacted, transformed: false, reason: "below_threshold", kind: "none" };
  const kind = classifyCommand(command);
  if (kind === "unknown") return { output: redacted, transformed: false, reason: "unsupported_command", kind };
  const lines = redacted.split(/\r?\n/).filter(Boolean);
  const selected = selectLines(lines, kind, config.caps);
  const header = `[output optimizer: ${kind}; ${lines.length} lines; use output_raw: true for full output]`;
  const compacted = fit(selected, header, config.maxOutputBytes, lines.length - selected.length);
  return { output: compacted, transformed: compacted !== redacted, reason: `compacted_${kind}`, kind };
}
