// PR Checklist Contract — pure checklist logic (P1).
//
// All functions here are pure: they take strings/facts and return data. No git,
// no filesystem, no process. This is the security-relevant parse layer, and by
// construction it cannot execute repo-controlled code (S1): it only runs regexes
// over strings. It never returns secret/body/file *content* (S6) — callers get
// ids, statuses, and counts.
//
// Ported and hardened from lucy PR #735 (scripts/verify-pr-checklist.mjs).

import type { CheckResult, ChecklistRow, DiffFacts } from './types.js';

/** Marker id → the change that proves a checked box was acted on. */
export interface BoxEvidence {
  label: string;
  /** A checked box requires at least one changed path to match one of these. */
  paths: RegExp[];
}

export const BOX_EVIDENCE: Record<string, BoxEvidence> = {
  readme: { label: 'README updated', paths: [/^README\.md$/] },
  help: { label: 'command surfaces updated', paths: [/^src\/commands\.[jt]s$/, /^README\.md$/] },
  env: { label: '.env.example updated', paths: [/^\.env\.example$/] },
  docs: { label: 'operator docs updated', paths: [/^docs\/[^/]+\.md$/] },
  mbse: { label: 'architecture docs refreshed', paths: [/^docs\/system-models\//, /^docs\/rfc\//] },
  roadmap: { label: 'ROADMAP updated', paths: [/^ROADMAP\.md$/] },
  'new-tests': { label: 'new behavior has tests', paths: [/(^|\/)tests?\//] },
  tests: { label: 'tests added/updated', paths: [/(^|\/)tests?\//] },
  'integration-tests': { label: 'integration tests added/updated', paths: [/(^|\/)tests?\//] },
  'e2e-tests': { label: 'end-to-end test added/updated', paths: [/(^|\/)tests?\//] },
};

// Conservative committed-secret patterns (low false-positive).
export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub PAT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
];

const MARKER_LINE = /^[ \t]*(~~)?-\s*\[( |x|X)\]\s*(~~)?\s*<!--\s*(?:kookr:check:|pr:)([a-z0-9-]+)\s*-->(.*)$/gm;

/** Parse marked checklist lines out of a PR body. Pure; regex-only. */
export function parseChecklist(body: string): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  // Fresh regex state per call (the shared literal is /g).
  MARKER_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_LINE.exec(body)) !== null) {
    const rest = match[5] ?? '';
    const struck = Boolean(match[1]) || Boolean(match[3]) || /~~/.test(rest);
    rows.push({
      id: match[4],
      checked: match[2].toLowerCase() === 'x',
      struck,
      reason: struck ? rest.replace(/~~/g, '').replace(/^[\s—:-]+/, '').trim() : '',
    });
  }
  return rows;
}

/** Does any changed path match one of the evidence patterns? */
function changed(paths: string[], patterns: RegExp[]): boolean {
  return patterns.some((re) => paths.some((p) => re.test(p)));
}

/**
 * Evaluate attestation coupling for every marked box.
 *   checked + evidence in diff  -> pass
 *   checked + no evidence       -> fail ("ticked but not touched")
 *   struck                      -> waived (reason recorded)
 *   blank                       -> fail
 * Returns per-row results plus the set of waived ids (so structural checks can honor a waiver).
 */
export function evaluateAttestation(
  rows: ChecklistRow[],
  changedPaths: string[],
): { results: CheckResult[]; waived: Set<string>; notes: string[] } {
  const results: CheckResult[] = [];
  const waived = new Set<string>();
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    seen.add(row.id);
    const spec = BOX_EVIDENCE[row.id];
    if (row.struck) {
      waived.add(row.id);
      results.push({
        id: row.id,
        status: 'waived',
        summary: spec ? spec.label : `checklist item ${row.id}`,
        reason: row.reason || undefined,
      });
      continue;
    }
    if (!spec) {
      // Unknown id: treat as attest against nothing — a checked box is a bare
      // attestation (pass), a blank one still fails.
      notes.push(`unknown checklist id "${row.id}" — no built-in evidence rule; treated as bare attestation`);
      results.push(
        row.checked
          ? { id: row.id, status: 'pass', summary: `attested: ${row.id}` }
          : { id: row.id, status: 'fail', summary: `checklist item ${row.id} is neither checked nor struck through` },
      );
      continue;
    }
    if (!row.checked) {
      results.push({
        id: row.id,
        status: 'fail',
        summary: `"${spec.label}" is neither checked nor struck through — do it, or strike the box with a reason`,
      });
      continue;
    }
    if (!changed(changedPaths, spec.paths)) {
      results.push({
        id: row.id,
        status: 'fail',
        summary: `"${spec.label}" is checked but no matching change is in the diff — update it, or strike the box`,
      });
      continue;
    }
    results.push({ id: row.id, status: 'pass', summary: spec.label });
  }
  return { results, waived, notes };
}

/** Parse `FOO=` keys from a .env-style file's text. Pure. */
export function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Env vars newly referenced in added source lines but absent from the declared keys. */
export function findMissingEnv(addedSourceLines: string[], declaredKeys: string[]): string[] {
  const declared = new Set(declaredKeys);
  const refs = new Set<string>();
  for (const text of addedSourceLines) {
    const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) refs.add(m[1]);
  }
  return [...refs].filter((v) => !declared.has(v));
}

/** New source files whose basename is referenced nowhere in the given test corpus. Pure. */
export function findUntested(newSourceFiles: string[], testCorpus: string): string[] {
  return newSourceFiles.filter((p) => {
    const base = p.replace(/^.*\//, '').replace(/\.[jt]s$/, '');
    return base.length > 0 && !testCorpus.includes(base);
  });
}

/**
 * Return the first committed-secret hit as { file, patternIndex } — never the
 * matched value (S6). An inline `pragma: allowlist secret` suppresses a line.
 */
export function scanSecrets(
  lines: { file: string; text: string }[],
): { file: string; patternIndex: number } | null {
  for (const { file, text } of lines) {
    if (/pragma:\s*allowlist secret/i.test(text)) continue;
    const idx = SECRET_PATTERNS.findIndex((re) => re.test(text));
    if (idx !== -1) return { file, patternIndex: idx };
  }
  return null;
}

/**
 * Structural fact checks that fire from the diff regardless of any box.
 * `envFileText` is the declared env template (empty string if none).
 * `testCorpus` is the concatenated text of the repo's test files.
 */
export function evaluateStructural(
  facts: DiffFacts,
  envFileText: string,
  testCorpus: string,
  waived: Set<string>,
): CheckResult[] {
  const results: CheckResult[] = [];

  if (facts.baseUnresolved) {
    // S2: don't assert a verdict against a bogus base — skip, don't fail.
    results.push({
      id: 'structural',
      status: 'skipped',
      summary: 'diff base unresolved — structural checks skipped (CI is authoritative)',
    });
    return results;
  }

  // (A) New env var referenced in source but undocumented.
  if (!waived.has('env')) {
    const missing = findMissingEnv(facts.addedSourceLines, parseEnvKeys(envFileText));
    if (missing.length > 0) {
      results.push({
        id: 'env',
        status: 'fail',
        summary: `${missing.length} new env var(s) referenced in source but absent from .env.example: ${missing.join(', ')}`,
      });
    }
  }

  // (B) New source file with no reference under a test path.
  if (!waived.has('new-tests') && !waived.has('tests')) {
    const untested = findUntested(facts.addedFiles.filter(isSourceFile), testCorpus);
    if (untested.length > 0) {
      results.push({
        id: 'new-tests',
        status: 'fail',
        summary: `${untested.length} new source module(s) with no reference under a test path: ${untested.join(', ')}`,
      });
    }
  }

  // (C) Conservative committed-secret scan (S6: report location only, never value).
  const secret = scanSecrets(facts.addedScannableLines);
  if (secret) {
    results.push({
      id: 'secret',
      status: 'fail',
      summary: `possible committed secret in ${secret.file} — move it to an untracked .env (add \`pragma: allowlist secret\` if intentional)`,
    });
  }

  return results;
}

/** Source file heuristic: a .ts/.js under src/ (not a test). */
export function isSourceFile(path: string): boolean {
  return /^src\/.*\.[jt]s$/.test(path) && !/\.test\.[jt]s$/.test(path) && !/(^|\/)__tests__\//.test(path);
}
