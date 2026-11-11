import React, { useEffect, useRef } from 'react';
import type { AgentState } from '../../../shared/contracts/agent-state.js';
import type { GitHubPRState } from '../../../shared/protocol.js';
import {
  agentProviderPresentation,
  formatBranch,
  formatCacheHit,
  formatCost,
  formatCostRate,
  formatTokens,
  projectColor,
} from '../../presentation.js';
import { TaskIdCopyButton } from '../TaskIdCopyButton.js';
import { DashboardLinkCopyButton } from '../DashboardLinkCopyButton.js';
import { PathCopyButton } from '../PathCopyButton.js';
import { TaskDependencyEditor } from '../TaskDependencyEditor.js';
import { TaskDependencyRail } from '../TaskDependencyRail.js';
import { TaskTimeline } from '../TaskTimeline.js';
import type { TaskShareHeaderStatus } from '../task-share-header-status.js';

export function AgentProviderBadge({
  agentType,
  provider,
}: {
  agentType: NonNullable<AgentState['agentType']>;
  provider: ReturnType<typeof agentProviderPresentation>;
}) {
  const title = `${provider.label} by ${provider.provider}`;

  return (
    <span
      className={`detail-agent-provider detail-agent-provider--${agentType}`}
      title={title}
    >
      <svg className="detail-agent-provider-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={provider.iconPath} />
      </svg>
      <span className="detail-agent-provider-label">{provider.label}</span>
      <span className="sr-only"> by {provider.provider}</span>
    </span>
  );
}

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="detail-fact" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The reading pane's facts column (issue #3561 slice 4b). It replaces the
 * header's Details popover, the Relationships row above the tabs and the
 * timestamp card at the top of the conversation: project, directory, branch,
 * agent (with the hooks view), cost, tokens, pull request, relationships and
 * the task timeline, then the copy, share and prompt links.
 *
 * DetailPanel renders exactly one instance. On a wide pane it is docked beside
 * the conversation; on a narrow one it opens over the pane from the header's
 * Details button.
 */
export function TaskFactsColumn({
  agent,
  projectLabel,
  prs,
  shareStatus,
  onShare,
  hookSettingsTriggerRef,
  onShowHookSettings,
  overlay,
  onClose,
}: {
  agent: AgentState;
  projectLabel: string;
  prs: readonly GitHubPRState[];
  shareStatus: TaskShareHeaderStatus;
  onShare: () => void;
  hookSettingsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onShowHookSettings: () => void;
  /** Narrow pane: the column floats over the pane and has a close button. */
  overlay: boolean;
  onClose: () => void;
}) {
  const provider = agent.agentType ? agentProviderPresentation(agent.agentType) : null;
  const usage = agent.tokenUsage;
  const hasUsageCost = !!usage && usage.costUsd > 0;
  const costRate = formatCostRate(usage?.costUsd, agent.startedAt);
  const tokenCount = usage ? usage.inputTokens + usage.outputTokens : 0;
  const hasCacheReads = !!usage && usage.cacheReadTokens > 0;
  const firstPr = prs[0];
  const closeRef = useRef<HTMLButtonElement>(null);
  // Opened over the pane: move focus into it; Escape closes it (DetailPanel
  // returns focus to the Details toggle).
  useEffect(() => {
    if (overlay) closeRef.current?.focus();
  }, [overlay]);

  return (
    <aside
      className={`detail-facts${overlay ? ' detail-facts--overlay' : ''}`}
      data-testid="detail-facts"
      aria-label="Task facts"
      id="detail-facts"
      onKeyDown={overlay ? (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.stopPropagation();
        onClose();
      } : undefined}
    >
      {overlay && (
        <div className="detail-facts-head">
          <span>Details</span>
          <button ref={closeRef} type="button" className="detail-facts-close" aria-label="Close details" onClick={onClose}>
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
      )}
      <dl className="detail-facts-list">
        {projectLabel && (
          <Fact label="Project">
            <span className={`project-badge color-${projectColor(agent.projectId ?? agent.cwd)}`} title={agent.cwd}>
              {projectLabel}
            </span>
          </Fact>
        )}
        {agent.cwd && (
          <Fact label="Directory"><PathCopyButton cwd={agent.cwd} /></Fact>
        )}
        {agent.gitBranch && (
          <Fact label="Branch">
            <span className="detail-branch" title={agent.gitIsWorktree ? `Worktree: ${agent.cwd}` : 'Git branch'}>
              {formatBranch(agent.gitBranch)}
              {agent.gitIsWorktree && <span className="worktree-badge">worktree</span>}
            </span>
          </Fact>
        )}
        {!agent.gitBranch && agent.gitCommit && (
          <Fact label="Revision">
            <span className="detail-branch detached" title="Detached HEAD">({agent.gitCommit})</span>
          </Fact>
        )}
        {agent.agentType && provider && (
          <Fact label="Agent">
            <span className="detail-agent-type-group">
              <AgentProviderBadge agentType={agent.agentType} provider={provider} />
              <button
                ref={hookSettingsTriggerRef}
                type="button"
                className="detail-hook-settings-btn"
                aria-label={`Hooks: view effective hook settings for ${provider.label} session`}
                title={`Hooks: view effective hook settings for ${provider.label} session`}
                onClick={onShowHookSettings}
              >
                hooks
              </button>
            </span>
          </Fact>
        )}
        {hasUsageCost && (
          <Fact label="Cost">
            <span className="detail-cost" title={`In: ${formatTokens(usage!.inputTokens)} / Out: ${formatTokens(usage!.outputTokens)}`}>
              {formatCost(usage!.costUsd)}{costRate ? ` · ${costRate}` : ''}
            </span>
            {usage!.pricingQuality === 'fallback' && (
              <span
                className="pricing-fallback-badge"
                title="Estimated: priced with fallback (Sonnet) rates because exact pricing for this model was unavailable."
              >
                ~ estimated
              </span>
            )}
          </Fact>
        )}
        {tokenCount > 0 && (
          <Fact label="Tokens">
            <span className="detail-tokens">{formatTokens(tokenCount)} tok</span>
          </Fact>
        )}
        {hasCacheReads && (
          <Fact label="Cache">
            <span
              className="detail-tokens"
              title="Cache-hit % = cacheReadTokens / (inputTokens + cacheReadTokens): share of input served from the prompt cache"
            >
              {formatTokens(usage!.cacheReadTokens)} rd · {formatCacheHit(usage)} hit
            </span>
          </Fact>
        )}
        {agent.taskId && (
          <Fact label="Pull request" testId="detail-fact-pr">
            {firstPr ? (
              <a href={firstPr.ref.url} target="_blank" rel="noopener noreferrer" title={firstPr.title}>
                #{firstPr.ref.number}{prs.length > 1 ? ` +${prs.length - 1}` : ''}
              </a>
            ) : 'none yet'}
          </Fact>
        )}
      </dl>
      {agent.taskId && (
        <div className="detail-facts-section">
          <TaskDependencyEditor agent={agent} />
          <TaskDependencyRail agent={agent} />
        </div>
      )}
      {agent.taskId && <TaskTimeline agent={agent} />}
      <div className="detail-facts-links">
        <TaskIdCopyButton taskId={agent.taskId} />
        <DashboardLinkCopyButton taskId={agent.taskId} />
        {agent.taskId && (
          <button
            type="button"
            data-testid="task-share-button"
            className={`action-btn action-btn--neutral task-share-header-button task-share-header-button--${shareStatus.kind}`}
            title={shareStatus.title}
            aria-label={shareStatus.title}
            onClick={onShare}
          >
            <span>{shareStatus.buttonLabel}</span>
            {shareStatus.badgeLabel && (
              <span className="task-share-header-badge">{shareStatus.badgeLabel}</span>
            )}
          </button>
        )}
        {agent.description && (
          <details className="detail-facts-prompt">
            <summary>View full prompt</summary>
            <div className="detail-facts-prompt-text">{agent.description}</div>
          </details>
        )}
      </div>
    </aside>
  );
}
