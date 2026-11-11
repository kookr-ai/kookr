// PR Checklist Contract — GitHub command adapter (P3).
//
// Pure string→struct extraction of the PR body and base ref from a raw
// `gh pr create …` invocation. The local hook (pr-workflow-gate.sh) forwards the
// raw command via `--from-command`; keeping the fragile shell-flag parsing here
// (not in bash) turns hook integration into pure-function tests (boundary-critic).
//
// The body is only *statically* verifiable when it is a literal `--body`/`-b`
// string, a `--body-file`/`-F` path that is a real file, or a `cat` heredoc
// substitution (`--body "$(cat <<'EOF' … EOF)"`, resolved by a pre-pass over the
// raw command — see `resolveHeredocBodies`). `--fill`/`--fill-*`, a missing body
// flag, `--body-file -` (stdin), and any other shell expansion (`$(…)`,
// backticks, `${…}`) are **unverifiable**. The first two set `templateRequired`
// so the CLI can still fail them when the repo ships a marker template; the rest
// are only reported as attest-unverified (printed, never a silent pass).

import { randomBytes } from 'node:crypto';

/** What the raw command yields for the body. */
export type GhBodySource =
  | { kind: 'file'; path: string }
  | { kind: 'inline'; text: string }
  | {
      kind: 'unverifiable';
      reason: string;
      /**
       * True when the body is one gh builds itself (`--fill*`) or that the command
       * does not provide at all. Such a body can never contain the template's
       * checklist, so the caller should fail it when the repo template declares
       * markers (rather than merely noting it as unverified).
       */
      templateRequired?: boolean;
    };

export interface GhExtract {
  /** Explicit `--base`/`-B` ref, or null (caller defaults, e.g. to `main`). */
  base: string | null;
  /** Explicit `--repo`/`-R` target (`owner/repo`), or null (gh infers it from the cwd). */
  repo: string | null;
  bodySource: GhBodySource;
}

/** Shell control tokens that end the `gh pr create` argument run. */
const CONTROL = new Set(['&&', '||', '|', ';', '&', '>', '>>', '<', '|&']);

/** A value carries a shell expansion we cannot resolve statically. */
function hasExpansion(value: string): boolean {
  return /\$\(|`|\$\{/.test(value);
}


/**
 * `--body|-b` (plain or `=`-joined) followed by a `$(cat <<DELIM` opener, with
 * or without an enclosing double quote. Group 1 = flag + separator, 2 = opening
 * quote, 3 = `-` (tab-stripping `<<-`), 4/5/6 = single-quoted / double-quoted /
 * bare delimiter. The opener must end at a newline: anything else after the
 * delimiter (a pipe, extra args) is not a plain `cat` of the heredoc.
 */
const HEREDOC_OPENER =
  /(?<![\w-])(--body=|--body[ \t]+|-b=|-b[ \t]+)(")?\$\([ \t]*cat[ \t]+<<(-)?[ \t]*(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)"|([A-Za-z_][\w.-]*))[ \t]*\r?\n/g;

/**
 * Pre-pass over the RAW command (before `tokenize`, which mis-splits on a `"` or
 * an unbalanced `)` inside heredoc text): replace each statically resolvable
 * `--body "$(cat <<'EOF' … EOF)"` after `gh pr create` with a single-quoted
 * placeholder token and return the literal heredoc text keyed by that
 * placeholder. Anything that is not exactly a `cat` heredoc with a terminator
 * line and the closing `)` is left untouched (it then stays unverifiable). The
 * text is only ever parsed for checklist marker rows — never executed or echoed.
 */
function resolveHeredocBodies(command: string): { command: string; bodies: Map<string, string> } {
  const bodies = new Map<string, string>();
  // Per-call nonce: a literal `--body <placeholder>` typed by the author must not
  // be able to alias a heredoc the pre-pass replaced.
  const nonce = randomBytes(8).toString('hex');
  const start = command.search(/\bgh\s+pr\s+create\b/);
  if (start < 0) return { command, bodies };

  let out = command.slice(0, start);
  let pos = start;
  HEREDOC_OPENER.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = HEREDOC_OPENER.exec(command)) !== null) {
    const delim = m[4] ?? m[5] ?? m[6];
    const stripTabs = m[3] === '-';
    const bodyStart = m.index + m[0].length;

    // Find the terminator line (exact match; `<<-` ignores leading tabs).
    let lineStart = bodyStart;
    let terminatorStart = -1;
    let terminatorEnd = -1;
    while (lineStart <= command.length) {
      const nl = command.indexOf('\n', lineStart);
      const lineEnd = nl < 0 ? command.length : nl;
      let line = command.slice(lineStart, lineEnd).replace(/\r$/, '');
      if (stripTabs) line = line.replace(/^\t+/, '');
      if (line === delim) {
        terminatorStart = lineStart;
        terminatorEnd = lineEnd;
        break;
      }
      if (nl < 0) break;
      lineStart = nl + 1;
    }
    // No terminator anywhere after this opener means none exists for any later
    // opener either — stop (also keeps adversarial input linear).
    if (terminatorStart < 0) break;

    // After the terminator: the substitution's closing `)` (and `"` if opened).
    const close = /^\s*\)/.exec(command.slice(terminatorEnd));
    if (!close) continue;
    let end = terminatorEnd + close[0].length;
    if (m[2]) {
      if (command[end] !== '"') continue;
      end += 1;
    }

    const text = command.slice(bodyStart, terminatorStart).replace(/\r?\n$/, '');
    const placeholder = `__KOOKR_HEREDOC_${nonce}_${bodies.size}__`;
    bodies.set(placeholder, text);
    out += `${command.slice(pos, m.index)}${m[1]}'${placeholder}'`;
    pos = end;
    HEREDOC_OPENER.lastIndex = end;
  }
  return { command: out + command.slice(pos), bodies };
}

/**
 * Split a command line into tokens, honoring single/double quotes. Unquoted
 * shell-control operators become their own tokens. Command substitutions are
 * preserved verbatim inside a token so `hasExpansion` can flag them (we do not
 * try to evaluate them).
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false; // current token has content (even if empty-quoted)
  let quote: '"' | "'" | null = null;

  const push = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += command[i + 1];
      has = true;
      i += 1;
      continue;
    }
    // Keep an unquoted `$(…)` substitution whole (balanced parens) so inner
    // spaces don't split it — `hasExpansion` still flags it downstream.
    if (c === '$' && command[i + 1] === '(') {
      let depth = 0;
      let j = i;
      for (; j < command.length; j += 1) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      cur += command.slice(i, j + 1);
      has = true;
      i = j;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      push();
      continue;
    }
    // Two-char operators.
    const two = command.slice(i, i + 2);
    if (['&&', '||', '>>', '|&'].includes(two)) {
      push();
      tokens.push(two);
      i += 1;
      continue;
    }
    if (c === '|' || c === ';' || c === '&' || c === '>' || c === '<') {
      push();
      tokens.push(c);
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return tokens;
}

/**
 * Return the argument tokens of the first `gh pr create` invocation, or null if
 * the command is not a `gh pr create`. Stops at the first shell-control token so
 * a trailing `&& …` / `| …` does not leak into the args.
 */
function ghPrCreateArgs(tokens: string[]): string[] | null {
  for (let i = 0; i + 2 < tokens.length + 1; i += 1) {
    if (tokens[i] === 'gh' && tokens[i + 1] === 'pr' && tokens[i + 2] === 'create') {
      const args: string[] = [];
      for (let j = i + 3; j < tokens.length; j += 1) {
        if (CONTROL.has(tokens[j])) break;
        args.push(tokens[j]);
      }
      return args;
    }
  }
  return null;
}

/** Value of `--flag value` / `--flag=value` / `-x value`; null if absent. Sets `expanded` on `$(...)`. */
function flagValue(args: string[], names: string[]): { value: string | null; expanded: boolean } {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    for (const name of names) {
      if (a === name) {
        const v = args[i + 1] ?? '';
        return { value: v, expanded: hasExpansion(v) };
      }
      if (a.startsWith(`${name}=`)) {
        const v = a.slice(name.length + 1);
        return { value: v, expanded: hasExpansion(v) };
      }
    }
  }
  return { value: null, expanded: false };
}

function hasFlag(args: string[], names: string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

/**
 * Extract base + body source from a raw `gh pr create …` command. Returns null
 * only when the command is not a `gh pr create` at all (caller: no-op).
 */
export function extractFromGhCommand(rawCommand: string): GhExtract | null {
  const { command, bodies } = resolveHeredocBodies(rawCommand);
  const args = ghPrCreateArgs(tokenize(command));
  if (args === null) return null;

  const base = flagValue(args, ['--base', '-B']).value;
  const repo = flagValue(args, ['--repo', '-R']).value;

  const file = flagValue(args, ['--body-file', '-F']);
  if (file.value !== null) {
    if (file.value === '-') {
      return { base, repo, bodySource: { kind: 'unverifiable', reason: '--body-file -: body read from stdin' } };
    }
    if (file.expanded) {
      return { base, repo, bodySource: { kind: 'unverifiable', reason: '--body-file path contains a shell expansion' } };
    }
    return { base, repo, bodySource: { kind: 'file', path: file.value } };
  }

  const body = flagValue(args, ['--body', '-b']);
  if (body.value !== null) {
    const heredoc = bodies.get(body.value);
    if (heredoc !== undefined) return { base, repo, bodySource: { kind: 'inline', text: heredoc } };
    if (body.expanded) {
      return { base, repo, bodySource: { kind: 'unverifiable', reason: '--body contains a shell expansion ($(…)/`…`)' } };
    }
    return { base, repo, bodySource: { kind: 'inline', text: body.value } };
  }

  // gh derives the body itself (commit messages) — it can never carry the repo
  // template's checklist, so the caller fails it when a marker template exists.
  if (hasFlag(args, ['--fill', '--fill-first', '--fill-verbose'])) {
    return {
      base,
      repo,
      bodySource: { kind: 'unverifiable', reason: '--fill: body generated by gh from commits', templateRequired: true },
    };
  }

  // --web hands the body to the GitHub UI, which prefills the template itself.
  if (hasFlag(args, ['--web', '-w'])) {
    return { base, repo, bodySource: { kind: 'unverifiable', reason: '--web: body composed in the browser' } };
  }

  // No body flag: gh opens an editor / infers — the checklist cannot be on the command.
  return {
    base,
    repo,
    bodySource: {
      kind: 'unverifiable',
      reason: 'no --body/--body-file/--fill: body not on the command line',
      templateRequired: true,
    },
  };
}
