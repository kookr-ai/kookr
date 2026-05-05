import type { Playbook, PlaybookParameter, PlaybookParameterOption } from './playbook.js';

export class PlaybookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookParseError';
  }
}

/**
 * Parse a playbook Markdown file into a Playbook object.
 * Expects YAML-like frontmatter delimited by --- lines.
 */
export function parsePlaybook(content: string, relativePath: string, sourceCwd: string): Playbook {
  const { frontmatter, body } = extractFrontmatter(content);
  const meta = parseFrontmatter(frontmatter);

  if (!meta.name || typeof meta.name !== 'string') {
    throw new PlaybookParseError(`Playbook "${relativePath}" is missing required field: name`);
  }

  return {
    id: relativePath,
    name: meta.name,
    description: typeof meta.description === 'string' ? meta.description : '',
    parameters: parseParameters(meta.parameters),
    checklist: parseStringArray(meta.checklist),
    body: body.trim(),
    ...(typeof meta.cwd === 'string' && meta.cwd ? { cwd: meta.cwd } : {}),
    sourceCwd,
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
      result = result.replaceAll(`{{${param.name}}}`, value);
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

function parseParameters(raw: unknown): PlaybookParameter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      name: String(item.name ?? ''),
      description: String(item.description ?? ''),
      required: item.required === true || item.required === 'true',
      ...(item.default !== undefined ? { default: String(item.default) } : {}),
      ...(item.type === 'select' ? { type: 'select' as const } : {}),
      ...(item.type === 'textarea' ? { type: 'textarea' as const } : {}),
      ...(Array.isArray(item.options) ? { options: parseOptions(item.options) } : {}),
      ...(typeof item.source === 'string' && item.source ? { source: item.source } : {}),
    }));
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
