#!/usr/bin/env node
import {
  formatEnvVarIssues,
  verifyDocumentedEnvVars,
} from '../src/core/documented-env-var-verifier.js';

const repoRoot = process.argv[2] ?? process.cwd();
const result = verifyDocumentedEnvVars(repoRoot);

if (result.issues.length > 0) {
  console.error(formatEnvVarIssues(result));
  process.exit(1);
}

console.log(
  `Documented environment-variable verification passed. Checked ${result.checked} env var(s) read in source against ${result.documented.length} documented var(s).`,
);
