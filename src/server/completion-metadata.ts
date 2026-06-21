import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexRolloutScanner, type DiscoveryOutcome } from '../adapters/codex-rollout-scanner.js';
import { createOpenRouterLlmClientFromEnv } from '../adapters/llm/openrouter-client.js';
import { createRequestyLlmClientFromEnv } from '../adapters/llm/requesty-client.js';
import { generateCompletionDigest, type CompletionDigest, type CompletionTokenUsage } from '../core/completion-digest.js';
import { evaluateCriteriaVerdict } from '../core/criteria-verdict.js';
import { createLlmClient } from '../adapters/llm/factory.js';
import type { LlmClient } from '../core/llm-types.js';
import { estimateCost, lookupPricing } from '../core/pricing-tables.js';
import type { Task } from '../core/tasks.js';
import type { AgentEvent, TokenUsage } from '../core/types.js';

const execFileAsync = promisify(execFile);

export type CompletionCommandRunner = (
  command: string,
  args: string[],
  opts: { cwd: string },
) => Promise<string>;

export interface CompletionScanner {
  scan(windowStartMs: number, windowEndMs: number): Promise<{ rollouts: unknown[] }>;
  bindTasks(
    rollouts: unknown[],
    tasks: Array<{ taskId: string; cwd: string; createdAtMs: number }>,
  ): { outcomes: Map<string, DiscoveryOutcome> };
}

export interface CompletionMetadataDeps {
  runCommand?: CompletionCommandRunner;
  scanner?: CompletionScanner;
  now?: () => number;
  criteriaVerdictLlmClient?: LlmClient | null;
}

export interface TaskCompletionMetadata {
  digest: CompletionDigest;
  taskTokenUsage?: TokenUsage;
}

let criteriaVerdictLlmClientPromise: Promise<LlmClient | null> | null = null;

export async function buildTaskCompletionMetadata(
  task: Task,
  events: AgentEvent[],
  deps: CompletionMetadataDeps = {},
): Promise<TaskCompletionMetadata> {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const git = await collectGitMetadata(task, runCommand);
  const codexUsage = task.agentType === 'codex-cli'
    ? await collectCodexUsage(task, deps.scanner ?? new CodexRolloutScanner(), deps.now ?? (() => Date.now()))
    : undefined;

  const digest = generateCompletionDigest(events, {
    branch: git.branch,
    commits: git.commits,
    prUrls: git.prUrls,
    filesChanged: git.filesChanged,
    tokenUsage: codexUsage?.digestUsage,
  });
  if (task.criteria?.trim()) {
    const criteriaVerdict = await evaluateCriteriaVerdict({
      criteria: task.criteria,
      events,
      llmClient: await resolveCriteriaVerdictLlmClient(deps),
    });
    if (criteriaVerdict) digest.criteriaVerdict = criteriaVerdict;
  }

  return {
    digest,
    taskTokenUsage: codexUsage?.taskTokenUsage,
  };
}

async function resolveCriteriaVerdictLlmClient(deps: CompletionMetadataDeps): Promise<LlmClient | null> {
  if ('criteriaVerdictLlmClient' in deps) return deps.criteriaVerdictLlmClient ?? null;
  criteriaVerdictLlmClientPromise ??= createLlmClient({
    buildOpenRouter: createOpenRouterLlmClientFromEnv,
    buildRequesty: createRequestyLlmClientFromEnv,
  });
  return criteriaVerdictLlmClientPromise;
}

async function defaultRunCommand(command: string, args: string[], opts: { cwd: string }): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: opts.cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function collectGitMetadata(
  task: Task,
  runCommand: CompletionCommandRunner,
): Promise<{ branch?: string; commits?: string[]; filesChanged?: string[]; prUrls?: string[] }> {
  const cwd = latestSessionCwd(task);
  if (!cwd) return {};

  const branch = await bestEffort(() => runCommand('git', ['branch', '--show-current'], { cwd }));
  const base = await resolveMergeBase(cwd, runCommand);
  const commits = base
    ? splitLines(await bestEffort(() => runCommand('git', ['log', '--format=%H', `${base}..HEAD`], { cwd })))
    : [];
  const filesChanged = base
    ? splitLines(await bestEffort(() => runCommand('git', ['diff', '--name-only', `${base}...HEAD`], { cwd })))
    : [];
  const prUrl = await bestEffort(() => runCommand('gh', ['pr', 'view', '--json', 'url', '--jq', '.url'], { cwd }));

  return {
    ...(branch.trim() ? { branch: branch.trim() } : {}),
    ...(commits.length > 0 ? { commits } : {}),
    ...(filesChanged.length > 0 ? { filesChanged } : {}),
    ...(prUrl.trim() ? { prUrls: [prUrl.trim()] } : {}),
  };
}

async function resolveMergeBase(cwd: string, runCommand: CompletionCommandRunner): Promise<string> {
  for (const baseRef of ['origin/main', 'origin/staging', 'origin/master']) {
    const out = await bestEffort(() => runCommand('git', ['merge-base', baseRef, 'HEAD'], { cwd }));
    if (out.trim()) return out.trim();
  }
  return '';
}

async function collectCodexUsage(
  task: Task,
  scanner: CompletionScanner,
  now: () => number,
): Promise<{ digestUsage: CompletionTokenUsage; taskTokenUsage?: TokenUsage }> {
  const sessionCwd = latestSessionCwd(task) ?? task.cwd;
  const createdAtMs = task.createdAt instanceof Date ? task.createdAt.getTime() : new Date(task.createdAt).getTime();
  try {
    const scan = await scanner.scan(createdAtMs - 60_000, now());
    const { outcomes } = scanner.bindTasks(scan.rollouts, [{ taskId: task.id, cwd: sessionCwd, createdAtMs }]);
    const outcome = outcomes.get(task.id);
    return usageFromOutcome(outcome);
  } catch (err) {
    return {
      digestUsage: unavailableUsage('parse-error', `Codex rollout scan failed: ${(err as Error).message}`),
    };
  }
}

function usageFromOutcome(outcome: DiscoveryOutcome | undefined): { digestUsage: CompletionTokenUsage; taskTokenUsage?: TokenUsage } {
  if (!outcome || outcome.kind === 'not-found') {
    return {
      digestUsage: unavailableUsage('rollout-not-found', 'No Codex rollout matched this task'),
    };
  }
  if (outcome.kind === 'abandoned') {
    return {
      digestUsage: unavailableUsage('rollout-abandoned', 'Codex rollout ended without terminal token telemetry'),
    };
  }

  const binding = outcome.binding;
  if (binding.hasParseError) {
    return {
      digestUsage: unavailableUsage('parse-error', 'Codex rollout token schema could not be parsed'),
    };
  }
  if (!binding.hasTokenData) {
    return {
      digestUsage: unavailableUsage('unavailable', 'Codex rollout has no token telemetry'),
    };
  }

  const inputTokens = Math.max(0, binding.totalInputTokens - binding.totalCachedInputTokens);
  const outputTokens = binding.totalOutputTokens;
  const cacheReadTokens = binding.totalCachedInputTokens;
  const cacheWriteTokens = 0;
  const pricing = binding.model ? lookupPricing(binding.model) : null;
  const costUsd = pricing
    ? estimateCost(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, pricing)
    : null;
  const quality = costUsd == null ? 'unknown-pricing' : 'available';
  const digestUsage: CompletionTokenUsage = {
    source: 'codex-rollout',
    quality,
    model: binding.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    ...(quality === 'unknown-pricing' ? { reason: `No pricing row for model ${binding.model ?? '<unknown>'}` } : {}),
  };

  return {
    digestUsage,
    ...(costUsd != null ? {
      taskTokenUsage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
      },
    } : {}),
  };
}

function unavailableUsage(
  quality: Exclude<CompletionTokenUsage['quality'], 'available' | 'unknown-pricing'>,
  reason: string,
): CompletionTokenUsage {
  return {
    source: 'codex-rollout',
    quality,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    reason,
  };
}

function latestSessionCwd(task: Task): string | undefined {
  return task.sessions[task.sessions.length - 1]?.cwd ?? task.cwd;
}

async function bestEffort(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch {
    return '';
  }
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
