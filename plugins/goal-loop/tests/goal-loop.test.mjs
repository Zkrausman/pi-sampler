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
  loop.decide(boundary, 1100); loop.toolCompleted(true, 1150);
  assert.equal(loop.receiveWorkState(ready(loop), 1200), true);
  assert.equal(loop.decide(boundary, 1200).reason, 'no-new-tool-evidence');
  loop.arm('safe repository test', 1000);
  loop.decide(boundary, 1100); loop.toolCompleted(false, 1150);
  assert.equal(loop.receiveWorkState(ready(loop), 1200), true);
  assert.equal(loop.decide(boundary, 1200).nextAction, 'Read one bounded file');
  loop.toolCompleted(false, 1250);
  assert.equal(loop.decide(boundary, 1300).reason, 'model-turn-budget-exhausted');
});
test('broad caller-required goal never takes the unconditional first step', () => {
  const absent = new GoalLoop(3, 5000);
  absent.arm('finish approved hot-path tickets', 1000, null, true);
  assert.equal(absent.decide(boundary, 1100).reason, 'work-state-unknown');
  const attested = new GoalLoop(3, 5000);
  attested.arm('finish approved hot-path tickets', 1000, null, true);
  assert.equal(attested.receiveWorkState(ready(attested, 1, 1100), 1100), true);
  assert.equal(attested.decide(boundary, 1100).nextAction, 'Read one bounded file');
  attested.toolCompleted(false, 1150);
  assert.equal(attested.decide(boundary, 1200).reason, 'work-state-unknown');
  const premature = new GoalLoop(3, 5000);
  premature.arm('finish approved hot-path tickets', 1000, null, true);
  premature.receiveWorkState(ready(premature, 1, 1100), 1100);
  premature.toolCompleted(false, 1150);
  assert.equal(premature.decide(boundary, 1200).reason, 'work-state-unknown');
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
  premature.decide(boundary, 1100); premature.toolCompleted(false, 1150);
  assert.equal(premature.decide(boundary, 1200).reason, 'work-state-unknown');
  const rearmed = new GoalLoop(2, 5000); rearmed.arm('safe', 1000);
  const oldSnapshot = ready(rearmed);
  rearmed.arm('fresh', 1100);
  assert.equal(rearmed.receiveWorkState(oldSnapshot, 1200), false);
  assert.equal(rearmed.status().active, false);
  const changed = new GoalLoop(2, 60000); changed.arm('safe', 1000); changed.decide(boundary, 1100); changed.toolCompleted(false, 1150);
  const snapshot = ready(changed); changed.receiveWorkState(snapshot, 1200); snapshot.nextAction = 'Changed after validation';
  assert.equal(changed.decide(boundary, 1200).nextAction, 'Read one bounded file');
  const stale = new GoalLoop(2, 60000); stale.arm('safe', 1000); stale.decide(boundary, 1100); stale.toolCompleted(false, 1150);
  assert.equal(stale.receiveWorkState(ready(stale), 1200), true);
  assert.equal(stale.decide(boundary, 32001).reason, 'work-state-unknown');
});
test('ready snapshots must follow the latest tool result, including failed tools', () => {
  const early = new GoalLoop(3, 5000); early.arm('safe', 1000); early.decide(boundary, 1100);
  assert.equal(early.receiveWorkState(ready(early), 1200), true);
  early.toolCompleted(false, 1250);
  assert.equal(early.decide(boundary, 1300).reason, 'work-state-unknown');

  const failed = new GoalLoop(3, 5000); failed.arm('safe', 1000); failed.decide(boundary, 1100);
  failed.toolCompleted(false, 1150);
  assert.equal(failed.receiveWorkState(ready(failed), 1200), true);
  failed.toolCompleted(true, 1250); // a failed tool may still have changed external state
  assert.equal(failed.decide(boundary, 1300).reason, 'work-state-unknown');

  const fresh = new GoalLoop(3, 5000); fresh.arm('safe', 1000); fresh.decide(boundary, 1100);
  assert.equal(fresh.receiveWorkState(ready(fresh), 1200), true);
  fresh.toolCompleted(false, 1250); // invalidates the earlier snapshot
  assert.equal(fresh.receiveWorkState(ready(fresh, 2, 1300), 1300), true);
  assert.equal(fresh.decide(boundary, 1400).nextAction, 'Read one bounded file');

  for (const error of [false, true]) {
    const delayed = new GoalLoop(3, 5000); delayed.arm('safe', 1000, null, true);
    delayed.toolCompleted(error, 1200);
    assert.equal(delayed.receiveWorkState(ready(delayed, 1, 1100), 1250), false);
    assert.equal(delayed.status().active, false);
    const equalTime = new GoalLoop(3, 5000); equalTime.arm('safe', 1000, null, true);
    equalTime.toolCompleted(error, 1200);
    assert.equal(equalTime.receiveWorkState(ready(equalTime, 1, 1200), 1250), false);
    const after = new GoalLoop(3, 5000); after.arm('safe', 1000, null, true);
    after.toolCompleted(error, 1200);
    assert.equal(after.receiveWorkState(ready(after, 1, 1201), 1250), true);
    assert.equal(after.decide(boundary, 1300).continue, true);
  }
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
  let goalId, armedGoal;
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => commands.set(name, value),
    events: { on: (name, handler) => bus.set(name, handler), emit: (name, data) => { if (name === 'pi-sampler:goal-loop:armed') { goalId = data.goalId; armedGoal = data.goal; } } },
  });
  const branch = [{ id: 'reply', type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.01 } } } }];
  const ctx = { hasUI: false, sessionManager: {
    getLeafId: () => null,
    getBranch: () => branch,
  } };
  const event = { outcome: 'completed', continue: false, context: { canContinue: false, pendingMessages: [] } };
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start safe tests', ctx);
  const next = handlers.get('agent_before_settle')(event, ctx);
  assert.equal(next.continue, true);
  assert.match(next.entries[0].content, /no authority for consequential actions/i);
  assert.doesNotMatch(next.entries[0].content, /Squire|Gelt|both lanes/i);
  // Pi commits the continuation draft into getBranch(); a second step must
  // count only provider usage, not treat our zero-cost message as unknown cost.
  branch.push({ id: 'injected-1', ...next.entries[0] });
  branch.push({ id: 'answer-2', type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.02 } } } });
  handlers.get('tool_result')({ isError: false });
  await new Promise(resolve => setTimeout(resolve, 2)); // distinct millisecond observation
  bus.get('pi-sampler:goal-loop:work-state')({ goalId, revision: 1, observedAt: Date.now(), disposition: 'ready', nextAction: 'Inspect one file', evidenceRef: 'receipt:1' });
  const second = handlers.get('agent_before_settle')(event, ctx);
  assert.equal(second.continue, true);
  assert.match(second.entries[0].content, /Inspect one file/);
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start --caller-required finish approved hot path', ctx);
  assert.equal(armedGoal, 'finish approved hot path');
  assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined);
  await commands.get('goal-loop').handler('start --caller-required finish approved hot path', ctx);
  branch.push({ id: 'answer-strict', type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.01 } } } });
  bus.get('pi-sampler:goal-loop:work-state')({ goalId, revision: 1, observedAt: Date.now(), disposition: 'ready', nextAction: 'Inspect one receipt', evidenceRef: 'receipt:strict' });
  const strict = handlers.get('agent_before_settle')(event, ctx);
  assert.equal(strict.continue, true);
  assert.match(strict.entries[0].content, /Inspect one receipt/);
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
test('caller-required command parsing fails closed across whitespace and malformed options', async () => {
  const handlers = new Map(), commands = new Map(), bus = new Map();
  let goalId;
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => commands.set(name, value),
    events: { on: (name, handler) => bus.set(name, handler), emit: (name, data) => { if (name === 'pi-sampler:goal-loop:armed') goalId = data.goalId; } },
  });
  const ctx = { hasUI: false, sessionManager: { getLeafId: () => null,
    getBranch: () => [{ id: 'answer', type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.01 } } } }] } };
  const event = { outcome: 'completed', continue: false, context: { pendingMessages: [] } };
  for (const input of ['start  --caller-required finish approved hot path', 'resume --caller-required\tfinish approved hot path', 'start\t--caller-required finish approved hot path']) {
    await commands.get('goal-loop').handler(input, ctx);
    assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined, input);
  }
  for (const input of ['start --caller-required', 'start --caller-required=off finish', 'start finish --caller-required', 'start --caller-required --caller-required finish']) {
    const prior = goalId;
    await commands.get('goal-loop').handler(input, ctx);
    assert.equal(goalId, prior, input);
    assert.equal(handlers.get('agent_before_settle')(event, ctx), undefined, input);
  }
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
  assert.ok(Math.abs(reportedCostSince([...branch, { id: 'injected', type: 'custom_message', customType: 'pi-sampler-goal-loop' }], 'arm') - 0.06) < 1e-9);
  assert.equal(reportedCostSince([...branch, { id: 'unrelated', type: 'custom_message', customType: 'unknown' }], 'arm'), undefined);
  assert.equal(reportedCostSince([...branch, { id: 'unknown', type: 'custom' }], 'arm'), undefined);
  assert.equal(reportedCostSince(branch, 'missing'), undefined);
  assert.equal(reportedCostSince([{ id: 'answer', type: 'message', message: { role: 'assistant' } }], null), undefined);
  assert.equal(reportedCostSince([{ id: 'answer', type: 'message', message: { role: 'assistant', usage: usd(-1) } }], null), undefined);
});
