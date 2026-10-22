// `nb` — the Agent Notebook CLI. A role's bounded, voted memory, kb-shaped but
// local plain text (no FAISS / embeddings / network), so every call is a fast,
// deterministic, offline file edit. RFC: docs/rfc/rfc-self-improving-agent-fleet.md.
//
// Commands:
//   nb show   <role>                       print the notebook (used by the start hook)
//   nb add    <role> "<lesson>"            dedup-skip, score +1, write, trim (lowest-score out)
//   nb vote   <role> <id|query> +1|-1      adjust an entry's score (used by the end hook)
//   nb merge  <role> <idA> <idB> "<merged>"  consolidate two entries into one
//   nb rm     <role> <id|query>            delete an entry the agent judges useless
//   nb stats  [<role>] [--since 7d]        usage analytics + anomaly flags
//   nb --help                              this help
//
// Every call appends one line to the usage ring so `nb stats` can surface
// loop / went-silent / high-error-rate anomalies.

import {
  addEntry,
  logUsage,
  maxChars,
  merge,
  notebooksDir,
  parseWindowMs,
  remove,
  render,
  stats,
  vote,
} from '../core/notebook.js';

const HELP = `nb — the Agent Notebook (bounded, voted, per-role memory)

usage:
  nb show   <role>                        print the notebook (highest-scored first)
  nb add    <role> "<lesson>"             add a lesson (dedup-skipped; rejected if too long, never truncated)
  nb vote   <role> <id|query> +1|-1       upvote/downvote an entry you used
  nb merge  <role> <idA> <idB> "<merged>" consolidate two entries into one
  nb rm     <role> <id|query>             delete an entry
  nb stats  [<role>] [--since 7d]         usage analytics + anomaly flags
  nb --help                               show this help
  nb --version                            print the tool name

notes:
  - a notebook holds at most 200 lines; each lesson is one line of at most 200 chars.
  - an over-long add is REJECTED (exit 1), never truncated — rewrite shorter and retry.
  - when full, the LOWEST-scored line is evicted (ties: oldest).
  - <query> selects an entry by case-insensitive substring; <id> is the number from \`nb show\`.
  - storage: $NB_DIR or ~/.kookr/notebooks/<role>.md (plain text, git-diffable).

docs: docs/reference/agent-notebook.md`;

function parseDelta(arg: string): number {
  const t = arg.trim();
  if (t === '+1' || t === '1' || t === '++') return 1;
  if (t === '-1' || t === '--') return -1;
  throw new Error('vote direction must be +1 or -1');
}

export async function runNbCli(argv: string[]): Promise<number> {
  const cmd = (argv[0] ?? '').trim();
  if (cmd === '' || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write('nb (kookr Agent Notebook)\n');
    return 0;
  }

  const dir = notebooksDir();
  const started = Date.now();
  let role = '-';
  let ok = false;
  try {
    switch (cmd) {
      case 'show': {
        role = need(argv[1], 'role');
        process.stdout.write(render(dir, role) + '\n');
        break;
      }
      case 'add': {
        role = need(argv[1], 'role');
        const lesson = need(argv[2], 'lesson');
        const r = await addEntry(dir, role, lesson);
        if (r.reason === 'duplicate') process.stdout.write(`skipped (near-duplicate already present) — ${r.size} lines\n`);
        else if (r.reason === 'empty') process.stdout.write('skipped (empty lesson)\n');
        else if (r.reason === 'rejected-full') process.stdout.write(`skipped (notebook full — every entry outranks this lesson; vote one down or merge first) — ${r.size} lines\n`);
        else if (r.reason === 'too-long') throw new Error(`lesson too long (${r.length} chars > ${maxChars()} max). Rewrite it shorter as ONE complete line and retry — it was NOT truncated or stored.`);
        else {
          process.stdout.write(`added — ${r.size} lines`);
          if (r.evicted) process.stdout.write(` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text})`);
          process.stdout.write('\n');
        }
        break;
      }
      case 'vote': {
        role = need(argv[1], 'role');
        const selector = need(argv[2], 'id|query');
        const delta = parseDelta(need(argv[3], '+1|-1'));
        const r = await vote(dir, role, selector, delta);
        process.stdout.write(`${delta > 0 ? '+1' : '-1'} → [${fmt(r.score)}] ${r.text}\n`);
        break;
      }
      case 'merge': {
        role = need(argv[1], 'role');
        const a = need(argv[2], 'idA');
        const b = need(argv[3], 'idB');
        const merged = need(argv[4], 'merged lesson');
        const r = await merge(dir, role, a, b, merged);
        process.stdout.write(`merged two entries into one — ${r.size} lines\n`);
        break;
      }
      case 'rm': {
        role = need(argv[1], 'role');
        const selector = need(argv[2], 'id|query');
        const r = await remove(dir, role, selector);
        process.stdout.write(`removed — [${fmt(r.score)}] ${r.text}\n`);
        break;
      }
      case 'stats': {
        const rest = argv.slice(1);
        const sinceIdx = rest.indexOf('--since');
        const windowMs = sinceIdx >= 0 ? parseWindowMs(rest[sinceIdx + 1]) : undefined;
        const maybeRole = rest.find((a, i) => !a.startsWith('--') && (sinceIdx < 0 || i !== sinceIdx + 1));
        role = maybeRole ?? '-';
        process.stdout.write(renderStats(dir, maybeRole, windowMs) + '\n');
        break;
      }
      default:
        process.stderr.write(`nb: unknown command "${cmd}". Try \`nb --help\`.\n`);
        return 2;
    }
    ok = true;
    return 0;
  } catch (e) {
    process.stderr.write(`nb ${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    // The `stats` read of the usage log happens above; logging it afterwards is fine.
    logUsage(dir, role, cmd, ok, Date.now() - started);
  }
}

function need(v: string | undefined, name: string): string {
  if (v == null || v === '') throw new Error(`missing <${name}> argument`);
  return v;
}

function fmt(score: number): string {
  return score >= 0 ? `+${score}` : `${score}`;
}

function renderStats(dir: string, role: string | undefined, windowMs: number | undefined): string {
  const rep = stats(dir, { role, windowMs });
  const lines: string[] = [];
  lines.push(`nb usage — ${role ? `role ${role}, ` : ''}window ${rep.window}, ${rep.totalCalls} calls`);
  if (rep.perCommand.length === 0) {
    lines.push('  (no usage recorded in this window)');
  } else {
    lines.push('  command   calls  err%   p50    p95    last-used');
    for (const c of rep.perCommand) {
      lines.push(
        `  ${c.command.padEnd(8)}  ${String(c.calls).padStart(4)}  ${String(Math.round(c.errorRate * 100)).padStart(3)}%  ` +
          `${(c.p50ms + 'ms').padStart(5)}  ${(c.p95ms + 'ms').padStart(5)}  ${c.lastUsed.slice(0, 19)}`,
      );
    }
  }
  if (rep.anomalies.length > 0) {
    lines.push('  anomalies:');
    for (const a of rep.anomalies) {
      lines.push(`    [${a.kind}] ${a.command}${a.role ? ` (role ${a.role})` : ''}: ${a.detail}`);
    }
  } else {
    lines.push('  anomalies: none');
  }
  return lines.join('\n');
}
