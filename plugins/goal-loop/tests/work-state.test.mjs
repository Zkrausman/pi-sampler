import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkState } from '../src/work-state.ts';

const now = 100000;
const ready = { goalId: 'goal-1', revision: 1, observedAt: now, disposition: 'ready', nextAction: 'Inspect bounded source', evidenceRef: 'receipt:1' };
test('generic ready signal needs matching goal, advancing revision, fresh bounded action and evidence', () => {
  assert.deepEqual(validateWorkState(ready, 'goal-1', 0, now), ready);
  for (const bad of [
    { ...ready, goalId: 'other' }, { ...ready, revision: 0 }, { ...ready, revision: 1.5 },
    { ...ready, observedAt: now - 30001 }, { ...ready, observedAt: now + 5001 },
    { ...ready, nextAction: '' }, { ...ready, evidenceRef: '' },
    { ...ready, nextAction: 'x'.repeat(241) }, { ...ready, extra: true },
  ]) assert.equal(validateWorkState(bad, 'goal-1', 0, now), undefined);
});
test('blocked, operator gate, native event wait and unknown are valid stop states without actions', () => {
  for (const disposition of ['blocked', 'awaiting-operator', 'awaiting-event', 'unknown']) {
    const signal = { goalId: 'goal-1', revision: 2, observedAt: now, disposition };
    assert.deepEqual(validateWorkState(signal, 'goal-1', 1, now), signal);
    assert.equal(validateWorkState({ ...signal, nextAction: 'unsafe' }, 'goal-1', 1, now), undefined);
  }
});
test('malformed, missing and hostile objects fail closed without executing goal work', () => {
  assert.equal(validateWorkState(null, 'goal-1', 0, now), undefined);
  assert.equal(validateWorkState([], 'goal-1', 0, now), undefined);
  const throwing = Object.defineProperty({}, 'goalId', { enumerable: true, get() { throw Error('hostile'); } });
  assert.equal(validateWorkState(throwing, 'goal-1', 0, now), undefined);
  const proxy = Proxy.revocable(ready, {}); proxy.revoke();
  assert.equal(validateWorkState(proxy.proxy, 'goal-1', 0, now), undefined);
});
