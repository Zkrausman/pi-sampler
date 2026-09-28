# Workstream-state boundary (AIDEV-343 partial candidate; caller adapter absent)

The goal loop is a generic **Pi productivity mechanism**, not a Squire/Gelt controller or a security boundary. A successful tool response or a model statement cannot prove another safe action exists. The current uninstalled prototype's tool-result heuristic therefore must not be promoted as workstream verification.

## Proposed opt-in adapter contract

An independently loaded, operator-trusted caller adapter may publish a small typed snapshot at the final `agent_before_settle` decision point:

```ts
type WorkState = {
  goalId: string;            // active session goal, never a ticket ID
  revision: number;          // strictly increasing for this goal
  observedAt: number;        // bounded freshness in the same process
  disposition: 'ready' | 'blocked' | 'awaiting-operator' | 'awaiting-event' | 'unknown';
  nextAction?: string;       // short and bounded; only for ready
  evidenceRef?: string;      // stable reference to caller-owned state
};
```

No Squire/Gelt paths, APIs, issue identifiers or lane rules belong in `plugins/goal-loop`. A caller decides *whether* work remains authorized and supplies evidence; the generic core only validates shape, freshness, revision, active goal identity and finite budgets. Unknown/missing/stale state, a claimed ready state without a bounded action and evidence, owner gate or native event wait all stop closed. A published state is **advice**, never authority to trade, deploy, merge, install, transfer credentials, bypass review or start a second writer. Same-process extensions share OS permissions: event data cannot be treated as cryptographically trusted if untrusted extensions or tools run in that process.

The initial demonstration permits at most one operator-armed response-only continuation without an adapter, then stops. `src/work-state.ts` validates bounded snapshots and the extension listens for `pi-sampler:goal-loop:work-state`; `/goal-loop start` emits `pi-sampler:goal-loop:armed` with `{ goalId }`. A separate **operator-selected** caller extension may emit a WorkState for that active goal; a post-first continuation requires a new successful tool-result event *followed by* a fresh `ready` snapshot. Any later tool result, including a failure, invalidates the snapshot; the caller must re-observe state after that result. A blocked/operator/event/unknown snapshot pauses. Nothing is bundled that can attest to actual workstream state. In-process event messages are not authenticated: untrusted extensions in the same Pi process can spoof them; isolate the trusted caller adapter and do not grant the loop consequential permissions. Do not poll the model for async completions. The adapter is a separate integration and must be tested with missed/stale/duplicate/out-of-order events, session switch/reload and blocked status before activation. The Pi process exiting still terminates the goal loop; a durable controller is out of scope.
