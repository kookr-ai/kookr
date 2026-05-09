#!/usr/bin/env node
/**
 * Read-only report of `kb` CLI usage per Kookr task in a recent window.
 *
 * Usage: pnpm kb:usage [--days N]   (default: 7)
 *
 * Source of truth:
 *   ~/.kookr/tasks.json               — tasks + their session list
 *   ~/.kookr/hooks/<tmuxSession>.jsonl — PreToolUse/PostToolUse Bash events
 *
 * Detection: any PreToolUse Bash event whose `tool_input.command` contains the
 * literal substring `kb ` (with trailing space). This catches `kb search …`,
 * piped forms (`… | kb remember …`), and chained forms (`a && kb list`).
 *
 * Lesson decisions (issue #227): per-task classification of post-task lesson
 * behavior — wrote-lesson (saw `kb remember`), explicit-skip (saw the
 * `No generic KB lesson:` marker the playbook prompts agents to print), or
 * search-only (kb activity with neither). See src/core/kb-lesson-classifier.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  classifyKbCommand,
  aggregateLessonDecision,
  KB_LESSON_SKIP_MARKER,
  type LessonDecisionState,
} from '../src/core/kb-lesson-classifier.js';

interface TaskSession {
  tmuxSession?: string;
  claudeSessionId?: string;
  agentType?: string;
  lastEventAt?: number;
}

interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  playbookId?: string;
  sessions?: TaskSession[];
  prompt?: string;
}

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Math.max(1, parseInt(args[daysIdx + 1] ?? '7', 10) || 7) : 7;
const cutoffMs = Date.now() - days * 86_400_000;

interface LogStats {
  kbCalls: number;
  bashCalls: number;
  lessonWrites: number;
  lessonSkips: number;
  kbSearches: number;
  exists: boolean;
}

async function scanLog(path: string): Promise<LogStats> {
  if (!existsSync(path)) {
    return { kbCalls: 0, bashCalls: 0, lessonWrites: 0, lessonSkips: 0, kbSearches: 0, exists: false };
  }
  let kbCalls = 0;
  let bashCalls = 0;
  let lessonWrites = 0;
  let lessonSkips = 0;
  let kbSearches = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
  for await (const line of rl) {
    if (!line) continue;
    let evt: { hook_event_name?: string; tool_name?: string; tool_input?: { command?: string } };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.hook_event_name !== 'PreToolUse' || evt.tool_name !== 'Bash') continue;
    bashCalls++;
    const cmd = evt.tool_input?.command ?? '';
    if (cmd.includes('kb ')) kbCalls++;
    switch (classifyKbCommand(cmd)) {
      case 'lesson-write':
        lessonWrites++;
        break;
      case 'lesson-skip':
        lessonSkips++;
        break;
      case 'kb-search':
        kbSearches++;
        break;
      case 'none':
        break;
    }
  }
  return { kbCalls, bashCalls, lessonWrites, lessonSkips, kbSearches, exists: true };
}

function pad(s: string | number, n: number, right = false): string {
  const v = String(s);
  if (v.length >= n) return v.slice(0, n);
  const fill = ' '.repeat(n - v.length);
  return right ? v + fill : fill + v;
}

async function loadAllTasks(): Promise<Task[]> {
  const dir = join(homedir(), '.kookr');
  const files = ['tasks.json'];
  try {
    const entries = await readdir(dir);
    for (const e of entries) {
      if (e.startsWith('tasks.json.daily.') || e.startsWith('tasks.json.predelete.')) files.push(e);
    }
  } catch {
    /* ignore */
  }
  const byId = new Map<string, Task>();
  for (const name of files) {
    const path = join(dir, name);
    let parsed: { tasks?: Task[] };
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    for (const t of parsed.tasks ?? []) {
      const existing = byId.get(t.id);
      if (!existing) {
        byId.set(t.id, t);
        continue;
      }
      const a = Date.parse(existing.updatedAt ?? existing.createdAt);
      const b = Date.parse(t.updatedAt ?? t.createdAt);
      if (Number.isFinite(b) && (!Number.isFinite(a) || b > a)) byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}

async function main(): Promise<void> {
  const tasks = await loadAllTasks();

  const recent = tasks.filter((t) => {
    const ts = Date.parse(t.updatedAt ?? t.createdAt);
    return Number.isFinite(ts) && ts >= cutoffMs;
  });

  interface Row {
    taskId: string;
    playbookId: string;
    status: string;
    sessions: number;
    missingLogs: number;
    kb: number;
    bash: number;
    lessonWrites: number;
    lessonSkips: number;
    kbSearches: number;
    decision: LessonDecisionState;
    promptHead: string;
    updatedAt: string;
  }

  const rows: Row[] = [];
  for (const t of recent) {
    let kb = 0;
    let bash = 0;
    let missing = 0;
    let lessonWrites = 0;
    let lessonSkips = 0;
    let kbSearches = 0;
    for (const s of t.sessions ?? []) {
      if (!s.tmuxSession) continue;
      const logPath = join(homedir(), '.kookr', 'hooks', `${s.tmuxSession}.jsonl`);
      const r = await scanLog(logPath);
      if (!r.exists) missing++;
      kb += r.kbCalls;
      bash += r.bashCalls;
      lessonWrites += r.lessonWrites;
      lessonSkips += r.lessonSkips;
      kbSearches += r.kbSearches;
    }
    rows.push({
      taskId: t.id,
      playbookId: t.playbookId ?? '(none)',
      status: t.status,
      sessions: (t.sessions ?? []).length,
      missingLogs: missing,
      kb,
      bash,
      lessonWrites,
      lessonSkips,
      kbSearches,
      decision: aggregateLessonDecision({ lessonWrites, lessonSkips, kbSearches }),
      promptHead: (t.prompt ?? '').replace(/\s+/g, ' ').slice(0, 80),
      updatedAt: t.updatedAt,
    });
  }

  const total = rows.length;
  const withLogs = rows.filter((r) => r.sessions > 0 && r.missingLogs < r.sessions);
  const withLogsCount = withLogs.length;
  const zeroKb = withLogs.filter((r) => r.kb === 0).length;
  const sumKb = withLogs.reduce((a, r) => a + r.kb, 0);
  const sumBash = withLogs.reduce((a, r) => a + r.bash, 0);
  const sortedKb = withLogs.map((r) => r.kb).sort((a, b) => a - b);
  const median = sortedKb.length ? sortedKb[Math.floor(sortedKb.length / 2)] : 0;
  const p10 = sortedKb.length ? sortedKb[Math.max(0, Math.floor(sortedKb.length * 0.1) - 1)] : 0;

  console.log(`\n=== Kookr kb-usage report (last ${days} day(s)) ===`);
  console.log(`Tasks in window:           ${total}`);
  console.log(`Tasks with at least 1 log: ${withLogsCount}`);
  console.log(`Tasks with 0 kb calls:     ${zeroKb}  (${withLogsCount ? ((zeroKb / withLogsCount) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`Mean kb / task:            ${withLogsCount ? (sumKb / withLogsCount).toFixed(2) : '0.00'}`);
  console.log(`Median kb / task:          ${median}`);
  console.log(`p10 kb / task:             ${p10}`);
  console.log(`Total kb calls:            ${sumKb}`);
  console.log(`Total Bash calls:          ${sumBash}`);
  console.log(`kb / Bash ratio:           ${sumBash ? ((sumKb / sumBash) * 100).toFixed(2) + '%' : 'N/A'}`);

  const byPb = new Map<string, { tasks: number; kb: number; bash: number; zero: number }>();
  for (const r of withLogs) {
    const e = byPb.get(r.playbookId) ?? { tasks: 0, kb: 0, bash: 0, zero: 0 };
    e.tasks++;
    e.kb += r.kb;
    e.bash += r.bash;
    if (r.kb === 0) e.zero++;
    byPb.set(r.playbookId, e);
  }
  if (byPb.size) {
    console.log(`\n--- By playbook ---`);
    console.log(`${pad('playbook', 36, true)}  ${pad('tasks', 5)}  ${pad('zero%', 6)}  ${pad('mean-kb', 8)}  ${pad('mean-bash', 10)}`);
    const entries = [...byPb.entries()].sort((a, b) => b[1].tasks - a[1].tasks);
    for (const [pb, e] of entries) {
      const zeroPct = ((e.zero / e.tasks) * 100).toFixed(0) + '%';
      const meanKb = (e.kb / e.tasks).toFixed(2);
      const meanBash = (e.bash / e.tasks).toFixed(1);
      console.log(`${pad(pb, 36, true)}  ${pad(e.tasks, 5)}  ${pad(zeroPct, 6)}  ${pad(meanKb, 8)}  ${pad(meanBash, 10)}`);
    }
  }

  // Post-task lesson-decision visibility (issue #227): one bucket per task
  // based on the strongest signal in its hook log.
  const wrote = withLogs.filter((r) => r.decision === 'wrote-lesson').length;
  const skipped = withLogs.filter((r) => r.decision === 'explicit-skip').length;
  const searched = withLogs.filter((r) => r.decision === 'search-only').length;
  const noKb = withLogs.filter((r) => r.decision === 'no-kb-activity').length;
  const decided = wrote + skipped;
  console.log(`\n--- Lesson decisions ---`);
  console.log(
    `Wrote lesson:              ${wrote}  (${withLogsCount ? ((wrote / withLogsCount) * 100).toFixed(1) : '0.0'}%)`,
  );
  console.log(
    `Explicit skip:             ${skipped}  (${withLogsCount ? ((skipped / withLogsCount) * 100).toFixed(1) : '0.0'}%)`,
  );
  console.log(
    `Search only (no decision): ${searched}  (${withLogsCount ? ((searched / withLogsCount) * 100).toFixed(1) : '0.0'}%)`,
  );
  console.log(
    `No kb activity:            ${noKb}  (${withLogsCount ? ((noKb / withLogsCount) * 100).toFixed(1) : '0.0'}%)`,
  );
  console.log(
    `Decision rate:             ${decided}  (${withLogsCount ? ((decided / withLogsCount) * 100).toFixed(1) : '0.0'}%)  — wrote-or-skipped of tasks with logs`,
  );

  // Zero-kb listing is the operational signal for "agent forgot the policy",
  // so exclude tasks that explicitly opted out — those are intentionally
  // zero-kb-but-decided and surfacing them as forgotten would be misleading.
  const zeros = withLogs
    .filter((r) => r.kb === 0 && r.decision !== 'explicit-skip')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 20);
  if (zeros.length) {
    console.log(`\n--- Zero-kb tasks (most recent ${zeros.length}) — excludes explicit-skip ---`);
    console.log(`${pad('task-id', 38, true)}  ${pad('playbook', 26, true)}  ${pad('bash', 5)}  ${pad('status', 12, true)}  prompt`);
    for (const r of zeros) {
      console.log(
        `${pad(r.taskId, 38, true)}  ${pad(r.playbookId, 26, true)}  ${pad(r.bash, 5)}  ${pad(r.status, 12, true)}  ${r.promptHead}`,
      );
    }
  }

  if (rows.some((r) => r.sessions === 0)) {
    const n = rows.filter((r) => r.sessions === 0).length;
    console.log(`\nNote: ${n} task(s) had no sessions[] entry (likely queued/canceled before launch) and were excluded.`);
  }
  if (rows.some((r) => r.missingLogs > 0)) {
    const n = rows.filter((r) => r.missingLogs > 0).length;
    console.log(`Note: ${n} task(s) had ${rows.reduce((a, r) => a + r.missingLogs, 0)} session(s) with no hook log on disk (rotated or pre-hook) — partial coverage.`);
  }
  console.log(`\nDetection rule: PreToolUse Bash event whose command contains the literal "kb " (trailing space). Source: ~/.kookr/hooks/<tmuxSession>.jsonl. Subagent tool calls only count if they fire the parent-session hook.`);
  console.log(
    `Lesson-decision rule (#227): "kb remember" → wrote-lesson; "${KB_LESSON_SKIP_MARKER}" marker → explicit-skip; otherwise kb-search. Strongest signal wins per task.\n`,
  );
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
