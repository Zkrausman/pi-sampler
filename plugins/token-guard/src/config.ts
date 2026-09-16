export interface TokenGuardConfig {
  enabled: boolean;
  warnAfter: number;
  stopAfter?: number;
}

const DEFAULT_WARN_AFTER = 6;
const MIN_THRESHOLD = 2;

function positiveInteger(name: string, value: unknown, minimum: number, optional: boolean): number | undefined {
  if (value === undefined || value === false || value === "") {
    if (optional) return undefined;
    return undefined;
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`--${name} must be a positive integer (minimum ${minimum})`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be a positive integer (minimum ${minimum})`);
  }
  return parsed;
}

export function configFromFlags(getFlag: (name: string) => unknown): TokenGuardConfig {
  const enabled = getFlag("token-guard") === true;
  const warnAfterValue = getFlag("token-guard-warn-after");
  const warnAfter = warnAfterValue === undefined || warnAfterValue === false || warnAfterValue === ""
    ? DEFAULT_WARN_AFTER
    : positiveInteger("token-guard-warn-after", warnAfterValue, MIN_THRESHOLD, false)!;
  const stopAfter = positiveInteger("token-guard-stop-after", getFlag("token-guard-stop-after"), warnAfter, true);
  return { enabled, warnAfter, stopAfter };
}

export const defaults = { enabled: false, warnAfter: DEFAULT_WARN_AFTER } as const;
