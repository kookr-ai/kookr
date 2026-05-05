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
  const report = await generateReportFromFile(filePath);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  if (report.totalEntries === 0) {
    console.log(`No shadow-detection data found at ${filePath}.`);
    console.log('Run Kookr with shadow strategies enabled to collect data first.');
    return;
  }

  console.log(formatReport(report));
}

main().catch((err) => {
  console.error('Error generating shadow report:', err);
  process.exit(1);
});
