/**
 * Lucy's launch card (issue #3676): what she proposes to start, in the avatar panel.
 *
 * The card shows the project, whether it is an investigation or an implementation, the whole task
 * description (never a summary), the operator's own words it was built from, and the level in force as a
 * small label. "Go" (or Enter) confirms; "Cancel" declines. A hands-off card has no "Go": it counts down
 * to `launchesAt`, when the server starts the task by itself, and only "Cancel" is offered.
 *
 * Enter confirms only when focus is not in a text field, a button or a link (Enter there already means
 * something else). When the proposal ends, the card turns into a one-line result; a result that started a
 * task links to it. The card also goes by itself at `expiresAt`.
 *
 * Purely the browser half of a server rule: no level is decided or sent from here.
 */
import { useEffect, useState } from 'react';
import {
  confirmLucyLaunch,
  declineLucyLaunch,
  dismissLucyLaunchResult,
  dismissLucyReport,
  expireLucyProposal,
  useLucyLaunch,
} from '../store/lucy-launch.js';
import { useKookrStore } from '../store/useStore.js';
import type { LucyLaunchProposalView } from '../../shared/contracts/lucy-launch.js';

const LEVEL_LABEL: Record<LucyLaunchProposalView['level'], string> = {
  careful: 'Careful',
  balanced: 'Balanced',
  'hands-off': 'Hands-off',
};
const KIND_LABEL: Record<LucyLaunchProposalView['kind'], string> = {
  investigation: 'Investigation',
  implementation: 'Implementation',
};

/** Select a task in the dashboard, the same way opening an existing duplicate in Quick Launch does. */
export function openLucyTask(taskId: string): void {
  const state = useKookrStore.getState();
  const agent = state.agents.find((a) => a.taskId === taskId);
  if (agent) state.selectAgent(agent.agentId, taskId);
}

/** True when Enter pressed with focus on `target` already has another meaning. */
export function enterBelongsToTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]') !== null;
}

function secondsLeft(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

export function LucyLaunchCard({ nowFn = Date.now }: { nowFn?: () => number } = {}) {
  const { proposal, sending, error, result, report } = useLucyLaunch();
  const [now, setNow] = useState(nowFn);
  const proposalId = proposal?.id;
  const expiresAt = proposal?.expiresAt;
  const handsOff = proposal?.launchesAt !== undefined;

  // Gone by itself at `expiresAt`.
  useEffect(() => {
    if (proposalId === undefined || expiresAt === undefined) return undefined;
    const timer = setTimeout(() => expireLucyProposal(proposalId), Math.max(0, expiresAt - nowFn()));
    return () => clearTimeout(timer);
  }, [proposalId, expiresAt, nowFn]);

  // The countdown of a hands-off card.
  useEffect(() => {
    if (!handsOff) return undefined;
    setNow(nowFn());
    const timer = setInterval(() => setNow(nowFn()), 250);
    return () => clearInterval(timer);
  }, [handsOff, proposalId, nowFn]);

  // Enter confirms a card that waits for the operator.
  useEffect(() => {
    if (proposalId === undefined || handsOff) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
      // The card is sent to every open tab: an Enter in a tab nobody is looking at must not launch it.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (enterBelongsToTarget(event.target)) return;
      event.preventDefault();
      void confirmLucyLaunch('enter');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [proposalId, handsOff]);

  if (!proposal && !result && !report) return null;
  return (
    <div className="avatar-launch" data-testid="avatar-launch">
      {proposal && (
        <section className="avatar-launch-card" aria-label="Task Lucy proposes to start" data-testid="avatar-launch-card">
          <div className="avatar-launch-head">
            <span className="avatar-mark-diamond" aria-hidden="true" />
            <span className="avatar-launch-project" data-testid="avatar-launch-project">{proposal.project}</span>
            <span className="avatar-launch-kind" data-testid="avatar-launch-kind">{KIND_LABEL[proposal.kind]}</span>
            <span className="avatar-launch-level" data-testid="avatar-launch-level">{LEVEL_LABEL[proposal.level]}</span>
          </div>
          <p className="avatar-launch-description" data-testid="avatar-launch-description">{proposal.description}</p>
          <p className="avatar-launch-asked" data-testid="avatar-launch-asked">
            <span className="avatar-live-who">You asked</span> {proposal.asked}
          </p>
          {handsOff && proposal.launchesAt !== undefined && (
            <p className="avatar-launch-countdown" role="timer" data-testid="avatar-launch-countdown">
              Starts in {secondsLeft(proposal.launchesAt, now)} s unless you cancel.
            </p>
          )}
          {error && <p className="avatar-launch-error" role="alert" data-testid="avatar-launch-error">{error}</p>}
          <div className="avatar-launch-buttons">
            {!handsOff && (
              <button
                type="button"
                className="avatar-ask-send"
                onClick={() => void confirmLucyLaunch('click')}
                aria-disabled={sending ? 'true' : undefined}
                data-testid="avatar-launch-go"
              >
                Go
              </button>
            )}
            <button
              type="button"
              className="avatar-ask-option avatar-launch-cancel"
              onClick={() => void declineLucyLaunch()}
              aria-disabled={sending ? 'true' : undefined}
              data-testid="avatar-launch-cancel"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
      {result && (
        <p className="avatar-launch-result" role="status" data-testid="avatar-launch-result">
          <span>{result.text}</span>
          {result.taskId && (
            <button type="button" className="avatar-launch-link" onClick={() => openLucyTask(result.taskId!)} data-testid="avatar-launch-open">
              Open task
            </button>
          )}
          <button type="button" className="avatar-launch-link" onClick={dismissLucyLaunchResult} aria-label="Dismiss">Dismiss</button>
        </p>
      )}
      {report && (
        <p className="avatar-launch-result avatar-launch-report" role="status" data-testid="avatar-launch-report">
          <span>{report.text}</span>
          <button type="button" className="avatar-launch-link" onClick={() => openLucyTask(report.taskId)} data-testid="avatar-launch-report-open">
            Open task
          </button>
          <button type="button" className="avatar-launch-link" onClick={dismissLucyReport} aria-label="Dismiss report">Dismiss</button>
        </p>
      )}
    </div>
  );
}
