// kb relevance nudge — a lightweight alternative to full context injection.
//
// The injection path (kb-context-injection.ts) runs `kb search --gate`, which
// invokes the Stage-B LLM judge on every turn: slow (up to KB_SEARCH_TIMEOUT_MS)
// and, when the judge endpoint is unhealthy, it silently degrades — the exact
// failure that made the dormant injection hook untrustworthy. The nudge path
// does none of that. On a substantive turn it runs ONE fast, ungated
// `kb search` and, only when the top hit is clearly close, appends a one-line
// non-blocking suggestion that the agent run `kb` itself. It never injects KB
// content, never calls the judge, and preserves agent agency: the agent reads
// the real results, so a false positive costs one ignored line, not a polluted
// turn.
//
// Fail-open throughout: any error returns an empty nudge so the turn proceeds.

import {
  stripPlaybookContextHeader,
  type KbContextInjectionDeps,
  type KbContextInjectionInput,
  type KbContextInjectionResult,
} from './kb-context-injection.js';

/** Query cap for the nudge probe (mirrors the injection path's bound). */
const NUDGE_QUERY_MAX_CHARS = 400;
/** How many results to pull when deciding whether to nudge. */
const NUDGE_K = 5;
/**
 * FAISS returns a DISTANCE per result — lower is closer (see
 * knowledge-base-mcp-server search-core.ts). A nudge should fire only on a
 * clearly-close hit, so the default is well under the gate's generous A1 keep
 * floor (KB_GATE_SCORE_FLOOR=0.95): observed genuinely-relevant hits sit around
 * 0.50-0.65. Tunable via KOOKR_KB_NUDGE_MAX_DISTANCE.
 */
export const NUDGE_MAX_DISTANCE_DEFAULT = 0.8;
/** Below this many real words, a prompt is treated as glue, not a KB question. */
const NUDGE_MIN_WORDS = 6;
/** Shelves named in the nudge line (the most relevant few). */
const NUDGE_MAX_SHELVES = 3;

/**
 * Glue / approval / command turns that are not information-needs. A turn whose
 * entire body (after header-strip) is one of these is never nudged, so a short
 * "yes push the PR" never triggers a KB probe. Matched case-insensitively
 * against the whole trimmed prompt, with trailing punctuation ignored.
 */
const GLUE_PROMPT_RE =
  /^(?:ok(?:ay)?|yes|yep|yeah|sure|y|no|nope|n|go|go ahead|proceed|continue|do it|lgtm|looks good|sounds good|approved?|ship it|merge(?: it)?|push(?: it)?(?: and open (?:the )?pr)?|retry|again|thanks?|ty|done|stop|wait|next|skip)\b[\s.!]*$/i;

/** Resolve the configured max distance, falling back to the default. */
export function nudgeMaxDistance(env: NodeJS.ProcessEnv): number {
  const raw = (env.KOOKR_KB_NUDGE_MAX_DISTANCE ?? '').trim();
  if (raw === '') return NUDGE_MAX_DISTANCE_DEFAULT;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : NUDGE_MAX_DISTANCE_DEFAULT;
}

/**
 * Whether a prompt is worth probing the KB for. Skips empty, short, and
 * glue/command turns — this both avoids the per-turn search cost on the
 * conversational majority and keeps the nudge from firing on turns that were
 * never a KB question.
 */
export function isNudgeEligiblePrompt(prompt: string): boolean {
  const body = stripPlaybookContextHeader(prompt).trim();
  if (body === '') return false;
  if (GLUE_PROMPT_RE.test(body)) return false;
  const words = body.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  return words.length >= NUDGE_MIN_WORDS;
}

export interface ScoredSource {
  /** The shelf (KB) name — the first path segment of the result source. */
  shelf: string;
  /** FAISS distance; lower is closer. */
  distance: number;
}

/** Pull (shelf, distance) pairs from a `kb search --format=json` payload. */
export function parseScoredSources(stdout: string): ScoredSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const results = (parsed as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  const out: ScoredSource[] = [];
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const score = rec.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    const sourceRaw =
      typeof rec.source === 'string'
        ? rec.source
        : typeof rec.chunk_id === 'string'
          ? rec.chunk_id
          : '';
    const shelf = shelfOf(sourceRaw);
    if (shelf === '') continue;
    out.push({ shelf, distance: score });
  }
  return out;
}

/** The shelf name is the first path segment of a result source. */
export function shelfOf(source: string): string {
  const trimmed = source.trim().replace(/^\.?\//, '');
  const seg = trimmed.split(/[/\\]/, 1)[0] ?? '';
  return seg.trim();
}

export interface NudgeDecision {
  nudge: boolean;
  /** Distinct shelves among the clearly-relevant hits, most-relevant first. */
  shelves: string[];
  /** How many results cleared the distance threshold. */
  count: number;
}

/** Decide whether the hits are close enough to nudge, and which shelves. */
export function decideNudge(items: ScoredSource[], maxDistance: number): NudgeDecision {
  const relevant = items
    .filter((it) => it.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);
  if (relevant.length === 0) return { nudge: false, shelves: [], count: 0 };
  const shelves: string[] = [];
  for (const it of relevant) {
    if (!shelves.includes(it.shelf)) shelves.push(it.shelf);
    if (shelves.length >= NUDGE_MAX_SHELVES) break;
  }
  return { nudge: true, shelves, count: relevant.length };
}

/** The agent-facing nudge line (stdout). Empty when nothing is nudged. */
export function formatNudge(decision: NudgeDecision, query: string): string {
  if (!decision.nudge) return '';
  const shelves = decision.shelves.join(', ');
  const noun = decision.count === 1 ? 'note' : 'notes';
  const hint = query.trim().replace(/\s+/g, ' ').slice(0, 60);
  return [
    '<system-reminder>',
    `[kb-nudge] Your local knowledge base has ${decision.count} ${noun} that look relevant `
      + `to this task (shelves: ${shelves}). Consider running \`kb search "${hint}"\` — `
      + 'or the `kb-scout` subagent for a broader survey — before diving in. '
      + 'Ignore this if it is not useful.',
    '</system-reminder>',
  ].join('\n');
}

/**
 * Run the nudge flow for one agent turn. Fail-open: any error returns an empty
 * nudge. Reuses the injected `execKbSearch` so tests never touch the binary.
 */
export async function runKbNudge(
  input: KbContextInjectionInput,
  deps: KbContextInjectionDeps,
): Promise<KbContextInjectionResult> {
  const prompt = input.prompt.trim();
  if (!isNudgeEligiblePrompt(prompt)) {
    return { stdout: '', stderr: '', turnId: 0 };
  }
  const query = stripPlaybookContextHeader(prompt).slice(0, NUDGE_QUERY_MAX_CHARS);
  try {
    // No `--gate` (no LLM judge → fast, no degradation) and no `--kb` (search
    // all shelves). `execFile` with an array arg makes the query shell-safe.
    const exec = await deps.execKbSearch([
      'search',
      query,
      `--k=${NUDGE_K}`,
      '--format=json',
    ]);
    if (exec.exitCode !== 0 || exec.stdout.trim() === '') {
      return {
        stdout: '',
        stderr: `[kb-nudge] kb search unavailable (exit ${exec.exitCode}); no nudge.`,
        turnId: 0,
      };
    }
    const items = parseScoredSources(exec.stdout);
    const decision = decideNudge(items, nudgeMaxDistance(deps.env));
    const top = items.length > 0 ? Math.min(...items.map((i) => i.distance)) : null;
    const stderr =
      `[kb-nudge] results=${items.length} top_distance=${top === null ? 'n/a' : top.toFixed(3)} `
      + `nudged=${decision.nudge}${decision.nudge ? ` shelves=${decision.shelves.join('|')}` : ''}`;
    return { stdout: formatNudge(decision, query), stderr, turnId: 0 };
  } catch (err) {
    return { stdout: '', stderr: `[kb-nudge] skipped (${(err as Error).message}); no nudge.`, turnId: 0 };
  }
}
