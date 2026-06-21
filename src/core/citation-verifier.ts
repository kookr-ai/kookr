import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export type CitationInputFormat = 'json' | 'jsonl' | 'markdown';

export interface CitationClaim {
  id?: string;
  label?: string;
  path: string;
  line?: number | string | CitationLineRange;
  quote?: string;
}

export interface CitationLineRange {
  start: number;
  end: number;
}

export type CitationFailureReason =
  | 'file_not_found'
  | 'path_outside_source_root'
  | 'line_unresolvable'
  | 'quote_not_found'
  | 'no_falsifiable_claims'
  | 'invalid_claim';

export interface CitationFailure {
  reason: CitationFailureReason;
  message: string;
  claimId?: string;
  label?: string;
  path?: string;
  line?: CitationLineRange;
  quote?: string;
}

export interface CitationVerificationResult {
  verdict: 'grounded' | 'unverifiable';
  failures: CitationFailure[];
}

interface NormalizedClaim extends CitationClaim {
  lineRange?: CitationLineRange;
}

const PATH_CITATION_RE = /^(.+?):(\d+)(?:-(\d+))?$/;
const MARKDOWN_PATH_RE = /\*\*([^*\n]+?\.(?:md|mdx|txt|json|jsonl|yaml|yml|ts|tsx|js|jsx|mjs|cjs|sh|py|html|css)(?:(?::\d+(?:-\d+)?)|(?:#L\d+(?:-L?\d+)?))?)\*\*/i;

export function verifyCitationClaims(claims: CitationClaim[], sourceRoot: string): CitationVerificationResult {
  const root = resolve(sourceRoot);
  const failures: CitationFailure[] = [];
  let sawFalsifiableClaim = false;

  for (const claim of claims) {
    const normalized = normalizeClaim(claim);
    if (!normalized) {
      failures.push({
        reason: 'invalid_claim',
        message: 'Claim must include a non-empty path.',
        claimId: claim.id,
        label: claim.label,
      });
      continue;
    }
    sawFalsifiableClaim = true;

    const resolvedPath = resolveCitationPath(root, normalized.path);
    if (!resolvedPath) {
      failures.push(failure(normalized, 'path_outside_source_root', `Citation path escapes source root: ${normalized.path}`));
      continue;
    }

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      failures.push(failure(normalized, 'file_not_found', `Citation file does not exist: ${normalized.path}`));
      continue;
    }

    const raw = readFileSync(resolvedPath, 'utf8');

    if (normalized.lineRange) {
      const lines = raw.split(/\r?\n/);
      const { start, end } = normalized.lineRange;
      if (start < 1 || end < start || end > lines.length) {
        failures.push(failure(
          normalized,
          'line_unresolvable',
          `Citation line range ${formatLineRange(normalized.lineRange)} is outside ${normalized.path} (${lines.length} line(s)).`,
        ));
      }
    }

    if (normalized.quote && normalized.quote.trim().length > 0) {
      if (!containsNormalizedQuote(raw, normalized.quote)) {
        failures.push(failure(normalized, 'quote_not_found', `Quoted citation text was not found in ${normalized.path}.`));
      }
    }
  }

  if (!sawFalsifiableClaim && failures.length === 0) {
    failures.push({
      reason: 'no_falsifiable_claims',
      message: 'No falsifiable citation claims were found.',
    });
  }

  return {
    verdict: failures.length === 0 ? 'grounded' : 'unverifiable',
    failures,
  };
}

export function parseCitationClaims(format: CitationInputFormat, content: string): CitationClaim[] {
  switch (format) {
    case 'json':
      return parseJsonCitationClaims(JSON.parse(content) as unknown);
    case 'jsonl':
      return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => parseJsonCitationClaims(JSON.parse(line) as unknown));
    case 'markdown':
      return parseMarkdownCitationClaims(content);
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

export function parseJsonCitationClaims(value: unknown): CitationClaim[] {
  const candidates = unwrapJsonClaims(value);
  return candidates.flatMap((candidate, index) => jsonValueToClaim(candidate, index));
}

export function parseMarkdownCitationClaims(content: string): CitationClaim[] {
  const claims: CitationClaim[] = [];
  const lines = content.split(/\r?\n/);
  let current: CitationClaim | undefined;
  let quoteLines: string[] = [];

  const flush = () => {
    if (!current) return;
    const quote = normalizeWhitespace(quoteLines.join(' '));
    claims.push(quote ? { ...current, quote } : current);
    current = undefined;
    quoteLines = [];
  };

  for (const line of lines) {
    const cite = line.match(MARKDOWN_PATH_RE);
    if (cite) {
      flush();
      current = { path: cite[1].trim() };
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote && current) {
      quoteLines.push(quote[1]);
      continue;
    }

    if (quoteLines.length > 0) flush();
  }

  flush();
  return claims;
}

export function inferCitationInputFormat(path: string): CitationInputFormat {
  if (path.endsWith('.jsonl')) return 'jsonl';
  if (path.endsWith('.json')) return 'json';
  return 'markdown';
}

function unwrapJsonClaims(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ['claims', 'citations', 'passages', 'evidence']) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
  }
  return [value];
}

function jsonValueToClaim(value: unknown, index: number): CitationClaim[] {
  if (!isRecord(value)) return [];
  const path = firstString(value, ['path', 'file', 'source', 'sourcePath', 'citation']);
  if (!path) return [];
  return [{
    id: firstString(value, ['id', 'claimId']) ?? String(index + 1),
    label: firstString(value, ['label', 'name']),
    path,
    line: lineFromJson(value),
    quote: firstString(value, ['quote', 'excerpt', 'text', 'verbatim']),
  }];
}

function lineFromJson(value: Record<string, unknown>): number | string | CitationLineRange | undefined {
  const line = value.line ?? value.lines ?? value.lineRange ?? value.loc;
  if (typeof line === 'number' || typeof line === 'string') return line;
  if (isRecord(line)) {
    const start = numberField(line, ['start', 'from', 'line']);
    const end = numberField(line, ['end', 'to']) ?? start;
    if (start !== undefined && end !== undefined) return { start, end };
  }
  const start = numberField(value, ['lineStart', 'startLine']);
  const end = numberField(value, ['lineEnd', 'endLine']) ?? start;
  return start !== undefined && end !== undefined ? { start, end } : undefined;
}

function normalizeClaim(claim: CitationClaim): NormalizedClaim | undefined {
  const path = claim.path?.trim();
  if (!path) return undefined;
  const pathWithLine = parsePathLineReference(path);
  const explicitLine = parseLineRange(claim.line);
  return {
    ...claim,
    path: pathWithLine?.path ?? path,
    lineRange: explicitLine ?? pathWithLine?.lineRange,
  };
}

function parsePathLineReference(path: string): { path: string; lineRange: CitationLineRange } | undefined {
  const normalized = path.replace(/#L(\d+)(?:-L?(\d+))?$/i, (_match, start: string, end: string | undefined) => {
    return end ? `:${start}-${end}` : `:${start}`;
  });
  const match = normalized.match(PATH_CITATION_RE);
  if (!match) return undefined;
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  return { path: match[1], lineRange: { start, end } };
}

function parseLineRange(line: CitationClaim['line']): CitationLineRange | undefined {
  if (line === undefined) return undefined;
  if (typeof line === 'number') return Number.isInteger(line) ? { start: line, end: line } : undefined;
  if (typeof line === 'string') {
    const match = line.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return undefined;
    return { start: Number(match[1]), end: Number(match[2] ?? match[1]) };
  }
  return line;
}

function resolveCitationPath(root: string, citationPath: string): string | undefined {
  if (isAbsolute(citationPath)) return undefined;
  const absolutePath = resolve(root, citationPath);
  const rel = relative(root, absolutePath);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return absolutePath;
}

function containsNormalizedQuote(source: string, quote: string): boolean {
  const sourceNorm = normalizeWhitespace(source);
  const segments = quote
    .split(/(?:\.\.\.|…|\[\.\.?\])/)
    .map(normalizeWhitespace)
    .filter(Boolean);
  if (segments.length === 0) return sourceNorm.includes(normalizeWhitespace(quote));

  let searchOffset = 0;
  for (const segment of segments) {
    const index = sourceNorm.indexOf(segment, searchOffset);
    if (index === -1) return false;
    searchOffset = index + segment.length;
  }
  return true;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function failure(claim: NormalizedClaim, reason: CitationFailureReason, message: string): CitationFailure {
  return {
    reason,
    message,
    claimId: claim.id,
    label: claim.label,
    path: claim.path,
    line: claim.lineRange,
    quote: claim.quote,
  };
}

function formatLineRange(range: CitationLineRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function numberField(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}
