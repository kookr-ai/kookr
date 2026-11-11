#!/usr/bin/env node
// kookr-opencode-push-guard — keeps profiled opencode workers local-only.
// Runs as a Claude-style PreToolUse hook on the Bash tool: the payload arrives
// as JSON on stdin ({tool_name, tool_input:{command}}); exit 2 + stderr makes
// the generated plugin fail the tool call with that message, exit 0 allows it.
//
// A profile worker (scoped-fix, reviewer, test-auditor) delivers a LOCAL commit
// or file for the operator to review. It must never publish: no `git push`, no
// pull-request merge/create/ready/close/review, no mutating `gh api` call.
// Before this guard that rule was only prose in the profile instructions.
//
// This is a guardrail against a compliant-but-careless model, not a sandbox: it
// does not try to stop a worker that deliberately obfuscates a command (for
// example by building the command from variables or calling the GitHub API with
// curl). It reads through the common wrappers (env/sudo/time/xargs, `bash -c`,
// `eval`, `$(...)`, backticks, heredocs fed to a shell, `&&`/`;`/`|` chains).
//
// Every unexpected internal error exits 0 (fail open), like the other hooks.

import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const STDIN_TIMEOUT_MS = 2000;
const MAX_DEPTH = 5;

const GIT_BLOCKED = new Set(['push', 'send-pack']);
const GIT_OPTS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const GH_PR_BLOCKED = new Set(['merge', 'create', 'ready', 'close', 'reopen', 'review', 'comment', 'edit', 'lock', 'unlock', 'update-branch']);
const GH_RELEASE_BLOCKED = new Set(['create', 'delete', 'edit', 'upload']);
const GH_GLOBAL_OPTS_WITH_ARG = new Set(['-R', '--repo', '--hostname']);
const GH_API_OPTS_WITH_ARG = new Set([
  '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q', '--jq', '-t', '--template',
  '--cache', '--hostname', '-p', '--preview',
]);
const GH_API_FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin', 'setsid', 'stdbuf']);
const KEYWORDS = new Set(['{', '}', '(', ')', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for']);

/** Replaces each heredoc body with nothing, except a body fed to a shell, which is returned for scanning. */
function splitHeredocs(command) {
  const lines = command.split('\n');
  const kept = [];
  const shellBodies = [];
  const expandingBodies = []; // unquoted-delimiter heredoc bodies: `$(...)` inside them still executes
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const m = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (!m) continue;
    const delim = m[1] ?? m[2] ?? m[3];
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== delim) body.push(lines[j++]);
    if (/(^|[\s;&|(])(?:bash|sh|zsh|dash|ksh|source|\.)\b/.test(line.slice(0, m.index))) shellBodies.push(body.join('\n'));
    else if (m[3] !== undefined) expandingBodies.push(body.join('\n'));
    i = j; // skip body and the delimiter line
  }
  return { text: kept.join('\n'), shellBodies, expandingBodies };
}

/**
 * Inner text of every command substitution the shell would EXECUTE: `$( ... )` (balanced) and backtick pairs.
 * Text inside single quotes is literal, and so is anything after a backslash, so `git commit -m 'explain `git push`'`
 * is not a push. Double quotes still expand.
 */
function substitutions(text) {
  const out = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" && !inDouble) { inSingle = true; continue; }
    if (c === '"') { inDouble = !inDouble; continue; }
    if (c === '$' && text[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
    } else if (c === '`') {
      let end = i + 1;
      while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
      if (end < text.length) { out.push(text.slice(i + 1, end)); i = end; }
    }
  }
  return out;
}

/** Quote-aware split into simple commands, each an array of unquoted tokens. */
function toSegments(text) {
  const segments = [];
  let tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  const pushTok = () => { if (has) tokens.push(cur); cur = ''; has = false; };
  const pushSeg = () => { pushTok(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
      has = true;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < text.length) { cur += text[++i]; has = true; continue; }
    if (c === '#' && !has && (i === 0 || /\s/.test(text[i - 1]))) { while (i < text.length && text[i] !== '\n') i++; pushSeg(); continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { pushSeg(); continue; }
    if (/\s/.test(c)) { pushTok(); continue; }
    cur += c;
    has = true;
  }
  pushSeg();
  return segments;
}

function gitVerdict(t) {
  let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    i += GIT_OPTS_WITH_ARG.has(t[i]) ? 2 : 1;
  }
  const sub = t[i];
  if (sub === 'subtree' && t[i + 1] === 'push') return 'git subtree push';
  return sub && GIT_BLOCKED.has(sub) ? `git ${sub}` : null;
}

function ghApiVerdict(t, from) {
  let method = null;
  let hasField = false;
  let endpoint = null;
  for (let i = from; i < t.length; i++) {
    const tok = t[i];
    if (tok.startsWith('-')) {
      const eq = tok.indexOf('=');
      const name = eq > 0 ? tok.slice(0, eq) : tok;
      const value = eq > 0 ? tok.slice(eq + 1) : null;
      if (name === '-X' || name === '--method') method = (value ?? t[i + 1] ?? '').toUpperCase();
      else if (/^-X./.test(tok)) method = tok.slice(2).toUpperCase(); // attached form: -XPOST
      if (GH_API_FIELD_FLAGS.has(name) || /^-[fF]./.test(tok)) hasField = true; // -fkey=value too
      if (eq < 0 && GH_API_OPTS_WITH_ARG.has(name)) i++;
    } else if (endpoint === null) {
      endpoint = tok;
    }
  }
  if (endpoint === 'graphql') return t.some((tok) => /\bmutation\b/i.test(tok)) ? 'gh api graphql mutation' : null;
  if (method !== null && method !== 'GET') return `gh api -X ${method}`;
  if (method === null && hasField) return 'gh api with request fields (implicit POST)';
  return null;
}

function ghVerdict(t) {
  let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    i += GH_GLOBAL_OPTS_WITH_ARG.has(t[i]) ? 2 : 1;
  }
  const sub = t[i];
  if (sub === 'pr' || sub === 'release') {
    // `gh pr --repo x merge 3`: flags may sit between the command group and the action.
    let j = i + 1;
    while (j < t.length && t[j].startsWith('-')) j += GH_GLOBAL_OPTS_WITH_ARG.has(t[j]) ? 2 : 1;
    const action = t[j];
    const blocked = sub === 'pr' ? GH_PR_BLOCKED : GH_RELEASE_BLOCKED;
    return action && blocked.has(action) ? `gh ${sub} ${action}` : null;
  }
  if (sub === 'api') return ghApiVerdict(t, i + 1);
  return null;
}

function segmentVerdict(rawTokens, depth) {
  let t = rawTokens.slice();
  for (;;) {
    while (t.length && (KEYWORDS.has(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) t = t.slice(1);
    if (!t.length) return null;
    const head = basename(t[0]);
    if (head === 'env') { t = t.slice(1); while (t.length && (t[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) t = t.slice(1); continue; }
    if (head === 'xargs') { t = t.slice(1); while (t.length && t[0].startsWith('-')) t = t.slice(1); continue; }
    if (WRAPPERS.has(head)) { t = t.slice(1); while (t.length && t[0].startsWith('-')) t = t.slice(1); continue; }
    break;
  }
  const head = basename(t[0]);
  if (head === 'git') return gitVerdict(t);
  if (head === 'gh') return ghVerdict(t);
  if (head === 'eval') return classifyCommand(t.slice(1).join(' '), depth + 1);
  if (SHELLS.has(head)) {
    const c = t.findIndex((tok, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(tok));
    if (c > 0 && t[c + 1] !== undefined) return classifyCommand(t[c + 1], depth + 1);
  }
  return null;
}

/** Returns a short description of the first publishing command found in `command`, or null. */
export function classifyCommand(command, depth = 0) {
  if (typeof command !== 'string' || !command.trim() || depth > MAX_DEPTH) return null;
  // A backslash-newline is a line continuation: `git push \\\n origin` is one command.
  const { text, shellBodies, expandingBodies } = splitHeredocs(command.replace(/\\\r?\n/g, ' '));
  for (const inner of [...substitutions(text), ...expandingBodies.flatMap(substitutions), ...shellBodies]) {
    const v = classifyCommand(inner, depth + 1);
    if (v) return v;
  }
  for (const seg of toSegments(text)) {
    const v = segmentVerdict(seg, depth);
    if (v) return v;
  }
  return null;
}

function readStdin() {
  return new Promise((resolveStdin) => {
    let buf = '';
    const timer = setTimeout(() => resolveStdin(buf), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); resolveStdin(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolveStdin(buf); });
  });
}

export async function main() {
  let payload = null;
  try { payload = JSON.parse((await readStdin()) || 'null'); } catch { return 0; }
  if (!payload || payload.tool_name !== 'Bash') return 0;
  const command = payload.tool_input && payload.tool_input.command;
  const hit = classifyCommand(command);
  if (!hit) return 0;
  process.stderr.write(
    `Blocked by the Kookr worker guard: \`${hit}\` is not allowed in this profile.\n` +
    'You deliver a LOCAL commit (and PR_BODY.md or the profile file) for the operator to review; ' +
    'the operator pushes and opens the pull request. Do not push, merge or open pull requests. ' +
    'Commit locally and finish; if you believe a push is required, say so in your final message instead.\n',
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`kookr-opencode-push-guard: internal error (${err}); allowing\n`);
    process.exit(0);
  });
}
