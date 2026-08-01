/**
 * Reflection telemetry — `ideasFiled` auto-resolver (#1751).
 *
 * The daily workflow-reflection playbook records each run's filed idea URLs in
 * `~/.kookr/playbook-state/lucy/workflow-reflection/log.jsonl` as one JSON
 * object per line:
 *
 *   {"date":"2026-07-31","directionVerdict":"forward",
 *    "ideasFiled":["https://github.com/kookr-ai/kookr/issues/1751"],
 *    "topFriction":"…"}
 *
 * Historically the reflection's Phase 1 resolved each prior `ideasFiled` URL to
 * its current state (open / closed / shipped-by-PR#) by hand, issuing manual
 * `gh` queries every run. These helpers do that resolution mechanically and
 * emit a compact filed→shipped table.
 *
 * All GitHub access is injected via an {@link IssueProbe} so this module stays
 * pure and unit-testable — the CLI supplies a `gh api graphql` implementation.
 */

export interface ReflectionLogEntry {
  date: string | null;
  directionVerdict: string | null;
  ideasFiled: string[];
  topFriction: string | null;
}

export interface IssueRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

export interface FiledIdea {
  url: string;
  ref: IssueRef | null;
  /** ISO date of the reflection run the idea was first filed in. */
  filedDate: string | null;
}

export type IdeaState = 'open' | 'closed' | 'shipped' | 'unknown';

export interface ClosingPr {
  number: number;
  url: string;
  merged: boolean;
}

export interface RawIssueState {
  state: 'OPEN' | 'CLOSED';
  stateReason: string | null;
  closingPrs: ClosingPr[];
}

/** Resolves a single issue reference to its current GitHub state. */
export type IssueProbe = (ref: IssueRef) => Promise<RawIssueState>;

export interface ResolvedIdea {
  url: string;
  owner: string | null;
  repo: string | null;
  number: number | null;
  filedDate: string | null;
  state: IdeaState;
  stateReason: string | null;
  shippedByPr: number | null;
  shippedByPrUrl: string | null;
  error: string | null;
}

export interface IdeasSummary {
  total: number;
  open: number;
  closed: number;
  shipped: number;
  unknown: number;
  /** shipped / (total − unknown), or null when nothing was resolvable. */
  shippedRate: number | null;
}

/**
 * Parse the reflection `log.jsonl` text into entries, tolerating blank lines
 * and malformed records (which are skipped rather than throwing — a corrupt
 * line must not break the whole reflection).
 */
export function parseReflectionLog(text: string): ReflectionLogEntry[] {
  const entries: ReflectionLogEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const ideasFiled = Array.isArray(record.ideasFiled)
      ? record.ideasFiled.filter((u): u is string => typeof u === 'string')
      : [];
    entries.push({
      date: typeof record.date === 'string' ? record.date : null,
      directionVerdict:
        typeof record.directionVerdict === 'string' ? record.directionVerdict : null,
      ideasFiled,
      topFriction: typeof record.topFriction === 'string' ? record.topFriction : null,
    });
  }
  return entries;
}

/** Parse a GitHub issue URL into owner/repo/number, or null if not an issue URL. */
export function parseIssueRef(url: string): IssueRef | null {
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/.exec(url.trim());
  if (!match) return null;
  const number = Number.parseInt(match[3]!, 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { url: url.trim(), owner: match[1]!, repo: match[2]!, number };
}

/**
 * Flatten the `ideasFiled` URLs across the last `runs` reflection entries,
 * de-duplicating by owner/repo#number (keeping the earliest filed date).
 */
export function collectIdeasFiled(
  entries: ReflectionLogEntry[],
  opts: { runs?: number } = {},
): FiledIdea[] {
  const runs = opts.runs && opts.runs > 0 ? Math.floor(opts.runs) : 1;
  const selected = entries.slice(-runs);
  const seen = new Set<string>();
  const out: FiledIdea[] = [];
  for (const entry of selected) {
    for (const url of entry.ideasFiled) {
      const ref = parseIssueRef(url);
      const key = ref ? `${ref.owner}/${ref.repo}#${ref.number}` : url.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: url.trim(), ref, filedDate: entry.date });
    }
  }
  return out;
}

interface GraphqlIssueNode {
  state?: string;
  stateReason?: string | null;
  closedByPullRequestsReferences?: {
    nodes?: Array<{ number?: number; url?: string; merged?: boolean } | null>;
  };
}

/**
 * Parse the JSON body of a `gh api graphql` issue query into a
 * {@link RawIssueState}. Pure — separated from the process spawn so the fragile
 * response-shape handling (GraphQL error envelope, non-JSON output, missing
 * issue, null PR nodes) is unit-testable without shelling out to `gh`.
 *
 * @throws Error on non-JSON output, a GraphQL error envelope, or a null issue.
 */
export function parseGhIssueResponse(stdout: string): RawIssueState {
  let parsed: {
    data?: { repository?: { issue?: GraphqlIssueNode | null } | null };
    errors?: Array<{ message?: string; type?: string }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('gh returned non-JSON output');
  }

  const issue = parsed.data?.repository?.issue;
  if (!issue) {
    throw new Error(parsed.errors?.[0]?.message ?? 'issue not found');
  }

  const state = issue.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const closingPrs: ClosingPr[] = (issue.closedByPullRequestsReferences?.nodes ?? [])
    .filter((n): n is { number: number; url: string; merged?: boolean } =>
      n != null && typeof n.number === 'number' && typeof n.url === 'string',
    )
    .map((n) => ({ number: n.number, url: n.url, merged: Boolean(n.merged) }));

  return {
    state,
    stateReason: typeof issue.stateReason === 'string' ? issue.stateReason : null,
    closingPrs,
  };
}

/** Map a raw GitHub state to an {@link IdeaState} and its shipping PR (if any). */
export function classifyIssueState(raw: RawIssueState): {
  state: IdeaState;
  shippedByPr: number | null;
  shippedByPrUrl: string | null;
} {
  if (raw.state === 'OPEN') {
    return { state: 'open', shippedByPr: null, shippedByPrUrl: null };
  }
  const mergedPr = raw.closingPrs.find((pr) => pr.merged);
  if (mergedPr) {
    return { state: 'shipped', shippedByPr: mergedPr.number, shippedByPrUrl: mergedPr.url };
  }
  return { state: 'closed', shippedByPr: null, shippedByPrUrl: null };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Resolve each filed idea to its current state via `probe`. Probe failures and
 * unparseable URLs degrade to `state: 'unknown'` with an `error` rather than
 * rejecting — a single unreachable issue must not sink the whole table.
 */
export async function resolveIdeas(
  filed: readonly FiledIdea[],
  probe: IssueProbe,
  opts: { concurrency?: number } = {},
): Promise<ResolvedIdea[]> {
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 4;
  return mapWithConcurrency(filed, concurrency, async (item): Promise<ResolvedIdea> => {
    if (!item.ref) {
      return {
        url: item.url,
        owner: null,
        repo: null,
        number: null,
        filedDate: item.filedDate,
        state: 'unknown',
        stateReason: null,
        shippedByPr: null,
        shippedByPrUrl: null,
        error: 'unparseable issue URL',
      };
    }
    const { ref } = item;
    try {
      const raw = await probe(ref);
      const classified = classifyIssueState(raw);
      return {
        url: ref.url,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        filedDate: item.filedDate,
        state: classified.state,
        stateReason: raw.stateReason,
        shippedByPr: classified.shippedByPr,
        shippedByPrUrl: classified.shippedByPrUrl,
        error: null,
      };
    } catch (err) {
      return {
        url: ref.url,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        filedDate: item.filedDate,
        state: 'unknown',
        stateReason: null,
        shippedByPr: null,
        shippedByPrUrl: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function summarizeIdeas(resolved: readonly ResolvedIdea[]): IdeasSummary {
  const summary: IdeasSummary = {
    total: resolved.length,
    open: 0,
    closed: 0,
    shipped: 0,
    unknown: 0,
    shippedRate: null,
  };
  for (const idea of resolved) {
    summary[idea.state] += 1;
  }
  const resolvable = summary.total - summary.unknown;
  summary.shippedRate = resolvable > 0 ? summary.shipped / resolvable : null;
  return summary;
}

function slug(idea: ResolvedIdea): string {
  if (idea.owner && idea.repo && idea.number != null) {
    return `${idea.repo}#${idea.number}`;
  }
  return idea.url;
}

/** Render a compact, human-readable filed→shipped table. */
export function formatIdeasTable(resolved: readonly ResolvedIdea[]): string {
  if (resolved.length === 0) {
    return '(no ideas filed in the selected window)';
  }
  const rows = resolved.map((idea) => {
    const label = slug(idea).padEnd(22);
    const filed = idea.filedDate ? `filed ${idea.filedDate}` : 'filed ?';
    let state: string;
    switch (idea.state) {
      case 'shipped':
        state = `→ shipped by PR #${idea.shippedByPr}`;
        break;
      case 'closed':
        state = '→ closed (unshipped)';
        break;
      case 'open':
        state = '→ open';
        break;
      default:
        state = `→ unknown${idea.error ? ` (${idea.error})` : ''}`;
    }
    return `  ${label} ${filed.padEnd(17)} ${state}`;
  });
  const s = summarizeIdeas(resolved);
  const rate = s.shippedRate == null ? 'n/a' : `${Math.round(s.shippedRate * 100)}%`;
  const footer =
    `\n${s.total} filed · ${s.shipped} shipped · ${s.closed} closed(unshipped) · ` +
    `${s.open} open · ${s.unknown} unknown · ship-rate ${rate}`;
  return `${rows.join('\n')}\n${footer}`;
}
