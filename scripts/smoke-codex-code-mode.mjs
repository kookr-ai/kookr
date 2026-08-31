#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message, details = '') {
  process.stderr.write(`ERROR: ${message}\n`);
  if (details.trim()) process.stderr.write(`${details.trimEnd()}\n`);
  process.exit(1);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function commandResultContainsMarker(stdout, marker) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return false;
      }
      return event?.type === 'item.completed'
        && event?.item?.type === 'command_execution'
        && event?.item?.status === 'completed'
        && event?.item?.exit_code === 0
        && event?.item?.aggregated_output?.trim() === marker;
    });
}

const codex = argumentValue('--codex')
  ?? process.env.KOOKR_CODEX_BIN
  ?? join(homedir(), 'bin', 'codex');
const marker = process.env.CODEX_IPC_SMOKE_EXPECTED_MARKER
  ?? `kookr-ipc-smoke-${randomUUID()}`;

try {
  accessSync(codex, constants.X_OK);
} catch {
  fail(`Codex executable is missing or not executable: ${codex}`);
}

const prompt = [
  'Perform exactly one code-mode IPC check.',
  'Call functions.exec with JavaScript that invokes tools.exec_command using',
  '{cmd:"printenv CODEX_IPC_SMOKE_MARKER", workdir:"/tmp", yield_time_ms:10000}.',
  'Pass the command output to text(). Do not call another tool.',
  'After the tool result arrives, reply only with: done',
].join(' ');

const result = spawnSync(
  codex,
  [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    // The smoke command is fixed to print one environment variable. Bypass the
    // sandbox so hosts without system/bundled bubblewrap can still validate IPC.
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'features.code_mode={enabled=true}',
    '-c',
    'features.code_mode_host={enabled=true,disable_in_process_fallback=true}',
    prompt,
  ],
  {
    cwd: tmpdir(),
    env: { ...process.env, CODEX_IPC_SMOKE_MARKER: marker },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: Number(process.env.CODEX_IPC_SMOKE_TIMEOUT_MS ?? 180_000),
  },
);

if (result.error) {
  fail(`could not run the Codex smoke process: ${result.error.message}`);
}
if (result.status !== 0) {
  fail(
    `Codex smoke process exited with status ${result.status}`,
    [result.stderr, result.stdout].filter(Boolean).join('\n'),
  );
}
if (!commandResultContainsMarker(result.stdout, marker)) {
  fail(
    'marker was not observed in a completed command result',
    [result.stderr, result.stdout].filter(Boolean).join('\n'),
  );
}

process.stdout.write('code-mode IPC smoke passed\n');
