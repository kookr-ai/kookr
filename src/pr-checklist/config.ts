// PR Checklist Contract — per-repo declarative rule config (P4a).
//
// Reads `.kookr/pr-checklist.json`. This is the MINIMAL, SAFE slice of the
// RFC's P4: a repo may **disable** named built-in rules for its OWN gate, and
// nothing else. No `command` rules, no rule redirection, no YAML — so the config
// can only ever *weaken* the repo's own gate, never execute code, read outside
// the file, or affect another repo. CI stays authoritative. That property is
// why this slice needs none of the command/CI-generator security review the
// full P4 requires (see docs/rfc/rfc-pr-checklist-contract.md, "P4a").
//
// Motivating case: repos like knowledge-base-mcp-server document 100+ config
// vars in a typed config module / reference doc rather than a flat
// `.env.example`, so the built-in `env` rule is a structural mismatch. Rather
// than force a brittle `.env.example`, the repo declares `{ "disable": ["env"] }`.
//
// Pure: this module only parses a string into data (S1). The file read + size
// cap live in engine.ts (impure), like every other input.

/**
 * Rule ids a repo is allowed to disable. Exactly the built-in structural +
 * attest rule/marker ids the engine can emit. An unknown id in `disable` is
 * ignored with a note (typo-safe; never a hard fail on repo-controlled input).
 */
export const KNOWN_RULE_IDS: ReadonlySet<string> = new Set([
  'env',
  'new-tests',
  'tests',
  'integration-tests',
  'e2e-tests',
  'pr-template',
  'readme',
  'help',
  'docs',
  'mbse',
  'roadmap',
  'changelog',
  'benchmarks',
]);

export interface ChecklistConfig {
  /** Rule ids the repo has opted OUT of. Only ever removes checks. */
  disable: Set<string>;
  /** Non-fatal parse/validation notes surfaced in the report (S2: never a hard fail). */
  notes: string[];
}

/**
 * Parse `.kookr/pr-checklist.json` text. Strict but forgiving: malformed input
 * degrades to "no config" (empty disable set) with an explanatory note, never a
 * throw — repo-controlled input must not be able to crash or fail-close the gate
 * on a parse error (that would be a denial-of-service via a broken config).
 */
export function parseChecklistConfig(text: string): ChecklistConfig {
  const notes: string[] = [];
  const disable = new Set<string>();
  if (!text.trim()) return { disable, notes };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    notes.push('.kookr/pr-checklist.json is not valid JSON — ignored');
    return { disable, notes };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    notes.push('.kookr/pr-checklist.json must be a JSON object — ignored');
    return { disable, notes };
  }

  const rec = parsed as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'disable') notes.push(`.kookr/pr-checklist.json: unknown key "${key}" ignored`);
  }

  const raw = rec.disable;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      notes.push('.kookr/pr-checklist.json: "disable" must be an array of rule ids — ignored');
    } else {
      for (const item of raw) {
        if (typeof item !== 'string') {
          notes.push('.kookr/pr-checklist.json: "disable" entries must be strings — one skipped');
          continue;
        }
        if (!KNOWN_RULE_IDS.has(item)) {
          notes.push(`.kookr/pr-checklist.json: unknown rule id "${item}" in "disable" ignored`);
          continue;
        }
        disable.add(item);
      }
    }
  }

  return { disable, notes };
}
