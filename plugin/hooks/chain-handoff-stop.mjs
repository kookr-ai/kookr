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
// It stays silent while the agent is parked on its own background work, when a
// task not flagged `unattended: true` ends its turn on a question to the
// operator (issue #4047), outside a Kookr task, and on any error (fail open).
//
// It does not rely on `stop_hook_active`: when another Stop hook (such as
// delivery-step-stop) blocked first, the agent's next stop carries that flag,
// and that next stop is often the end of the unit. Instead it blocks at most
// MAX_BLOCKS times per task, counted in a small file under the temp directory.
// Once the task has handed off (child or signal seen), the counter is set to the
// limit, so a later stop is not blocked after an operator message clears the
// signal. Known limits: any child task counts as the successor; an unflagged
// task that asks its question without a question mark still uses up the
// blocks; and an unflagged task that nobody watches can still end on a real
// question (only its last line, or the line before an option list, counts,
// and an offer to continue the chain never does: issue #4089).
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
 *   - `You are continuing a sequential Kookr task chain (continuation envelope vN)`
 *     at the start of a line  (the continuation envelope header)
 */
export function isSelfContinuationTask(task) {
  if (!task) return false;
  const param = task.playbookParameterValues?.selfContinuation;
  if (typeof param === 'string') return param === 'true' || param === '1';
  const text = `${task.prompt ?? ''}\n${task.userPrompt ?? ''}`;
  return (
    /^\s*-\s*self-continuation:\s*`?true`?\s*$/im.test(text) ||
    /\*\*Self-continuation\*\*\s*[—–-]+\s*`true`/.test(text) ||
    /^You are continuing a sequential Kookr task chain \(continuation envelope v\d+\)/m.test(text)
  );
}

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;
const QUESTION_END = /\?[\s*_`'"’”)\]]*$/;
/** Lines of an option list that may follow the question. */
const MAX_OPTION_LINES = 6;
// A closing offer to keep the chain going ("Want me to continue with the next
// issue?", "Shall I proceed?", "Next issue?"). The chain contract already
// answers it (yes), so it is not a question the operator must answer. This is
// a best-effort denylist, biased toward "offer": a real decision misread as an
// offer only costs a bounded block, while an offer misread as a question
// breaks the chain (issue #4089).
const OFFER_OPENER = /\b(?:want me to|would you like me to|shall i|should i|can i|may i|ready to|ok(?:ay)? to)\b/i;
const CONTINUE_VERB =
  '(?:continue|proceed|move on|move|go on|go ahead|carry on|keep going|start|begin|spawn|launch|pick up|tackle|work on|take on|take)';
const STARTS_WITH_CONTINUE = new RegExp(`^${CONTINUE_VERB}\\b`, 'i');
const NEXT_UNIT = /\b(?:next|remaining|another|successor|rest|following|chain|queue|batch)\b/i;
// A continuation verb with only a short tail: "Shall I proceed?", "Should I continue with issue #14 now?"
const CONTINUE_SHORT_TAIL = new RegExp(
  `\\b${CONTINUE_VERB}(?:\\s+(?:with|on|to|the|issue|unit|task|pr|it|this|that|now|then|here|#\\d+))*\\s*\\?`,
  'i',
);

/** The last sentence of a line, stripped of markdown emphasis and quotes. */
function lastSentence(line) {
  const bare = line.replace(/[*_`'"’”“]/g, '').trim();
  const parts = bare.split(/(?<=[.!:?])\s+/);
  return parts[parts.length - 1];
}

/** True when the question is an offer to continue the chain rather than a decision. */
export function isClosingOffer(line) {
  const sentence = lastSentence(line);
  if (!OFFER_OPENER.test(sentence) && !STARTS_WITH_CONTINUE.test(sentence) && !/^next\b/i.test(sentence)) return false;
  return NEXT_UNIT.test(sentence) || CONTINUE_SHORT_TAIL.test(sentence);
}

/**
 * True when the agent's last message ends on a question to the operator: its
 * last non-empty line ends in `?`, or that line is followed only by a short
 * list of options ("Pick one?" then "- A", "- B"). The question line itself
 * must not be a list item, so a summary bullet ending in `?` does not count,
 * and a closing offer to continue the chain ("Want me to continue with the
 * next issue?") does not count either (issue #4089). Markdown emphasis and
 * closing quotes or brackets after the `?` are ignored. A missing or empty
 * message is not a question. Known gaps: a question followed by a prose
 * trailer ("I recommend 1.") or by options that are not list items no longer
 * counts, and a header-style question above summary bullets ("What's next?"
 * then "- #14") still does.
 */
export function endsWithQuestion(message) {
  if (typeof message !== 'string') return false;
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let i = lines.length - 1;
  let options = 0;
  while (i >= 0 && LIST_ITEM.test(lines[i])) {
    i -= 1;
    options += 1;
  }
  if (i < 0 || options > MAX_OPTION_LINES) return false;
  const line = lines[i];
  return QUESTION_END.test(line) && !isClosingOffer(line);
}

/**
 * True when the agent is waiting on an operator who may be there to answer:
 * the task is not flagged `unattended: true` and the last message asks a
 * question (issue #4047). The flag alone is not enough: 49 of 222 real chain
 * tasks had none, so an unflagged task that ends its turn silently is still
 * blocked; only one that ends on a question is let through. A task flagged
 * unattended is always blocked, since nobody will answer it.
 */
export function isAskingOperator(event, task) {
  if (task?.unattended === true) return false;
  return endsWithQuestion(event?.last_assistant_message);
}

/** True once the task spawned a child or raised a completion signal. */
export function hasHandedOff(task) {
  if (Array.isArray(task?.childTaskIds) && task.childTaskIds.length > 0) return true;
  return Boolean(task?.pendingSignal || task?.finishedSignalAt);
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
  if (hasHandedOff(task)) return null;
  if (isAskingOperator(event, task)) return null;
  return [
    'This is a self-continuation chain task, and it is ending its turn with no successor task and no recorded stop reason.',
    'Nobody will resume this session: if it stops here, the chain breaks and the task looks like a crash.',
    '- If the current unit is not finished (for example you are waiting on CI or a review), do not end the turn: wait in the foreground and finish the unit.',
    '- If the unit reached a terminal outcome (merged, closed, quarantined, blocker recorded) and an eligible unit remains, spawn the successor now:',
    '  kookr spawn -C <repository checkout> --prompt-file <file> --parent-task-id "$KOOKR_TASK_ID" --unattended --json </dev/null',
    '  (-C sets the child\'s working directory and project; never spawn from the scratchpad without it.)',
    '- If you already spawned the successor without --parent-task-id, do not spawn a second one: record the existing child instead:',
    '  kookr signal completion-ready --note "successor <task id> spawned"',
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
    const task = await fetchTask(taskId);
    // Latch: once the task handed off, later stops are allowed even if the
    // signal is cleared (an operator follow-up message clears it).
    if (hasHandedOff(task)) {
      writeBlockCount(taskId, MAX_BLOCKS);
      return 0;
    }
    const reason = decide({ event, task, priorBlocks });
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
