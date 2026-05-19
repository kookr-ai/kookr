// RFC 018 M2 (#373) — Kookr context-injection hook runnable.
//
// The thin process wrapper around `runHook`: reads the Claude Code
// `UserPromptSubmit` hook event from stdin, runs the RFC §11 injection
// logic, and writes any injected context to stdout (Claude Code feeds a
// UserPromptSubmit hook's stdout into the turn) and the `gate_verdict` echo
// to stderr (the operator/debug channel). Invoked by `hooks/kb-context-inject.sh`.
//
// This file only ever runs as an entry point — it is never imported — so it
// executes `main()` unconditionally (same pattern as `src/server/start.ts`).
// All testable logic lives in `kb-context-injection-hook.ts`.
//
// Fail-open: every path exits 0 so a hook fault can never break the turn.

import { runHook } from './kb-context-injection-hook.js';
import { defaultExecKbSearch } from './kb-context-injection.js';

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main(): Promise<void> {
  let stdout = '';
  let stderr = '';
  try {
    const raw = await readStdin();
    const result = await runHook(raw, { execKbSearch: defaultExecKbSearch, env: process.env });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    // Last-resort fail-open — a hook fault must never break the agent's turn.
    stderr = `[kb-context-inject] hook error: ${(err as Error).message}`;
  }
  if (stdout !== '') process.stdout.write(`${stdout}\n`);
  if (stderr !== '') process.stderr.write(`${stderr}\n`);
  process.exit(0);
}

void main();
