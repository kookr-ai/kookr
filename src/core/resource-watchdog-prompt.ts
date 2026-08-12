/**
 * Investigation + meta-reflection prompt templates for the resource watchdog
 * (issue #1724). Embeds the autonomous hard-rules block so a spawned agent
 * never hangs on interactive prompts and never kills non-kookr processes.
 */

import { redactSecrets } from './redact-secrets.js';
import type {
  ResourceWatchdogSample,
  ResourceWatchdogSpawnKind,
  ResourceWatchdogTrigger,
} from './resource-watchdog-types.js';

/**
 * Scrub free-text tails before they land in investigation/meta prompts.
 * Defense-in-depth: even if a caller passes an unredacted string, the brief
 * never embeds raw Authorization/Bearer/token shapes (issue #2346).
 */
function scrubBriefTail(text: string): string {
  return redactSecrets(text);
}

const HARD_RULES_BLOCK = `## 0. HARD RULES — read first (NON-NEGOTIABLE)
- **NO INTERACTIVE PROMPTS, EVER.** Never call AskUserQuestion or any clarification/confirmation prompt — it HANGS forever.
- **ON ANY BLOCKER → WRITE-FILE-AND-STOP.** Write \`runs/operator-needed-resource-pressure.md\` at the worktree root (exact problem + file:line evidence), then STOP with a report.
- **REVERSIBLE REMEDIATION ONLY.** You may reap orphaned kookr-owned sessions via existing kookr mechanisms, free disk under \`~/.kookr\` with documented maintenance tools, and file GitHub issues. You may NOT kill non-kookr-owned processes, user terminals, IDE processes, or anything outside kookr session sockets. You may NOT run \`rm -rf\` outside clearly-aged kookr data-dir prune paths.
- **NEVER kill a process you cannot prove is kookr-owned** (dtach socket under this instance's socket dir, or a task-store session id). When in doubt, leave it and file an issue.
- **Durable code fixes go through issues/PRs**, not ad-hoc edits from this remediation task.
- **STRICT SCOPE.** Investigate resource pressure, apply reversible temporary remediation, file pinpointed root-cause issues, report. Do not merge PRs. Do not redeploy prod. Do not restart the prod server unless the operator has already authorized it in a runbook you are following.
- **TERMINAL ACTION:** write a short report under \`runs/resource-pressure-report.md\` and signal completion-ready.`;

function formatSample(sample: ResourceWatchdogSample): string {
  const lines = [
    `sampledAt: ${sample.sampledAt}`,
    `swapUsedPercent: ${sample.swapUsedPercent === null ? 'n/a' : `${sample.swapUsedPercent.toFixed(1)}%`}`,
    `memAvailableMb: ${sample.memAvailableMb === null ? 'n/a' : sample.memAvailableMb.toFixed(0)}`,
    `oomKillTotal: ${sample.oomKillTotal === null ? 'n/a' : sample.oomKillTotal}`,
    `processCounts: claude=${sample.processCounts.claude} grok=${sample.processCounts.grok} codex=${sample.processCounts.codex} dtach=${sample.processCounts.dtach}`,
    `orphanSessionCount: ${sample.orphanSessionCount}`,
    `terminalLeakCount: ${sample.terminalLeakCount}`,
  ];
  if (sample.topConsumers.length > 0) {
    lines.push('topConsumers (rss):');
    for (const c of sample.topConsumers.slice(0, 15)) {
      lines.push(`  - pid=${c.pid} rssKb=${c.rssKb} cmd=${c.command.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}

function formatTriggers(triggers: ResourceWatchdogTrigger[]): string {
  return triggers.map((t) => `- ${t.reason}: ${t.detail}`).join('\n');
}

export interface BuildResourceWatchdogPromptInput {
  kind: ResourceWatchdogSpawnKind;
  sample: ResourceWatchdogSample;
  triggers: ResourceWatchdogTrigger[];
  spawnsInWindow: number;
  spawnBudget24h: number;
  /** Optional tail of server.log (already truncated by the service). */
  serverLogTail?: string;
  /** Optional last N audit lines (already truncated). */
  recentAuditTail?: string;
}

export function buildResourceWatchdogPrompt(
  input: BuildResourceWatchdogPromptInput,
): string {
  if (input.kind === 'meta_reflection') {
    return buildMetaReflectionPrompt(input);
  }
  return buildInvestigationPrompt(input);
}

function buildInvestigationPrompt(input: BuildResourceWatchdogPromptInput): string {
  const parts = [
    '# Resource watchdog investigation (issue #1724)',
    '',
    'You were spawned automatically because the Kookr resource watchdog detected host pressure.',
    'Your job is to investigate, apply *reversible* temporary remediation, file pinpointed root-cause issues, and leave the host more operable.',
    '',
    HARD_RULES_BLOCK,
    '',
    '## Triggers',
    formatTriggers(input.triggers),
    '',
    '## Resource snapshot',
    '```',
    formatSample(input.sample),
    '```',
    '',
    '## Suggested investigation steps',
    '1. Confirm current pressure: `free -h`, `swapon --show`, `cat /proc/vmstat | grep oom_kill`, process counts for claude/grok/codex/dtach.',
    '2. Cross-check kookr session inventory vs task table (`GET /api/health` sessionReaper block; `kookr status` if available). Prefer calling any existing orphan reaper / maintenance path over inventing kill logic.',
    '3. Apply reversible remediation only for kookr-owned leaks (orphan sessions, aged data-dir cruft via documented prune).',
    '4. File GitHub issue(s) on kookr-ai/kookr naming the root cause class, with evidence (counts, ages, sample JSON).',
    '5. Write `runs/resource-pressure-report.md` with: what you found, what you changed, issues filed, residual risk.',
    '',
    '## Spawn budget context',
    `Spawns in the last 24h before this one: ${input.spawnsInWindow} (budget before meta-reflection: ${input.spawnBudget24h}).`,
  ];

  if (input.serverLogTail) {
    parts.push('', '## Recent server.log (tail)', '```', scrubBriefTail(input.serverLogTail), '```');
  }
  if (input.recentAuditTail) {
    parts.push('', '## Recent watchdog audit lines', '```', scrubBriefTail(input.recentAuditTail), '```');
  }

  return parts.join('\n');
}

function buildMetaReflectionPrompt(input: BuildResourceWatchdogPromptInput): string {
  const parts = [
    '# Resource watchdog meta-reflection (issue #1724)',
    '',
    'The resource watchdog has spawned investigation tasks at or above its rolling 24h budget.',
    'Pressure should be spiky and occasional — chronic firing means wrong thresholds, an unfixed root cause, or a new regression.',
    '',
    HARD_RULES_BLOCK,
    '',
    '## Why you were spawned',
    `Spawns in the last 24h before this one: ${input.spawnsInWindow} (budget: ${input.spawnBudget24h}).`,
    'This is a *meta-reflection* task, not another investigation of the same spike.',
    '',
    '## Latest triggers',
    formatTriggers(input.triggers),
    '',
    '## Latest resource snapshot',
    '```',
    formatSample(input.sample),
    '```',
    '',
    '## Your job',
    '1. Read the watchdog audit trail (`~/.kookr/resource-watchdog-audit.jsonl` or the data-dir equivalent) and summarize why spawns are chronic.',
    '2. Distinguish: wrong thresholds vs unfixed root cause vs new regression vs thrashing (remediation not sticking).',
    '3. Propose concrete changes: threshold env vars, new detectors, missing reapers, capacity policy — as GitHub issues, not silent edits.',
    '4. Apply only the same reversible kookr-owned remediations an investigation task may apply, if pressure is still acute.',
    '5. Write `runs/resource-watchdog-meta-reflection.md` with diagnosis + recommended next actions.',
  ];

  if (input.recentAuditTail) {
    parts.push('', '## Recent watchdog audit lines', '```', scrubBriefTail(input.recentAuditTail), '```');
  }
  if (input.serverLogTail) {
    parts.push('', '## Recent server.log (tail)', '```', scrubBriefTail(input.serverLogTail), '```');
  }

  return parts.join('\n');
}

export function resourceWatchdogTaskName(kind: ResourceWatchdogSpawnKind): string {
  return kind === 'meta_reflection'
    ? 'Resource watchdog meta-reflection'
    : 'Resource watchdog investigation';
}
