export const COLOR_PALETTE = [
  "#264653",
  "#2A9D8F",
  "#8AB17D",
  "#E9C46A",
  "#F4A261",
  "#E76F51",
  "#6D597A",
  "#355070",
] as const;

export const COPIED_FEEDBACK_DURATION_MS = 1_500;

export type CopyFeedbackState = Readonly<{
  color: string | null;
  status: "copied" | "failed" | null;
  token: number;
}>;

export const INITIAL_COPY_FEEDBACK_STATE: CopyFeedbackState = { color: null, status: null, token: 0 };

export function markColorCopied(state: CopyFeedbackState, color: string): CopyFeedbackState {
  return { color, status: "copied", token: state.token + 1 };
}

export function markColorCopyFailed(state: CopyFeedbackState, color: string): CopyFeedbackState {
  return { color, status: "failed", token: state.token + 1 };
}

export function clearCopiedColor(state: CopyFeedbackState, token: number): CopyFeedbackState {
  return state.token === token ? { ...state, color: null, status: null } : state;
}

export async function copyHexColor(color: string): Promise<void> {
  await navigator.clipboard.writeText(color);
}
