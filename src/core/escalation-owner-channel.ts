/**
 * Owner-read escalation channel for environment blockers (issue #1702).
 *
 * The env-blocker registry (#1690/#1691) shipped with a single-shot escalation
 * sink that was "a clearly-marked operator log line" — a buried console.warn.
 * For a blocker only a human can clear (the motivating lucy #1748 GitHub-billing
 * case), a single line in the daemon log is not an owner-read surface: the
 * blocker sat 2+ days while the harness built tolerance machinery around it.
 *
 * This module is the routing layer that turns each {@link EnvironmentBlockerEscalation}
 * into an owner-facing message and delivers it to one or more
 * {@link OwnerReadChannel}s — a control-room feed and/or an owner DM — carrying
 * the *quantified running cost* so the human sees the compounding price, not
 * just "still blocked". It is deliberately transport-agnostic: the registry
 * only knows about the {@link EnvironmentBlockerNotifier} contract, and this
 * layer adapts that to whatever concrete channels the daemon wires in.
 *
 * Pure formatting ({@link formatEscalationMessage}) is unit-testable without any
 * transport; delivery ({@link createOwnerEscalationNotifier}) is verifiable by
 * injecting a fake {@link OwnerReadChannel}.
 */

import type {
  EnvironmentBlockerEscalation,
  EnvironmentBlockerNotifier,
} from './environment-blocker-registry.js';

/**
 * Owner-facing escalation message. `subject`/`body` are for human channels
 * (control-room line, DM); `fields` is the structured projection for machine
 * sinks (webhooks, dashboards) so no consumer has to re-parse the body.
 */
export interface OwnerEscalationMessage {
  /** One-line subject for a control-room feed / DM preview. */
  subject: string;
  /** Full multi-line body including the running-cost accounting. */
  body: string;
  /** True for re-escalations of human-authority blockers (higher urgency). */
  urgent: boolean;
  /** Structured fields; mirrors the escalation + its cost. */
  fields: {
    blockerKey: string;
    kind: 'initial' | 're-escalation';
    escalationCount: number;
    requiresHuman: boolean;
    ciBlindMergeCount: number;
    retroVerifyQueueDepth: number;
    blockedCapabilities: string[];
    at: string;
  };
}

/**
 * A place the owner actually reads: a control-room feed, an owner DM, a pinned
 * message. Implementations must handle their own transport errors *or* throw —
 * a throw is treated by {@link createOwnerEscalationNotifier} as a delivery
 * failure for that channel (see its all-channels-failed semantics).
 */
export interface OwnerReadChannel {
  /** Stable id for logs/audit (e.g. `control-room`, `telegram-owner-dm`). */
  readonly id: string;
  deliver(message: OwnerEscalationMessage): void | Promise<void>;
}

/** Humanize a millisecond duration to a compact `2d 3h`-style string. */
function humanizeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && !days) parts.push(`${minutes}m`);
  return parts.length ? parts.join(' ') : '0m';
}

/**
 * Render an escalation into an owner-facing message. Pure — no transport, no
 * clock (the `at`/`detectedAt` timestamps already live on the escalation).
 */
export function formatEscalationMessage(
  escalation: EnvironmentBlockerEscalation,
): OwnerEscalationMessage {
  const { blocker, kind, escalationCount, cost, at } = escalation;
  const requiresHuman = blocker.requiresHuman === true;
  const urgent = kind === 're-escalation' && requiresHuman;

  const detectedMs = Date.parse(blocker.detectedAt);
  const atMs = Date.parse(at);
  const ageStr =
    Number.isFinite(detectedMs) && Number.isFinite(atMs)
      ? humanizeAge(atMs - detectedMs)
      : 'unknown';

  const tag = kind === 're-escalation' ? 'RE-ESCALATION' : 'ESCALATION';
  const authority = requiresHuman ? ' [requires human]' : '';
  const subject = `${tag}${authority}: ${blocker.key} blocked ${ageStr} (escalation #${escalationCount})`;

  const capabilities = cost.blockedCapabilities.length
    ? cost.blockedCapabilities.join(', ')
    : '(none recorded)';

  const bodyLines = [
    subject,
    '',
    `Blocker:        ${blocker.key} (type=${blocker.type} scope=${blocker.scope})`,
    `Detected:       ${blocker.detectedAt} — open ${ageStr}`,
    ...(blocker.reason ? [`Reason:         ${blocker.reason}`] : []),
    ...(blocker.probe ? [`Re-check probe: ${blocker.probe}`] : []),
    '',
    'Running cost of this blocker:',
    `  • CI-blind merges (unverified on main): ${cost.ciBlindMergeCount}`,
    `  • Retro-verify queue depth:             ${cost.retroVerifyQueueDepth}`,
    `  • Blocked capabilities:                 ${capabilities}`,
    '',
    requiresHuman
      ? 'This blocker can only be cleared by a human. Resolve it at the source ' +
        '(e.g. the billing/quota page) — do not build more tolerance machinery for it.'
      : 'Clear the blocker at its source; it auto-clears on the next successful probe.',
  ];

  return {
    subject,
    body: bodyLines.join('\n'),
    urgent,
    fields: {
      blockerKey: blocker.key,
      kind,
      escalationCount,
      requiresHuman,
      ciBlindMergeCount: cost.ciBlindMergeCount,
      retroVerifyQueueDepth: cost.retroVerifyQueueDepth,
      blockedCapabilities: cost.blockedCapabilities,
      at,
    },
  };
}

/**
 * Built-in control-room channel: emits a single, high-signal, greppable line
 * (`[control-room][escalation] ...`) plus the cost body. This is the owner's
 * control-room feed — distinct from an ordinary debug log, and always available
 * even when no DM transport is configured. `urgent` messages go to `error`, the
 * rest to `warn`, so a re-escalation of a human-authority blocker is visible at
 * the highest log severity.
 */
export function controlRoomLogChannel(
  logger: Pick<Console, 'warn' | 'error'> = console,
): OwnerReadChannel {
  return {
    id: 'control-room',
    deliver(message: OwnerEscalationMessage): void {
      const line = `[control-room][escalation] ${message.body}`;
      if (message.urgent) logger.error(line);
      else logger.warn(line);
    },
  };
}

/**
 * Adapt a set of {@link OwnerReadChannel}s into an {@link EnvironmentBlockerNotifier}
 * for the registry. Formats the escalation once and fans it out to every
 * channel. Delivery semantics are chosen so the registry's stamp/retry logic
 * does the right thing:
 *
 *   - at least one channel delivered ⇒ resolve, so the registry stamps
 *     `lastEscalatedAt` (the escalation reached the owner somewhere);
 *   - every channel threw ⇒ reject, so the registry leaves the escalation
 *     unstamped and retries on the next register/heartbeat.
 *
 * A per-channel failure never prevents the others from receiving the message.
 * Requires at least one channel (an empty notifier would silently swallow every
 * escalation — a misconfiguration, not a valid state).
 */
export function createOwnerEscalationNotifier(
  channels: readonly OwnerReadChannel[],
): EnvironmentBlockerNotifier {
  if (channels.length === 0) {
    throw new Error(
      'createOwnerEscalationNotifier requires at least one OwnerReadChannel',
    );
  }
  return async (escalation) => {
    const message = formatEscalationMessage(escalation);
    let delivered = 0;
    const failures: string[] = [];
    for (const channel of channels) {
      try {
        await channel.deliver(message);
        delivered += 1;
      } catch (err) {
        failures.push(`${channel.id}: ${err instanceof Error ? err.message : String(err)}`);
        console.error(
          `[escalation-owner-channel] channel ${JSON.stringify(channel.id)} failed to ` +
            `deliver escalation for ${message.fields.blockerKey}:`,
          err,
        );
      }
    }
    if (delivered === 0) {
      throw new Error(
        `all ${channels.length} owner channel(s) failed to deliver escalation for ` +
          `${message.fields.blockerKey}: ${failures.join('; ')}`,
      );
    }
  };
}
