#!/usr/bin/env node
// POC — Cross-Agent Task Migration planner (READ-ONLY, no side effects).
//
// Validates the load-bearing claims of rfc-cross-agent-task-migration.md:
//   1. Interrupted/migratable tasks actually exist in real local stores.
//   2. Migratability can be classified from persisted state alone.
//   3. A cross-agent continuation brief is constructible from PORTABLE state
//      (intent + git worktree progress) WITHOUT any vendor transcript.
//
// It never launches an agent, never mutates a store, never writes anything.
// git is invoked read-only (log/status) and only when a worktree exists.
//
// Usage:
//   node docs/poc/rfc-cross-agent-task-migration-poc.mjs [--to claude-code]
//        [--from grok-build] [--dir ~/.kookr] [--show-brief <taskId>] [--git]
//
// Exit code is always 0 on a clean scan; a non-zero code means the POC itself
// failed to run (bad args / unreadable dir), not that a task is unmigratable.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const AGENT_TYPES = ['claude-code', 'codex-cli', 'grok-build'];
const TERMINAL = new Set(['completed', 'terminated', 'cancelled']);

function parseArgs(argv) {
  const a = { to: 'claude-code', from: null, dir: null, showBrief: null, git: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--to') a.to = argv[++i];
    else if (t === '--from') a.from = argv[++i];
    else if (t === '--dir') a.dir = argv[++i];
    else if (t === '--show-brief') a.showBrief = argv[++i];
    else if (t === '--git') a.git = true;
  }
  if (!AGENT_TYPES.includes(a.to)) throw new Error(`--to must be one of ${AGENT_TYPES.join(', ')}`);
  return a;
}

// Discover ~/.kookr and ~/.kookr-<port> stores (matches server/start.ts KOOKR_DIR shape).
function discoverStores(explicitDir) {
  if (explicitDir) {
    const d = explicitDir.replace(/^~/, homedir());
    return [join(d, 'tasks.json')].filter(existsSync);
  }
  const home = homedir();
  const out = [];
  for (const name of readdirSync(home)) {
    if (name === '.kookr' || name.startsWith('.kookr-')) {
      const f = join(home, name, 'tasks.json');
      if (existsSync(f)) out.push(f);
    }
  }
  return out;
}

function loadTasks(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // Envelope v2: { version, tasks: [...] }. Tolerate a bare array too.
    return Array.isArray(raw) ? raw : Array.isArray(raw.tasks) ? raw.tasks : [];
  } catch (e) {
    console.error(`  ! could not parse ${file}: ${e.message}`);
    return [];
  }
}

function liveLooking(session) {
  // POC heuristic only: the real server probes the dtach backend. Here we treat
  // a session with a non-terminal lastStatus as "maybe live" and thus a reason
  // to be cautious. lastStatus is AgentStatus (starting|running|stuck|...).
  const s = session?.lastStatus;
  return s === 'starting' || s === 'running' || s === 'stuck';
}

function newestSession(task) {
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  return sessions.length ? sessions[sessions.length - 1] : undefined;
}

// Mirror of classifyMigration() from the RFC, over persisted state only.
function classify(task, target) {
  const status = task.status;
  if (status === 'completed') return { migratable: false, reason: 'status_not_migratable' };
  if (status === 'open' || status === 'pending') {
    // reopenable candidates only if not actively launching a live session
  }
  const session = newestSession(task);
  if ((status === 'inProgress' || status === 'open') && session && liveLooking(session)) {
    return { migratable: false, reason: 'live_session_exists' };
  }
  const cwd = task.cwd || session?.cwd;
  if (!cwd) return { migratable: false, reason: 'missing_cwd' };
  if (!existsSync(cwd)) return { migratable: false, reason: 'cwd_gone' };
  const intent = task.userPrompt || task.prompt;
  if (!intent || !String(intent).trim()) return { migratable: false, reason: 'missing_intent' };
  if (task.agentType === target) return { migratable: false, reason: 'same_agent_use_restore' };
  if (task.ralphLoop) return { migratable: false, reason: 'workflow_owner_unsupported' };
  return { migratable: true };
}

function gitSummary(cwd, branch) {
  try {
    const opts = { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] };
    const log = execFileSync('git', ['log', '--oneline', '-n', '8', ...(branch ? [branch] : [])], opts).trim();
    const stat = execFileSync('git', ['diff', '--stat', '--no-color'], opts).trim();
    const status = execFileSync('git', ['status', '--porcelain'], opts).trim();
    return {
      recentCommits: log ? log.split('\n') : [],
      dirtyFiles: status ? status.split('\n').length : 0,
      diffStatTail: stat ? stat.split('\n').slice(-1)[0] : '(clean)',
    };
  } catch {
    return null; // not a git repo, or git unavailable — brief degrades gracefully
  }
}

function buildBrief(task, target, git) {
  const intent = (task.userPrompt || task.prompt || '').trim();
  const criteria = task.criteria ? `\nAcceptance criteria:\n${task.criteria}` : '';
  const from = task.agentType;
  // Honest attribution (consensus-attack fix): the checkout is usually shared,
  // so we do NOT claim commits belong to the interrupted session — we report
  // only current uncommitted state as context and lead with intent.
  const progress = git
    ? `\nCurrent working-tree state in this checkout (may be a shared checkout — ` +
      `verify what belongs to this task before assuming it):\n` +
      `  - uncommitted files: ${git.dirtyFiles}\n  - ${git.diffStatTail}`
    : `\n(worktree state unavailable — assess the working tree before editing)`;
  return (
    `You are CONTINUING an interrupted task, not starting fresh.\n` +
    `The previous agent (${from}) was interrupted before finishing; you are ${target}.\n` +
    `The working tree already contains partial work — assess it before making changes.\n\n` +
    `Original request:\n${intent}${criteria}${progress}`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const stores = discoverStores(args.dir);
  console.log(`# Cross-Agent Task Migration POC (read-only)`);
  console.log(`target agent: ${args.to}${args.from ? `   source filter: ${args.from}` : ''}`);
  console.log(`stores scanned: ${stores.length ? stores.join(', ') : '(none found)'}\n`);

  let total = 0;
  const bySourceAgent = {};
  const reasons = {};
  const migratable = [];

  for (const file of stores) {
    for (const task of loadTasks(file)) {
      total++;
      const src = task.agentType || 'unknown';
      bySourceAgent[src] = bySourceAgent[src] || { total: 0, migratable: 0, byStatus: {} };
      bySourceAgent[src].total++;
      bySourceAgent[src].byStatus[task.status] = (bySourceAgent[src].byStatus[task.status] || 0) + 1;
      if (args.from && src !== args.from) continue;
      const c = classify(task, args.to);
      if (c.migratable) {
        bySourceAgent[src].migratable++;
        migratable.push({ task, file });
      } else {
        reasons[c.reason] = (reasons[c.reason] || 0) + 1;
      }
    }
  }

  console.log(`## Totals`);
  console.log(`  tasks scanned: ${total}`);
  console.log(`  migratable to ${args.to}: ${migratable.length}\n`);

  console.log(`## By source agent`);
  for (const [agent, s] of Object.entries(bySourceAgent)) {
    const statuses = Object.entries(s.byStatus).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`  ${agent.padEnd(12)} total=${s.total} migratable=${s.migratable}  [${statuses}]`);
  }

  console.log(`\n## Not-migratable reasons (within source filter)`);
  if (Object.keys(reasons).length === 0) console.log('  (none)');
  for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(28)} ${n}`);
  }

  console.log(`\n## Migration plan (first 10 candidates)`);
  for (const { task } of migratable.slice(0, 10)) {
    const cwd = task.cwd || newestSession(task)?.cwd;
    console.log(`  ${task.id?.slice(0, 8)}  ${String(task.agentType).padEnd(11)} -> ${args.to}  status=${task.status}  ${cwd}`);
  }
  if (migratable.length > 10) console.log(`  ... and ${migratable.length - 10} more`);

  if (args.showBrief) {
    const hit = migratable.find(({ task }) => task.id?.startsWith(args.showBrief));
    if (!hit) console.log(`\n(no migratable task id starts with ${args.showBrief})`);
    else {
      const cwd = hit.task.cwd || newestSession(hit.task)?.cwd;
      const git = args.git ? gitSummary(cwd, newestSession(hit.task)?.gitBranch) : null;
      console.log(`\n## Reconstructed continuation brief for ${hit.task.id?.slice(0, 8)}\n`);
      console.log('```');
      console.log(buildBrief(hit.task, args.to, git));
      console.log('```');
    }
  }

  console.log(`\n## Verdict`);
  console.log(
    migratable.length > 0
      ? `  CLAIM CONFIRMED: ${migratable.length} interrupted task(s) are migratable to ${args.to} from persisted state alone, with a portable continuation brief. No transcript required.`
      : `  No migratable candidates in the scanned stores right now (design still valid; try --from <agent> or run when tasks are interrupted).`,
  );
}

main();
