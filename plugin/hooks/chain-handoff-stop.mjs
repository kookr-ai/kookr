#!/usr/bin/env node
// Stop hook — a self-continuation chain task must not end its turn with no
// successor and no recorded stop reason (issue #3678).
//
// A self-continuation task does one unit of work and then either spawns the
// next task of the chain (`kookr spawn ... --parent-task-id`) or records why the
// chain stops (`kookr signal completion-ready --note ...`). The playbook states
// this as a "mandatory completion gate", but only in prose: a chain task that
// ended its turn without either left a terminated task that looked like a
// crash, with eligible work still open (task d850beb1), and another sat silent
// for hours waiting on CI until the hung-task reaper took it (task c29a86b9).
//
// This hook blocks the stop, with an instruction, when the task:
//   - is a self-continuation task (playbook parameter `selfContinuation=true`,
//     or the prompt markers the playbook and the continuation envelope render),
//   - is not a playbook-chain iteration (Kookr launches those itself) and not an
//     active Ralph loop (the loop chains on its own),
//   - has no child task, and
//   - has raised no completion signal (the recorded stop reason).
// It stays silent while the agent is parked on its own background work, outside
// a Kookr task, and on any error (fail open).
//
// It does not rely on `stop_hook_active`: when another Stop hook (such as
// delivery-step-stop) blocked first, the agent's next stop carries that flag,
// and that next stop is often the end of the unit. Instead it blocks at most
// MAX_BLOCKS times per task, counted in a small file under the temp directory.
// Opt out: KOOKR_CHAIN_HANDOFF_STOP_SKIP=1.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isParked } from './delivery-step-stop.mjs';

/** Blocks per task before the hook lets every stop through (a stuck agent must still be able to stop). */
export const MAX_BLOCKS = 3;

/**
 * True when the task is one link of a self-continuation chain. An explicit
 * `selfContinuation` playbook parameter decides; otherwise the prompt markers:
 *   - `- self-continuation: true`  (parameter list in hand-written successor prompts)
 *   - `**Self-continuation** — \`true\``  (the rendered implement-github-issue playbook)
 *   - `You are continuing a sequential Kookr task chain`  (the continuation envelope header)
 */
export function isSelfContinuationTask(task) {
  if (!task) return false;
  const param = task.playbookParameterValues?.selfContinuation;
  if (typeof param === 'string') return param === 'true' || param === '1';
  const text = `${task.prompt ?? ''}\n${task.userPrompt ?? ''}`;
  return (
    /^\s*-\s*self-continuation:\s*`?true`?\s*$/im.test(text) ||
    /\*\*Self-continuation\*\*\s*[—–-]+\s*`true`/.test(text) ||
    /You are continuing a sequential Kookr task chain/.test(text)
  );
}

/**
 * Pure decision. Returns a block reason string, or null to allow the stop.
 * task: the task JSON from GET /api/tasks/:id; priorBlocks: how many times this
 * hook already blocked this task.
 */
export function decide({ event, task, priorBlocks = 0 }) {
  if (!event || !task) return null;
  if (isParked(event)) return null;
  if (priorBlocks >= MAX_BLOCKS) return null;
  if (task.status !== undefined && task.status !== 'inProgress') return null;
  if (!isSelfContinuationTask(task)) return null;
  if (task.chain) return null;
  if (task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused') return null;
  if (Array.isArray(task.childTaskIds) && task.childTaskIds.length > 0) return null;
  if (task.pendingSignal || task.finishedSignalAt) return null;
  return [
    'This is a self-continuation chain task, and it is ending its turn with no successor task and no recorded stop reason.',
    'Nobody will resume this session: if it stops here, the chain breaks and the task looks like a crash.',
    '- If the current unit is not finished (for example you are waiting on CI or a review), do not end the turn: wait in the foreground and finish the unit.',
    '- If the unit reached a terminal outcome (merged, closed, quarantined, blocker recorded) and an eligible unit remains, spawn the successor now:',
    '  kookr spawn -C <repository checkout> --prompt-file <file> --parent-task-id "$KOOKR_TASK_ID" --unattended --json </dev/null',
    '  (-C sets the child\'s working directory and project; never spawn from the scratchpad without it.)',
    '- If no eligible unit remains or the chain must stop, record why: kookr signal completion-ready --note "chain end: <reason>"',
    'See the self-continuation-task skill (Handoff Procedure).',
  ].join('\n');
}

function counterFile(taskId) {
  return path.join(tmpdir(), 'kookr-chain-handoff-stop', `${taskId}.count`);
}

export function readBlockCount(taskId) {
  try {
    const n = Number.parseInt(readFileSync(counterFile(taskId), 'utf-8'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeBlockCount(taskId, count) {
  try {
    mkdirSync(path.dirname(counterFile(taskId)), { recursive: true });
    writeFileSync(counterFile(taskId), String(count));
  } catch {
    /* best effort: without the file the hook may block again, still bounded by the agent's own stops */
  }
}

async function fetchTask(id) {
  const base = process.env.KOOKR_API_BASE_URL || 'http://127.0.0.1:4800';
  try {
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const task = await res.json();
    return task?.task && !task.prompt ? task.task : task;
  } catch {
    return null;
  }
}

async function main() {
  if (process.env.KOOKR_CHAIN_HANDOFF_STOP_SKIP === '1') return 0;
  const taskId = process.env.KOOKR_TASK_ID;
  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId)) return 0;
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return 0;
  }
  try {
    if (isParked(event)) return 0;
    const priorBlocks = readBlockCount(taskId);
    if (priorBlocks >= MAX_BLOCKS) return 0;
    const reason = decide({ event, task: await fetchTask(taskId), priorBlocks });
    if (!reason) return 0;
    writeBlockCount(taskId, priorBlocks + 1);
    process.stderr.write(`${reason}\n(This hook blocks at most ${MAX_BLOCKS} times per task.)\n`);
    return 2;
  } catch {
    return 0; // fail open: a session must always be able to end
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
