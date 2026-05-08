import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where to send a one-line warning when a file in `.claude/agents/` parses
 * to nothing. Defaults to `console.warn`; tests stub it. Visible noise is
 * the only diagnostic surface a user has when an agent silently disappears
 * under bypass mode.
 */
let warnSink: (msg: string) => void = (msg) => console.warn(msg);
export function __setWarnSinkForTests(sink: (msg: string) => void): void {
  warnSink = sink;
}

/**
 * Inline agent definition matching `claude --agents <json>` schema.
 * Per `claude --help`: keys are agent names, values carry at minimum a
 * `description` and `prompt`. `model` is honored when provided.
 */
export interface InlineAgentDef {
  description: string;
  prompt: string;
  model?: string;
}

/**
 * Read all `*.md` files in a directory and parse them as Claude Code agents.
 * Failure on any single file is silent (agent skipped) — fail-open keeps
 * launch reliable even if one file has malformed frontmatter.
 */
function loadAgentsFromDir(dir: string): Record<string, InlineAgentDef> {
  const out: Record<string, InlineAgentDef> = {};
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const path = join(dir, entry);
    const parsed = parseAgentFile(path);
    if (!parsed) {
      warnSink(`file-based-agents: skipped ${path} — missing frontmatter or 'name' field`);
      continue;
    }
    const { name, def } = parsed;
    out[name] = def;
  }
  return out;
}

interface ParsedAgent {
  name: string;
  def: InlineAgentDef;
}

/** Strict-but-tolerant frontmatter parser. Returns null on any oddity. */
function parseAgentFile(path: string): ParsedAgent | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  return parseAgentText(text);
}

/**
 * Parse Claude Code agent frontmatter into an inline-agent definition.
 *
 * Supports the subset of YAML actually seen in `.claude/agents/*.md`:
 *
 *   - `key: value`
 *   - `key: "quoted"` / `key: 'quoted'` (one pair of surrounding quotes stripped)
 *   - `key: |` followed by indented lines (literal block scalar — newlines preserved)
 *   - `key: >` followed by indented lines (folded block scalar — newlines → spaces)
 *   - `key:` followed by an indented `- list` (recognized so it doesn't pollute the
 *     next key, but the list value itself is dropped — `tools:` lists aren't carried
 *     into the inline agent contract)
 *
 * Returns `null` if there is no frontmatter, no closing fence, or no `name` field.
 * A real YAML library would be more correct but pulls in a dependency just for
 * this hot path; the code coverage here matches what real agents write.
 */
export function parseAgentText(text: string): ParsedAgent | null {
  const fenceOpen = text.startsWith('---\n') ? 4 : text.startsWith('---\r\n') ? 5 : -1;
  if (fenceOpen === -1) return null;
  const closeMatch = text.slice(fenceOpen).match(/\r?\n---\r?\n/);
  if (!closeMatch || closeMatch.index === undefined) return null;
  const fmText = text.slice(fenceOpen, fenceOpen + closeMatch.index);
  // Strip the blank line(s) that separate frontmatter from body, plus trailing
  // whitespace at end of file. Leading whitespace inside the body is preserved.
  const body = text
    .slice(fenceOpen + closeMatch.index + closeMatch[0].length)
    .replace(/^[\r\n]+/, '')
    .trimEnd();

  const fields = parseFrontmatterFields(fmText);
  if (!fields.name) return null;

  const def: InlineAgentDef = {
    description: fields.description ?? '',
    prompt: body,
  };
  if (fields.model) def.model = fields.model;
  return { name: fields.name, def };
}

function parseFrontmatterFields(fmText: string): Record<string, string> {
  const lines = fmText.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2];

    // Block scalar: `key: |` (literal) or `key: >` (folded).
    if (rest === '|' || rest === '>') {
      const folded = rest === '>';
      const collected: string[] = [];
      let blockIndent: number | null = null;
      i += 1;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === '') {
          collected.push('');
          i += 1;
          continue;
        }
        const indent = cur.match(/^[ \t]*/)?.[0].length ?? 0;
        if (indent === 0) break;
        if (blockIndent === null) blockIndent = indent;
        collected.push(cur.slice(blockIndent));
        i += 1;
      }
      // Trim trailing blank lines that were just spacing before the next key.
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      fields[key] = folded
        ? collected.map((l) => l.trim()).filter((l) => l.length > 0).join(' ')
        : collected.join('\n').trim();
      continue;
    }

    // Empty value with possible indented list / mapping continuation.
    // Skip past indented continuation lines so the next top-level key is
    // recognised correctly. The list value itself is dropped — none of the
    // fields we expose to `--agents` (description, model) are list-shaped.
    if (rest === '') {
      i += 1;
      while (i < lines.length && (lines[i] === '' || /^[ \t]/.test(lines[i]))) i += 1;
      continue;
    }

    fields[key] = rest.trim().replace(/^["']|["']$/g, '');
    i += 1;
  }
  return fields;
}

export interface LoadFileBasedAgentsOptions {
  /** Override `~/.claude/agents` for tests. */
  userAgentsDir?: string;
  /** Override `<cwd>/.claude/agents` for tests. */
  projectAgentsDir?: string;
}

/**
 * Load user-scope (`~/.claude/agents/`) and project-scope
 * (`<cwd>/.claude/agents/`) agents. Project entries override user entries
 * when names collide — same precedence Claude Code uses natively.
 *
 * Used by the Claude Code adapter to inject these agents back via
 * `--agents <json>` when `--setting-sources ''` strips file-based discovery.
 * See `docs/poc/007-bypass-keeps-file-based-agents.md`.
 */
export function loadFileBasedAgents(
  cwd: string,
  options: LoadFileBasedAgentsOptions = {},
): Record<string, InlineAgentDef> {
  const userDir = options.userAgentsDir ?? join(homedir(), '.claude', 'agents');
  const projectDir = options.projectAgentsDir ?? join(cwd, '.claude', 'agents');
  return {
    ...loadAgentsFromDir(userDir),
    ...loadAgentsFromDir(projectDir),
  };
}
