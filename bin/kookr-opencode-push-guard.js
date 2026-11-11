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
const GH_PR_BLOCKED = new Set(['merge', 'create', 'new', 'ready', 'close', 'reopen', 'review', 'comment', 'edit', 'lock', 'unlock', 'update-branch']);
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

/** Finds the first `<<DELIM` / `<<-DELIM` that sits OUTSIDE quotes on one line (not a `<<<` here-string). */
function findHeredoc(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return null; // comment: nothing after it runs
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|(\\)?([^\s;&|<>()'"\\]+))/.exec(line.slice(i));
      if (m) return { index: i, delim: m[1] ?? m[2] ?? m[4], expands: m[4] !== undefined && m[3] === undefined };
    }
  }
  return null;
}

/**
 * Removes heredoc bodies from the command text. A body fed to a shell is returned in `shellBodies` (it is run as
 * commands); the body of an unquoted-delimiter heredoc is returned in `expandingBodies` (only `$(...)` in it runs).
 */
function splitHeredocs(command) {
  const lines = command.split('\n');
  const kept = [];
  const shellBodies = [];
  const expandingBodies = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const h = findHeredoc(line);
    if (!h) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== h.delim) body.push(lines[j++]);
    // Fed to a shell if any word on the line is a shell (`bash <<EOF`, `/bin/bash <<EOF`, `cat <<EOF | bash`, `source /dev/stdin <<EOF`).
    if (toSegments(line).some((seg) => seg.some((tok) => SHELLS.has(basename(tok)) || tok === 'source' || tok === '.'))) shellBodies.push(body.join('\n'));
    else if (h.expands) expandingBodies.push(body.join('\n'));
    i = j; // skip body and the delimiter line
  }
  return { text: kept.join('\n'), shellBodies, expandingBodies };
}

/**
 * Inner text of every command substitution the shell would EXECUTE: `$( ... )` (balanced) and backtick pairs.
 * Text inside single quotes is literal, and so is anything after a backslash, so `git commit -m 'explain `git push`'`
 * is not a push. Double quotes still expand.
 */
function substitutions(text, literalQuotes = false) {
  const out = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (c === '\\') { i++; continue; }
    // Inside a heredoc body quote characters are plain text, so only the substitutions matter.
    if (!literalQuotes) {
      if (c === "'" && !inDouble) { inSingle = true; continue; }
      if (c === '"') { inDouble = !inDouble; continue; }
      // A comment (`#` at the start of a word, outside quotes) never runs, whatever it quotes.
      if (c === '#' && !inDouble && (i === 0 || /\s/.test(text[i - 1]))) { while (i < text.length && text[i] !== '\n') i++; continue; }
    }
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
      const short = /^-([A-Za-z]*)X([A-Za-z]*)$/.exec(tok); // -X PUT, -XPUT, -iX PUT, -iXPUT
      if (name === '--method') method = (value ?? t[i + 1] ?? '').toUpperCase();
      else if (short) method = (short[2] || t[i + 1] || '').toUpperCase();
      if (GH_API_FIELD_FLAGS.has(name) || /^-[fF]./.test(tok)) hasField = true; // -fkey=value too
      if (eq < 0 && (GH_API_OPTS_WITH_ARG.has(name) || /^-[A-Za-z]*X$/.test(tok))) i++;
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
    // Flags (some taking an argument) may sit between the command group and the action
    // (`gh pr --repo x merge 3`, `gh pr --title t create`), so take the first blocked action word anywhere after it.
    // A harmless command that merely has such a word as a flag value (`gh pr list --search merge`) is blocked too.
    const blocked = sub === 'pr' ? GH_PR_BLOCKED : GH_RELEASE_BLOCKED;
    const action = t.slice(i + 1).find((tok) => blocked.has(tok));
    return action ? `gh ${sub} ${action}` : null;
  }
  if (sub === 'api') return ghApiVerdict(t, i + 1);
  return null;
}

function segmentVerdict(t, depth) {
  // Any token may be the program (`env -u X git push`, `> /dev/null git push`, `nohup git push`, `xargs git push`),
  // so look at every position instead of guessing which leading words are wrappers or redirections. The cost is a
  // few conservative blocks (`echo git push` is blocked); a worker can rephrase those.
  for (let k = 0; k < t.length; k++) {
    const head = basename(t[k]);
    const rest = t.slice(k);
    let v = null;
    if (head === 'git') v = gitVerdict(rest);
    else if (head === 'gh') v = ghVerdict(rest);
    else if (head === 'eval') v = classifyCommand(rest.slice(1).join(' '), depth + 1);
    else if (SHELLS.has(head)) {
      const c = rest.findIndex((tok, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(tok));
      if (c > 0 && rest[c + 1] !== undefined) v = classifyCommand(rest[c + 1], depth + 1);
    }
    if (v) return v;
  }
  return null;
}

/** Returns a short description of the first publishing command found in `command`, or null. */
export function classifyCommand(command, depth = 0) {
  if (typeof command !== 'string' || !command.trim() || depth > MAX_DEPTH) return null;
  // A backslash-newline is a line continuation: `git push \\\n origin` is one command.
  const { text, shellBodies, expandingBodies } = splitHeredocs(command.replace(/\\\r?\n/g, ' '));
  for (const inner of [...substitutions(text), ...expandingBodies.flatMap((b) => substitutions(b, true)), ...shellBodies]) {
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
