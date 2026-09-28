export type WorkState = {
  goalId: string;
  revision: number;
  observedAt: number;
  disposition: 'ready' | 'blocked' | 'awaiting-operator' | 'awaiting-event' | 'unknown';
  nextAction?: string;
  evidenceRef?: string;
};

// Generic structural validation, not authentication. An explicitly loaded
// caller adapter is responsible for the truth of its claims and permissions.
export function validateWorkState(input: unknown, goalId: string, priorRevision: number, now = Date.now()): WorkState | undefined {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return undefined;
    const value = input as Record<string, unknown>;
    const allowed = ['goalId', 'revision', 'observedAt', 'disposition', 'nextAction', 'evidenceRef'];
    if (Object.keys(value).some(key => !allowed.includes(key))) return undefined;
    if (!['goalId', 'revision', 'observedAt', 'disposition'].every(key => Object.hasOwn(value, key))) return undefined;
    if (!goalId || value.goalId !== goalId || !Number.isSafeInteger(value.revision) || (value.revision as number) <= priorRevision) return undefined;
    if (!Number.isSafeInteger(value.observedAt) || !Number.isSafeInteger(now) ||
        (value.observedAt as number) > now + 5000 || now - (value.observedAt as number) > 30000) return undefined;
    if (!['ready', 'blocked', 'awaiting-operator', 'awaiting-event', 'unknown'].includes(value.disposition as string)) return undefined;
    if (value.disposition === 'ready') {
      if (typeof value.nextAction !== 'string' || !value.nextAction.trim() || value.nextAction.length > 240 ||
          typeof value.evidenceRef !== 'string' || !value.evidenceRef.trim() || value.evidenceRef.length > 240) return undefined;
    } else if (value.nextAction !== undefined || value.evidenceRef !== undefined) return undefined;
    // Copy primitives: changing the caller's object after validation cannot
    // change an already accepted decision snapshot.
    return { goalId: value.goalId as string, revision: value.revision as number,
      observedAt: value.observedAt as number, disposition: value.disposition as WorkState['disposition'],
      ...(value.disposition === 'ready' ? { nextAction: value.nextAction as string, evidenceRef: value.evidenceRef as string } : {}),
    };
  } catch { return undefined; }
}
