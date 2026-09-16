import assert from "node:assert/strict";
import test from "node:test";
import { configFromFlags } from "../src/config.ts";
import { TokenGuard } from "../src/guard.ts";
import tokenGuardExtension from "../extensions/token-guard/index.ts";

test("defaults are disabled and warn at six", () => {
  assert.deepEqual(configFromFlags(() => undefined), { enabled: false, warnAfter: 6, stopAfter: undefined });
});

test("flags validate and stopping cannot be below warning", () => {
  assert.deepEqual(configFromFlags((name) => ({ "token-guard": true, "token-guard-warn-after": "3" }[name])), { enabled: true, warnAfter: 3, stopAfter: undefined });
  assert.throws(() => configFromFlags((name) => name === "token-guard-warn-after" ? "1" : undefined), /minimum 2/);
  assert.throws(() => configFromFlags((name) => name === "token-guard-stop-after" ? "2" : name === "token-guard-warn-after" ? "3" : undefined), /minimum 3/);
  assert.throws(() => configFromFlags((name) => name === "token-guard-warn-after" ? "nope" : undefined), /positive integer/);
});

function repeated(config = { enabled: true, warnAfter: 3 }) {
  const guard = new TokenGuard(config);
  const decisions = [];
  for (let i = 0; i < 4; i++) { guard.start(String(i), "read", { path: "same" }); decisions.push(guard.complete(String(i), { content: [{ type: "text", text: "same" }] })); }
  return { guard, decisions };
}

test("warns once per suspicion episode and resets on changed evidence", () => {
  const { guard, decisions } = repeated();
  assert.equal(decisions[0].warn, false);
  assert.equal(decisions[2].warn, true);
  assert.equal(decisions[3].warn, false);
  guard.start("changed", "read", { path: "different" });
  assert.equal(guard.complete("changed", { content: [{ type: "text", text: "same" }] }).suspected, false);
});

test("requires completed call/result pairs and bounds pending calls", () => {
  const guard = new TokenGuard({ enabled: true, warnAfter: 2 });
  for (let i = 0; i < 200; i++) guard.start(String(i), "read", { path: String(i) });
  assert.equal(guard.complete("0", { ok: true }).suspected, false);
  guard.start("a", "read", { path: "x" });
  assert.equal(guard.complete("a", { value: 1 }).suspected, false);
});

test("unknown, oversized, cyclic and image evidence fail open and reset", () => {
  const guard = new TokenGuard({ enabled: true, warnAfter: 2 });
  const cycle = {}; cycle.self = cycle;
  for (const [id, result] of [["cycle", cycle], ["oversized", { text: "x".repeat(20000) }], ["image", { type: "image", data: "x".repeat(20000) }], ["unknown", undefined]]) {
    guard.start(id, "read", { path: "x" });
    assert.equal(guard.complete(id, result).suspected, false);
  }
  guard.start("1", "read", { path: "x" }); guard.complete("1", { ok: true });
  guard.start("2", "read", { path: "x" }); assert.equal(guard.complete("2", { ok: true }).suspected, true);
});

test("optional stop is only a response to repeated suspicion", () => {
  const { decisions } = repeated({ enabled: true, warnAfter: 2, stopAfter: 3 });
  assert.equal(decisions[1].stop, false);
  assert.equal(decisions[2].stop, true);
});

test("reset clears episode and session state is in memory only", () => {
  const guard = new TokenGuard({ enabled: true, warnAfter: 2 });
  guard.start("1", "bash", { command: "echo hi" }); guard.complete("1", "ok");
  guard.reset();
  guard.start("2", "bash", { command: "echo hi" }); assert.equal(guard.complete("2", "ok").suspected, false);
});

test("throwing getters and revoked proxies fail open and reset", () => {
  const guard = new TokenGuard({ enabled: true, warnAfter: 2 });
  const throwing = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("no access"); } });
  guard.start("getter", "read", throwing);
  assert.equal(guard.complete("getter", { ok: true }).reason, "unsupported-or-oversized-evidence");
  const revocable = Proxy.revocable({ value: 1 }, {}); revocable.revoke();
  guard.start("proxy", "read", revocable.proxy);
  assert.equal(guard.complete("proxy", { ok: true }).reason, "unsupported-or-oversized-evidence");
  guard.start("valid-1", "read", { path: "x" }); guard.complete("valid-1", { ok: true });
  guard.start("valid-2", "read", { path: "x" }); assert.equal(guard.complete("valid-2", { ok: true }).suspected, true);
});

test("extension lifecycle resets state and remains safe without UI", () => {
  const handlers = new Map();
  const pi = {
    registerFlag() {}, getFlag(name) { return name === "token-guard" ? true : name === "token-guard-warn-after" ? "2" : undefined; },
    on(name, handler) { handlers.set(name, handler); }
  };
  tokenGuardExtension(pi);
  const start = handlers.get("tool_execution_start");
  const end = handlers.get("tool_execution_end");
  const lifecycle = handlers.get("agent_start");
  const sessionStart = handlers.get("session_start");
  const sessionShutdown = handlers.get("session_shutdown");
  let aborts = 0;
  const ctx = { hasUI: false, abort() { aborts++; } };
  sessionStart();
  start({ toolCallId: "wait", toolName: "read", args: { path: "x" } });
  // A long pending wait does not count until its matching completion.
  for (let i = 0; i < 120; i++) {
    start({ toolCallId: `productive-${i}`, toolName: "read", args: { path: `item-${i}` } });
    end({ toolCallId: `productive-${i}`, result: { ok: true, item: i } }, ctx);
  }
  lifecycle();
  start({ toolCallId: "after-reset-1", toolName: "read", args: { path: "x" } });
  end({ toolCallId: "after-reset-1", result: { ok: true } }, ctx);
  start({ toolCallId: "after-reset-2", toolName: "read", args: { path: "x" } });
  end({ toolCallId: "after-reset-2", result: { ok: true } }, ctx);
  sessionShutdown();
  assert.equal(aborts, 0);
});


test("adapter resets warning episodes on every lifecycle boundary", () => {
  const handlers = new Map();
  tokenGuardExtension({ registerFlag() {}, getFlag: name => name === "token-guard" ? true : name === "token-guard-warn-after" ? "2" : undefined, on: (name, handler) => handlers.set(name, handler) });
  let warnings = 0;
  const ctx = { hasUI: true, ui: { notify() { warnings++; } }, abort() { assert.fail("default must not abort"); } };
  let id = 0;
  function pair(context = ctx) {
    const toolCallId = String(id++);
    handlers.get("tool_execution_start")({ toolCallId, toolName: "read", args: { path: "same" } });
    handlers.get("tool_execution_end")({ toolCallId, result: { ok: true } }, context);
  }
  for (const boundary of ["agent_start", "session_start", "session_shutdown"]) {
    pair(); pair();
    const before = warnings;
    handlers.get(boundary)();
    pair(); assert.equal(warnings, before, `${boundary}: first completion must not warn`);
    pair(); assert.equal(warnings, before + 1, `${boundary}: second completion must warn`);
    pair(); assert.equal(warnings, before + 1, "warning latched");
  }
  handlers.get("agent_start")();
  let uiAccesses = 0;
  const headless = { hasUI: false, get ui() { uiAccesses++; throw new Error("UI unavailable"); }, abort() { assert.fail("headless warning must not abort"); } };
  for (let i = 0; i < 10; i++) pair(headless);
  assert.equal(uiAccesses, 0);
});
