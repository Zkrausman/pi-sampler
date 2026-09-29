import { randomUUID } from 'node:crypto';
import { validateWorkState, type WorkState } from './work-state.ts';

export type Boundary = { outcome: 'completed' | 'aborted' | 'error'; alreadyContinuing?: boolean; pendingMessages?: boolean; reportedCostUSD?: number };
export type Decision = { continue: boolean; reason: string; goal?: string; nextAction?: string; count: number };

// In-memory, opt-in and intentionally short-lived. This is not an authority or a scheduler.
export class GoalLoop {
  private goal: string | undefined;
  private goalId: string | undefined;
  private revision = 0;
  private pendingState: WorkState | undefined;
  private latestToolResultAt = -Infinity;
  private count = 0;
  private completedTools = 0;
  private seenTools = 0;
  private deadline = 0;
  private waiting = false;
  private callerRequired = false;
  private cursor: string | null = null;
  private readonly audit: string[] = [];
  private readonly maxContinuations: number;
  private readonly maxMilliseconds: number;
  private readonly maxReportedCostUSD: number;

  constructor(maxContinuations = 3, maxMilliseconds = 15 * 60_000, maxReportedCostUSD = 0.25) {
    if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > 5 ||
        !Number.isSafeInteger(maxMilliseconds) || maxMilliseconds < 1000 || maxMilliseconds > 60 * 60_000 ||
        !Number.isFinite(maxReportedCostUSD) || maxReportedCostUSD <= 0 || maxReportedCostUSD > 1) {
      throw new Error('Goal-loop bounds must be finite and small');
    }
    this.maxContinuations = maxContinuations;
    this.maxMilliseconds = maxMilliseconds;
    this.maxReportedCostUSD = maxReportedCostUSD;
  }
  get costCursor(): string | null { return this.cursor; }
  arm(goal: string, now = Date.now(), cursor: string | null = null, callerRequired = false): string {
    const text = goal.trim();
    if (!text || text.length > 240) throw new Error('Goal must be 1–240 characters');
    if (typeof callerRequired !== 'boolean') throw new Error('Invalid caller requirement');
    this.reset(); this.goal = text; this.goalId = randomUUID(); this.deadline = now + this.maxMilliseconds; this.cursor = cursor; this.callerRequired = callerRequired; this.log('armed');
    return this.goalId;
  }
  reset(): void { this.goal = undefined; this.goalId = undefined; this.revision = 0; this.pendingState = undefined; this.latestToolResultAt = -Infinity; this.count = 0; this.completedTools = 0; this.seenTools = 0; this.deadline = 0; this.waiting = false; this.callerRequired = false; this.cursor = null; this.audit.length = 0; }
  pause(reason = 'operator-paused'): void { this.goal = undefined; this.goalId = undefined; this.pendingState = undefined; this.log(reason); }
  receiveWorkState(input: unknown, now = Date.now()): boolean {
    if (!this.goalId) return false;
    const state = validateWorkState(input, this.goalId, this.revision, now);
    if (!state || (state.disposition === 'ready' && state.observedAt <= this.latestToolResultAt)) {
      this.pause('invalid-work-state'); return false;
    }
    this.revision = state.revision;
    if (state.disposition !== 'ready') { this.pause(`work-${state.disposition}`); return true; }
    this.pendingState = state;
    this.log(`work-ready-${state.revision}`);
    return true;
  }
  wait(): void { this.waiting = true; this.log('await-native-completion'); }
  toolCompleted(isError: boolean, now = Date.now()): void {
    if (!this.goalId) return;
    // Delivery order is not observation order: a delayed ready event observed
    // before a tool result must not authorize the next continuation.
    if (!Number.isSafeInteger(now)) { this.pause('invalid-tool-time'); return; }
    this.latestToolResultAt = Math.max(this.latestToolResultAt, now);
    if (this.count > 0 || this.callerRequired) this.pendingState = undefined;
    if (!isError) this.completedTools++;
  }
  status(): { active: boolean; waiting: boolean; count: number; goal?: string; goalId?: string; audit: string[] } {
    return { active: !!this.goal, waiting: this.waiting, count: this.count, goal: this.goal, goalId: this.goalId, audit: [...this.audit] };
  }
  decide(boundary: Boundary, now = Date.now()): Decision {
    const stop = (reason: string): Decision => { this.pause(reason); return { continue: false, reason, count: this.count }; };
    if (!this.goal) return { continue: false, reason: 'not-armed', count: this.count };
    if (boundary.outcome !== 'completed') return stop(`run-${boundary.outcome}`);
    if (boundary.alreadyContinuing || boundary.pendingMessages) return stop('native-continuation-pending');
    if (this.waiting) return stop('await-native-completion');
    if (now >= this.deadline) return stop('time-budget-exhausted');
    if (this.count >= this.maxContinuations) return stop('model-turn-budget-exhausted');
    if (typeof boundary.reportedCostUSD !== 'number' || !Number.isFinite(boundary.reportedCostUSD) || boundary.reportedCostUSD < 0) return stop('cost-unknown');
    if (boundary.reportedCostUSD >= this.maxReportedCostUSD) return stop('reported-cost-budget-exhausted');
    // The first continuation follows the operator's explicit arm. Each later
    // one needs a fresh caller snapshot AND new tool evidence; neither alone
    // establishes authority. A pre-first snapshot cannot authorize step two.
    const needsSnapshot = this.count > 0 || this.callerRequired;
    const next = needsSnapshot ? this.pendingState : undefined;
    if (needsSnapshot && (!next || !validateWorkState(next, this.goalId!, next.revision - 1, now))) return stop('work-state-unknown');
    if (this.count > 0 && this.completedTools === this.seenTools) return stop('no-new-tool-evidence');
    this.pendingState = undefined;
    this.seenTools = this.completedTools;
    this.count++;
    this.log(`continue-${this.count}`);
    return { continue: true, reason: 'bounded-next-action', goal: this.goal, nextAction: next?.nextAction, count: this.count };
  }
  private log(reason: string): void { this.audit.push(reason); if (this.audit.length > 12) this.audit.shift(); }
}
