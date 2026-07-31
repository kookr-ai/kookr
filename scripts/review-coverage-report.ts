#!/usr/bin/env node
/**
 * Reviewed-before-merge coverage report (issue #1717).
 *
 * Emits the daily "review-coverage %" metric: of the PRs merged in the window,
 * how many carried an independent-review verdict comment before merge, how many
 * merged under the timeout label, and how many merged with neither (a gate
 * regression — should be zero once `scripts/kookr-merge.sh` is enforcing).
 *
 * Usage: pnpm review:coverage [--days N] [--repo OWNER/NAME] [--json]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  computeReviewCoverage,
  REVIEW_SKIPPED_TIMEOUT_LABEL,
  type MergedPrRecord,
} from '../src/core/independent-review.js';

const execFileAsync = promisify(execFile);

interface Args {
  days: number;
  repo: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let days = 1;
  let repo: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') {
      days = parseInt(argv[++i] ?? '', 10) || 1;
    } else if (arg === '--repo') {
      repo = argv[++i] ?? null;
    } else if (arg === '--json') {
      json = true;
    }
  }
  return { days, repo, json };
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

interface MergedPrListItem {
  number: number;
  mergedAt: string | null;
}

async function main(): Promise<void> {
  const { days, repo, json } = parseArgs(process.argv.slice(2));
  const repoArgs = repo ? ['--repo', repo] : [];

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(cutoffMs).toISOString().slice(0, 10);

  let merged: MergedPrListItem[];
  try {
    const listOut = await gh([
      'pr',
      'list',
      ...repoArgs,
      '--state',
      'merged',
      '--limit',
      '200',
      '--json',
      'number,mergedAt',
    ]);
    const all = JSON.parse(listOut) as MergedPrListItem[];
    // Filter to the window client-side by mergedAt — avoids the lag-prone search
    // backend and keeps the list query state-only.
    merged = all.filter((pr) => pr.mergedAt != null && Date.parse(pr.mergedAt) >= cutoffMs);
  } catch (err) {
    console.error(`review-coverage: failed to list merged PRs: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const records: MergedPrRecord[] = [];
  for (const pr of merged) {
    try {
      const viewOut = await gh([
        'pr',
        'view',
        String(pr.number),
        ...repoArgs,
        '--json',
        'number,comments,labels',
      ]);
      const view = JSON.parse(viewOut) as {
        number: number;
        comments?: Array<{ body: string; createdAt?: string }>;
        labels?: Array<{ name: string }>;
      };
      records.push({
        number: view.number,
        comments: (view.comments ?? []).map((c) => ({ body: c.body, createdAt: c.createdAt })),
        labels: (view.labels ?? []).map((l) => l.name),
      });
    } catch (err) {
      console.error(`review-coverage: skipping PR #${pr.number}: ${(err as Error).message}`);
    }
  }

  const summary = computeReviewCoverage(records);

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('\n=== Reviewed-before-merge Coverage ===');
  console.log(`Window: last ${days} day(s) (merged:>=${since})${repo ? ` — ${repo}` : ''}`);
  console.log(`Merged PRs: ${summary.total}`);
  if (summary.total === 0) {
    console.log('No merged PRs in window.');
    return;
  }
  console.log(`Reviewed before merge: ${summary.reviewed} (${summary.coveragePct}%)`);
  console.log(`Timed out (${REVIEW_SKIPPED_TIMEOUT_LABEL} label): ${summary.timedOut}`);
  console.log(`Unreviewed (gate regression): ${summary.unreviewed}`);
  if (summary.unreviewed > 0) {
    const bad = summary.rows.filter((r) => r.outcome === 'unreviewed').map((r) => `#${r.number}`);
    console.log(`  ⚠ unreviewed merges: ${bad.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
