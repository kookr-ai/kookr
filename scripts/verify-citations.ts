#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import {
  type CitationInputFormat,
  inferCitationInputFormat,
  parseCitationClaims,
  verifyCitationClaims,
} from '../src/core/citation-verifier.js';

interface CliArgs {
  input?: string;
  sourceRoot?: string;
  format?: CitationInputFormat;
  help?: boolean;
}

const usage = 'Usage: node --import tsx scripts/verify-citations.ts --input <file> --source-root <dir> [--format json|jsonl|markdown]';
const args = parseCliArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage);
  process.exit(0);
}
if (!args.input || !args.sourceRoot) {
  console.error(usage);
  process.exit(2);
}

const content = readFileSync(args.input, 'utf8');
const format = args.format ?? inferCitationInputFormat(args.input);
const claims = parseCitationClaims(format, content);
const result = verifyCitationClaims(claims, args.sourceRoot);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.verdict === 'grounded' ? 0 : 1);

function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {};
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      const value = argv[index + 1];
      if (arg === '--input') {
        parsed.input = requireValue(arg, value);
        index += 1;
      } else if (arg === '--source-root') {
        parsed.sourceRoot = requireValue(arg, value);
        index += 1;
      } else if (arg === '--format') {
        parsed.format = parseFormat(requireValue(arg, value));
        index += 1;
      } else if (arg === '--help' || arg === '-h') {
        parsed.help = true;
      } else {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  return parsed;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseFormat(value: string): CitationInputFormat {
  if (value === 'json' || value === 'jsonl' || value === 'markdown') return value;
  throw new Error(`Unsupported --format ${value}; expected json, jsonl, or markdown`);
}
