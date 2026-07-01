// kookr pr-checklist — machine-verify a repo's anti-drift PR checklist against
// the diff. Deterministic, no AI. See docs/rfc/rfc-pr-checklist-contract.md.
//
// Exit protocol (S7 — callers branch on the code, never on output presence):
//   0   pass
//   2   verification failure (findings, or a repo-input error → fail closed, S2)
//   64  usage error (bad arguments)
//   70  kookr-internal fault (only this class may be treated as fail-open by a hook)

import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { BOX_EVIDENCE } from '../pr-checklist/checklist.js';
import { collectAndVerify, MAX_BODY_BYTES } from '../pr-checklist/engine.js';
import { ChecklistInputError } from '../pr-checklist/errors.js';
import type { GitRunner } from '../pr-checklist/git.js';
import type { VerifyReport } from '../pr-checklist/types.js';

export const EXIT_PASS = 0;
export const EXIT_VERIFICATION_FAILURE = 2;
export const EXIT_USAGE = 64;
export const EXIT_INTERNAL = 70;

const HELP_TEXT = `kookr pr-checklist — verify a repo's anti-drift PR checklist against the diff.

Usage:
  kookr pr-checklist verify [--pr-body <file|->] [--base <ref>] [--json]
  kookr pr-checklist verify --explain

Options:
  --pr-body <file|->   PR body to check attestation boxes against (- reads stdin).
                       Omit to run structural checks only (CI supplies the body).
  --base <ref>         Diff base branch (default: main).
  --json               Emit one machine-readable JSON report to stdout.
  --explain            Print the resolved built-in checklist rules and exit.
  -h, --help           Show this help.

Exit: 0 pass · 2 verification failure · 64 usage · 70 internal.
`;

interface Args {
  verb?: string;
  prBody?: string;
  base: string;
  json: boolean;
  explain: boolean;
  help: boolean;
  error?: string;
}

interface RunDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?: Pick<typeof console, 'log' | 'error'>;
  gitRunner?: GitRunner;
  readStdin?: () => Promise<string>;
  readBodyFile?: (cwd: string, path: string) => Promise<string>;
}

export async function runPrChecklistCli(argv = process.argv.slice(2), deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? console;
  const args = parseArgs(argv);

  if (args.help) {
    out.log(HELP_TEXT);
    return EXIT_PASS;
  }
  if (args.error) {
    out.error(args.error);
    out.error(HELP_TEXT);
    return EXIT_USAGE;
  }
  if (args.verb !== 'verify') {
    out.error(`Unknown or missing subcommand${args.verb ? `: ${args.verb}` : ''}. Expected \`verify\`.`);
    out.error(HELP_TEXT);
    return EXIT_USAGE;
  }
  if (args.explain) {
    out.log(JSON.stringify(explainRules(), null, 2));
    return EXIT_PASS;
  }

  const cwd = deps.cwd ?? process.cwd();

  let body: string | null = null;
  if (args.prBody !== undefined) {
    try {
      body = args.prBody === '-'
        ? await (deps.readStdin ?? readStdin)()
        : await (deps.readBodyFile ?? readBodyFileConfined)(cwd, args.prBody);
    } catch (error) {
      // Body is repo/author-controlled input → fail closed (S2).
      out.error(`Could not read --pr-body: ${errMessage(error)}`);
      return EXIT_VERIFICATION_FAILURE;
    }
  }

  let report: VerifyReport;
  try {
    report = await collectAndVerify({ cwd, base: args.base, body, gitRunner: deps.gitRunner });
  } catch (error) {
    if (error instanceof ChecklistInputError) {
      // Derived from repo input → fail closed, do not fail open (S2/C3).
      out.error(`Checklist verification failed (input guard): ${error.message}`);
      return EXIT_VERIFICATION_FAILURE;
    }
    // kookr-internal fault → the only class a hook may treat as fail-open (S7).
    out.error(`kookr pr-checklist internal error: ${errMessage(error)}`);
    return EXIT_INTERNAL;
  }

  if (args.json) {
    out.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report, out);
  }
  return report.ok ? EXIT_PASS : EXIT_VERIFICATION_FAILURE;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { base: 'main', json: false, explain: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--explain') args.explain = true;
    else if (arg === '--pr-body') {
      const value = argv[++i];
      if (value === undefined) return { ...args, error: '--pr-body requires a value (<file> or -)' };
      args.prBody = value;
    } else if (arg === '--base') {
      const value = argv[++i];
      if (value === undefined) return { ...args, error: '--base requires a value' };
      args.base = value;
    } else if (arg.startsWith('-')) {
      return { ...args, error: `Unknown option: ${arg}` };
    } else if (args.verb === undefined) {
      args.verb = arg;
    } else {
      return { ...args, error: `Unexpected argument: ${arg}` };
    }
  }
  return args;
}

function explainRules(): { id: string; label: string; type: 'attest' | 'changed-when'; evidence: string[] }[] {
  const structural = new Set(['env', 'new-tests', 'tests']);
  return Object.entries(BOX_EVIDENCE).map(([id, spec]) => ({
    id,
    label: spec.label,
    type: structural.has(id) ? 'changed-when' : 'attest',
    evidence: spec.paths.map((re) => re.source),
  }));
}

function printHuman(report: VerifyReport, out: Pick<typeof console, 'log' | 'error'>): void {
  for (const note of report.notes) out.log(`  • ${note}`);
  for (const r of report.results) {
    const glyph = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'waived' ? '~' : '–';
    out.log(`  ${glyph} [${r.status}] ${r.id}: ${r.summary}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  if (report.ok) {
    out.log(report.bodyChecked
      ? '✓ PR checklist passed (attestation + structural checks).'
      : '✓ Structural checks passed (run with --pr-body in CI for attestation).');
  } else {
    out.error('✗ PR checklist verification FAILED — fix the items above, or strike genuinely-N/A boxes with a reason.');
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ChecklistInputError('stdin body exceeds size cap');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** S4: a --pr-body file must resolve inside the repo root, be regular, and be capped. */
async function readBodyFileConfined(cwd: string, path: string): Promise<string> {
  const realRoot = await realpath(cwd);
  let real: string;
  try {
    real = await realpath(resolve(cwd, path));
  } catch {
    real = resolve(cwd, path);
  }
  const rel = relative(realRoot, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ChecklistInputError('--pr-body path escapes repository root');
  }
  const text = await readFile(real, { encoding: 'utf-8' });
  if (text.length > MAX_BODY_BYTES) throw new ChecklistInputError('--pr-body exceeds size cap');
  return text;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
