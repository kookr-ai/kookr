/**
 * Lucy's permission cards in the avatar panel (issue #3932).
 *
 * The server sends the whole list (`lucyPermissionCards`) on connect and on every change, so a reload
 * or a reconnect converges; a card goes when the server's list no longer has it. A message with
 * `announce` is the one sentence she should say: the panel hears it through
 * {@link onPermissionAnnounced} (with the panel off nobody listens, so nothing is spoken). Once none
 * of a sentence's prompts is on the list, {@link onPermissionNoticeWithdrawn} tells the panel to stop it.
 *
 * Pressing Approve once or Deny sends the dashboard's `permissionChoice` message; the press only
 * disables the card's buttons here, and the card goes when the server's next list drops it.
 */
import { useSyncExternalStore } from 'react';
import type { LucyPermissionAnnouncement, LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import type { ClientMessage, ServerMessage } from '../../shared/contracts/messages.js';

export interface LucyPermissionSnapshot {
  cards: readonly LucyPermissionCardView[];
  /** Prompt ids whose Approve once or Deny was pressed in this tab. */
  pressed: ReadonlySet<string>;
}

const EMPTY: LucyPermissionSnapshot = Object.freeze({ cards: [], pressed: new Set<string>() });

let snapshot: LucyPermissionSnapshot = EMPTY;
const listeners = new Set<() => void>();
const announceListeners = new Set<(announcement: LucyPermissionAnnouncement) => void>();
const withdrawnListeners = new Set<(noticeId: string) => void>();
/** Sentences announced and not yet withdrawn: notice id -> the prompts it is about. */
const openNotices = new Map<string, readonly string[]>();
/** Server clock minus browser clock, from the last message: the button time limit is the server's. */
let clockOffsetMs = 0;

function set(next: LucyPermissionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getLucyPermissionSnapshot(): LucyPermissionSnapshot {
  return snapshot;
}

export function useLucyPermission(): LucyPermissionSnapshot {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getLucyPermissionSnapshot,
    getLucyPermissionSnapshot,
  );
}

/** Apply a `lucyPermissionCards` socket message. */
export function handleLucyPermissionCards(msg: Extract<ServerMessage, { type: 'lucyPermissionCards' }>): void {
  if (typeof msg.serverNow === 'number' && Number.isFinite(msg.serverNow)) clockOffsetMs = msg.serverNow - Date.now();
  const onList = new Set(msg.cards.map((card) => card.promptId));
  const pressed = new Set([...snapshot.pressed].filter((id) => onList.has(id)));
  set({ cards: msg.cards, pressed });
  if (msg.announce) {
    openNotices.set(msg.announce.noticeId, msg.announce.promptIds);
    for (const listener of announceListeners) listener(msg.announce);
  }
  for (const [noticeId, promptIds] of openNotices) {
    if (promptIds.some((id) => onList.has(id))) continue;
    openNotices.delete(noticeId);
    for (const listener of withdrawnListeners) listener(noticeId);
  }
}

/** A sentence to say arrived. Returns the unsubscribe function. */
export function onPermissionAnnounced(listener: (announcement: LucyPermissionAnnouncement) => void): () => void {
  announceListeners.add(listener);
  return () => { announceListeners.delete(listener); };
}

/** Every prompt a sentence was about has been answered. Returns the unsubscribe function. */
export function onPermissionNoticeWithdrawn(listener: (noticeId: string) => void): () => void {
  withdrawnListeners.add(listener);
  return () => { withdrawnListeners.delete(listener); };
}

/**
 * The buttons of a card still answer its prompt: the server keeps a dashboard binding valid for
 * `ttlMs` after the prompt was first seen and drops a press that arrives later. `nowMs` is the
 * browser's clock; it is moved to the server's before the comparison.
 */
export function permissionButtonsLive(card: LucyPermissionCardView, nowMs: number): boolean {
  const binding = card.permissionRequest;
  if (!binding) return false;
  const expiresAt = Date.parse(binding.detectedAt) + binding.ttlMs;
  return Number.isFinite(expiresAt) && nowMs + clockOffsetMs <= expiresAt;
}

/** The `permissionChoice` message a card's button sends; null when the button cannot answer this prompt. */
export function buildPermissionChoice(
  card: LucyPermissionCardView,
  choice: 'approve' | 'deny',
  nowMs: number,
): Extract<ClientMessage, { type: 'permissionChoice' }> | null {
  const keystroke = choice === 'approve' ? card.approveKey : card.denyKey;
  if (!keystroke || !card.permissionRequest || !permissionButtonsLive(card, nowMs)) return null;
  if (!snapshot.cards.some((c) => c.promptId === card.promptId) || snapshot.pressed.has(card.promptId)) return null;
  return { type: 'permissionChoice', agentId: card.agentId, keystroke, permissionRequest: card.permissionRequest };
}

/** A button of this card was pressed (or the press failed to send, `pressed` false). */
export function markPermissionPressed(promptId: string, pressed: boolean): void {
  const next = new Set(snapshot.pressed);
  if (pressed) next.add(promptId);
  else next.delete(promptId);
  set({ cards: snapshot.cards, pressed: next });
}

export function __resetLucyPermissionForTests(): void {
  snapshot = EMPTY;
  listeners.clear();
  announceListeners.clear();
  withdrawnListeners.clear();
  openNotices.clear();
  clockOffsetMs = 0;
}
