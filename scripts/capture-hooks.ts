#!/usr/bin/env node
/**
 * Capture a live hook JSONL log into a redacted, replay-ready fixture.
 *
 * Usage:
 *   node --import tsx scripts/capture-hooks.ts --session <id> --name <fixture>
 *   node --import tsx scripts/capture-hooks.ts ~/.kookr/hooks/<id>.jsonl --name <fixture>
 *
 * Options:
 *   --session <id>    Read <hooks-dir>/<id>.jsonl. Mutually exclusive with a file positional.
 *   --name <name>     Fixture name. Output file is prefixed with `kookr-replay-`.
 *   --hooks-dir <dir> Hook log directory for --session. Default: ~/.kookr/hooks.
 *   --out-dir <dir>   Output directory. Default: src/__fixtures__.
 *   --out <file>      Exact output path. Overrides --out-dir / --name filename derivation.
 *   --force           Overwrite an existing output file.
 *   -h, --help        Show help.
 */
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPLAY_SESSION_PREFIX } from '../src/server/hook-ingestion.js';
import { redactSecrets } from '../src/core/redact-secrets.js';

const FIXTURE_PREFIX = REPLAY_SESSION_PREFIX;
const DEFAULT_OUT_DIR = join('src', '__fixtures__');

interface CaptureOptions {
  inputFile: string;
  outFile: string;
  force: boolean;
}

interface RawArgs {
  file?: string;
  session?: string;
  name?: string;
  hooksDir: string;
  outDir: string;
  out?: string;
  force: boolean;
}

interface CaptureResult {
  inputFile: string;
  outFile: string;
  recordsWritten: number;
}

function parseArgs(argv: string[], cwd = process.cwd(), home = homedir()): CaptureOptions | { help: true } {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };

  const raw: RawArgs = {
    hooksDir: join(home, '.kookr', 'hooks'),
    outDir: DEFAULT_OUT_DIR,
    force: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--session':
        raw.session = requireValue(argv[++i], '--session');
        break;
      case '--name':
        raw.name = requireValue(argv[++i], '--name');
        break;
      case '--hooks-dir':
        raw.hooksDir = requireValue(argv[++i], '--hooks-dir');
        break;
      case '--out-dir':
        raw.outDir = requireValue(argv[++i], '--out-dir');
        break;
      case '--out':
        raw.out = requireValue(argv[++i], '--out');
        break;
      case '--force':
        raw.force = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        positionals.push(arg);
    }
  }

  if (positionals.length > 1) {
    throw new Error('Expected at most one hook JSONL file positional. See --help.');
  }
  raw.file = positionals[0];

  if ((raw.file ? 1 : 0) + (raw.session ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one input: either --session <id> or a hook JSONL file positional.');
  }
  if (!raw.name || !sanitizeFixtureName(raw.name)) {
    throw new Error('--name is required and must contain at least one letter or number.');
  }

  const inputFile = raw.file
    ? resolve(cwd, raw.file)
    : resolve(cwd, raw.hooksDir, `${raw.session}.jsonl`);
  const fixtureName = sanitizeFixtureName(raw.name);
  const defaultOut = join(raw.outDir, `${FIXTURE_PREFIX}${fixtureName}.jsonl`);
  const outFile = resolve(cwd, raw.out ?? defaultOut);

  return {
    inputFile,
    outFile,
    force: raw.force,
  };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
}

function sanitizeFixtureName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function redactJson(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactJson(child);
    }
    return out;
  }
  return value;
}

function splitJsonRecords(content: string): { records: string[]; consumedChars: number } {
  const records: string[] = [];
  let consumedChars = 0;
  let i = 0;

  while (i < content.length) {
    while (i < content.length && /\s/.test(content[i])) i += 1;
    consumedChars = i;
    if (i >= content.length) break;

    const start = i;
    if (content[i] !== '{') {
      const lineEnd = content.indexOf('\n', i);
      if (lineEnd === -1) break;
      records.push(content.slice(start, lineEnd));
      i = lineEnd + 1;
      consumedChars = i;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let complete = false;

    for (; i < content.length; i += 1) {
      const ch = content[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          records.push(content.slice(start, i));
          consumedChars = i;
          complete = true;
          break;
        }
      }
    }

    if (!complete) break;
  }

  return { records, consumedChars };
}

function captureRecords(content: string): string[] {
  const { records, consumedChars } = splitJsonRecords(content);
  if (content.slice(consumedChars).trim()) {
    throw new Error('Input ends with an incomplete hook record; wait for the log write to finish and retry.');
  }
  return records
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record);
      } catch {
        throw new Error(`Record ${index + 1} is not valid JSON; refusing to write a non-replay-ready fixture.`);
      }
      return JSON.stringify(redactJson(parsed));
    });
}

async function captureHooks(options: CaptureOptions): Promise<CaptureResult> {
  const content = await readFile(options.inputFile, 'utf-8');
  const records = captureRecords(content);
  if (records.length === 0) {
    throw new Error(`No hook records found in ${options.inputFile}.`);
  }

  if (!options.force) {
    try {
      await access(options.outFile, fsConstants.F_OK);
      throw new Error(`Output file already exists: ${options.outFile}. Pass --force to overwrite.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, `${records.join('\n')}\n`, 'utf-8');
  return {
    inputFile: options.inputFile,
    outFile: options.outFile,
    recordsWritten: records.length,
  };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    printHelp();
    return 0;
  }

  const result = await captureHooks(parsed);
  console.log(`Captured ${result.recordsWritten} hook record(s).`);
  console.log(`  input:  ${result.inputFile}`);
  console.log(`  output: ${result.outFile}`);
  return 0;
}

function printHelp(): void {
  console.log(
    [
      'Usage: node --import tsx scripts/capture-hooks.ts (--session <id> | <hooks.jsonl>) --name <fixture> [options]',
      '',
      'Capture a hook JSONL log into a redacted fixture compatible with scripts/replay-hooks.ts.',
      '',
      'Options:',
      '  --session <id>    Read <hooks-dir>/<id>.jsonl',
      '  --name <name>     Fixture name; output is prefixed with kookr-replay-',
      '  --hooks-dir <dir> Hook log directory for --session (default: ~/.kookr/hooks)',
      '  --out-dir <dir>   Output directory (default: src/__fixtures__)',
      '  --out <file>      Exact output path',
      '  --force           Overwrite an existing output file',
      '  -h, --help        Show this help',
    ].join('\n'),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}

export {
  captureHooks,
  captureRecords,
  parseArgs,
  redactJson,
  sanitizeFixtureName,
  splitJsonRecords,
  FIXTURE_PREFIX,
};
