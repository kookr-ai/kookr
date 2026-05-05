#!/usr/bin/env node
/**
 * CLI script to generate a telemetry usage report from session JSONL files.
 *
 * Usage: pnpm telemetry:report [--days N]
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readTelemetryLog } from '../src/core/telemetry.js';
import { generateTelemetryReport } from '../src/core/telemetry-report.js';
import type { TelemetryEvent } from '../src/core/telemetry.js';

const args = process.argv.slice(2);
let days = 7;
const daysIdx = args.indexOf('--days');
if (daysIdx >= 0 && args[daysIdx + 1]) {
  days = parseInt(args[daysIdx + 1], 10) || 7;
}

const sessionsDir = join(homedir(), '.kookr', 'sessions');
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

async function main() {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    console.log('No sessions found at', sessionsDir);
    process.exit(0);
  }

  const allEvents: TelemetryEvent[] = [];

  for (const entry of entries.sort().reverse()) {
    const dirPath = join(sessionsDir, entry);
    const info = await stat(dirPath).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (info.mtimeMs < cutoff) break; // sessions are sorted desc, so we can stop early

    const telemetryPath = join(dirPath, 'telemetry.jsonl');
    const events = await readTelemetryLog(telemetryPath);
    allEvents.push(...events);
  }

  if (allEvents.length === 0) {
    console.log(`No telemetry data found in the last ${days} day(s).`);
    process.exit(0);
  }

  const report = generateTelemetryReport(allEvents);

  console.log('\n=== Kookr Telemetry Report ===');
  console.log(`Period: last ${days} day(s)`);
  console.log(`Total events: ${report.totalEvents}`);
  if (report.timeRange) {
    console.log(`Time range: ${report.timeRange.first} → ${report.timeRange.last}`);
  }

  console.log('\n--- Event Counts ---');
  const sorted = Object.entries(report.eventCounts).sort(([, a], [, b]) => b - a);
  for (const [type, count] of sorted) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\n--- Input Method Breakdown ---');
  for (const [method, count] of Object.entries(report.inputMethodBreakdown)) {
    console.log(`  ${method}: ${count}`);
  }

  console.log('\n--- Shortcut Usage ---');
  if (Object.keys(report.shortcutUsage).length === 0) {
    console.log('  (none recorded)');
  } else {
    for (const [key, count] of Object.entries(report.shortcutUsage)) {
      console.log(`  ${key}: ${count}`);
    }
  }

  console.log('\n--- Suggestion Metrics ---');
  console.log(`  Accepted: ${report.suggestionMetrics.accepted}`);
  console.log(`  Ignored: ${report.suggestionMetrics.ignored}`);
  console.log(`  Acceptance rate: ${report.suggestionMetrics.acceptanceRate !== null ? (report.suggestionMetrics.acceptanceRate * 100).toFixed(1) + '%' : 'N/A'}`);

  console.log('\n--- Launch Dialog ---');
  console.log(`  Opened: ${report.launchDialogMetrics.opened}`);
  console.log(`  Submitted: ${report.launchDialogMetrics.submitted}`);
  console.log(`  Abandoned: ${report.launchDialogMetrics.abandoned}`);
  console.log(`  Avg dwell: ${report.launchDialogMetrics.avgDwellMs !== null ? (report.launchDialogMetrics.avgDwellMs / 1000).toFixed(1) + 's' : 'N/A'}`);

  console.log('\n--- Frustration Signals ---');
  console.log(`  Rapid repeat clicks: ${report.frustrationSignals.rapidRepeatClicks}`);
  console.log(`  Healthy agent inspections: ${report.frustrationSignals.healthyAgentInspections}`);

  console.log('\n--- Platform Breakdown ---');
  for (const [platform, count] of Object.entries(report.platformBreakdown)) {
    console.log(`  ${platform}: ${count}`);
  }

  if (report.deadFeatures.length > 0) {
    console.log('\n--- Dead Features (never triggered) ---');
    for (const feature of report.deadFeatures) {
      console.log(`  ${feature}`);
    }
  }

  console.log('');
}

main().catch((err) => {
  console.error('Error generating report:', err);
  process.exit(1);
});
