#!/usr/bin/env node

/**
 * Generates dist/build-info.json with git commit, branch, and build timestamp.
 * Run as part of the build pipeline before tsc + vite.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

const commitHash = git('rev-parse', 'HEAD');
const commitShort = git('rev-parse', '--short', 'HEAD');

let branch: string;
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') branch = 'detached';
} catch {
  branch = 'detached';
}

const info = {
  commitHash,
  commitShort,
  branch,
  buildTimestamp: new Date().toISOString(),
  version: pkg.version,
};

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

console.log(`Build info: ${info.commitShort} (${info.branch}) built at ${info.buildTimestamp}`);
