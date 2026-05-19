#!/usr/bin/env node
import {
  formatDocumentedCommandIssues,
  verifyDocumentedCommands,
} from '../src/core/documented-command-verifier.js';

const repoRoot = process.argv[2] ?? process.cwd();
const result = verifyDocumentedCommands(repoRoot);

if (result.issues.length > 0) {
  console.error(formatDocumentedCommandIssues(repoRoot, result));
  process.exit(1);
}

console.log(
  `Documented command verification passed. Checked ${result.checked.length} command segment(s); skipped ${result.skipped.length}.`,
);
