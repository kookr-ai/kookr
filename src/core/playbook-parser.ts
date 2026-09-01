import { createHash } from 'node:crypto';
import type { Playbook, EffectivePlaybookLoop, LaunchDependency, PlaybookParameter, PlaybookParameterOption, PlaybookProbe, PlaybookScope } from './playbook.js';
import { LAUNCH_DEPENDENCIES } from './playbook.js';
import {
  DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP,
  MAX_AUTONOMOUS_REVIEW_ITERATION_CAP,
} from './autonomous-review-policy.js';

export const PLAYBOOK_LOOP_DEFAULTS = {
  iterationCap: DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP,
  costCapUsd: 25,
} as const;

export const PLAYBOOK_LOOP_LIMITS = {
  maxIterationCap: MAX_AUTONOMOUS_REVIEW_ITERATION_CAP,
  maxCostCapUsd: 25,
} as const;

export class PlaybookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookParseError';
  }
}

/**
 * Top-level frontmatter keys the playbook parser recognises. Kept beside the
 * parser so a newly supported key updates the validation allowlist in lockstep
 * (see `scripts/validate-playbooks.ts`). `parseFrontmatter` silently ignores
 * any key outside this set, so the validation gate warns on unknown keys to
 * catch typos like `checkist:` that would otherwise drop a field with no signal.
 */
export const KNOWN_PLAYBOOK_FRONTMATTER_KEYS = [
  'name',
  'description',
  'tags',
  'loop',
  'repo-tags',
  'dependencies',
  'deliveryPreAuthorized',
  'deliveryMode',
  'autoCloseOnSignal',
  'parameters',
  'checklist',
  'cwd',
  'probe',
] as const;

/**
 * Return the top-level frontmatter keys in `content` that the parser does not
 * recognise. Uses the same `parseFrontmatter` pass as {@link parsePlaybook}, so
 * the reported keys are exactly the ones the parser saw and ignored. Throws
 * {@link PlaybookParseError} when the frontmatter block is malformed, mirroring
 * `parsePlaybook` so callers can treat parse failures uniformly.
 */
export function findUnknownFrontmatterKeys(content: string): string[] {
  const { frontmatter } = extractFrontmatter(content);
  const known = new Set<string>(KNOWN_PLAYBOOK_FRONTMATTER_KEYS);
  return Object.keys(parseFrontmatter(frontmatter)).filter((key) => !known.has(key));
}

/**
 * Parse a playbook Markdown file into a Playbook object.
 * Expects YAML-like frontmatter delimited by --- lines.
 */
export function parsePlaybook(
  content: string,
  relativePath: string,
  sourceCwd: string,
  scope: PlaybookScope = 'project',
): Playbook & { sourceDigest: string } {
  const { frontmatter, body } = extractFrontmatter(content);
  const meta = parseFrontmatter(frontmatter);

  if (!meta.name || typeof meta.name !== 'string') {
    throw new PlaybookParseError(`Playbook "${relativePath}" is missing required field: name`);
  }

  const tags = parseTags(meta.tags);
  const loop = parseLoopConfig(meta.loop);
  const probe = parseProbeConfig(meta.probe);
  const effectiveLoop = tags.includes('loopable') && !loop.error
    ? buildEffectiveLoop(loop.value)
    : undefined;
  const repoTags = parseStringArray(meta['repo-tags']);
  const dependencies = parseLaunchDependencies(meta.dependencies);
  // Fail safe: a present-but-unrecognized value (e.g. `no`, `off`, `0`) must
  // not fall through to the pre-authorized default — treat it as an explicit
  // opt-out so malformed frontmatter never grants autonomous delivery.
  const deliveryPreAuthorized = meta.deliveryPreAuthorized === undefined
    ? undefined
    : parseOptionalBoolean(meta.deliveryPreAuthorized) ?? false;
  const deliveryMode = parseDeliveryMode(meta.deliveryMode);
  const autoCloseOnSignal = parseOptionalBoolean(meta.autoCloseOnSignal);

  return {
    id: relativePath,
    scope,
    name: meta.name,
    description: typeof meta.description === 'string' ? meta.description : '',
    parameters: parseParameters(meta.parameters),
    checklist: parseStringArray(meta.checklist),
    tags,
    ...(loop.value ? { loop: loop.value } : {}),
    ...(probe ? { probe } : {}),
    ...(deliveryPreAuthorized === undefined ? {} : { deliveryPreAuthorized }),
    ...(deliveryMode === undefined ? {} : { deliveryMode }),
    ...(autoCloseOnSignal === undefined ? {} : { autoCloseOnSignal }),
    ...(effectiveLoop ? { effectiveLoop } : {}),
    ...(loop.error ? { loopValidationError: loop.error } : {}),
    body: body.trim(),
    ...(typeof meta.cwd === 'string' && meta.cwd ? { cwd: meta.cwd } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    sourceCwd,
    sourceDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    ...(repoTags.length > 0 ? { repoTags } : {}),
  };
}

/**
 * Interpolate {{paramName}} placeholders in the body with provided values.
 * Applies defaults for missing optional params with defaults.
 */
export function interpolateParameters(
  body: string,
  parameters: PlaybookParameter[],
  values: Record<string, string>,
): string {
  let result = body;

  for (const param of parameters) {
    const value = values[param.name] ?? param.default;
    if (param.required && (value === undefined || value === '')) {
      throw new PlaybookParseError(`Required parameter "${param.name}" is missing`);
    }
    if (value !== undefined) {
      // A string replacement interprets JavaScript replacement tokens such as
      // $&, $$, $`, and $'. Parameter values are user-controlled prose, so use
      // a replacer function to preserve them literally.
      result = result.replaceAll(`{{${param.name}}}`, () => value);
    }
  }

  return result;
}

// --- Internal helpers ---

function extractFrontmatter(content: string): { frontmatter: string; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new PlaybookParseError('Playbook must start with --- frontmatter delimiter');
  }

  const afterFirst = trimmed.slice(3);
  const closingIdx = afterFirst.indexOf('\n---');
  if (closingIdx === -1) {
    throw new PlaybookParseError('Playbook frontmatter is missing closing --- delimiter');
  }

  const frontmatter = afterFirst.slice(0, closingIdx).trim();
  const body = afterFirst.slice(closingIdx + 4); // skip \n---
  return { frontmatter, body };
}

/**
 * Minimal YAML-like frontmatter parser.
 * Handles: scalar values, arrays of strings (- item), arrays of objects (- key: val).
 * Does NOT handle the full YAML spec — only the fixed playbook schema.
 */
function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Top-level key: value
    const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const inlineValue = keyMatch[2].trim();

    // Schema-specific inline arrays, used by tags: [workflow, loopable].
    if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
      result[key] = parseInlineStringArray(inlineValue);
      i++;
      continue;
    }

    if ((key === 'loop' || key === 'probe') && !inlineValue) {
      const block: Record<string, string | boolean> = {};
      i++;
      while (i < lines.length) {
        const blockMatch = lines[i].match(/^\s{2,}(\w[\w-]*):\s*(.*)/);
        if (!blockMatch) break;
        block[blockMatch[1]] = parseScalar(blockMatch[2].trim());
        i++;
      }
      result[key] = block;
      continue;
    }

    // Scalar value on same line
    if (inlineValue && !inlineValue.startsWith('-')) {
      result[key] = unquote(inlineValue);
      i++;
      continue;
    }

    // Array: collect indented lines starting with -
    if (!inlineValue || inlineValue.startsWith('-')) {
      const items: unknown[] = [];

      // If inline value starts with -, handle it
      if (inlineValue.startsWith('-')) {
        const item = parseArrayItem(inlineValue, lines, i);
        items.push(item.value);
        i = item.nextIndex;
      } else {
        i++;
      }

      while (i < lines.length) {
        const nextLine = lines[i];
        // Must be indented and start with -
        const itemMatch = nextLine.match(/^(\s+)-\s*(.*)/);
        if (!itemMatch) break;

        const itemContent = itemMatch[2].trim();

        // Check if this is a simple string or start of an object
        if (itemContent.includes(':')) {
          // Object item: collect all indented key: value pairs
          const obj: Record<string, string | boolean> = {};
          const firstKv = itemContent.match(/^(\w[\w-]*):\s*(.*)/);
          if (firstKv) {
            obj[firstKv[1]] = parseScalar(firstKv[2].trim());
          }
          i++;
          // Collect continuation lines for this object
          while (i < lines.length) {
            const contLine = lines[i];
            const contMatch = contLine.match(/^\s{4,}(\w[\w-]*):\s*(.*)/);
            if (!contMatch) break;
            const contKey = contMatch[1];
            const contVal = contMatch[2].trim();
            // Check if this key introduces a nested array (empty value + indented - items follow)
            if (!contVal && i + 1 < lines.length && lines[i + 1].match(/^\s{6,}-\s/)) {
              const nestedItems: Record<string, string | boolean>[] = [];
              i++;
              while (i < lines.length) {
                const nestedLine = lines[i];
                const nestedMatch = nestedLine.match(/^\s{6,}-\s*(.*)/);
                if (!nestedMatch) break;
                const nestedContent = nestedMatch[1].trim();
                const nestedObj: Record<string, string | boolean> = {};
                const nestedKv = nestedContent.match(/^(\w[\w-]*):\s*(.*)/);
                if (nestedKv) {
                  nestedObj[nestedKv[1]] = parseScalar(nestedKv[2].trim());
                }
                i++;
                // Collect nested object continuation lines
                while (i < lines.length) {
                  const nestedContLine = lines[i];
                  const nestedContMatch = nestedContLine.match(/^\s{8,}(\w[\w-]*):\s*(.*)/);
                  if (!nestedContMatch) break;
                  nestedObj[nestedContMatch[1]] = parseScalar(nestedContMatch[2].trim());
                  i++;
                }
                nestedItems.push(nestedObj);
              }
              (obj as Record<string, unknown>)[contKey] = nestedItems;
            } else {
              obj[contKey] = parseScalar(contVal);
              i++;
            }
          }
          items.push(obj);
        } else {
          // Simple string item
          items.push(unquote(itemContent));
          i++;
        }
      }

      result[key] = items;
      continue;
    }

    i++;
  }

  return result;
}

function parseArrayItem(
  inlineValue: string,
  _lines: string[],
  currentIndex: number,
): { value: unknown; nextIndex: number } {
  const content = inlineValue.replace(/^-\s*/, '').trim();
  return { value: unquote(content), nextIndex: currentIndex + 1 };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s: string): string | boolean {
  const unquoted = unquote(s);
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  return unquoted;
}

function parseInlineStringArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function parseProbeConfig(raw: unknown): PlaybookProbe | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainRecord(raw)) return undefined;
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command) return undefined;
  const escalateOnExit = parseEscalateOnExit(raw.escalateOnExit);
  return {
    command,
    ...(escalateOnExit ? { escalateOnExit } : {}),
  };
}

function parseEscalateOnExit(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw)) return [raw];
  if (typeof raw === 'boolean') return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (/^-?\d+$/.test(trimmed)) return [Number(trimmed)];
    return undefined;
  }
  if (Array.isArray(raw)) {
    const codes = raw
      .map((item) => {
        if (typeof item === 'number' && Number.isInteger(item)) return item;
        if (typeof item === 'string' && /^-?\d+$/.test(item.trim())) return Number(item.trim());
        return null;
      })
      .filter((item): item is number => item !== null);
    return codes.length > 0 ? codes : undefined;
  }
  return undefined;
}

type ParsedLoopConfig = NonNullable<Playbook['loop']>;

function parseLoopConfig(raw: unknown): { value?: ParsedLoopConfig; error?: string } {
  if (raw === undefined) return {};
  if (!isPlainRecord(raw)) return { error: 'loop metadata must be a mapping' };

  const loop: ParsedLoopConfig = {};

  const iterationCap = parseOptionalInteger(raw.iterationCap, 'loop.iterationCap');
  if (!iterationCap.ok) return { error: iterationCap.error };
  if (iterationCap.value !== undefined) {
    if (iterationCap.value <= 0 || iterationCap.value > PLAYBOOK_LOOP_LIMITS.maxIterationCap) {
      return { error: `loop.iterationCap must be between 1 and ${PLAYBOOK_LOOP_LIMITS.maxIterationCap}` };
    }
    loop.iterationCap = iterationCap.value;
  }

  const zeroDiff = parseOptionalInteger(
    raw.zeroDiffConsecutiveIterations,
    'loop.zeroDiffConsecutiveIterations',
  );
  if (!zeroDiff.ok) return { error: zeroDiff.error };
  if (zeroDiff.value !== undefined) {
    if (zeroDiff.value <= 0) {
      return { error: 'loop.zeroDiffConsecutiveIterations must be a positive integer' };
    }
    const effectiveIterationCap = loop.iterationCap ?? PLAYBOOK_LOOP_DEFAULTS.iterationCap;
    if (zeroDiff.value > effectiveIterationCap) {
      return { error: 'loop.zeroDiffConsecutiveIterations must not exceed loop.iterationCap' };
    }
    loop.zeroDiffConsecutiveIterations = zeroDiff.value;
  }

  const costCap = parseOptionalNumber(raw.costCapUsd, 'loop.costCapUsd');
  if (!costCap.ok) return { error: costCap.error };
  if (costCap.value !== undefined) {
    if (costCap.value <= 0 || costCap.value > PLAYBOOK_LOOP_LIMITS.maxCostCapUsd) {
      return { error: `loop.costCapUsd must be greater than 0 and at most ${PLAYBOOK_LOOP_LIMITS.maxCostCapUsd}` };
    }
    loop.costCapUsd = costCap.value;
  }

  if (raw.stopPredicate !== undefined) {
    if (typeof raw.stopPredicate !== 'string') {
      return { error: 'loop.stopPredicate must be a string' };
    }
    const trimmed = raw.stopPredicate.trim();
    if (trimmed.length === 0) {
      return { error: 'loop.stopPredicate must be a non-empty string' };
    }
    loop.stopPredicate = trimmed;
  }

  return Object.keys(loop).length > 0 ? { value: loop } : {};
}

function buildEffectiveLoop(loop: ParsedLoopConfig | undefined): NonNullable<Playbook['effectiveLoop']> {
  return {
    iterationCap: loop?.iterationCap ?? PLAYBOOK_LOOP_DEFAULTS.iterationCap,
    ...(loop?.costCapUsd !== undefined
      ? { costCapUsd: loop.costCapUsd }
      : { costCapUsd: PLAYBOOK_LOOP_DEFAULTS.costCapUsd }),
    ...(loop?.zeroDiffConsecutiveIterations !== undefined
      ? { zeroDiffConsecutiveIterations: loop.zeroDiffConsecutiveIterations }
      : {}),
    ...(loop?.stopPredicate !== undefined ? { stopPredicate: loop.stopPredicate } : {}),
    sources: {
      iterationCap: loop?.iterationCap !== undefined ? 'playbook' : 'default',
      costCapUsd: loop?.costCapUsd !== undefined ? 'playbook' : 'default',
      ...(loop?.zeroDiffConsecutiveIterations !== undefined
        ? { zeroDiffConsecutiveIterations: 'playbook' as const }
        : {}),
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalInteger(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { ok: false, error: `${field} must be an integer` };
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: `${field} must be an integer` };
  return { ok: true, value: Number(text) };
}

function parseOptionalNumber(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { ok: false, error: `${field} must be a number` };
  }
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return { ok: false, error: `${field} must be a number` };
  return { ok: true, value: Number(text) };
}

function parseParameters(raw: unknown): PlaybookParameter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const gatedBy = parseParameterGatedBy(item.gatedBy);
      return {
        name: String(item.name ?? ''),
        description: String(item.description ?? ''),
        required: item.required === true || item.required === 'true',
        ...(item.default !== undefined ? { default: String(item.default) } : {}),
        ...(item.type === 'text' ? { type: 'text' as const } : {}),
        ...(item.type === 'select' ? { type: 'select' as const } : {}),
        ...(item.type === 'textarea' ? { type: 'textarea' as const } : {}),
        ...(Array.isArray(item.options) ? { options: parseOptions(item.options) } : {}),
        ...(typeof item.source === 'string' && item.source ? { source: item.source } : {}),
        ...(item.defaultFrom === 'git-remote' ? { defaultFrom: 'git-remote' as const } : {}),
        ...(gatedBy ? { gatedBy } : {}),
      };
    });
}

/**
 * Validate an optional parameter `gatedBy` value. An empty/absent value is
 * treated as "not gated"; a non-empty value not in {@link LAUNCH_DEPENDENCIES}
 * is a fatal parse error, consistent with how `dependencies` entries are
 * validated. See `docs/rfc/rfc-capability-gated-playbook-params.md`.
 */
function parseParameterGatedBy(raw: unknown): LaunchDependency | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (!value) return undefined;
  if (!(LAUNCH_DEPENDENCIES as readonly string[]).includes(value)) {
    throw new PlaybookParseError(`Unsupported parameter gatedBy dependency: ${value}`);
  }
  return value as LaunchDependency;
}

function parseOptions(raw: unknown[]): PlaybookParameterOption[] {
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      label: String(item.label ?? item.value ?? ''),
      value: String(item.value ?? ''),
    }));
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function parseOptionalBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return undefined;
}

/**
 * Parse the optional `deliveryMode` frontmatter field. Only `self-advancing` is
 * recognised; any other value (or absence) leaves delivery mode unset so the
 * existing `deliveryPreAuthorized` shape applies. An explicit unsupported value
 * throws so a typo cannot silently grant or drop the self-advancing contract.
 */
function parseDeliveryMode(raw: unknown): 'self-advancing' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'self-advancing') return 'self-advancing';
  throw new PlaybookParseError(`Unsupported deliveryMode: ${String(raw)} (expected "self-advancing")`);
}

function parseLaunchDependencies(raw: unknown): LaunchDependency[] {
  const values = parseStringArray(raw).map((item) => item.trim()).filter(Boolean);
  for (const value of values) {
    if (!(LAUNCH_DEPENDENCIES as readonly string[]).includes(value)) {
      throw new PlaybookParseError(`Unsupported launch dependency: ${value}`);
    }
  }
  return [...new Set(values)] as LaunchDependency[];
}

/**
 * Parse loop frontmatter fields into validated `effectiveLoop` or a
 * `loopValidationError`. Returns an empty object when no loop metadata is
 * present (non-loopable playbooks).
 */
function parseLoopFields(
  raw: unknown,
  tags: string[],
): Pick<Playbook, 'effectiveLoop' | 'loopValidationError'> {
  const isLoopable = tags.includes('loopable');

  // No loop metadata — nothing to validate.
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    if (isLoopable) {
      return { loopValidationError: 'playbook is tagged loopable but has no loop: frontmatter block' };
    }
    return {};
  }

  const meta = raw as Record<string, unknown>;
  const iterationCap = typeof meta.iterationCap === 'number' ? meta.iterationCap
    : typeof meta.iterationCap === 'string' ? parseInt(meta.iterationCap, 10)
    : NaN;

  if (!Number.isInteger(iterationCap) || iterationCap <= 0) {
    return { loopValidationError: 'loop.iterationCap must be a positive integer' };
  }

  const effectiveLoop: EffectivePlaybookLoop = { iterationCap, sources: { iterationCap: 'playbook' } };

  if (typeof meta.stopPredicate === 'string' && meta.stopPredicate) {
    effectiveLoop.stopPredicate = meta.stopPredicate;
  }

  if (meta.zeroDiffConsecutiveIterations !== undefined) {
    const n = typeof meta.zeroDiffConsecutiveIterations === 'number'
      ? meta.zeroDiffConsecutiveIterations
      : parseInt(String(meta.zeroDiffConsecutiveIterations), 10);
    if (!Number.isInteger(n) || n <= 0) {
      return { loopValidationError: 'loop.zeroDiffConsecutiveIterations must be a positive integer' };
    }
    effectiveLoop.zeroDiffConsecutiveIterations = n;
  }

  if (meta.costCapUsd !== undefined) {
    const c = typeof meta.costCapUsd === 'number' ? meta.costCapUsd : parseFloat(String(meta.costCapUsd));
    if (!isFinite(c) || c <= 0) {
      return { loopValidationError: 'loop.costCapUsd must be a positive finite number' };
    }
    effectiveLoop.costCapUsd = c;
  }

  return { effectiveLoop };
}
