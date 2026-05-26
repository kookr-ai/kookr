#!/usr/bin/env node
// kookr-infer-relations — diagnostics CLI for task-relation inference (issue #600).
//
// Scans local Kookr state (~/.kookr/tasks.json, ~/.kookr/hooks/*.jsonl,
// ~/.kookr/playbook-state/**) and prints inferred relation edges with
// confidence and evidence. Defaults to --dry-run; pass --apply to upsert the
// high-confidence edges via POST /api/task-relations (the typed-graph endpoint
// shipped in #599).
//
// The actual inference rules live in `src/core/task-relation-inference.ts` —
// this CLI is the IO shell around that engine. Confidence thresholds and
// rule documentation are pinned at the top of the engine file.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

const engineEntry = join(here, '..', 'dist', 'core', 'task-relation-inference.js');
if (!existsSync(engineEntry)) {
  console.error('[kookr-infer-relations] Engine build not found at ' + engineEntry);
  console.error('[kookr-infer-relations] Run `pnpm build:server` first.');
  process.exit(2);
}

const engine = await import(engineEntry);
const {
  inferRelations,
  parseKookrSpawnTaskId,
  parseChildrenJson,
  parseStateMd,
  HIGH_CONFIDENCE_RELATION_THRESHOLD,
} = engine;

const HIGH_CONFIDENCE_GATE = HIGH_CONFIDENCE_RELATION_THRESHOLD;

const HELP_TEXT = `kookr-infer-relations — infer task-relation edges from local Kookr state.

Usage:
  kookr-infer-relations [--dry-run] [--apply] [--format json|table]
                        [--kookr-dir <path>] [--api-base <url>]
                        [--apply-threshold <number>]

Modes:
  --dry-run (default) Print inferred edges, do not write.
  --apply             POST each edge with confidence >= --apply-threshold
                      (default ${HIGH_CONFIDENCE_GATE}) to POST /api/task-relations.

Output:
  --format json       Machine-readable JSON dump (default).
  --format table      Human-readable table.

Discovery:
  --kookr-dir <path>  Override Kookr data directory (default: ~/.kookr).
  --api-base <url>    Override Kookr server base URL (default: probe of
                      KOOKR_API_BASE_URL or http://127.0.0.1:4800).

Acceptance summary (printed last as JSON):
  { totalTasks, alreadyLinked, inferred, ambiguous }

Confidence ladder is documented in src/core/task-relation-inference.ts.
`;

function parseArgs(argv) {
  const out = {
    dryRun: true,
    apply: false,
    format: 'json',
    kookrDir: process.env.KOOKR_DIR || join(homedir(), '.kookr'),
    apiBase: process.env.KOOKR_API_BASE_URL || 'http://127.0.0.1:4800',
    applyThreshold: HIGH_CONFIDENCE_GATE,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eat = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`option ${tok} requires a value`);
        process.exit(2);
      }
      return v;
    };
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--dry-run') {
      out.dryRun = true;
      out.apply = false;
    } else if (tok === '--apply') {
      out.apply = true;
      out.dryRun = false;
    } else if (tok === '--format') {
      out.format = eat();
    } else if (tok === '--kookr-dir') {
      out.kookrDir = eat();
    } else if (tok === '--api-base') {
      out.apiBase = eat().replace(/\/+$/, '');
    } else if (tok === '--apply-threshold') {
      const n = Number(eat());
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        console.error('--apply-threshold must be a number in [0, 1]');
        process.exit(2);
      }
      out.applyThreshold = n;
    } else {
      console.error(`unknown option: ${tok}`);
      process.exit(2);
    }
  }
  if (out.format !== 'json' && out.format !== 'table') {
    console.error('--format must be "json" or "table"');
    process.exit(2);
  }
  return out;
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function* iterDirEntries(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) {
      yield* iterDirEntries(p);
    } else if (ent.isFile()) {
      yield p;
    }
  }
}

// ---------- extraction ----------

function loadTasksAndRelations(kookrDir) {
  const tasksPath = join(kookrDir, 'tasks.json');
  const doc = readJsonSafe(tasksPath);
  if (!doc || !Array.isArray(doc.tasks)) return { tasks: [], existingRelations: [] };
  const tasks = doc.tasks.map((t) => ({
    id: t.id,
    createdAt: t.createdAt ?? new Date(0).toISOString(),
    ...(typeof t.prompt === 'string' ? { prompt: t.prompt } : {}),
    ...(typeof t.userPrompt === 'string' ? { userPrompt: t.userPrompt } : {}),
    ...(typeof t.parentTaskId === 'string' ? { parentTaskId: t.parentTaskId } : {}),
  }));
  const existingRelations = Array.isArray(doc.taskRelations) ? doc.taskRelations : [];
  return { tasks, existingRelations };
}

// Match `--parent-task-id <uuid>` or `--parent-task-id=<uuid>` with a strict
// UUID body so noise like `--parent-task-id 0000000000000000000000000000-----`
// doesn't match.
const PARENT_TASK_FLAG_RE = /--parent-task-id[= ]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function loadSpawnEvents(kookrDir) {
  const hooksDir = join(kookrDir, 'hooks');
  const out = [];
  for (const path of iterDirEntries(hooksDir)) {
    if (!path.endsWith('.jsonl')) continue;
    let raw;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    // We pair PreToolUse Bash invocations of kookr-spawn (which carry
    // KOOKR_TASK_ID env or --parent-task-id flag) with the matching
    // PostToolUse response that announces task_id=<uuid>. The pairing is keyed
    // on `tool_use_id` so unrelated tool events between the Pre and Post don't
    // leak a stale parent into the next kookr-spawn invocation. Hook events
    // lack the process env, so we only emit when --parent-task-id is on argv.
    const pendingByToolUseId = new Map();
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.tool_name !== 'Bash') continue;
      const cmd = ev.tool_input?.command;
      if (typeof cmd !== 'string' || !cmd.includes('kookr-spawn')) continue;
      const toolUseId = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : null;
      if (!toolUseId) continue; // can't pair without a stable id

      if (ev.hook_event_name === 'PreToolUse') {
        const m = PARENT_TASK_FLAG_RE.exec(cmd);
        if (!m) continue;
        pendingByToolUseId.set(toolUseId, {
          parentTaskId: m[1].toLowerCase(),
          observedAt: typeof ev.timestamp === 'string' ? ev.timestamp : null,
        });
      } else if (ev.hook_event_name === 'PostToolUse') {
        const pending = pendingByToolUseId.get(toolUseId);
        pendingByToolUseId.delete(toolUseId);
        if (!pending) continue;
        const resp = typeof ev.tool_response === 'string' ? ev.tool_response : '';
        const taskId = parseKookrSpawnTaskId(resp);
        if (!taskId || taskId === pending.parentTaskId) continue;
        out.push({
          taskId,
          parentTaskId: pending.parentTaskId,
          observedAt: pending.observedAt ?? new Date().toISOString(),
          filePath: path,
          rawSnippet: `task_id=${taskId}`,
        });
      }
    }
  }
  return out;
}

function loadPlaybookSources(kookrDir) {
  const root = join(kookrDir, 'playbook-state');
  const playbookChildren = [];
  const playbookStates = [];
  for (const path of iterDirEntries(root)) {
    let observedAt;
    try {
      observedAt = statSync(path).mtime.toISOString();
    } catch {
      observedAt = new Date().toISOString();
    }
    const name = basename(path);
    if (name === 'children.json') {
      let raw;
      try {
        raw = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      const entries = parseChildrenJson(raw);
      if (entries.length === 0) continue;
      // Run key is the immediate parent directory name; sibling state.md may
      // upgrade parentTaskId, but we resolve that during the state.md pass.
      const dir = dirname(path);
      const runKey = dir.split('/').pop() ?? '';
      const stateMdPath = join(dir, 'state.md');
      let parentTaskId;
      if (existsSync(stateMdPath)) {
        try {
          const parsed = parseStateMd(readFileSync(stateMdPath, 'utf-8'));
          if (parsed.parentTaskId) parentTaskId = parsed.parentTaskId;
        } catch { /* fall through */ }
      }
      playbookChildren.push({
        runKey,
        ...(parentTaskId ? { parentTaskId } : {}),
        filePath: path,
        observedAt,
        entries,
      });
    } else if (name === 'state.md') {
      let raw;
      try {
        raw = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      const parsed = parseStateMd(raw);
      playbookStates.push({
        referencedTaskIds: parsed.referencedTaskIds,
        ...(parsed.parentTaskId ? { parentTaskId: parsed.parentTaskId } : {}),
        ...(parsed.priorParentTaskId ? { priorParentTaskId: parsed.priorParentTaskId } : {}),
        ...(parsed.runKey ? { runKey: parsed.runKey } : {}),
        filePath: path,
        observedAt,
      });
    }
  }
  return { playbookChildren, playbookStates };
}

// ---------- output ----------

function renderTable(result) {
  const lines = [];
  lines.push('source                                target                                type            conf source');
  lines.push('-'.repeat(110));
  // Sort by confidence desc so highest-signal edges land on top.
  const sorted = [...result.inferred].sort((a, b) => b.confidence - a.confidence);
  for (const rel of sorted) {
    lines.push(
      `${rel.sourceTaskId.padEnd(38)}${rel.targetTaskId.padEnd(38)}${rel.type.padEnd(16)}${rel.confidence.toFixed(2).padEnd(5)}${rel.source}`,
    );
  }
  if (result.ambiguous.length > 0) {
    lines.push('');
    lines.push('Ambiguous (below confidence floor or unresolved by LLM):');
    for (const a of result.ambiguous) {
      lines.push(`  ${a.sourceTaskId} → ${a.targetTaskId}: ${a.reason}`);
    }
  }
  return lines.join('\n');
}

async function postRelation(apiBase, input) {
  const res = await fetch(`${apiBase}/api/task-relations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`POST /api/task-relations ${res.status}: ${detail}`);
  }
  return res.json();
}

// ---------- main ----------

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const kookrDir = args.kookrDir;
  if (!existsSync(kookrDir)) {
    console.error(`[kookr-infer-relations] kookr-dir does not exist: ${kookrDir}`);
    return 2;
  }
  const { tasks, existingRelations } = loadTasksAndRelations(kookrDir);
  const spawnEvents = loadSpawnEvents(kookrDir);
  const { playbookChildren, playbookStates } = loadPlaybookSources(kookrDir);

  const result = await inferRelations({
    tasks,
    existingRelations,
    spawnEvents,
    playbookChildren,
    playbookStates,
  });

  if (args.format === 'table') {
    process.stdout.write(renderTable(result) + '\n');
  } else {
    process.stdout.write(JSON.stringify({
      inferred: result.inferred,
      ambiguous: result.ambiguous,
    }, null, 2) + '\n');
  }

  let applied = 0;
  let applyErrors = 0;
  if (args.apply) {
    for (const rel of result.inferred) {
      if (rel.confidence < args.applyThreshold) continue;
      try {
        await postRelation(args.apiBase, {
          sourceTaskId: rel.sourceTaskId,
          targetTaskId: rel.targetTaskId,
          type: rel.type,
          confidence: rel.confidence,
          source: rel.source,
          evidence: rel.evidence,
          lifecycle: 'active',
        });
        applied += 1;
      } catch (err) {
        applyErrors += 1;
        process.stderr.write(`[apply] ${rel.sourceTaskId} → ${rel.targetTaskId} (${rel.type}): ${err.message}\n`);
      }
    }
  }

  // Acceptance criterion (issue #600): "Add a summary metric: number of tasks,
  // number already linked, number inferred, number ambiguous." Printed verbatim
  // as a final JSON block so consumers can grep for it.
  const summary = {
    totalTasks: result.metrics.totalTasks,
    alreadyLinked: result.metrics.alreadyLinked,
    inferred: result.metrics.inferred,
    ambiguous: result.metrics.ambiguous,
    ...(args.apply ? { applied, applyErrors } : {}),
    ...(args.dryRun ? { mode: 'dry-run' } : { mode: 'apply', applyThreshold: args.applyThreshold }),
  };
  process.stdout.write('\nsummary=' + JSON.stringify(summary) + '\n');
  return applyErrors > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`[kookr-infer-relations] ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exit(1);
  },
);
