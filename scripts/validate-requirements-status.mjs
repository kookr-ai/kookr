import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRIORITIES = new Set(['SHALL', 'SHOULD', 'MAY']);
const STATUSES = new Set(['done', 'partial', 'todo', 'deferred']);

const root = process.cwd();
const requirementsPath = join(root, 'docs', 'requirements.md');
const text = readFileSync(requirementsPath, 'utf8');

const requirementIdPattern = 'R[0-9][0-9A-Za-z.]*';
const sectionPattern = new RegExp(
  '^### (' + requirementIdPattern + '): .+ — ([^—`]+) — `([^`]+)`$',
  'gm',
);
const sections = new Map();
for (const match of text.matchAll(sectionPattern)) {
  const [, id, rawPriority, rawStatus] = match;
  const priority = rawPriority.trim();
  const status = rawStatus.trim();
  validateAllowed(priority, PRIORITIES, `${id} priority`);
  validateAllowed(status, STATUSES, `${id} status`);
  sections.set(id, { id, priority, status });
}

const matrixStart = text.indexOf('## Summary Matrix');
const gapStart = text.indexOf('## Gap Summary');
if (matrixStart === -1 || gapStart === -1 || gapStart <= matrixStart) {
  fail(['Could not locate Summary Matrix before Gap Summary in docs/requirements.md.']);
}

const matrixText = text.slice(matrixStart, gapStart);
const matrixPattern = new RegExp(`^\\| (${requirementIdPattern}) \\| [^|]+ \\| ([^|]+) \\| ([^|]+) \\| ([^|]+) \\|$`, 'gm');
const matrix = new Map();
for (const match of matrixText.matchAll(matrixPattern)) {
  const [, id, rawPriority, rawStatus, modules] = match;
  const priority = rawPriority.trim();
  const status = rawStatus.trim();
  validateAllowed(priority, PRIORITIES, `${id} matrix priority`);
  validateAllowed(status, STATUSES, `${id} matrix status`);
  matrix.set(id, { id, priority, status, modules: modules.trim() });
}

const errors = [];

for (const [id, section] of sections) {
  const row = matrix.get(id);
  if (!row) {
    errors.push(`${id} is missing from the Summary Matrix.`);
    continue;
  }
  if (row.priority !== section.priority) {
    errors.push(`${id} priority mismatch: section=${section.priority}, matrix=${row.priority}.`);
  }
  if (row.status !== section.status) {
    errors.push(`${id} status mismatch: section=${section.status}, matrix=${row.status}.`);
  }
}

for (const id of matrix.keys()) {
  if (!sections.has(id)) {
    errors.push(`${id} appears in the Summary Matrix but has no requirement section.`);
  }
}

const shallRemaining = parseReqColumn('### SHALL requirements not yet fully done:', '### SHOULD requirements remaining:');
const expectedShallRemaining = [...sections.values()]
  .filter((section) => section.priority === 'SHALL' && section.status !== 'done')
  .map((section) => section.id)
  .sort(compareRequirementIds);
if (!sameIds(shallRemaining, expectedShallRemaining)) {
  errors.push(
    `SHALL remaining mismatch: expected ${formatIds(expectedShallRemaining)}, found ${formatIds(shallRemaining)}.`,
  );
}

const shouldRemaining = parseReqColumn('### SHOULD requirements remaining:', '### MAY requirements remaining:');
const expectedShouldRemaining = [...sections.values()]
  .filter((section) => section.priority === 'SHOULD' && section.status !== 'done')
  .map((section) => section.id)
  .sort(compareRequirementIds);
if (!sameIds(shouldRemaining, expectedShouldRemaining)) {
  errors.push(
    `SHOULD remaining mismatch: expected ${formatIds(expectedShouldRemaining)}, found ${formatIds(shouldRemaining)}.`,
  );
}

const mayRemaining = parseReqColumn('### MAY requirements remaining:', undefined);
const expectedMayRemaining = [...sections.values()]
  .filter((section) => section.priority === 'MAY' && section.status !== 'done')
  .map((section) => section.id)
  .sort(compareRequirementIds);
if (!sameIds(mayRemaining, expectedMayRemaining)) {
  errors.push(`MAY remaining mismatch: expected ${formatIds(expectedMayRemaining)}, found ${formatIds(mayRemaining)}.`);
}

for (const row of matrix.values()) {
  if (row.status === 'done' && row.modules === '—') {
    errors.push(`${row.id} is marked done but has no evidence modules in the Summary Matrix.`);
  }
}

if (errors.length > 0) {
  fail(errors);
}

console.log(`Requirements status check passed (${sections.size} sections).`);

function parseReqColumn(startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  if (start === -1) {
    errors.push(`Could not locate ${startHeading}`);
    return [];
  }
  const end = endHeading ? text.indexOf(endHeading, start + startHeading.length) : text.length;
  const body = text.slice(start, end === -1 ? text.length : end);
  const reqs = new Set();
  const reqPattern = new RegExp(`^\\| (${requirementIdPattern}) \\|`, 'gm');
  for (const match of body.matchAll(reqPattern)) {
    reqs.add(match[1]);
  }
  return [...reqs].sort(compareRequirementIds);
}

function compareRequirementIds(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

function sameIds(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatIds(ids) {
  return ids.length === 0 ? 'none' : ids.join(', ');
}

function validateAllowed(value, allowed, label) {
  if (!allowed.has(value)) {
    errors.push(`${label} has unexpected value ${value}.`);
  }
}

function fail(errorsToPrint) {
  console.error('Requirements status check failed:');
  for (const error of errorsToPrint) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
