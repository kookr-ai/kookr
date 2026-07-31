/**
 * Bridge from existing operational-alert broadcasts to operator signals
 * (issue #1716, emitter #2).
 *
 * kookr's deploy-lag detector and prod-smoke tick already compute edge-triggered
 * fire/recover transitions and broadcast them as `type: 'alert'` messages
 * carrying an `operationalAlert: { key, metric, state }`. Those broadcasts reach
 * the dashboard but nothing outbound. This adapter maps such a message to an
 * operator-signal write so the *same* fire/recover edges also land in the
 * delivery outbox — turning existing detection into operator-visible delivery
 * without duplicating any edge logic.
 *
 * `fired` → an `alert` signal; `recovered` → a `clear` signal. The signal key is
 * derived from the operational-alert key plus the edge, so a fire and its later
 * clear are distinct spool files (and each dedups on its own key).
 */

import type { WriteOperatorSignalInput } from './operator-signal.js';

/** Minimal shape of the operational-alert broadcast this bridge understands. */
export interface OperationalAlertLike {
  type?: string;
  summary?: string;
  details?: string;
  operationalAlert?: {
    key?: string;
    metric?: string;
    state?: string;
  };
}

/**
 * Map an operational-alert broadcast to the operator signal it should spool, or
 * null when the message is not a fire/recover operational alert.
 */
export function operationalAlertToSignal(msg: OperationalAlertLike): WriteOperatorSignalInput | null {
  if (!msg || msg.type !== 'alert') return null;
  const op = msg.operationalAlert;
  if (!op || typeof op.key !== 'string' || !op.key) return null;

  const state = op.state;
  if (state !== 'fired' && state !== 'recovered') return null;

  const source = op.metric && op.metric.trim() ? op.metric.trim() : op.key;
  const kind = state === 'recovered' ? 'clear' : 'alert';
  const edge = state === 'recovered' ? 'clear' : 'alert';

  return {
    key: `op:${op.key}:${edge}`,
    kind,
    source,
    title: msg.summary && msg.summary.trim() ? msg.summary.trim() : `${op.key} ${state}`,
    ...(msg.details && msg.details.trim() ? { detail: msg.details.trim() } : {}),
  };
}
