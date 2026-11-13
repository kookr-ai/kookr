#!/usr/bin/env node
// Stop hook — do not end the turn while this task still owns an actionable
// delivery step (umbrella #3691, issue #3694).
//
// Three shapes it catches, each seen in real delivery sessions:
//   1. red test   — the last test/gate run in the transcript failed, and the
//                   task's branch has an open PR.
//   2. no review  — the PR is open and has no `kookr-review-verdict` comment
//                   (the agent launches the independent review itself).
//   3. merge      — the PR has a `pass` verdict for the current head and the
//                   task is `pre-authorized`/`self-advancing`: run the merge gate.
// Ownership evidence is an open PR from the checked-out branch, so a task that
// never opened a PR is never nudged.
//
// It blocks once (Claude Code sets `stop_hook_active` on the re-run, which we
// always allow) with a specific instruction. It stays silent when the agent is
// parked on its own background work (same predicate as `needs_input:stop`,
// src/core/background-parked.ts), when the task is `ask-first` (the merge is the
// operator's to give), outside a Kookr task, or on any error (fail open).
// Opt out: KOOKR_DELIVERY_STOP_SKIP=1.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TEST_CMD_RE =
  /(\bvitest\b|\bplaywright\s+test\b|\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|test:changed|verify|check|gate|typecheck|lint)\b|scripts\/verify\.sh|\bpre-push\b)/;

/** Same rule as `isBackgroundParked` in src/core/background-parked.ts. */
export function isParked(event) {
  const n = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
  return n(event.background_tasks) > 0 || n(event.session_crons) > 0;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n');
  return '';
}

/**
 * Replay a Claude Code JSONL transcript and return the outcome of the LAST
 * test/gate Bash command: 'red', 'green', or null when none ran.
 */
export function lastTestOutcome(transcriptText) {
  const testIds = new Set();
  let outcome = null;
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Bash') {
        const cmd = String(block.input?.command ?? '');
        if (TEST_CMD_RE.test(cmd)) testIds.add(block.id);
      } else if (block?.type === 'tool_result' && testIds.has(block.tool_use_id)) {
        const failed = block.is_error === true || /^Exit code [1-9]/.test(textOf(block.content));
        outcome = failed ? 'red' : 'green';
      }
    }
  }
  return outcome;
}

/** Latest verdict comment: { verdict, headSha } or null. */
export function latestVerdict(commentBodies) {
  let found = null;
  for (const body of commentBodies) {
    if (!/kookr-independent-review/.test(body) && !/kookr-review-verdict:/.test(body)) continue;
    const v = /kookr-review-verdict:\s*(pass|block)/i.exec(body);
    if (!v) continue;
    const sha = /review-head-sha:\s*([0-9a-f]{7,40})/i.exec(body);
    found = { verdict: v[1].toLowerCase(), headSha: sha ? sha[1].toLowerCase() : null };
  }
  return found;
}

/**
 * Pure decision. Returns a block reason string, or null to allow the stop.
 * pr: { number, headSha, comments: string[] } | null
 */
export function decide({ event, testOutcome, pr, authorization }) {
  if (!event || event.stop_hook_active) return null;
  if (isParked(event)) return null;
  if (!pr) return null;
  if (testOutcome === 'red') {
    return (
      `PR #${pr.number} is open but your last test/gate run failed. Fix the failure (or record a concrete blocker on the PR) ` +
      `and re-run it; do not end the turn on a red test.`
    );
  }
  const v = latestVerdict(pr.comments ?? []);
  if (!v) {
    return (
      `PR #${pr.number} is open with no independent review verdict. Launching the independent review is your step: ` +
      `run the independent-merge-review skill and post the exact-head verdict, then continue to the merge gate.`
    );
  }
  if (v.verdict === 'block') {
    return `PR #${pr.number} has a BLOCK review verdict. Address the findings, push, and request a fresh review for the new head.`;
  }
  const fresh = v.headSha && pr.headSha && pr.headSha.toLowerCase().startsWith(v.headSha.slice(0, 7));
  if (!fresh) {
    return `PR #${pr.number} head moved since the last review verdict. Re-run the independent review for the current head.`;
  }
  if (authorization === 'pre-authorized' || authorization === 'self-advancing') {
    return `PR #${pr.number} is open, reviewed (pass) and pre-authorized for merge. Run the merge gate (pnpm merge) now.`;
  }
  return null; // ask-first / unknown: the merge is the operator's to give.
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
}

async function fetchAuthorization() {
  const id = process.env.KOOKR_TASK_ID;
  if (!id) return null;
  const base = process.env.KOOKR_API_BASE_URL || 'http://127.0.0.1:4800';
  try {
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const task = await res.json();
    return task?.deliveryAuthorization ?? task?.task?.deliveryAuthorization ?? null;
  } catch {
    return null;
  }
}

async function main() {
  if (process.env.KOOKR_DELIVERY_STOP_SKIP === '1') return 0;
  if (!process.env.KOOKR_TASK_ID) return 0;
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return 0;
  }
  if (event.stop_hook_active || isParked(event)) return 0;
  try {
    const cwd = event.cwd || process.cwd();
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
    if (!branch || branch === 'HEAD' || branch === 'main') return 0;
    const list = JSON.parse(sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,headRefOid'], cwd));
    if (!Array.isArray(list) || list.length === 0) return 0;
    const view = JSON.parse(sh('gh', ['pr', 'view', String(list[0].number), '--json', 'comments'], cwd));
    const pr = {
      number: list[0].number,
      headSha: list[0].headRefOid,
      comments: (view.comments ?? []).map((c) => String(c.body ?? '')),
    };
    let testOutcome = null;
    if (event.transcript_path) testOutcome = lastTestOutcome(readFileSync(event.transcript_path, 'utf-8'));
    const authorization = await fetchAuthorization();
    const reason = decide({ event, testOutcome, pr, authorization });
    if (!reason) return 0;
    process.stderr.write(`${reason}\n(If this step is genuinely not yours to take, say so in one line and stop; this hook blocks once.)\n`);
    return 2;
  } catch {
    return 0; // fail open: a session must always be able to end
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
