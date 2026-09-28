// Cost is provider-reported/estimated, not a billing authority. If an assistant
// response has missing or invalid usage, refuse automatic continuation.
export function reportedCostSince(branch: readonly any[], startId: string | null): number | undefined {
  const index = startId === null ? -1 : branch.findIndex(entry => entry.id === startId);
  if (startId !== null && index < 0) return undefined; // branch changed under an armed goal
  let cost = 0;
  for (const entry of branch.slice(index + 1)) {
    const usage = entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary'
      ? entry.usage : entry.type === 'message' && ['assistant', 'toolResult'].includes(entry.message?.role)
        ? entry.message.usage : undefined;
    if (entry.type === 'message' && !['assistant', 'toolResult'].includes(entry.message?.role)) continue;
    if (!usage) {
      if (entry.type !== 'message' || entry.message?.role === 'assistant') return undefined;
      continue; // tool results are usually free; nested model usage, when present, counts
    }
    const amount = usage.cost?.total;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return undefined;
    cost += amount;
    if (!Number.isFinite(cost)) return undefined;
  }
  return cost;
}
