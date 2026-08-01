#!/usr/bin/env node
import {
  formatApiRouteIssues,
  verifyDocumentedApiRoutes,
} from '../src/core/documented-api-route-verifier.js';

const repoRoot = process.argv[2] ?? process.cwd();
const result = verifyDocumentedApiRoutes(repoRoot);

if (result.issues.length > 0) {
  console.error(formatApiRouteIssues(result));
  process.exit(1);
}

console.log(
  `Documented API-route verification passed. Checked ${result.checked} registered /api/* route(s) against ${result.documented.length} documented route(s).`,
);
