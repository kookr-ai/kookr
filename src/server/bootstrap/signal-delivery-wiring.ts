/**
 * Server wiring for the operator-signal delivery bridge (issues #1716, #3924).
 *
 * Detectors (permission-prompt wait, train halt, paused schedules, ...) call
 * `detectorBroadcast`. It always reaches open dashboards; when an alert channel
 * resolves it also spools the alert into the operator-signal outbox, which the
 * delivery service tails and sends to Telegram / Discord. With no channel the
 * outbox is never written and the service is never built, so the start-up log
 * says once that alerts stay on this machine.
 */

import type { ServerMessage } from '../../shared/contracts/messages.js';
import {
  SignalDeliveryService,
  defaultOperatorSignalDir,
  operationalAlertToSignal,
  resolveSignalDeliveryFromEnv,
  writeOperatorSignal,
  type AlertDestination,
  type OperationalAlertLike,
  type SignalDeliveryConfig,
} from '../../observability/signal-delivery/index.js';

export interface SignalDeliveryWiringDeps {
  env: NodeJS.ProcessEnv;
  broadcastToAll: (msg: ServerMessage) => void;
  /** Outbox directory; defaults to the env-derived operator-signal dir. */
  dir?: string;
  warn?: (msg: string, err?: unknown) => void;
}

export interface SignalDeliveryWiring {
  destination: AlertDestination;
  config: SignalDeliveryConfig | null;
  dir: string;
  /** Dashboard broadcast, plus an outbox write when a channel resolves. */
  detectorBroadcast: (msg: ServerMessage) => void;
  /** Builds the outbox → Telegram/Discord service, or null when no channel resolves. Not started. */
  createDeliveryService: () => SignalDeliveryService | null;
}

export function wireSignalDelivery(deps: SignalDeliveryWiringDeps): SignalDeliveryWiring {
  const warn = deps.warn ?? ((msg: string, err?: unknown) => {
    if (err === undefined) console.warn(msg);
    else console.warn(msg, err);
  });
  const dir = deps.dir ?? defaultOperatorSignalDir(deps.env);
  const { config, destination } = resolveSignalDeliveryFromEnv(deps.env, { warn: (m: string) => warn(m) });

  if (!config) {
    warn(
      `[signal-delivery] server alerts go ${destination.label}: ${destination.reason ?? 'no alert channel is configured'}. ` +
        'See docs/reference/signal-outbox.md.',
    );
  }

  const emitOperationalSignal = (msg: ServerMessage): void => {
    const input = operationalAlertToSignal(msg as OperationalAlertLike);
    if (!input) return;
    void writeOperatorSignal(dir, input).catch((err: unknown) => {
      warn('[signal-delivery] failed to spool operational signal:', err);
    });
  };
  const { broadcastToAll } = deps;
  const detectorBroadcast: (msg: ServerMessage) => void = config
    ? (msg) => { broadcastToAll(msg); emitOperationalSignal(msg); }
    : broadcastToAll;

  return {
    destination,
    config,
    dir,
    detectorBroadcast,
    createDeliveryService: () => (config ? new SignalDeliveryService({ dir, config }) : null),
  };
}
