#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function completedRoundTripContainsMarker(stdout, marker) {
  const events = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return [];
      }
      return [event];
    });
  const commandIndex = events.findIndex((event) => event?.type === 'item.completed'
    && event?.item?.type === 'command_execution'
    && event?.item?.status === 'completed'
    && event?.item?.exit_code === 0
    && event?.item?.aggregated_output?.trim() === marker);
  return commandIndex !== -1 && events.slice(commandIndex + 1).some(
    (event) => event?.type === 'item.completed'
      && event?.item?.type === 'agent_message'
      && event?.item?.text?.trim() === marker,
  );
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyManagedPair(codex, expectedSourceCommit) {
  if (!/^[0-9a-f]{40}$/.test(expectedSourceCommit)) {
    fail('--expected-source-commit must be a full lowercase Git SHA');
  }

  const host = join(dirname(codex), 'codex-code-mode-host');
  let cliRealPath;
  let hostRealPath;
  try {
    accessSync(host, constants.X_OK);
    cliRealPath = realpathSync(codex);
    hostRealPath = realpathSync(host);
  } catch {
    fail(`managed Codex host is missing or not executable: ${host}`);
  }

  const pairDirectory = dirname(cliRealPath);
  if (dirname(hostRealPath) !== pairDirectory) {
    fail('managed Codex CLI and host do not resolve to the same runtime pair');
  }

  const manifestPath = join(pairDirectory, 'codex-pair.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`could not read managed Codex pair manifest: ${error.message}`);
  }
  if (manifest.schemaVersion !== 1
    || manifest.sourceCommit !== expectedSourceCommit
    || manifest.cliSha256 !== sha256(cliRealPath)
    || manifest.hostSha256 !== sha256(hostRealPath)) {
    fail('managed Codex pair manifest, source commit, or executable hashes do not match');
  }
}

const codex = argumentValue('--codex')
  ?? process.env.KOOKR_CODEX_BIN
  ?? join(homedir(), 'bin', 'codex');
const expectedSourceCommit = argumentValue('--expected-source-commit');
const marker = process.env.CODEX_IPC_SMOKE_EXPECTED_MARKER
  ?? `kookr-ipc-smoke-${randomUUID()}`;

try {
  accessSync(codex, constants.X_OK);
} catch {
  fail(`Codex executable is missing or not executable: ${codex}`);
}
if (expectedSourceCommit) verifyManagedPair(codex, expectedSourceCommit);

const prompt = [
  'Perform exactly one code-mode IPC check.',
  'Call functions.exec with JavaScript that invokes tools.exec_command using',
  '{cmd:"printenv CODEX_IPC_SMOKE_MARKER", workdir:"/tmp", yield_time_ms:10000}.',
  'Pass the command output to text(). Do not call another tool.',
  'After the tool result arrives, reply only with the exact value returned by the command.',
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
    'features.code_mode_only=true',
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
if (!completedRoundTripContainsMarker(result.stdout, marker)) {
  fail(
    'marker did not complete the command-to-final-response code-mode round trip',
    [result.stderr, result.stdout].filter(Boolean).join('\n'),
  );
}

process.stdout.write('code-mode IPC smoke passed\n');
