import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { GoalLoop } from '../../src/goal-loop.ts';
import { reportedCostSince } from '../../src/budget.ts';

export default function goalLoopExtension(pi: ExtensionAPI): void {
  const loop = new GoalLoop(); // default OFF; never auto-arms on load
  pi.on('session_start', () => loop.reset());
  pi.on('session_shutdown', () => loop.reset());
  pi.on('session_tree', () => loop.reset());
  pi.on('session_compact', () => loop.reset());
  pi.on('tool_result', event => loop.toolCompleted(event.isError));
  // Only an explicitly loaded caller-owned adapter should emit this event.
  // The in-process event bus is not an authentication or authorization boundary.
  pi.events.on('pi-sampler:goal-loop:work-state', (data: unknown) => { loop.receiveWorkState(data); });

  pi.registerCommand('goal-loop', {
    description: 'Opt in to a bounded in-process next-action loop; status, wait, pause or fresh explicit resume',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const input = args.trim();
      try {
        if (input.startsWith('start ') || input.startsWith('resume ')) {
          // Resume requires a freshly named operator-approved goal; never restore
          // a stale paused goal, cursor, work-state assertion or budget.
          const goalId = loop.arm(input.slice(input.indexOf(' ') + 1), Date.now(), ctx.sessionManager.getLeafId());
          pi.events.emit('pi-sampler:goal-loop:armed', { goalId });
        }
        else if (input === 'pause' || input === 'stop') loop.pause();
        else if (input === 'wait') loop.wait();
        else if (input !== 'status') throw new Error('Usage: /goal-loop start|resume <approved goal> | status | wait | pause | stop');
        if (ctx.hasUI) ctx.ui.notify(`Goal loop: ${JSON.stringify(loop.status())}`, 'info');
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : 'Invalid goal loop command', 'error');
      }
    },
  });

  pi.on('agent_before_settle', (event, ctx) => {
    // canContinue describes the context BEFORE the appended continuation message.
    // It is normally false after an ordinary answer. Pi validates the proposed
    // custom_message against the final context before making the next call.
    const reportedCostUSD = reportedCostSince(ctx.sessionManager.getBranch(), loop.costCursor);
    const result = loop.decide({ outcome: event.outcome, alreadyContinuing: event.continue, pendingMessages: event.context.pendingMessages.length > 0, reportedCostUSD });
    if (!result.continue) return;
    return { continue: true, entries: [{
      type: 'custom_message', customType: 'pi-sampler-goal-loop', display: true,
      content: `Goal-loop continuation ${result.count} for operator-approved goal: ${result.goal}. ${result.nextAction ? `Caller snapshot next action: ${result.nextAction}. ` : ''}Take ONE next safe authorized action, or stop and report all approved workstreams blocked, an operator gate, native async wait, or uncertainty. This message grants no authority for consequential actions (including purchases, trades, deployment, deletion, credential transfer, merges or installation). Do not model-poll a child.`,
    }] };
  });
}
