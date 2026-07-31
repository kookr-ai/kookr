#!/usr/bin/env node
/**
 * CLI script to analyze shadow-detection.jsonl and report per-strategy
 * coverage, precision, and latency metrics. Used as input to the
 * promotion criteria in docs/adr/013-stuck-detection-promotion-criteria.md.
 *
 * Usage:
 *   pnpm shadow:report
 *   pnpm shadow:report --file /path/to/shadow-detection.jsonl
 *   pnpm shadow:report --json
 *
 * Rotated siblings such as shadow-detection.jsonl.1 are read automatically.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generateReportFromFile, formatReport } from '../src/core/shadow-report.js';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');

let filePath = join(homedir(), '.kookr', 'shadow-detection.jsonl');
const fileIdx = args.indexOf('--file');
if (fileIdx >= 0 && args[fileIdx + 1]) {
  filePath = args[fileIdx + 1];
}

async function main(): Promise<void> {
  // Offline CLI intentionally opts out of the HTTP route's tight defaults
  // (issue #1764): promotion metrics in ADR-013 need a wider corpus than a
  // dashboard poll. Unbounded maxBytes/maxEntries stream the full file(s);
  // maxAgeMs: 0 disables the relative age filter.
  const report = await generateReportFromFile(filePath, {
    maxBytes: Number.POSITIVE_INFINITY,
    maxEntries: Number.POSITIVE_INFINITY,
    maxAgeMs: 0,
  });

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  if (report.totalEntries === 0) {
    console.log(`No shadow-detection data found at ${filePath} or rotated siblings.`);
    console.log('Run Kookr with shadow strategies enabled to collect data first.');
    return;
  }

  console.log(formatReport(report));
}

main().catch((err) => {
  console.error('Error generating shadow report:', err);
  process.exit(1);
});
