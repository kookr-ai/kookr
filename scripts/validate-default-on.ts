#!/usr/bin/env node
// Fails when docs/reference/environment-variables.md documents a new feature
// switch that defaults to off without the one-line reason the "ship finished
// features switched on" rule requires (issue #3936). See src/core/default-on-guard.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDefaultOn, DEFAULT_ON_DOC_FILE, formatDefaultOnIssues } from '../src/core/default-on-guard.js';

const repoRoot = process.argv[2] ?? process.cwd();
const result = checkDefaultOn(readFileSync(join(repoRoot, DEFAULT_ON_DOC_FILE), 'utf8'));

if (result.issues.length > 0) {
  console.error(formatDefaultOnIssues(result));
  process.exit(1);
}

if (result.stale.length > 0) {
  console.log(
    `Note: these grandfathered switches are no longer off by default; remove them from GRANDFATHERED_DEFAULT_OFF: ${result.stale.join(', ')}`,
  );
}
console.log(`Default-on check passed. Checked ${result.checked} documented variable(s).`);
