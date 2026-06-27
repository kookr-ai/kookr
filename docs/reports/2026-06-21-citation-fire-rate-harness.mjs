#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputJson = join(repoRoot, 'docs/reports/2026-06-21-citation-fire-rate-reviewer-distillation.json');
const outputMd = join(repoRoot, 'docs/reports/2026-06-21-citation-fire-rate-reviewer-distillation.md');

const defaultRoots = [
  '~/.claude/grafana-reviewer-distillation',
  '~/.claude/grafana-reviewer-distillation-run1',
  '~/.claude/grafana-grafana-reviewer-distillation',
];

const roots = (process.env.CITATION_FIRE_RATE_ROOTS ?? defaultRoots.join(':'))
  .split(':')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => p.replace(/^~(?=\/|$)/, homedir()))
  .filter((p) => existsSync(p) && statSync(p).isDirectory());

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const escapeNonAscii = (s) => s.replace(/[^\x00-\x7F]/g, (ch) => {
  const hex = ch.charCodeAt(0).toString(16).padStart(4, '0');
  return `\\u${hex}`;
});
const shingles = (toks, n) => {
  const out = [];
  for (let i = 0; i + n <= toks.length; i++) out.push(toks.slice(i, i + n).join(' '));
  return out;
};

const listFiles = (dir, predicate) => {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (predicate(abs)) out.push(abs);
    }
  }
  return out.sort();
};

const extractPassages = (scorePath) => {
  const text = readFileSync(scorePath, 'utf8');
  const pr = scorePath.match(/pr-(\d+).*judge\.md$/)?.[1];
  if (!pr) return [];

  const passages = [];
  const lines = text.split('\n');
  let currentComment = null;
  let quote = [];
  const inlinePassages = [];

  const flush = () => {
    if (currentComment !== null && quote.length) {
      passages.push({
        comment: currentComment,
        excerpt: norm(quote.join(' ')).replace(/^["']|["']$/g, ''),
      });
    }
    quote = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(?:#{2,4}\s+)?(?:\*\*)?(?:Comment\s+([A-Z]?\d+|T\d+)|Top-Level Review\s+(\d+))(?:\*\*)?\b/i);
    if (heading) {
      flush();
      currentComment = heading[1] ?? `top-level-${heading[2]}`;
      const headingQuote = line.slice(heading[0].length).match(/^\s*(?:[-:]\s*)?"([^"]{8,})"/);
      if (headingQuote) {
        inlinePassages.push({ comment: currentComment, excerpt: norm(headingQuote[1]).replace(/^["']|["']$/g, '') });
      }
      continue;
    }
    const nonCommentSection = line.match(/^#{2,4}\s+(Step\s+[2-9]\b|Matching\b|Match\b|Unmatched\b|Summary\b|JSON\b|Output\b)/i);
    if (nonCommentSection) {
      flush();
      currentComment = null;
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q && currentComment !== null) quote.push(q[1]);
    else {
      if (quote.length) flush();
      if (currentComment !== null) {
        const bulletQuote = line.match(/^\s*-\s*"([^"]{8,})"/);
        if (bulletQuote) {
          inlinePassages.push({ comment: currentComment, excerpt: norm(bulletQuote[1]).replace(/^["']|["']$/g, '') });
        }
      }
    }
  }
  flush();
  return passages.concat(inlinePassages).map((p) => ({ ...p, pr }));
};

const verifyPassage = (passage, reviewPath) => {
  if (!existsSync(reviewPath) || !statSync(reviewPath).isFile()) {
    return { ...passage, fileExists: false, verdict: 'unresolvable', grounding: 0 };
  }

  const raw = readFileSync(reviewPath, 'utf8');
  const src = norm(raw);
  const segs = passage.excerpt.split(/(?:\.\.\.|\u2026|\[\.\.?\])/).map(norm).filter((s) => s.length >= 40);
  const probe = segs.length ? segs : [passage.excerpt];
  if (probe.some((s) => src.includes(s))) {
    return { ...passage, fileExists: true, verdict: 'verbatim', grounding: 1 };
  }

  const srcNorm = words(raw).join(' ');
  const sh = shingles(words(passage.excerpt), 5);
  const hit = sh.length ? sh.filter((s) => srcNorm.includes(s)).length / sh.length : 0;
  return {
    ...passage,
    fileExists: true,
    verdict: hit >= 0.5 ? 'grounded' : 'fabricated',
    grounding: Math.round(hit * 100) / 100,
  };
};

const results = [];
for (const root of roots) {
  const scoreFiles = listFiles(join(root, 'scores'), (p) => /pr-\d+.*judge\.md$/.test(p))
    .filter((p) => existsSync(dirname(p).replace(/\/scores$/, '/reviews')));

  for (const scorePath of scoreFiles) {
    const pr = scorePath.match(/pr-(\d+)/)?.[1];
    const reviewPath = join(root, 'reviews', `pr-${pr}.md`);
    const portableReviewPath = reviewPath.replace(homedir(), '~');
    const passages = extractPassages(scorePath);
    const checks = passages
      .map((passage) => verifyPassage({ ...passage, source: portableReviewPath }, reviewPath))
      .map((check) => ({ ...check, source: portableReviewPath }));
    const count = (v) => checks.filter((c) => c.verdict === v).length;
    results.push({
      stateDir: root.replace(homedir(), '~'),
      output: scorePath.replace(root + '/', ''),
      source: portableReviewPath,
      passageCount: checks.length,
      verbatim: count('verbatim'),
      grounded: count('grounded'),
      fabricated: count('fabricated'),
      unresolvable: count('unresolvable'),
      checks,
    });
  }
}

const totals = results.reduce(
  (acc, r) => {
    acc.outputs += 1;
    acc.passages += r.passageCount;
    acc.verbatim += r.verbatim;
    acc.grounded += r.grounded;
    acc.fabricated += r.fabricated;
    acc.unresolvable += r.unresolvable;
    if (r.passageCount === 0) acc.zeroPassageOutputs += 1;
    return acc;
  },
  { outputs: 0, passages: 0, verbatim: 0, grounded: 0, fabricated: 0, unresolvable: 0, zeroPassageOutputs: 0 },
);

const parseableOutputs = results.filter((r) => r.passageCount > 0).length;
const failingPassages = totals.fabricated + totals.unresolvable;
const fireRate = totals.passages ? failingPassages / totals.passages : 0;
const decision = parseableOutputs > 0 && failingPassages > 0
  ? 'warrants_gate'
  : 'no_gate_for_this_loop_now';

const payload = {
  generatedAt: new Date().toISOString(),
  targetLoop: 'reviewer-distillation-judge',
  roots: roots.map((r) => r.replace(homedir(), '~')),
  parserConfirmed: {
    parseableOutputs,
    passages: totals.passages,
    passesPrerequisite: parseableOutputs > 0 && totals.passages > 0,
  },
  totals,
  fireRate,
  decision,
  decisionRationale: decision === 'warrants_gate'
    ? 'At least one parseable passage failed deterministic excerpt verification.'
    : 'The parser extracted real passages, but all extracted passages were verbatim or shingle-grounded in the sibling review files.',
  results,
};

writeFileSync(outputJson, escapeNonAscii(JSON.stringify(payload, null, 2)) + '\n');
writeFileSync(outputMd, `# Citation verifier fire-rate harness: reviewer-distillation-judge

Generated by \`docs/reports/2026-06-21-citation-fire-rate-harness.mjs\`.

## Scope

- Target loop: \`reviewer-distillation-judge\`
- Real outputs scanned: ${totals.outputs}
- Outputs with parsed passages: ${parseableOutputs}
- Zero-passage outputs: ${totals.zeroPassageOutputs} (not counted as clean)
- Parsed passages: ${totals.passages}

## Result

- Verbatim passages: ${totals.verbatim}
- Shingle-grounded passages: ${totals.grounded}
- Fabricated passages: ${totals.fabricated}
- Unresolvable passages: ${totals.unresolvable}
- Fire rate: ${fireRate}

## Decision

${decision === 'warrants_gate'
  ? 'This loop warrants a verifier gate because at least one parseable passage failed deterministic verification.'
  : 'This loop does not warrant a verifier gate right now. The parser extracted passages from real outputs, and every extracted passage was either verbatim or shingle-grounded in the sibling review files.'}

Named evidence file: \`docs/reports/2026-06-21-citation-fire-rate-reviewer-distillation.json\`.
`);

console.log(`wrote ${outputJson}`);
console.log(`wrote ${outputMd}`);
console.log(JSON.stringify({ targetLoop: payload.targetLoop, parserConfirmed: payload.parserConfirmed, totals, fireRate, decision }, null, 2));
