#!/usr/bin/env node
// Logic for closes-keyword-guard.sh (issue #4185, moved from the user-level
// hooks/pr-workflow-gate.sh, where issue #3642 added it). Reads a Claude Code
// PreToolUse event (Bash tool) from stdin and checks the pull-request body of a
// `gh pr create` or `gh pr edit` for a closing reference GitHub will ignore.
//
// Why a plugin hook: Kookr starts its agents with `--setting-sources ''`, so
// user-level hooks never run in the tasks that write pull requests. Plugin
// hooks do.
//
// GitHub closes an issue on merge only for a closing keyword
// (close/fix/resolve + #N, optionally owner/repo#N) written as plain text. The
// same text inside inline code or a fenced code block is ignored, and an
// inline `(#N)` reference never closes anything. So:
//   - a closing keyword that appears ONLY inside code is denied, and the deny
//     reason prints the bare form to use instead. When the branch names an
//     issue (`issue-<N>`), only that issue's keyword is checked: a fenced
//     `git log` line such as "fix: resolve #77" is a quote, not an intent;
//   - when the branch names an issue and the body mentions #N only as a `(#N)`
//     reference, the command is allowed with a warning in the agent's context.
//
// Scanned text: every heredoc body in the command, the quoted value of an
// inline --body/-b, and the --body-file/-F contents when that file already
// exists. The title, other flags and chained commands are left out: GitHub
// never closes an issue from them.
//
// Exit 0 always. A denial or a warning is the JSON PreToolUse output on
// stdout. Any crash allows the command (fail open) and is logged to
// ~/.kookr/hook-errors.log.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bothSplits, flagValue, stripPrefixes } from './merge-retarget-guard.mjs';

function logError(message) {
  try {
    const dir = join(homedir(), '.kookr');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook-errors.log'), `${new Date().toISOString()} ERROR closes-keyword-guard: ${message}\n`);
  } catch {
    // nothing else to do
  }
}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

const KW = /(^|[^a-z0-9_])(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved):?[ \t]+((?:[a-z0-9_.-]+\/[a-z0-9_.-]+)?#[0-9]+)/g;
const PAREN = /\(#([0-9]+)\)/g;

/**
 * Findings in a Markdown body, as a list of
 *   { kind: 'CODE', ref, form }  closing keyword inside inline code / a fenced block
 *   { kind: 'BARE', ref }        closing keyword in plain text (GitHub honours it)
 *   { kind: 'PAREN', n }         a plain-text `(#n)` reference
 * `ref` is the lowercased issue reference (`#12` or `owner/repo#12`); `form`
 * is the keyword and reference as written.
 */
export function scanBody(text) {
  const findings = [];
  const keywords = (segment, kind) => {
    const low = segment.toLowerCase();
    KW.lastIndex = 0;
    let m;
    while ((m = KW.exec(low)) !== null) {
      const start = m.index + m[1].length;
      const ref = m[3];
      if (kind === 'CODE') findings.push({ kind, ref, form: segment.slice(start, m.index + m[0].length) });
      else findings.push({ kind, ref });
    }
  };
  const parens = (segment) => {
    PAREN.lastIndex = 0;
    let m;
    while ((m = PAREN.exec(segment)) !== null) findings.push({ kind: 'PAREN', n: m[1] });
  };

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\\`/g, '`'); // a double-quoted --body "…" carries \` escapes
    // Fences (CommonMark): open on 3+ backticks or tildes (up to 3 spaces of
    // indent); close only on the SAME character, at least as long, with
    // nothing but whitespace after it.
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const f = fence[1];
      const after = line.slice(fence[0].length);
      if (!inFence) {
        inFence = true; fenceChar = f[0]; fenceLen = f.length;
        continue;
      }
      if (f[0] === fenceChar && f.length >= fenceLen && /^[ \t]*$/.test(after)) {
        inFence = false;
        continue;
      }
    }
    if (inFence) { keywords(line, 'CODE'); continue; }
    // Split on backtick runs. An unclosed trailing backtick is literal text,
    // so its segment counts as plain.
    const segments = line.split(/`+/);
    segments.forEach((segment, i) => {
      if (i % 2 === 1 && i < segments.length - 1) keywords(segment, 'CODE');
      else { keywords(segment, 'BARE'); parens(segment); }
    });
  }
  return findings;
}

/**
 * The pull-request body text a command carries: every heredoc body, then the
 * quoted value of each inline `--body`/`-b` (also `--body=`) left once the
 * heredocs are cut out. Works on the raw command so a body written by
 * `cat > f <<EOF … EOF && gh pr create --body-file f` is seen too.
 */
export function bodyText(command) {
  let out = '';
  let cmd = command;
  const heredoc = /(?<!<)<<(?!<)(-?)[ \t]*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/;
  let m;
  while ((m = heredoc.exec(cmd)) !== null) {
    const strip = m[1] === '-';
    const delim = m[2];
    const head = cmd.slice(0, m.index);
    let rest = cmd.slice(m.index + m[0].length);
    const nl = rest.indexOf('\n');
    if (nl === -1) { cmd = head + rest; continue; }
    const tail = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    const lines = [];
    while (rest.length > 0) {
      const eol = rest.indexOf('\n');
      const line = eol === -1 ? rest : rest.slice(0, eol);
      rest = eol === -1 ? '' : rest.slice(eol + 1);
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
      lines.push(`${line}\n`);
    }
    out += lines.join('');
    cmd = `${head}${tail}\n${rest}`;
  }
  const inline = /(^|[ \t])(--body|-b)(=|[ \t]+)(["'])/;
  while ((m = inline.exec(cmd)) !== null) {
    const q = m[4];
    const rest = cmd.slice(m.index + m[0].length);
    let val = '';
    let i = 0;
    while (i < rest.length) {
      const c = rest[i];
      if (q === '"' && c === '\\' && i + 1 < rest.length) { val += c + rest[i + 1]; i += 2; continue; }
      if (c === q) break;
      val += c;
      i++;
    }
    out += `${val}\n`;
    cmd = rest.slice(i + 1);
  }
  return out;
}

/** Path of the linked worktree that has `branch` checked out, or null. */
function worktreeForBranch(dir, branch) {
  const list = run('git', ['-C', dir, 'worktree', 'list', '--porcelain'], dir);
  if (!list) return null;
  let current = null;
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Finds the `gh pr create` / `gh pr edit` in a command. Returns its words and
 * the working directory it runs in (the event's cwd, following `cd`/`pushd`),
 * or null when there is none.
 */
export function findPrCommand(command, cwd) {
  // Both splits: a `#` comment with an apostrophe (`# don't ...`) opens a
  // quote in the plain split and would hide the command that follows it.
  for (const commands of bothSplits(command)) {
    let dir = cwd;
    for (const words of commands) {
      const w = stripPrefixes(words);
      if (w.length === 0) continue;
      if (w[0] === 'cd' || w[0] === 'pushd') {
        const target = w.slice(1).find((a) => !a.startsWith('-'));
        const p = target ? expandHome(target) : homedir();
        dir = isAbsolute(p) ? p : resolve(dir, p);
        continue;
      }
      if (w[0] === 'gh' && w[1] === 'pr' && (w[2] === 'create' || w[2] === 'edit')) {
        // A `cd "$WT"` the splitter cannot resolve leaves a path that does
        // not exist; fall back to the event's cwd, as the old gate did.
        return { words: w, dir: isDir(dir) ? dir : cwd, sub: w[2] };
      }
    }
  }
  return null;
}

/**
 * Decides on one Bash command. Returns { deny: reason }, { warn: message }, or
 * null to allow silently.
 */
export function decide(command, cwd) {
  const found = findPrCommand(command, cwd);
  if (!found) return null;
  const { words, dir, sub } = found;

  // The head branch: `--head [user:]branch` on `gh pr create`, else the
  // branch checked out where the command runs.
  let branch = sub === 'create' ? flagValue(words, ['--head', '-H']) : null;
  const headGiven = branch !== null;
  if (branch !== null) {
    branch = branch.slice(branch.lastIndexOf(':') + 1).replace(/^refs\/heads\//, '');
  } else if (isDir(dir)) {
    branch = run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], dir);
  }

  let text = bodyText(command);
  // Add the --body-file / -F contents when the file already exists. (A body
  // written by a heredoc in the same command does not exist yet, but then the
  // heredoc text is part of the command.) A relative path is tried in the
  // head branch's worktree first: an agent can run in the launcher checkout
  // while --head names a sibling worktree.
  const bodyFile = flagValue(words, ['--body-file', '-F']);
  if (bodyFile && bodyFile !== '-') {
    const p = expandHome(bodyFile);
    const bases = [];
    if (!isAbsolute(p)) {
      if (headGiven && branch && isDir(dir)) {
        const wt = worktreeForBranch(dir, branch);
        if (wt) bases.push(wt);
      }
      bases.push(dir);
      if (cwd !== dir) bases.push(cwd);
    }
    const candidates = isAbsolute(p) ? [p] : bases.map((b) => resolve(b, p));
    const file = candidates.find((c) => existsSync(c) && !isDir(c));
    if (file) {
      try { text += `\n${readFileSync(file, 'utf-8')}`; } catch { /* unreadable: scan what we have */ }
    }
  }

  const findings = scanBody(text);
  if (findings.length === 0) return null;

  const issueMatch = /(^|[^A-Za-z0-9])issue-([0-9]+)([^0-9]|$)/.exec(branch ?? '');
  const issueN = issueMatch ? issueMatch[2] : null;

  // Deny: a ref closed only from inside code (no plain-text closer for it).
  const bareRefs = new Set(findings.filter((f) => f.kind === 'BARE').map((f) => f.ref));
  const bad = [];
  for (const f of findings) {
    if (f.kind !== 'CODE') continue;
    if (issueN && !f.ref.endsWith(`#${issueN}`)) continue;
    if (bareRefs.has(f.ref)) continue;
    if (!bad.includes(f.form)) bad.push(f.form);
  }
  if (bad.length > 0) {
    return {
      deny: 'PR body has a closing keyword inside inline code or a code block. GitHub ignores it there, so the issue will NOT close on merge. Write it as a bare line outside code instead:\n' +
        `${bad.join('\n')}\n` +
        '(If the code text is only an example and should close nothing, rephrase it without the closing keyword.)',
    };
  }

  // Warn: the branch issue appears only as an inline (#N) reference.
  if (!issueN) return null;
  const paren = findings.some((f) => f.kind === 'PAREN' && f.n === issueN);
  const closed = [...bareRefs].some((r) => r === `#${issueN}` || (r.endsWith(`#${issueN}`) && r.includes('/')));
  if (paren && !closed) {
    return {
      warn: `closes-keyword-guard: the PR body mentions issue #${issueN} only as an inline (#${issueN}) reference. GitHub does not close an issue from that form. If this PR should close the issue, add this bare line to the body (outside code): Closes #${issueN}`,
    };
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return;
  }
  if ((event?.tool_name ?? 'Bash') !== 'Bash') return;
  const command = String(event?.tool_input?.command ?? '');
  if (!/\bgh\b/.test(command) || !/\bpr\b/.test(command)) return;
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  const result = decide(command, cwd);
  if (!result) return;
  const out = result.deny
    ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.deny }
    : { hookEventName: 'PreToolUse', additionalContext: result.warn };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
  }
}
