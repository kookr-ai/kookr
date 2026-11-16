/**
 * Lucy's permission cards (issue #3932): a task whose agent has waited on a permission prompt.
 *
 * Each card shows the task, the tool and the whole command (secrets already hidden by the server),
 * with the finding card's Approve once and Deny: they send the same `permissionChoice` message, bound
 * to the same prompt, so the server refuses a press meant for a prompt that is no longer on screen.
 * A button is shown only when the server found its option on the task's screen. The server keeps a
 * dashboard press valid for a few minutes after the prompt appeared; after that the buttons go and the
 * card says to answer in the task. The card goes when the prompt is answered anywhere.
 */
import { useEffect, useState } from 'react';
import type { LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import type { ClientMessage } from '../../shared/contracts/messages.js';
import { track } from '../telemetry.js';
import {
  buildPermissionChoice,
  markPermissionPressed,
  permissionButtonsLive,
  useLucyPermission,
} from '../store/lucy-permission.js';

export type PermissionChoiceSender = (msg: Extract<ClientMessage, { type: 'permissionChoice' }>) => boolean;

export const NO_BUTTONS_TEXT = 'Answer it in the task\'s terminal.';
export const EXPIRED_TEXT = 'These buttons have timed out. Answer it in the task\'s terminal.';
export const SENT_TEXT = 'Sent. The card goes once the task moves on.';
export const NOT_SENT_TEXT = 'Not sent: the connection is down. Try again.';

function waitedText(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.floor((nowMs - sinceMs) / 60_000));
  return `waiting ${minutes} min`;
}

function PermissionCard({
  card,
  pressed,
  nowMs,
  onChoice,
  onOpenTask,
}: {
  card: LucyPermissionCardView;
  pressed: boolean;
  nowMs: number;
  onChoice?: PermissionChoiceSender;
  onOpenTask?: (taskId: string) => boolean;
}) {
  const [failed, setFailed] = useState(false);
  const live = permissionButtonsLive(card, nowMs);
  const canApprove = live && Boolean(card.approveKey);
  const canDeny = live && Boolean(card.denyKey);
  const titleId = `avatar-permission-title-${card.promptId.slice(0, 16)}`;

  const press = (choice: 'approve' | 'deny'): void => {
    const msg = buildPermissionChoice(card, choice, Date.now());
    if (!msg || !onChoice) return;
    markPermissionPressed(card.promptId, true);
    track({ type: 'quick_action_clicked', agentId: card.agentId, actionLabel: `lucy_permission:${msg.keystroke}` });
    const sent = onChoice(msg);
    setFailed(!sent);
    if (!sent) markPermissionPressed(card.promptId, false);
  };

  let note: string;
  if (pressed) note = SENT_TEXT;
  else if (failed) note = NOT_SENT_TEXT;
  else if (!card.permissionRequest || (!card.approveKey && !card.denyKey)) note = NO_BUTTONS_TEXT;
  else if (!live) note = EXPIRED_TEXT;
  else note = 'Also on the finding card.';

  return (
    <li className="avatar-ask avatar-ask-pending avatar-permission" data-testid="avatar-permission" data-prompt-id={card.promptId}>
      <div className="avatar-ask-head">
        <span className="avatar-mark-diamond" aria-hidden="true" />
        <span className="avatar-ask-who" id={titleId} title={card.taskName ?? card.taskId}>
          {card.taskName ?? 'A task'}
        </span>
        <span className="avatar-ask-time">{waitedText(card.since, nowMs)}</span>
      </div>
      <p className="avatar-ask-question" data-testid="avatar-permission-ask">
        Waiting for your permission to use <span className="avatar-permission-tool">{card.toolName}</span>
      </p>
      {card.command && (
        <pre className="avatar-permission-command" data-testid="avatar-permission-command">{card.command}</pre>
      )}
      <div className="avatar-launch-buttons" role="group" aria-labelledby={titleId}>
        {canApprove && (
          <button
            type="button"
            className="avatar-ask-send"
            onClick={() => press('approve')}
            aria-disabled={pressed ? 'true' : undefined}
            data-testid="avatar-permission-approve"
          >
            Approve once
          </button>
        )}
        {canDeny && (
          <button
            type="button"
            className="avatar-ask-option avatar-launch-cancel"
            onClick={() => press('deny')}
            aria-disabled={pressed ? 'true' : undefined}
            data-testid="avatar-permission-deny"
          >
            Deny
          </button>
        )}
        {onOpenTask && (
          <button type="button" className="avatar-launch-link" onClick={() => onOpenTask(card.taskId)} data-testid="avatar-permission-open-task">
            Open task
          </button>
        )}
      </div>
      {/* Always present, only emptied, so a change is announced. */}
      <p className="avatar-ask-note" role="status" data-testid="avatar-permission-note">{note}</p>
    </li>
  );
}

export function LucyPermissionCards({
  onChoice,
  onOpenTask,
  nowFn = Date.now,
}: {
  onChoice?: PermissionChoiceSender;
  onOpenTask?: (taskId: string) => boolean;
  nowFn?: () => number;
}) {
  const { cards, pressed } = useLucyPermission();
  const [now, setNow] = useState(nowFn);
  const hasCards = cards.length > 0;
  // The "waiting N min" labels and the button time limit, kept current while there are cards.
  useEffect(() => {
    if (!hasCards) return undefined;
    setNow(nowFn());
    const timer = setInterval(() => setNow(nowFn()), 1000);
    return () => clearInterval(timer);
  }, [hasCards, nowFn]);

  if (!hasCards) return null;
  return (
    <ol
      className="avatar-asks avatar-permissions"
      role="list"
      aria-label={`Tasks waiting for your permission (${cards.length})`}
      data-testid="avatar-permissions"
    >
      {cards.map((card) => (
        <PermissionCard
          key={card.promptId}
          card={card}
          pressed={pressed.has(card.promptId)}
          nowMs={now}
          {...(onChoice ? { onChoice } : {})}
          {...(onOpenTask ? { onOpenTask } : {})}
        />
      ))}
    </ol>
  );
}
