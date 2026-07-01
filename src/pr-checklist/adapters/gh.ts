// PR Checklist Contract — GitHub command adapter (P3).
//
// Pure string→struct extraction of the PR body and base ref from a raw
// `gh pr create …` invocation. The local hook (pr-workflow-gate.sh) forwards the
// raw command via `--from-command`; keeping the fragile shell-flag parsing here
// (not in bash) turns hook integration into pure-function tests (boundary-critic).
//
// The body is only *statically* verifiable when it is a literal `--body`/`-b`
// string or a `--body-file`/`-F` path that is a real file. `--fill`/`--fill-*`,
// `--body-file -` (stdin), and any value containing a shell expansion
// (`$(…)`, backticks, `${…}`) are **unverifiable** — the engine then skips
// attestation locally and CI stays authoritative (never a silent pass).

/** What the raw command yields for the body. */
export type GhBodySource =
  | { kind: 'file'; path: string }
  | { kind: 'inline'; text: string }
  | { kind: 'unverifiable'; reason: string };

export interface GhExtract {
  /** Explicit `--base`/`-B` ref, or null (caller defaults, e.g. to `main`). */
  base: string | null;
  bodySource: GhBodySource;
}

/** Shell control tokens that end the `gh pr create` argument run. */
const CONTROL = new Set(['&&', '||', '|', ';', '&', '>', '>>', '<', '|&']);

/** A value carries a shell expansion we cannot resolve statically. */
function hasExpansion(value: string): boolean {
  return /\$\(|`|\$\{/.test(value);
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
export function extractFromGhCommand(command: string): GhExtract | null {
  const args = ghPrCreateArgs(tokenize(command));
  if (args === null) return null;

  const base = flagValue(args, ['--base', '-B']).value;

  // gh derives the body itself for these — we cannot see the text statically.
  if (hasFlag(args, ['--fill', '--fill-first', '--fill-verbose'])) {
    return { base, bodySource: { kind: 'unverifiable', reason: '--fill: body generated by gh from commits' } };
  }

  const file = flagValue(args, ['--body-file', '-F']);
  if (file.value !== null) {
    if (file.value === '-') {
      return { base, bodySource: { kind: 'unverifiable', reason: '--body-file -: body read from stdin' } };
    }
    if (file.expanded) {
      return { base, bodySource: { kind: 'unverifiable', reason: '--body-file path contains a shell expansion' } };
    }
    return { base, bodySource: { kind: 'file', path: file.value } };
  }

  const body = flagValue(args, ['--body', '-b']);
  if (body.value !== null) {
    if (body.expanded) {
      return { base, bodySource: { kind: 'unverifiable', reason: '--body contains a shell expansion ($(…)/`…`)' } };
    }
    return { base, bodySource: { kind: 'inline', text: body.value } };
  }

  // No body flag: gh opens an editor / infers — nothing to verify locally.
  return { base, bodySource: { kind: 'unverifiable', reason: 'no --body/--body-file/--fill: body not on the command line' } };
}
