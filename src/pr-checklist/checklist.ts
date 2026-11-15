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
  docs: { label: 'operator docs updated', paths: [/^docs\//] },
  mbse: {
    label: 'architecture docs refreshed',
    paths: [/^docs\/(?:system-models|rfcs?|adr)\//],
  },
  roadmap: { label: 'ROADMAP updated', paths: [/^ROADMAP\.md$/] },
  changelog: { label: 'changelog updated', paths: [/^CHANGELOG\.md$/] },
  benchmarks: { label: 'benchmark evidence updated', paths: [/^benchmarks?\//] },
  'new-tests': { label: 'new behavior has tests', paths: [/(^|\/)tests?\//, /\.(?:test|spec)\.[jt]sx?$/] },
  tests: { label: 'tests added/updated', paths: [/(^|\/)tests?\//, /\.(?:test|spec)\.[jt]sx?$/] },
  'integration-tests': {
    label: 'integration tests added/updated',
    paths: [/(^|\/)tests?\//],
  },
  'e2e-tests': {
    label: 'end-to-end test added/updated',
    paths: [/(^|\/)tests?\//],
  },
};

// Conservative committed-secret patterns (low false-positive).
export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub PAT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
];

const MARKER_LINE = /^[ \t]*(~~)?-\s*\[( |x|X)\]\s*(~~)?\s*<!--\s*(?:kookr:check:|pr:)([a-z0-9-]+)\s*-->(.*)$/gm;

// --- Row shapes `verify` accepts, rendered from the template (#3651) --------
// `scaffold` writes these lines and `verify` quotes them back when it rejects a
// row, so both come from `renderRow` and cannot drift apart. The rendered text
// is the repo's own PR-template row (marker + label), never PR-body content (S6).

/**
 * Reason text `scaffold` puts on a struck row. `verify` rejects a waiver whose
 * reason still contains one, so an unedited scaffold cannot pass the gate.
 */
export const WAIVER_REASON_PLACEHOLDER = 'TODO: say why this row does not apply';
/** Placeholder for a row with no diff evidence rule: only the author knows if it was done. */
export const DECIDE_REASON_PLACEHOLDER = 'TODO: if done, tick the box and remove the strikethrough; else say why it does not apply';
// Neither placeholder may contain `~~`: the parser takes the reason from after the LAST `~~`.
const PLACEHOLDERS = [WAIVER_REASON_PLACEHOLDER, DECIDE_REASON_PLACEHOLDER];
/** Reason slot shown in an "expected" line. */
const REASON_SLOT = '<one-line reason>';

/** A marked checklist row of the repo's PR template, kept with its exact marker and label text. */
export interface TemplateRow {
  /** 0-based line index in the template text. */
  line: number;
  indent: string;
  id: string;
  /** The marker exactly as the template spells it, e.g. `<!-- kookr:check:tests -->`. */
  marker: string;
  /** Row text after the marker, without strike delimiters. */
  label: string;
}

const TEMPLATE_ROW = /^([ \t]*)(?:~~)?-\s*\[(?: |x|X)\]\s*(?:~~)?\s*(<!--\s*(?:kookr:check:|pr:)([a-z0-9-]+)\s*-->)(.*)$/;

/** Parse the marked rows of a PR template, keeping line index, indent, marker and label. Pure. */
export function parseTemplateRows(templateText: string): TemplateRow[] {
  const rows: TemplateRow[] = [];
  templateText.split('\n').forEach((text, line) => {
    const m = TEMPLATE_ROW.exec(text.replace(/\r$/, ''));
    if (!m) return;
    const rest = m[4];
    const close = rest.indexOf('~~');
    const label = (close >= 0 ? rest.slice(0, close) : rest).trim();
    rows.push({ line, indent: m[1], id: m[3], marker: m[2], label });
  });
  return rows;
}

/** The one accepted line for a row: ticked (attest) or struck with the reason after the closing `~~` (waive). */
export function renderRow(row: Pick<TemplateRow, 'indent' | 'marker' | 'label'>, state: 'checked' | 'waived', reason = REASON_SLOT): string {
  const text = row.label ? `${row.marker} ${row.label}` : row.marker;
  return state === 'checked' ? `${row.indent}- [x] ${text}` : `${row.indent}- [ ] ~~${text}~~ — ${reason}`;
}

/** True when a waiver reason is still a `scaffold` placeholder. */
export function isPlaceholderReason(reason: string): boolean {
  return PLACEHOLDERS.some((p) => reason.includes(p));
}

/** Template rows by id (first wins), for quoting the expected line back on a rejection. */
export function templateRowsById(templateText: string): Map<string, TemplateRow> {
  const byId = new Map<string, TemplateRow>();
  for (const row of parseTemplateRows(templateText)) if (!byId.has(row.id)) byId.set(row.id, row);
  return byId;
}

/** The accepted line(s) for `id`, built from the template row (or a bare marker when the template lacks it). */
function expectedFor(id: string, templateRows: ReadonlyMap<string, TemplateRow>, states: ('checked' | 'waived')[]): string[] {
  const row = templateRows.get(id) ?? { indent: '', marker: `<!-- kookr:check:${id} -->`, label: '<row text>' };
  return states.map((state) => renderRow({ ...row, indent: '' }, state));
}

/** Parse marked checklist lines out of a PR body. Pure; regex-only. */
export function parseChecklist(body: string): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  // Fresh regex state per call (the shared literal is /g).
  MARKER_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_LINE.exec(body)) !== null) {
    const rest = match[5] ?? '';
    const struck = Boolean(match[1]) || Boolean(match[3]) || /~~/.test(rest);
    const closingStrike = rest.lastIndexOf('~~');
    rows.push({
      id: match[4],
      checked: match[2].toLowerCase() === 'x',
      struck,
      // Only text after the closing strike is a waiver reason. The struck
      // checklist label itself is evidence of what was waived, not why.
      reason: struck && closingStrike >= 0 ? rest.slice(closingStrike + 2).replace(/^[\s—:-]+/, '').trim() : '',
    });
  }
  return rows;
}

const ANY_MARKER = /<!--\s*(?:kookr:check:|pr:)([a-z0-9-]+)\s*-->/g;
// A line that starts like a list item (optionally struck): `-`, `*`, `+`, or `1.` / `1)`.
const LIST_ITEM_START = /^[ \t]*(?:~~)?[ \t]*(?:[-*+]|\d+[.)])\s/;

/**
 * Ids whose marker appears in the body on a list-item line that
 * `parseChecklist` does not recognise as a checklist row — e.g. a row struck
 * from the leading dash, `- ~~- [ ] <!-- kookr:check:x --> text~~`, or a `*`
 * bullet. Lets the presence rule say "present but malformed" instead of
 * "omitted". Markers merely quoted in prose (non-list lines) are ignored, so a
 * body that never used the template still gets the omission advice. Pure;
 * regex-only.
 */
export function findUnparsedMarkerIds(body: string, parsedRows: ChecklistRow[]): string[] {
  const parsed = new Set(parsedRows.map((r) => r.id));
  const ids = new Set<string>();
  for (const line of body.split('\n')) {
    if (!LIST_ITEM_START.test(line)) continue;
    for (const m of line.matchAll(ANY_MARKER)) if (!parsed.has(m[1])) ids.add(m[1]);
  }
  return [...ids];
}

/** Does any changed path match one of the evidence patterns? */
function changed(paths: string[], patterns: RegExp[]): boolean {
  return patterns.some((re) => paths.some((p) => re.test(p)));
}

/**
 * Does the diff carry the evidence a ticked `id` box needs? `null` when the id
 * has no built-in evidence rule (only the author can say whether it was done).
 * Shared by `evaluateAttestation` and `scaffold`, so a row scaffold ticks is one
 * verify accepts.
 */
export function hasEvidence(id: string, changedPaths: string[]): boolean | null {
  const spec = BOX_EVIDENCE[id];
  return spec ? changed(changedPaths, spec.paths) : null;
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
  templateText = '',
): { results: CheckResult[]; waived: Set<string>; notes: string[] } {
  const templateRows = templateRowsById(templateText);
  const expect = (id: string, ...states: ('checked' | 'waived')[]) => expectedFor(id, templateRows, states);
  const results: CheckResult[] = [];
  const waived = new Set<string>();
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    seen.add(row.id);
    const spec = BOX_EVIDENCE[row.id];
    if (row.struck) {
      if (!row.reason) {
        results.push({
          id: row.id,
          status: 'fail',
          summary:
            `checklist waiver for ${row.id} requires a one-line waiver reason, written after the closing ~~ ` +
            `(a reason inside the strikethrough does not count)`,
          expected: expect(row.id, 'waived'),
        });
        continue;
      }
      if (isPlaceholderReason(row.reason)) {
        results.push({
          id: row.id,
          status: 'fail',
          summary: `checklist waiver for ${row.id} still has the scaffold placeholder reason — replace it with the real one`,
          expected: expect(row.id, 'checked', 'waived'),
        });
        continue;
      }
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
          : {
              id: row.id,
              status: 'fail',
              summary: `checklist item ${row.id} is neither checked nor struck through`,
              expected: expect(row.id, 'checked', 'waived'),
            },
      );
      continue;
    }
    if (!row.checked) {
      results.push({
        id: row.id,
        status: 'fail',
        summary: `"${spec.label}" is neither checked nor struck through — do it, or strike the box with a reason`,
        expected: expect(row.id, 'checked', 'waived'),
      });
      continue;
    }
    if (!changed(changedPaths, spec.paths)) {
      results.push({
        id: row.id,
        status: 'fail',
        summary: `"${spec.label}" is checked but no matching change is in the diff — update it, or strike the box`,
        expected: expect(row.id, 'waived'),
      });
      continue;
    }
    results.push({ id: row.id, status: 'pass', summary: spec.label });
  }
  return { results, waived, notes };
}

/**
 * Enforce that a PR body reproduces the checklist the repo's PR template
 * declares. GitHub only injects `.github/PULL_REQUEST_TEMPLATE.md` in the web
 * UI (or when `gh pr create` runs with NO `--body`); an agent that builds the
 * body inline with `--body` silently drops the whole checklist. The per-box
 * attestation rules then have nothing to verify and pass vacuously — so this
 * is the rule that actually keeps the anti-drift checklist from being bypassed
 * (the exact hole that forced the per-repo reminder in lucy PR #835).
 *
 * A template marker id absent from the body is a fail. A marker that is in the
 * body but on a line that does not parse as a checklist row (`unparsedIds`, from
 * `findUnparsedMarkerIds`) is reported as a malformed row, not an omission. Ids the body carries in
 * any state — checked, blank, or struck — count as present here; whether a
 * present box is *honest* is `evaluateAttestation`'s job, not this rule's.
 *
 * No-op when the repo ships no template (or a template with no markers), or
 * when no body was provided (see `evaluateTemplateRequiredButMissing` for the
 * `--fill` / no-body-flag case). Pure;
 * returns only ids/counts, never body/template *content* (S6).
 */
export function evaluateTemplatePresence(
  templateText: string,
  bodyRows: ChecklistRow[],
  unparsedIds: readonly string[] = [],
): CheckResult[] {
  const templateIds = new Set(parseChecklist(templateText).map((r) => r.id));
  if (templateIds.size === 0) return [];
  const present = new Set(bodyRows.map((r) => r.id));
  const unparsed = new Set(unparsedIds);
  const absent = [...templateIds].filter((id) => !present.has(id));
  const malformed = absent.filter((id) => unparsed.has(id));
  const missing = absent.filter((id) => !unparsed.has(id));
  const results: CheckResult[] = [];
  if (malformed.length > 0) {
    const templateRows = templateRowsById(templateText);
    results.push({
      id: 'pr-template',
      status: 'fail',
      summary:
        `PR body has ${malformed.length} template checklist row(s) (${malformed.join(', ')}) present but ` +
        `not in a recognised checklist form (e.g. the checkbox inside the strikethrough, or struck from the ` +
        `leading dash). Keep the "- [ ]" box first and outside the ~~: tick it to attest, or strike only the ` +
        `marker and text and put the reason after the closing ~~ to waive.`,
      expected: malformed.flatMap((id) => expectedFor(id, templateRows, ['checked', 'waived'])),
    });
  }
  if (missing.length === 0) return results;
  return [
    ...results,
    {
      id: 'pr-template',
      status: 'fail',
      summary:
        `PR body omits ${missing.length} of ${templateIds.size} template checklist item(s) ` +
        `(${missing.join(', ')}) — the body was not built from the repo's PR template. ` +
        `Copy .github/PULL_REQUEST_TEMPLATE.md, work each box, and pass it via ` +
        `\`gh pr create --body-file <file>\` (or a quoted heredoc body); a short inline \`--body\` skips the template.`,
    },
  ];
}

/**
 * A body the command cannot show us (`--fill*`, or no body flag at all) is a
 * body gh builds from commit messages — it can never carry the repo template's
 * checklist. When the template declares markers that is a fail with the same
 * remedy as `evaluateTemplatePresence`; a marker-less or absent template is a
 * no-op (the caller keeps the degraded "attest-unverified" note). Pure; returns
 * only ids/counts (S6).
 */
export function evaluateTemplateRequiredButMissing(templateText: string, reason: string): CheckResult[] {
  const ids = [...new Set(parseChecklist(templateText).map((r) => r.id))];
  if (ids.length === 0) return [];
  return [
    {
      id: 'pr-template',
      status: 'fail',
      summary:
        `PR body is not on the command line (${reason}) but the repo's PR template declares ` +
        `${ids.length} checklist item(s) (${ids.join(', ')}) — gh would not include them. ` +
        `Build the body from the template (.github/pull_request_template.md), work each box, and ` +
        `pass it via \`--body-file <file inside the repo/worktree>\` or a quoted heredoc ` +
        `(\`--body "$(cat <<'EOF' … EOF)"\`); do not use \`--fill\` or omit the body.`,
    },
  ];
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
      summary: 'diff base unresolved — structural checks skipped',
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
