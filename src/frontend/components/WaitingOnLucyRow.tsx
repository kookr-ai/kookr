import { askClockOffsetMs } from '../store/operator-asks.js';
import { openLucyOnWaiting } from '../store/avatar-panel-prefs.js';
import { needsYouActionText, needsYouTimeLeftText, type NeedsYouItem } from '../store/needs-you.js';

/**
 * One row for a question or permission prompt that waits on the operator, in the task list and on the overview.
 *
 * It names the task and what it wants, and for a question how long is left. It does not print the question or
 * the command (Lucy's card does) and it has no answer buttons: pressing it opens Lucy's panel on her
 * "Waiting on you" strip and answers nothing.
 */
export function WaitingOnLucyRow({ item, variant }: { item: NeedsYouItem; variant: 'rail' | 'overview' }) {
  const name = item.taskName ?? 'A task';
  const action = needsYouActionText(item);
  const timeLeft = item.expiresAt !== undefined ? needsYouTimeLeftText(item.expiresAt, Date.now() + askClockOffsetMs()) : null;
  const classes = variant === 'rail'
    ? { row: 'needs-row', name: 'needs-row-name', action: 'needs-row-action', time: 'needs-row-time' }
    : { row: 'overview-waiting-row', name: 'overview-waiting-name', action: 'overview-waiting-kind', time: 'overview-waiting-meta' };
  return (
    <button
      type="button"
      className={`${classes.row} needs-lucy-row needs-lucy-row-${item.kind}`}
      data-testid="needs-you-lucy-row"
      data-needs-kind={item.kind}
      aria-label={`${name} ${action}${timeLeft ? `, ${timeLeft}` : ''}. Open Lucy.`}
      title="Open Lucy to answer"
      onClick={openLucyOnWaiting}
    >
      <span className={classes.name}>{name}</span>
      <span className={classes.action}>{action}</span>
      {timeLeft && <span className={classes.time}>{timeLeft}</span>}
    </button>
  );
}
