#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const usage = 'Usage: node verify-citations.mjs --input <file> --source-root <dir> [--format json|jsonl|markdown] [--allow-prefix <path>]...';

const PATH_CITATION_RE = /^(.+?):(\d+)(?:-(\d+))?$/;
const MARKDOWN_PATH_RE = /\*\*([^*\n]+?\.(?:md|mdx|txt|json|jsonl|yaml|yml|ts|tsx|js|jsx|mjs|cjs|sh|py|html|css)(?:(?::\d+(?:-\d+)?)|(?:#L\d+(?:-L?\d+)?))?)\*\*/i;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage);
  process.exit(0);
}
if (!args.input || !args.sourceRoot) {
  console.error(usage);
  process.exit(2);
}

const content = readFileSync(args.input, 'utf8');
const format = args.format ?? inferFormat(args.input);
const claims = parseClaims(format, content);
const result = verifyClaims(claims, args.sourceRoot, args.allowPrefixes ?? []);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.verdict === 'grounded' ? 0 : 1);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--input') {
      parsed.input = requireValue(arg, value);
      index += 1;
    } else if (arg === '--source-root') {
      parsed.sourceRoot = requireValue(arg, value);
      index += 1;
    } else if (arg === '--format') {
      parsed.format = parseFormat(requireValue(arg, value));
      index += 1;
    } else if (arg === '--allow-prefix') {
      parsed.allowPrefixes ??= [];
      parsed.allowPrefixes.push(requireValue(arg, value));
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function parseFormat(value) {
  if (value === 'json' || value === 'jsonl' || value === 'markdown') return value;
  console.error(`Unsupported --format ${value}; expected json, jsonl, or markdown`);
  process.exit(2);
}

function inferFormat(path) {
  if (path.endsWith('.jsonl')) return 'jsonl';
  if (path.endsWith('.json')) return 'json';
  return 'markdown';
}

function parseClaims(format, content) {
  if (format === 'json') return parseJsonClaims(JSON.parse(content));
  if (format === 'jsonl') {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => parseJsonClaims(JSON.parse(line)));
  }
  return parseMarkdownClaims(content);
}

function parseJsonClaims(value) {
  return unwrapJsonClaims(value).flatMap((candidate, index) => jsonValueToClaim(candidate, index));
}

function unwrapJsonClaims(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ['claims', 'citations', 'passages', 'evidence']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [value];
}

function jsonValueToClaim(value, index) {
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

function lineFromJson(value) {
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

function parseMarkdownClaims(content) {
  const claims = [];
  const lines = content.split(/\r?\n/);
  let current;
  let quoteLines = [];

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

function verifyClaims(claims, sourceRoot, allowPrefixes) {
  const root = resolve(sourceRoot);
  const failures = [];
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

    if (!normalized.quote || normalized.quote.trim().length === 0) {
      failures.push(failure(normalized, 'quote_required', `Citation must include a quoted excerpt: ${normalized.path}`));
      continue;
    }

    const resolvedPath = resolveCitationPath(root, normalized.path);
    if (!resolvedPath) {
      failures.push(failure(normalized, 'path_outside_source_root', `Citation path escapes source root: ${normalized.path}`));
      continue;
    }

    const rootRelativePath = relative(root, resolvedPath);
    if (allowPrefixes.length > 0 && !isAllowedPath(rootRelativePath, allowPrefixes)) {
      failures.push(failure(normalized, 'path_not_allowed', `Citation path is not under an allowed prefix: ${normalized.path}`));
      continue;
    }

    if (!existsSync(resolvedPath)) {
      failures.push(failure(normalized, 'file_not_found', `Citation file does not exist: ${normalized.path}`));
      continue;
    }

    if (lstatSync(resolvedPath).isSymbolicLink()) {
      failures.push(failure(normalized, 'symlink_not_allowed', `Citation file must not be a symlink: ${normalized.path}`));
      continue;
    }

    if (!statSync(resolvedPath).isFile()) {
      failures.push(failure(normalized, 'file_not_found', `Citation file is not a regular file: ${normalized.path}`));
      continue;
    }

    const raw = readFileSync(resolvedPath, 'utf8');

    let quoteSource = raw;
    if (normalized.lineRange) {
      const lines = raw.split(/\r?\n/);
      const { start, end } = normalized.lineRange;
      if (start < 1 || end < start || end > lines.length) {
        failures.push(failure(
          normalized,
          'line_unresolvable',
          `Citation line range ${formatLineRange(normalized.lineRange)} is outside ${normalized.path} (${lines.length} line(s)).`,
        ));
        continue;
      }
      quoteSource = lines.slice(start - 1, end).join('\n');
    }

    if (!containsNormalizedQuote(quoteSource, normalized.quote)) {
      failures.push(failure(normalized, 'quote_not_found', `Quoted citation text was not found in ${normalized.path}.`));
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

function isAllowedPath(citationPath, allowPrefixes) {
  const normalizedPath = citationPath.replace(/\\/g, '/');
  return allowPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
  });
}

function normalizeClaim(claim) {
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

function parsePathLineReference(path) {
  const normalized = path.replace(/#L(\d+)(?:-L?(\d+))?$/i, (_match, start, end) => {
    return end ? `:${start}-${end}` : `:${start}`;
  });
  const match = normalized.match(PATH_CITATION_RE);
  if (!match) return undefined;
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  return { path: match[1], lineRange: { start, end } };
}

function parseLineRange(line) {
  if (line === undefined) return undefined;
  if (typeof line === 'number') return Number.isInteger(line) ? { start: line, end: line } : undefined;
  if (typeof line === 'string') {
    const match = line.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return undefined;
    return { start: Number(match[1]), end: Number(match[2] ?? match[1]) };
  }
  return line;
}

function resolveCitationPath(root, citationPath) {
  if (isAbsolute(citationPath)) return undefined;
  const absolutePath = resolve(root, citationPath);
  const rel = relative(root, absolutePath);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return absolutePath;
}

function containsNormalizedQuote(source, quote) {
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

function failure(claim, reason, message) {
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

function formatLineRange(range) {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function firstString(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function numberField(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}
