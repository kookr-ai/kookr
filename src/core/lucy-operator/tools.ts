/**
 * The tools Lucy may call in this step, and the one place where a tool call from the
 * model is turned into something the server does.
 *
 * Every tool here only looks. There is no tool that launches, replies to, closes,
 * snoozes or aborts a task, so nothing a task wrote can make her act: an instruction
 * hidden in task output can at most make her read something else.
 *
 * {@link dispatchLucyTool} is the safety boundary. The model's output is untrusted too,
 * so the dispatcher, not the prompt, decides what runs:
 * - a tool name that is not in {@link LUCY_LOOK_TOOLS} is refused and nothing is called;
 * - arguments that are not a JSON object, or that fail validation, are refused;
 * - whatever a look-up returns has its secrets hidden and its length capped before the
 *   model sees it, because that text is sent to a provider outside this machine.
 */

import type { LlmFunctionTool } from '../llm-types.js';
import { LUCY_LOOK_TOOL_NAMES, type LucyLookToolName } from '../../shared/contracts/lucy-turn.js';
import { redactSpeechSecrets } from '../task-speech-summary.js';
import { agoWords, boardText, buildLucyBoard, resolveTaskRef, spokenLabel, type LucyBoardInput, type LucyBoardTask } from './board.js';

/** More about one task than the board shows. Every string here was written by an agent or pasted by the operator. */
export interface LucyTaskDetail {
  /** The request the task was launched with. */
  prompt?: string;
  agentType?: string;
  /** Folder the task works in. */
  cwd?: string;
  createdAt?: Date | string | number;
  /** A signal the task raised for the operator and that is still waiting, in Kookr's words. */
  pendingSignal?: string;
  /** The task's own closing summary, when it wrote one. */
  completionSummary?: string;
  /** Pull requests or issues the task is linked to, as short references such as "PR #12". */
  references?: readonly string[];
}

export interface LucyTaskOutput {
  text: string;
  /** `live`: read from the running terminal. `persisted`: the tail saved when the task ended. */
  source: 'live' | 'persisted';
}

export interface LucyProjectLine {
  name: string;
  activeTasks: number;
  findings: number;
}

/** Where the look tools get their facts. The server implements this over its stores; tests use a fake. */
export interface LucyLookSource {
  /** Fresh snapshot for the board; called at the start of a turn and again by `read_board`. */
  board(): LucyBoardInput;
  taskDetail(taskId: string): LucyTaskDetail | null;
  taskOutput(taskId: string, lines: number): Promise<LucyTaskOutput | null>;
  projects(): Promise<readonly LucyProjectLine[]>;
}

export const DEFAULT_OUTPUT_LINES = 40;
export const MAX_OUTPUT_LINES = 120;
/** Caps on what one look-up may send to the model, in characters. */
export const MAX_TASK_DETAIL_CHARS = 2500;
export const MAX_TASK_OUTPUT_CHARS = 6000;
export const MAX_PROJECT_LINES = 30;

const TASK_PARAM = {
  type: 'string',
  description: 'The code shown in square brackets before the task on the board, for example "3f2a".',
} as const;

function tool(name: LucyLookToolName, description: string, properties: Record<string, unknown>, required: string[]): LlmFunctionTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

/** The complete tool list sent to the model. Adding a tool that changes something does not belong in this file. */
export const LUCY_LOOK_TOOLS: readonly LlmFunctionTool[] = [
  tool('read_board', 'Read the current board again: what needs the operator, what is working, what just finished, spend and quota.', {}, []),
  tool('read_task', 'Read more about one task: what it was asked to do, where it runs, what it is waiting for, and its closing summary if it ended.', { task: TASK_PARAM }, ['task']),
  tool(
    'read_task_output',
    'Read the last lines of one task\'s terminal output. Use it to say what a task is doing right now or why it stopped.',
    { task: TASK_PARAM, lines: { type: 'integer', description: `How many lines to read, at most ${MAX_OUTPUT_LINES}. Default ${DEFAULT_OUTPUT_LINES}.` } },
    ['task'],
  ),
  tool('show_task', 'Open one task on the operator\'s screen. It changes nothing in the task.', { task: TASK_PARAM }, ['task']),
  tool('list_projects', 'List the projects Kookr knows, with how many tasks are active in each.', {}, []),
];

export interface LucyToolOutcome {
  ok: boolean;
  /** What the model reads as the tool's answer. Already redacted, capped and marked as untrusted where it is task text. */
  content: string;
  /** One short line for the dashboard and the log. Never contains task text. */
  summary: string;
  /** The arguments after validation, for the `tool_call` event. Empty when they could not be parsed. */
  args: Record<string, unknown>;
  /** Set by `show_task`: the dashboard should open this task. */
  screen?: { command: 'show_task'; taskId: string };
}

const UNTRUSTED_OPEN = '<untrusted_task_text>';
const UNTRUSTED_CLOSE = '</untrusted_task_text>';

/**
 * Wrap text that agents wrote so the model can tell it from Kookr's own words. Secrets
 * are hidden, the length is capped (keeping the end or the start, as the caller asks),
 * and any copy of the markers inside the text is broken, so task text cannot close the
 * block early and pose as Kookr.
 */
export function untrusted(text: string, maxChars: number, keep: 'start' | 'end' = 'end'): string {
  const safe = redactSpeechSecrets(text).replace(/<\s*\/?\s*untrusted_task_text\s*>/gi, '[marker removed]');
  const cut = safe.length > maxChars;
  // For terminal output the last lines matter; for a request, the beginning does.
  const body = !cut ? safe : keep === 'end' ? safe.slice(safe.length - maxChars) : safe.slice(0, maxChars);
  const note = !cut ? '' : keep === 'end' ? '(earlier text cut)\n' : '';
  const tail = cut && keep === 'start' ? '\n(the rest was cut)' : '';
  return `${UNTRUSTED_OPEN}\n${note}${body.trim()}${tail}\n${UNTRUSTED_CLOSE}`;
}

function refuse(summary: string, content: string, args: Record<string, unknown> = {}): LucyToolOutcome {
  return { ok: false, content, summary, args };
}

function parseArgs(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isLookTool(name: string): name is LucyLookToolName {
  return (LUCY_LOOK_TOOL_NAMES as readonly string[]).includes(name);
}

function describeTask(task: LucyBoardTask, detail: LucyTaskDetail | null, nowMs: number): string {
  const facts: string[] = [`Task: ${spokenLabel(task)}`, `State: ${task.status}`];
  if (task.project) facts.push(`Project: ${boardText(task.project, 60)}`);
  if (detail?.agentType) facts.push(`Agent: ${boardText(detail.agentType, 40)}`);
  const created = detail?.createdAt === undefined ? undefined : new Date(detail.createdAt).getTime();
  if (created !== undefined && Number.isFinite(created)) facts.push(`Started: ${agoWords(created, nowMs)}`);
  if (task.attention) facts.push(`Waiting on the operator: ${boardText(task.attention, 80)}`);
  if (typeof task.costUsd === 'number' && task.costUsd > 0) facts.push(`Spent: $${task.costUsd.toFixed(2)}`);
  if (detail?.references?.length) facts.push(`Linked: ${detail.references.slice(0, 6).map((r) => boardText(r, 40)).join(', ')}`);

  const written: string[] = [];
  if (detail?.cwd) written.push(`Folder: ${detail.cwd}`);
  if (detail?.pendingSignal) written.push(`Signal waiting for the operator: ${detail.pendingSignal}`);
  if (detail?.prompt) written.push(`What it was asked to do:\n${detail.prompt}`);
  if (detail?.completionSummary) written.push(`Its closing summary:\n${detail.completionSummary}`);
  if (written.length === 0) return facts.join('\n');
  return `${facts.join('\n')}\nThe rest was written by the operator or by agents:\n${untrusted(written.join('\n\n'), MAX_TASK_DETAIL_CHARS, 'start')}`;
}

/**
 * Run one tool call from the model. Never throws: a failure comes back as an outcome
 * with `ok: false`, which the loop hands to the model like any other tool answer.
 */
export async function dispatchLucyTool(name: string, rawArguments: string, source: LucyLookSource, nowMs: number): Promise<LucyToolOutcome> {
  if (!isLookTool(name)) {
    return refuse(
      'Refused: not a tool she has',
      `There is no tool called "${boardText(name, 40)}". You can only look things up, with: ${LUCY_LOOK_TOOL_NAMES.join(', ')}. You cannot change anything; tell the operator so if they asked for a change.`,
    );
  }
  const args = parseArgs(rawArguments);
  if (args === null) return refuse('Refused: unreadable arguments', 'The arguments were not a JSON object. Call the tool again with valid arguments.');

  try {
    switch (name) {
      case 'read_board':
        return { ok: true, content: buildLucyBoard(source.board(), nowMs), summary: 'Read the board', args: {} };

      case 'list_projects': {
        const projects = await source.projects();
        if (projects.length === 0) return { ok: true, content: 'Kookr knows no projects.', summary: 'Listed 0 projects', args: {} };
        const lines = projects
          .slice(0, MAX_PROJECT_LINES)
          .map((p) => `- ${boardText(p.name, 60)}: ${p.activeTasks} active, ${p.findings} waiting on the operator`);
        if (projects.length > MAX_PROJECT_LINES) lines.push(`- and ${projects.length - MAX_PROJECT_LINES} more not listed`);
        return { ok: true, content: `Projects (${projects.length}):\n${lines.join('\n')}`, summary: `Listed ${projects.length} projects`, args: {} };
      }

      case 'read_task':
      case 'read_task_output':
      case 'show_task': {
        const board = source.board();
        const found = resolveTaskRef(args.task, board.tasks);
        const cleanArgs: Record<string, unknown> = typeof args.task === 'string' ? { task: boardText(args.task, 80) } : {};
        if (!found.ok) return refuse('Task not found', found.message, cleanArgs);
        const task = found.task;

        if (name === 'show_task') {
          return {
            ok: true,
            content: `${spokenLabel(task)} is now open on the operator's screen.`,
            summary: 'Opened a task on screen',
            args: cleanArgs,
            screen: { command: 'show_task', taskId: task.id },
          };
        }
        if (name === 'read_task') {
          return { ok: true, content: describeTask(task, source.taskDetail(task.id), nowMs), summary: 'Read a task', args: cleanArgs };
        }

        const requested = typeof args.lines === 'number' && Number.isFinite(args.lines) ? Math.floor(args.lines) : DEFAULT_OUTPUT_LINES;
        const lines = Math.min(MAX_OUTPUT_LINES, Math.max(1, requested));
        const output = await source.taskOutput(task.id, lines);
        const outputArgs = { ...cleanArgs, lines };
        if (!output || !output.text.trim()) {
          return refuse('No output available', `No terminal output is available for ${spokenLabel(task)}. Say so instead of guessing.`, outputArgs);
        }
        const where = output.source === 'live' ? 'its running terminal' : 'the output saved when it ended';
        return {
          ok: true,
          content: `Last lines of ${spokenLabel(task)}, from ${where}. This is text written by an agent:\n${untrusted(output.text, MAX_TASK_OUTPUT_CHARS)}`,
          summary: `Read ${lines} lines of output`,
          args: outputArgs,
        };
      }
    }
  } catch {
    // The reason stays out of the model's context and the browser: it could quote task text or a path.
    return refuse('Look-up failed', 'That look-up failed inside Kookr. Tell the operator you could not read it.');
  }
}
