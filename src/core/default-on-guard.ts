/**
 * Guard for the "ship finished features switched on" rule (issue #3936).
 *
 * A finished feature ships on by default. A switch that defaults to off is
 * allowed only when turning the feature on is hard to undo or reaches outside
 * the host, and then its row in `docs/reference/environment-variables.md`
 * says which reason applies, with a fixed phrase this guard can find:
 *
 *   Off by default: deletes or migrates data …
 *   Off by default: spends money …
 *   Off by default: sends data to a third party …
 *   Off by default: needs a credential or service …
 *
 * The guard reads every four-column table row of that document, decides
 * whether the row documents a feature switch whose default is off (see
 * `hasOffDefault` for how far that reaches: switches, not rows that carry a
 * key, URL or number), and fails
 * on such a row unless it carries the phrase or is one of the switches that
 * were already off when the rule was written (`GRANDFATHERED_DEFAULT_OFF`).
 * Kill switches (settings that turn something off, or dry-run knobs) are
 * never flagged: the rule allows them.
 */

export const DEFAULT_ON_DOC_FILE = 'docs/reference/environment-variables.md';

/** The one-line reason of rule 2: a fixed phrase naming one of its four cases. */
export const OFF_BY_DEFAULT_REASON =
  /\boff by default:\s*(?:deletes or migrates data|spends money|sends (?:data |something )?to a third party|needs a credential or service)/i;

/**
 * Feature switches that were already off by default when the rule landed
 * (16 Nov 2026). Issue #3937 turned the finished ones on; those left here stay
 * off for a reason recorded in its pull request (#3945). The last group was
 * already off too; the wider check of issue #3942 is what first recognised
 * them as switches. Do not add names here for a new switch: it ships on, or
 * its row says why not.
 * Removing a name once its switch is on (or has its reason) is welcome; a name
 * whose row is no longer off by default is reported as stale, not as a failure.
 */
export const GRANDFATHERED_DEFAULT_OFF: ReadonlySet<string> = new Set([
  'KOOKR_ALLOW_NON_LOOPBACK',
  'KOOKR_ALLOW_WEAK_API_TOKEN',
  'KOOKR_EMISSION_OVERRIDE_SECRET',
  'KOOKR_LOG_TASK_SAVE_METRICS',
  'KOOKR_TERMINAL_ATTACH_FULL_RING',
  'KOOKR_TERMINAL_ATTACH_ALWAYS_HISTORY',
  'KOOKR_OPENCODE_ENABLED',
  'KOOKR_OPENCODE_FAST_BOOT',
  'KOOKR_OPENCODE_CONTAINERS',
  'KOOKR_HERMES_FLEET',
  'KOOKR_HERMES_DELEGATION',
  'KOOKR_PLUGIN_AUTO_UPDATE',
  'KOOKR_BYPASS_ALL_PERMISSIONS',
  'KOOKR_SPAWN_AUTO_IDEMPOTENCY',
  'KOOKR_VERIFY_FLAKY_RERUN',
  'KOOKR_TERMINAL_HOST',
  'KOOKR_CONTEXT_ADVISORY_ENABLED',
  'KOOKR_REMOTE_CHAT_ALLOW_CODEX',
  'KOOKR_HOSTED_RELAY_ENABLED',
  'KOOKR_STT',
  'KOOKR_STT_CORPUS',
  'KOOKR_TTS',
  'KOOKR_LUCY_EARS',
  'KOOKR_ALERT_CPU_PERCENT',
  'KOOKR_ALERT_MEMORY_PERCENT',
  'KOOKR_ALERT_EVENT_LOOP_DELAY_MS',
  'KOOKR_MAX_HOST_LOAD_PER_CPU',
  'KOOKR_FINDING_REVIEW_ENABLED',
  'KOOKR_FINDING_REVIEW_SAMPLER_ENABLED',
  // Recognised by the wider check of issue #3942: safety overrides and
  // acknowledgements, and audit-archive pruning caps (pruning deletes data).
  'KOOKR_OPENCODE_ALLOW_ANY_VERSION',
  'KOOKR_WEBHOOK_ALLOW_PRIVATE',
  'KOOKR_HOSTED_RELAY_OPS_GATES_MET',
  'KOOKR_RELAY_ALLOW_INSECURE_BIND',
  'KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_COUNT',
  'KOOKR_REMOTE_COMMAND_AUDIT_MAX_ARCHIVE_AGE_DAYS',
]);

export interface EnvVarRow {
  name: string;
  defaultValue: string;
  accepted: string;
  effect: string;
  /** 1-based line number in the document. */
  line: number;
}

export interface DefaultOnIssue {
  name: string;
  line: number;
  defaultValue: string;
}

export interface DefaultOnResult {
  /** Rows read from the document. */
  checked: number;
  /** Off-by-default feature switches with no reason and no grandfathering. */
  issues: DefaultOnIssue[];
  /** Grandfathered names whose row is gone or no longer off by default. */
  stale: string[];
}

/**
 * Split a markdown table row into cells, honouring `\|` escapes. Returns the
 * cells between the outer pipes.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  // Drop the empty strings before the first pipe and after the last one.
  return cells.slice(1, -1);
}

/** Every `| \`KOOKR_X\` | default | accepted | effect |` row of the document. */
export function parseEnvVarRows(markdown: string): EnvVarRow[] {
  const rows: EnvVarRow[] = [];
  markdown.split('\n').forEach((line, index) => {
    if (!line.startsWith('| `KOOKR_')) return;
    const cells = splitRow(line);
    if (cells.length !== 4) return;
    const match = cells[0].match(/^`(KOOKR_[A-Z0-9_]+)`$/);
    if (!match) return;
    rows.push({
      name: match[1],
      defaultValue: cells[1],
      accepted: cells[2],
      effect: cells[3],
      line: index + 1,
    });
  });
  return rows;
}

function normalize(cell: string): string {
  return cell.replace(/[`*]/g, '').trim().toLowerCase();
}

/**
 * A kill switch turns something off (`*_DISABLED`, `KOOKR_DISABLE_*`,
 * "`true` to halt") or makes it act less (`*_DRY_RUN`). The rule allows these.
 */
export function isKillSwitch(row: EnvVarRow): boolean {
  if (/(^KOOKR_DISABLE_|_DISABLE_|_DISABLED?$|_DRY_RUN$)/.test(row.name)) return true;
  const accepted = normalize(row.accepted);
  return /\bto (disable|halt|suppress)\b/.test(accepted) && !/\bto enable\b/.test(accepted);
}

/**
 * A default cell that leaves the variable unset: `unset`, `not set` or `0`
 * (but not a number such as `0.5` or `00`).
 */
const UNSET_DEFAULT = /^(unset|not set|0(?![\d.]))\b/;

/** Values that turn a boolean switch on. */
const TRUTHY_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/**
 * True when the accepted-values cell lists only values that turn a switch on,
 * such as `` `1` `` or `` `1` / `true` / `yes` ``, with no other words.
 */
function acceptsOnlyTruthyValues(accepted: string): boolean {
  const tokens = normalize(accepted)
    .split(/\s*(?:[/,|]|\bor\b)\s*/)
    .filter((token) => token !== '');
  return tokens.length > 0 && tokens.every((token) => TRUTHY_VALUES.has(token));
}

/**
 * True when the row's default leaves the switch off.
 *
 * How far the check reaches (issue #3942): it reads only what a row says
 * about itself as a switch. With an unset, `not set` or `0` default, a row is
 * off when it is named as a switch (`*_ENABLED`, `KOOKR_ENABLE_*`), when its
 * accepted values only turn something on (`` `1` / `true` ``) or say how to
 * enable it ("`1` to enable"), or when its Effect cell starts by calling it
 * opt-in. Any other wording in the Effect cell is not read. A row that only
 * carries a value (an API key, token, URL, ID or number) is configuration,
 * so its Effect cell saying "Enables the OpenRouter provider" does not flag it.
 */
export function hasOffDefault(row: EnvVarRow): boolean {
  const def = normalize(row.defaultValue);
  if (/^(off|disabled|false)\b/.test(def)) return true;
  if (/^(unset|not set|0(?![\d.]))\s*\([^)]*\b(off|disabled)\b[^)]*\)/.test(def)) return true;
  if (!UNSET_DEFAULT.test(def)) return false;
  if (/^unset\b|^not set\b/.test(def) && /(^KOOKR_ENABLE_|_ENABLED$)/.test(row.name)) return true;
  if (/^opt[- ]in\b/.test(normalize(row.effect))) return true;
  if (acceptsOnlyTruthyValues(row.accepted)) return true;
  // A bare unset or `0` default is off when the accepted values turn it on.
  const accepted = normalize(row.accepted);
  return /\b(to enable|enables?|to opt in)\b|=\s*on\b/.test(accepted);
}

/** A documented feature switch whose default is off. */
export function isDefaultOffFeatureSwitch(row: EnvVarRow): boolean {
  return hasOffDefault(row) && !isKillSwitch(row);
}

export function checkDefaultOn(
  markdown: string,
  grandfathered: ReadonlySet<string> = GRANDFATHERED_DEFAULT_OFF,
): DefaultOnResult {
  const rows = parseEnvVarRows(markdown);
  const issues: DefaultOnIssue[] = [];
  const offNames = new Set<string>();
  for (const row of rows) {
    if (!isDefaultOffFeatureSwitch(row)) continue;
    offNames.add(row.name);
    if (OFF_BY_DEFAULT_REASON.test(row.effect)) continue;
    if (grandfathered.has(row.name)) continue;
    issues.push({ name: row.name, line: row.line, defaultValue: row.defaultValue });
  }
  const stale = [...grandfathered].filter((name) => !offNames.has(name)).sort();
  return { checked: rows.length, issues, stale };
}

export function formatDefaultOnIssues(result: DefaultOnResult, docFile = DEFAULT_ON_DOC_FILE): string {
  const lines = [
    `${result.issues.length} feature switch(es) in ${docFile} default to off without saying why:`,
    ...result.issues.map((issue) => `  - ${issue.name} (line ${issue.line}, default: ${issue.defaultValue})`),
    '',
    'A finished feature ships switched on (CLAUDE.md, issue #3936). Either make the',
    'default on and keep the variable as a kill switch, or, when turning it on is hard',
    'to undo or reaches outside the host, add one of these phrases to the Effect cell:',
    '  Off by default: deletes or migrates data …',
    '  Off by default: spends money …',
    '  Off by default: sends data to a third party …',
    '  Off by default: needs a credential or service …',
  ];
  return lines.join('\n');
}
