/**
 * One item of each inbox kind, in two projects (issue #3931 acceptance). Used
 * by the server, `kookr brief` and Telegram `/brief` tests, so all three
 * surfaces are checked against the same inbox.
 *
 * Planted text that must never reach Telegram: the permission command
 * (`PLANTED_COMMAND`) sits in the tool input AND in the finding explanation,
 * the flagged task's error text sits in its explanation, and a
 * credential-shaped token sits in a task name and in the question.
 */
import type { AgentEvent } from '../../src/core/agent-events.js';
import type { Anomaly } from '../../src/shared/contracts/anomalies.js';
import type { AskRecord } from '../../src/shared/contracts/asks.js';
import type { IntegrationTrainHealth } from '../../src/server/integration-train-monitor.js';
import { buildOperatorInbox, type OperatorInboxSources, type OperatorInboxTask } from '../../src/server/operator-inbox.js';

export const NOW = Date.parse('2026-11-16T12:00:00Z');
const min = (n: number): number => NOW - n * 60_000;

export const KOOKR_CWD = '/home/op/git/kookr';
export const WEBSITE_CWD = '/home/op/git/website';
export const PLANTED_COMMAND = 'git push --force origin release-branch';
export const PLANTED_ERROR = 'npm ERR! could not resolve dependency tree near line forty';
export const PLANTED_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // pragma: allowlist secret (fake token planted to prove redaction)

function task(id: string, cwd: string, extra: Partial<OperatorInboxTask> = {}): OperatorInboxTask {
  return {
    id,
    name: `Task ${id}`,
    status: 'inProgress',
    cwd,
    sessions: [{ tmuxSession: `s-${id}` } as OperatorInboxTask['sessions'][number]],
    ...extra,
  };
}

function anomaly(agentId: string, type: Anomaly['type'], explanation: string, detectedAt: number): Anomaly {
  return { agentId, type, severity: 'warning', explanation, detectedAt: new Date(detectedAt) };
}

export function fixtureSources(overrides: Partial<OperatorInboxSources> = {}): OperatorInboxSources {
  const liveTasks: OperatorInboxTask[] = [
    task('perm', KOOKR_CWD, { name: 'Release the build' }),
    task('ask', WEBSITE_CWD, { name: 'Redesign settings page' }),
    task('flag', WEBSITE_CWD, { name: `Upgrade dependencies ${PLANTED_TOKEN}` }),
    task('review', KOOKR_CWD, {
      name: 'Fix login redirect',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(min(20)).toISOString() },
    }),
    task('work', KOOKR_CWD, { name: 'Quietly working' }),
  ];
  const anomalies = new Map<string, Anomaly>([
    ['s-perm', anomaly('s-perm', 'permission_blocked', `Permission requested for tool: Bash (${PLANTED_COMMAND})`, min(50))],
    ['s-flag', anomaly('s-flag', 'repeated_error', `Same error 4 times: ${PLANTED_ERROR}`, min(30))],
  ]);
  const events = new Map<string, AgentEvent[]>([
    ['s-perm', [{ type: 'permission_request', sessionId: 's-perm', toolName: 'Bash', toolInput: { command: PLANTED_COMMAND } }]],
  ]);
  const asks: AskRecord[] = [{
    id: 'a1b2c3d4e5f6',
    taskId: 'ask',
    question: `Which layout should the settings page use? (${PLANTED_TOKEN})`,
    options: ['Compact list', 'Cards'],
    allowText: true,
    state: 'pending',
    createdAt: min(40),
    expiresAt: min(-60),
    nonce: 'n',
    delivery: { chatId: 1, messageId: 2 },
  }];
  const train: IntegrationTrainHealth = {
    integrationBranch: 'staging',
    running: true,
    pid: 42,
    halted: { reason: 'base-red', at: new Date(min(10)).toISOString() },
    lastCycle: { at: new Date(min(10)).toISOString(), outcome: 'halted', detail: `verify failed: ${PLANTED_ERROR}` },
    restartPending: null,
    pendingSince: new Date(min(15)).toISOString(),
    alerting: true,
    checkedAt: new Date(min(1)).toISOString(),
  };
  return {
    liveTasks,
    monitor: {
      getCurrentAnomaly: (id) => anomalies.get(id) ?? null,
      getAgentEvents: (id) => events.get(id) ?? [],
      getAgentState: (id) => ({ anomaly: anomalies.get(id) ?? null }),
    },
    asks,
    train,
    now: NOW,
    ...overrides,
  };
}

export function fixtureInbox(overrides: Partial<OperatorInboxSources> = {}) {
  return buildOperatorInbox(fixtureSources(overrides));
}
