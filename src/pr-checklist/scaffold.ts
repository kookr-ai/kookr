// PR Checklist Contract — `scaffold`: write a PR body `verify` accepts (#3651).
//
// Agents kept rediscovering the accepted row syntax (the box stays outside the
// strikethrough, the reason goes after the closing `~~`, every template marker
// row must be present). `scaffold` removes the guesswork: it copies the repo's
// PR template and rewrites each marker row into the exact line `verify` wants:
//   - a row whose evidence rule matches a changed path → ticked;
//   - any other row → struck, with a placeholder reason the author must replace
//     (`verify` rejects an unreplaced placeholder, so the raw scaffold fails).
// Every other template line is passed through unchanged. Pure: strings in,
// data out; the template read and the diff live in engine.ts.

import {
  DECIDE_REASON_PLACEHOLDER,
  hasEvidence,
  parseTemplateRows,
  renderRow,
  WAIVER_REASON_PLACEHOLDER,
} from './checklist.js';

export interface ScaffoldResult {
  /** The PR body: the template with every marker row rewritten. */
  body: string;
  /** Rows ticked because the diff carries their evidence. */
  checked: string[];
  /** Rows with an evidence rule but no matching change — struck, reason to fill. */
  struck: string[];
  /** Rows with no evidence rule — struck, the author decides (tick or give a reason). */
  undecided: string[];
}

/** Build the PR body for `changedPaths` from the template text. Pure. */
export function scaffoldBody(templateText: string, changedPaths: string[]): ScaffoldResult {
  const lines = templateText.split('\n');
  const result: ScaffoldResult = { body: '', checked: [], struck: [], undecided: [] };
  for (const row of parseTemplateRows(templateText)) {
    const evidence = hasEvidence(row.id, changedPaths);
    const cr = lines[row.line].endsWith('\r') ? '\r' : '';
    if (evidence === true) {
      lines[row.line] = renderRow(row, 'checked') + cr;
      result.checked.push(row.id);
    } else if (evidence === false) {
      lines[row.line] = renderRow(row, 'waived', WAIVER_REASON_PLACEHOLDER) + cr;
      result.struck.push(row.id);
    } else {
      lines[row.line] = renderRow(row, 'waived', DECIDE_REASON_PLACEHOLDER) + cr;
      result.undecided.push(row.id);
    }
  }
  result.body = lines.join('\n');
  return result;
}
