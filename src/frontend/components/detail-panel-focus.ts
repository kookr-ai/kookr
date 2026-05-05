/**
 * Pure decision helper for the DetailPanel reply-input auto-focus effect.
 *
 * The effect used to call `inputRef.focus()` any time `agent.anomaly` changed,
 * but because the store re-emits a fresh `agent` object on every WebSocket
 * update, "changed" fired ~1 Hz while an anomaly persisted — stealing focus
 * mid-drag and breaking copy/paste in the activity panel.
 *
 * Rules encoded here:
 *   1. No current anomaly → don't focus.
 *   2. Same (agentId, anomalyType) as last tick → not a real transition, skip.
 *   3. User has a non-empty text selection somewhere → don't clobber the
 *      in-flight copy.
 *   4. Focus already sits in an input / textarea / terminal → don't steal it.
 *   5. Otherwise this is a real transition (null→type, type change, or
 *      agent-switch) → focus the reply input.
 */
export function shouldAutoFocusReply(params: {
  currentKey: string | null;
  prevKey: string | null;
  selectionLength: number;
  activeElement: Element | null;
}): boolean {
  const { currentKey, prevKey, selectionLength, activeElement } = params;
  if (!currentKey) return false;
  if (currentKey === prevKey) return false;
  if (selectionLength > 0) return false;
  const tag = activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
  if (activeElement?.closest?.('.xterm')) return false;
  if (activeElement?.closest?.('.terminal-xterm')) return false;
  return true;
}

/** Build the anomaly-transition key from the current agent state. */
export function anomalyTransitionKey(
  agentId: string | undefined,
  anomalyType: string | undefined,
): string | null {
  if (!anomalyType) return null;
  return `${agentId ?? ''}:${anomalyType}`;
}
