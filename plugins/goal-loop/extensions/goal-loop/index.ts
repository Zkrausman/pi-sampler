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
        const words = input.split(/\s+/);
        if ((words[0] === 'start' || words[0] === 'resume') && words.length > 1) {
          // Parse tokens before arming. Never silently downgrade a malformed or
          // misplaced caller-required flag to the unconditional first-step mode.
          const goalWords = words.slice(1);
          const callerRequired = goalWords[0] === '--caller-required';
          if (goalWords.some((word, index) => word.startsWith('--caller-required') && (!callerRequired || index !== 0)) ||
              (callerRequired && goalWords.length < 2)) throw new Error('Invalid caller-required goal');
          const goal = goalWords.slice(callerRequired ? 1 : 0).join(' ');
          const goalId = loop.arm(goal, Date.now(), ctx.sessionManager.getLeafId(), callerRequired);
          pi.events.emit('pi-sampler:goal-loop:armed', { goalId, goal, callerRequired });
        }
        else if (input === 'pause' || input === 'stop') loop.pause();
        else if (input === 'wait') loop.wait();
        else if (input !== 'status') throw new Error('Usage: /goal-loop start|resume [--caller-required] <approved goal> | status | wait | pause | stop');
        if (ctx.hasUI) ctx.ui.notify(`Goal loop: ${JSON.stringify(loop.status())}`, 'info');
      } catch (error) {
        loop.pause('invalid-command');
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
