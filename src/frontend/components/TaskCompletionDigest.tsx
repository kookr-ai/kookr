import React, { useState, useEffect } from 'react';
import type { AgentState } from '../../shared/protocol.js';
import { prLinkLabel } from '../presentation.js';
import { copyText } from '../clipboard.js';
import { getTaskVerificationCommands } from '../api/tasks.js';

function criterionCountLabel(count: number, suffix: string): string {
  return `${count} ${count === 1 ? 'criterion' : 'criteria'} ${suffix}`;
}

function criterionVerdictLabel(verdict: 'pass' | 'fail' | 'unknown'): string {
  switch (verdict) {
    case 'pass': return 'Passed';
    case 'fail': return 'Failed';
    case 'unknown': return 'Unknown';
  }
}

function PrLinksBlock({ digest }: { digest: NonNullable<AgentState['completionDigest']> }) {
  const prUrls = digest.prUrls;
  if (!prUrls || prUrls.length === 0) return null;
  return (
    <div className="detail-digest-prs" data-testid="detail-digest-prs">
      <strong>Pull request{prUrls.length > 1 ? 's' : ''}:</strong>
      {prUrls.map((url, i) => (
        <a
          key={`${url}-${i}`}
          className="detail-digest-pr-link"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {prLinkLabel(url)}
          <span className="sr-only"> (opens in new tab)</span>
          <span aria-hidden="true"> ↗</span>
        </a>
      ))}
    </div>
  );
}

function CriteriaVerdictBlock({ digest }: { digest: NonNullable<AgentState['completionDigest']> }) {
  const verdict = digest.criteriaVerdict;
  if (!verdict || verdict.items.length === 0) return null;
  const failed = verdict.summary.fail > 0;
  const allPassed = verdict.summary.pass === verdict.items.length;
  const label = failed
    ? criterionCountLabel(verdict.summary.fail, 'failed')
    : allPassed
      ? 'Criteria passed'
      : criterionCountLabel(verdict.summary.unknown, 'unknown');

  return (
    <div className={`criteria-verdict criteria-verdict--${failed ? 'fail' : allPassed ? 'pass' : 'unknown'}`} data-testid="criteria-verdict">
      <div className="criteria-verdict-header">
        <span className="criteria-verdict-title">Criteria</span>
        <span className="criteria-verdict-badge">{label}</span>
      </div>
      <ul className="criteria-verdict-list">
        {verdict.items.map((item, i) => (
          <li key={`${item.criterion}-${i}`} className={`criteria-verdict-item criteria-verdict-item--${item.verdict}`}>
            <span className="criteria-verdict-mark" aria-hidden="true">
              {item.verdict === 'pass' ? '✓' : item.verdict === 'fail' ? '!' : '?'}
            </span>
            <span className="criteria-verdict-text">
              <span className="sr-only">{criterionVerdictLabel(item.verdict)}: </span>
              <span className="criteria-verdict-criterion">{item.criterion}</span>
              <span className="criteria-verdict-reason">{item.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Copy control for a single verification command. Display + copy only. */
function VerifyCommandCopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);

  async function handleCopy() {
    try {
      await copyText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`verify-command-copy${copied ? ' copied' : ''}`}
      aria-label={copied ? `Copied command: ${command}` : `Copy command: ${command}`}
      title={copied ? 'Copied' : 'Copy command'}
      onClick={handleCopy}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * "How to verify" list for a completed task. The terminal snapshot sheds
 * `verificationCommands` for payload size (see event-projection.ts), so this
 * hydrates the full digest from `GET /api/tasks/:id` on open and renders the
 * commands read-only (display + copy — never executed). Renders nothing while
 * the fetch is in flight, on failure, or when there are no commands, so a
 * slow/failed fetch never breaks the already-rendered digest.
 */
function VerificationCommandsBlock({ taskId }: { taskId: string }) {
  const [commands, setCommands] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setCommands([]);
    getTaskVerificationCommands(taskId, controller.signal)
      .then((cmds) => {
        // A prior task's response can still resolve after taskId changed and the
        // effect was cleaned up; drop it so task A's commands never land on B.
        if (controller.signal.aborted) return;
        if (cmds.length > 0) setCommands(cmds);
      })
      .catch(() => {
        /* slow/failed detail fetch must not break the pane — leave the list empty */
      });
    return () => controller.abort();
  }, [taskId]);

  if (commands.length === 0) return null;

  return (
    <div className="detail-verify-commands" data-testid="verify-commands">
      <div className="detail-verify-commands-title">How to verify</div>
      <ul className="detail-verify-commands-list">
        {commands.map((command, i) => (
          <li key={`${command}-${i}`} className="detail-verify-commands-item">
            <code className="detail-verify-commands-code">{command}</code>
            <VerifyCommandCopyButton command={command} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Terminal-task completion digest. Renders the completed/cancelled/terminated
 * summary (bullets, files changed, tests, PR links, criteria verdict, and the
 * hydrated verification commands) that replaces both detail panes.
 *
 * Pane selection stays in {@link DetailPanel}: it decides *when* a terminal
 * task with a digest shows this instead of the Activity/Terminal split. This
 * component owns only the digest rendering and its verification hydration.
 */
export function TaskCompletionDigest({ agent }: { agent: AgentState }) {
  const digest = agent.completionDigest;
  if (!digest) return null;

  const digestHeading = agent.taskStatus === 'cancelled'
    ? 'Cancelled'
    : agent.taskStatus === 'terminated'
      ? 'Terminated'
      : 'Completed';

  return (
    <div className="detail-content">
      <div className="detail-digest">
        <h3>{digestHeading}</h3>
        <ul>
          {digest.bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
        {digest.filesChanged.length > 0 && (
          <div className="detail-digest-files">
            <strong>Files changed:</strong> {digest.filesChanged.join(', ')}
          </div>
        )}
        {digest.testSummary && (
          <div className="detail-digest-tests" data-testid="digest-test-summary">
            <strong>Tests:</strong> {digest.testSummary}
          </div>
        )}
        <PrLinksBlock digest={digest} />
        <CriteriaVerdictBlock digest={digest} />
        {/* key by taskId so switching tasks remounts with empty state —
            never paints task A's commands for a frame on task B's pane. */}
        {agent.taskId && <VerificationCommandsBlock key={agent.taskId} taskId={agent.taskId} />}
      </div>
    </div>
  );
}
