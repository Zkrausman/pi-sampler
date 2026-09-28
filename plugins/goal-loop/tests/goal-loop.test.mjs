import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalLoop } from '../src/goal-loop.ts';
import { reportedCostSince } from '../src/budget.ts';
import extension from '../extensions/goal-loop/index.ts';

const boundary = { outcome: 'completed', reportedCostUSD: 0.01 };
const ready = (loop, revision = 1, observedAt = 1200) => ({
  goalId: loop.status().goalId, revision, observedAt, disposition: 'ready',
  nextAction: 'Read one bounded file', evidenceRef: `receipt:${revision}`,
});
test('default off, one operator step then fresh caller work state AND successful tool evidence', () => {
  const loop = new GoalLoop(2, 5000);
  assert.equal(loop.decide(boundary).continue, false);
  loop.arm('safe repository test', 1000);
  assert.equal(loop.decide(boundary, 1100).continue, true);
  assert.equal(loop.decide(boundary, 1200).reason, 'work-state-unknown');
  loop.arm('safe repository test', 1000);
  loop.decide(boundary, 1100); loop.toolCompleted(true);
  assert.equal(loop.receiveWorkState(ready(loop), 1200), true);
  assert.equal(loop.decide(boundary, 1200).reason, 'no-new-tool-evidence');
  loop.arm('safe repository test', 1000);
  loop.decide(boundary, 1100); loop.toolCompleted(false);
  assert.equal(loop.receiveWorkState(ready(loop), 1200), true);
  assert.equal(loop.decide(boundary, 1200).nextAction, 'Read one bounded file');
  loop.toolCompleted(false);
  assert.equal(loop.decide(boundary, 1300).reason, 'model-turn-budget-exhausted');
});
test('work-state blocked, operator gate, event wait, duplicate and stale updates stop closed', () => {
  for (const disposition of ['blocked', 'awaiting-operator', 'awaiting-event', 'unknown']) {
    const loop = new GoalLoop(); loop.arm('safe', 1000);
    assert.equal(loop.receiveWorkState({ goalId: loop.status().goalId, revision: 1, observedAt: 1100, disposition }, 1100), true);
    assert.equal(loop.status().active, false);
    assert.equal(loop.status().audit.at(-1), `work-${disposition}`);
  }
  const duplicate = new GoalLoop(); duplicate.arm('safe', 1000);
  assert.equal(duplicate.receiveWorkState(ready(duplicate), 1200), true);
  assert.equal(duplicate.receiveWorkState(ready(duplicate), 1200), false);
  assert.equal(duplicate.status().active, false);
  const premature = new GoalLoop(2, 5000); premature.arm('safe', 1000);
  assert.equal(premature.receiveWorkState(ready(premature), 1100), true);
  premature.decide(boundary, 1100); premature.toolCompleted(false);
  assert.equal(premature.decide(boundary, 1200).reason, 'work-state-unknown');
  const rearmed = new GoalLoop(2, 5000); rearmed.arm('safe', 1000);
  const oldSnapshot = ready(rearmed);
  rearmed.arm('fresh', 1100);
  assert.equal(rearmed.receiveWorkState(oldSnapshot, 1200), false);
  assert.equal(rearmed.status().active, false);
  const changed = new GoalLoop(2, 60000); changed.arm('safe', 1000); changed.decide(boundary, 1100); changed.toolCompleted(false);
  const snapshot = ready(changed); changed.receiveWorkState(snapshot, 1200); snapshot.nextAction = 'Changed after validation';
  assert.equal(changed.decide(boundary, 1200).nextAction, 'Read one bounded file');
  const stale = new GoalLoop(2, 60000); stale.arm('safe', 1000); stale.decide(boundary, 1100); stale.toolCompleted(false);
  assert.equal(stale.receiveWorkState(ready(stale), 1200), true);
  assert.equal(stale.decide(boundary, 32001).reason, 'work-state-unknown');
});
test('ready snapshots must follow the latest tool result, including failed tools', () => {
  const early = new GoalLoop(3, 5000); early.arm('safe', 1000); early.decide(boundary, 1100);
  assert.equal(early.receiveWorkState(ready(early), 1200), true);
  early.toolCompleted(false);
  assert.equal(early.decide(boundary, 1300).reason, 'work-state-unknown');

  const failed = new GoalLoop(3, 5000); failed.arm('safe', 1000); failed.decide(boundary, 1100);
  failed.toolCompleted(false);
  assert.equal(failed.receiveWorkState(ready(failed), 1200), true);
  failed.toolCompleted(true); // a failed tool may still have changed external state
  assert.equal(failed.decide(boundary, 1300).reason, 'work-state-unknown');

  const fresh = new GoalLoop(3, 5000); fresh.arm('safe', 1000); fresh.decide(boundary, 1100);
  assert.equal(fresh.receiveWorkState(ready(fresh), 1200), true);
  fresh.toolCompleted(false); // invalidates the earlier snapshot
  assert.equal(fresh.receiveWorkState(ready(fresh, 2, 1300), 1300), true);
  assert.equal(fresh.decide(boundary, 1400).nextAction, 'Read one bounded file');
});
test('error, abort, native pending, wait, pause and deadline stop closed', () => {
  for (const [setup, value, reason] of [
    [() => {}, { outcome: 'error' }, 'run-error'],
    [() => {}, { outcome: 'aborted' }, 'run-aborted'],
    [() => {}, { ...boundary, pendingMessages: true }, 'native-continuation-pending'],
    [() => {}, { ...boundary, alreadyContinuing: true }, 'native-continuation-pending'],
    [() => {}, { outcome: 'completed' }, 'cost-unknown'],
    [() => {}, { ...boundary, reportedCostUSD: 0.25 }, 'reported-cost-budget-exhausted'],
    [(l) => l.wait(), boundary, 'await-native-completion'],
    [(l) => l.pause(), boundary, 'not-armed'],
  ]) {
    const loop = new GoalLoop(); loop.arm('approved', 1000); setup(loop);
    assert.equal(loop.decide(value, 1200).reason, reason);
    assert.equal(loop.status().active, false);
  }
  const loop = new GoalLoop(3, 1000); loop.arm('approved', 1000);
  assert.equal(loop.decide(boundary, 2000).reason, 'time-budget-exhausted');
  assert.throws(() => new GoalLoop(6));
  assert.throws(() => loop.arm(' '.repeat(241)));
});
test('extension never auto-arms, injects one bounded continuation and resets across sessions', async () => {
  const handlers = new Map(), commands = new Map(), bus = new Map();
  let goalId;
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => commands.set(name, value),
    events: { on: (name, handler) => bus.set(name, handler), emit: (name, data) => { if (name === 'pi-sampler:goal-loop:armed') goalId = data.goalId; } },
  });
  const ctx = { hasUI: false, sessionManager: {
    getLeafId: () => null,
    getBranch: () => [{ id: 'reply', type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.01 } } } }],
  } };
  const event = { outcome: 'completed', continue: false, context: { canContinue: false, pendingMessages: [] } };
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  const next = handlers.get('agent_before_settle')(event, ctx);
  assert.equal(next.continue, true);
  assert.match(next.entries[0].content, /no authority for consequential actions/i);
  assert.doesNotMatch(next.entries[0].content, /Squire|Gelt|both lanes/i);
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  handlers.get('agent_before_settle')(event, ctx);
  handlers.get('tool_result')({ isError: false });
  bus.get('pi-sampler:goal-loop:work-state')({ goalId, revision: 1, observedAt: Date.now(), disposition: 'ready', nextAction: 'Inspect one file', evidenceRef: 'receipt:1' });
  assert.match(handlers.get('agent_before_settle')(event, ctx).entries[0].content, /Inspect one file/);
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  handlers.get('session_start')();
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  assert.equal(handlers.get('agent_before_settle')({ ...event, continue: true }, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  await commands.get('goal-loop').handler('wait', ctx);
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  const oldGoalId = goalId;
  await commands.get('goal-loop').handler('resume fresh approved tests', ctx);
  assert.notEqual(goalId, oldGoalId);
  assert.equal(handlers.get('agent_before_settle')(event, ctx).continue, true);
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  handlers.get('session_tree')();
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  handlers.get('session_compact')();
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  handlers.get('session_shutdown')();
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
});
test('provider-reported cost uses active branch after arm and rejects unknown or changed branches', () => {
  const usd = value => ({ cost: { total: value } });
  const branch = [
    { id: 'arm', type: 'custom' },
    { id: 'answer', type: 'message', message: { role: 'assistant', usage: usd(0.02) } },
    { id: 'extra', type: 'usage', usage: usd(0.03) },
    { id: 'tool', type: 'message', message: { role: 'toolResult', usage: usd(0.01) } },
  ];
  assert.ok(Math.abs(reportedCostSince(branch, 'arm') - 0.06) < 1e-9);
  assert.equal(reportedCostSince(branch, 'missing'), undefined);
  assert.equal(reportedCostSince([{ id: 'answer', type: 'message', message: { role: 'assistant' } }], null), undefined);
  assert.equal(reportedCostSince([{ id: 'answer', type: 'message', message: { role: 'assistant', usage: usd(-1) } }], null), undefined);
});
