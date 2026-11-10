/**
 * Design-token guardrails for the triage-inbox overhaul (#3561 slice 1).
 *
 * The dashboard stylesheet grew without a scale (33 font sizes, text down to
 * 7 px, muted text at 3.3:1). These tests pin the rules from
 * docs/spikes/gui-proposals/34-overhaul-triage-inbox.html so the scale cannot
 * drift back one declaration at a time:
 *
 * - type: five sizes only (12, 13, 14, 16, 20 px), nothing under 12;
 * - contrast: three text tiers, each at 4.5:1 or better on every surface;
 * - radii: 4 px, 8 px, or a full pill/circle;
 * - state: four roles (amber = waiting on you, red = failed or stuck,
 *   teal = working/selected, neutral otherwise), each with its own shape.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const frontendDir = dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return readFileSync(join(frontendDir, rel), 'utf8');
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const STYLESHEETS: Record<string, string> = {
  'styles.css': read('styles.css'),
  'critical.css': read('critical.css'),
  ...Object.fromEntries(
    readdirSync(join(frontendDir, 'components'))
      .filter((name) => name.endsWith('.css'))
      .map((name) => [`components/${name}`, read(`components/${name}`)]),
  ),
};

/** Collect `prop: value` declarations as `file:line value` strings. */
function declarations(prop: string): Array<{ where: string; value: string }> {
  const out: Array<{ where: string; value: string }> = [];
  const re = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'g');
  for (const [file, raw] of Object.entries(STYLESHEETS)) {
    const css = stripComments(raw);
    for (const match of css.matchAll(re)) {
      const line = css.slice(0, match.index).split('\n').length;
      out.push({ where: `${file}:${line}`, value: match[1].replace(/!important/, '').trim() });
    }
  }
  return out;
}

/** Innermost `selector { body }` blocks, keyed by each comma-separated selector. */
function rules(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1].split(',')) {
      const key = selector.trim().replace(/\s+/g, ' ');
      map.set(key, `${map.get(key) ?? ''};${match[2]}`);
    }
  }
  return map;
}

function rootTokens(css: string): Record<string, string> {
  const body = stripComments(css).match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

type Rgb = [number, number, number];

function parseColor(value: string, tokens: Record<string, string>): Rgb {
  const v = value.trim();
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref) return parseColor(tokens[ref[1]], tokens);
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (!hex) throw new Error(`unsupported colour ${value}`);
  return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(top: Rgb, alpha: number, under: Rgb): Rgb {
  return top.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha))) as Rgb;
}

const TYPE_SCALE = new Set(['12px', '13px', '14px', '16px', '20px']);

describe('type scale', () => {
  test('every stylesheet font-size is one of 12, 13, 14, 16 or 20 px', () => {
    const offScale = declarations('font-size')
      .filter(({ value }) => value !== 'inherit' && !TYPE_SCALE.has(value))
      .map(({ where, value }) => `${where} ${value}`);
    expect(offScale).toEqual([]);
  });

  test('font shorthands use the same scale', () => {
    const offScale = declarations('font')
      .filter(({ value }) => value !== 'inherit')
      .filter(({ value }) => {
        const size = value.match(/(\d+(?:\.\d+)?)(px|rem|em)\b/);
        return size !== null && !TYPE_SCALE.has(`${size[1]}${size[2]}`);
      })
      .map(({ where, value }) => `${where} ${value}`);
    expect(offScale).toEqual([]);
  });

  test('inline React fontSize styles in components use the scale', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          const src = readFileSync(path, 'utf8');
          // The onboarding diagram is a scaled illustration (SVG viewBox),
          // not UI text; its user units are not CSS pixels.
          if (entry.name === 'OnboardingLayoutDiagram.tsx') continue;
          for (const m of src.matchAll(/fontSize\s*:\s*(\d+(?:\.\d+)?)\b/g)) {
            if (!TYPE_SCALE.has(`${m[1]}px`)) offenders.push(`${path}: fontSize ${m[1]}`);
          }
        }
      }
    };
    walk(frontendDir);
    expect(offenders).toEqual([]);
  });
});

describe('radii', () => {
  test('corners are 4 px, 8 px, or a full pill or circle', () => {
    const allowed = new Set(['0', '4px', '8px', '999px', '50%', 'inherit']);
    const offScale = declarations('border-radius')
      .filter(({ value }) => !value.split(/\s+/).every((part) => allowed.has(part)))
      .map(({ where, value }) => `${where} ${value}`);
    expect(offScale).toEqual([]);
  });
});

describe('text contrast', () => {
  const styles = rootTokens(STYLESHEETS['styles.css']);

  test('critical.css and styles.css declare identical :root tokens', () => {
    expect(rootTokens(STYLESHEETS['critical.css'])).toEqual(styles);
  });

  test('text resolves to exactly three tiers', () => {
    const tiers = new Set(
      ['--text-bright', '--text', '--text-secondary', '--text-muted'].map((name) =>
        parseColor(styles[name], styles).join(','),
      ),
    );
    expect(tiers.size).toBe(3);
  });

  const surfaces: Array<[string, (t: Record<string, string>) => Rgb]> = [
    ['--bg', (t) => parseColor(t['--bg'], t)],
    ['--bg-panel', (t) => parseColor(t['--bg-panel'], t)],
    ['--bg-card', (t) => parseColor(t['--bg-card'], t)],
    ['--bg-card-hover', (t) => parseColor(t['--bg-card-hover'], t)],
    ['--bg-input', (t) => parseColor(t['--bg-input'], t)],
    // Selected rows: --bg-card-selected is teal at 10% over a card.
    ['selected card', (t) => mix(parseColor(t['--teal'], t), 0.1, parseColor(t['--bg-card'], t))],
  ];

  for (const tier of ['--text-bright', '--text', '--text-secondary', '--text-muted']) {
    test(`${tier} reaches 4.5:1 on every surface`, () => {
      const failures = surfaces
        .map(([name, surface]) => [name, contrast(parseColor(styles[tier], styles), surface(styles))] as const)
        .filter(([, ratio]) => ratio < 4.5)
        .map(([name, ratio]) => `${name} ${ratio.toFixed(2)}:1`);
      expect(failures).toEqual([]);
    });
  }
});

/**
 * State roles from the spike's shared rules table. Each state marker maps to
 * exactly one role colour, and each role has one shape on its marker.
 */
const ROLE_COLOR = {
  need: 'var(--state-need)',
  bad: 'var(--state-bad)',
  work: 'var(--state-work)',
  neutral: 'var(--state-neutral)',
} as const;
type Role = keyof typeof ROLE_COLOR;

const FINDING_KIND_ROLE: Record<string, Role> = {
  permission: 'need',
  input: 'need',
  stuck: 'bad',
  error: 'bad',
  'turn-complete': 'neutral',
};

const TURN_STATE_ROLE: Record<string, Role> = {
  waiting: 'need',
  blocked: 'need',
  running: 'work',
  complete: 'neutral',
};

describe('state colours: four roles, one shape each', () => {
  const css = rules(STYLESHEETS['styles.css']);
  const tokens = rootTokens(STYLESHEETS['styles.css']);
  const body = (selector: string) => css.get(selector) ?? '';

  test('role tokens resolve to amber, red, teal and the neutral text tier', () => {
    expect(tokens['--state-need']).toBe('var(--amber)');
    expect(tokens['--state-bad']).toBe('var(--red)');
    expect(tokens['--state-work']).toBe('var(--teal)');
    expect(tokens['--state-neutral']).toBe('var(--text-secondary)');
  });

  for (const [kind, role] of Object.entries(FINDING_KIND_ROLE)) {
    test(`finding kind "${kind}" is ${role}: card edge and severity label`, () => {
      expect(body(`.finding-card.${kind}`)).toContain(`border-left-color: ${ROLE_COLOR[role]}`);
      expect(body(`.finding-severity.${kind}`)).toContain(`color: ${ROLE_COLOR[role]}`);
    });
  }

  for (const [state, role] of Object.entries(TURN_STATE_ROLE)) {
    test(`turn state "${state}" is ${role}`, () => {
      expect(body(`.finding-turn-state.turn-state--${state}`)).toContain(`color: ${ROLE_COLOR[role]}`);
    });
  }

  /** Which shape a marker's role-specific rule draws, or null if none/ambiguous. */
  function shapeOf(declarations: string): Role | null {
    const has = (re: RegExp) => re.test(declarations);
    const matches: Role[] = [];
    if (has(/border-radius: 50%/) && has(/background: currentColor/)) matches.push('need'); // filled dot
    if (has(/transform: rotate\(45deg\)/)) matches.push('bad'); // diamond
    if (has(/background: transparent/) && has(/border: 2px solid currentColor/)) matches.push('work'); // ring
    if (has(/height: 2px/)) matches.push('neutral'); // short dash
    return matches.length === 1 ? matches[0] : null;
  }

  test('finding severity labels draw their role shape', () => {
    for (const [kind, role] of Object.entries(FINDING_KIND_ROLE)) {
      expect(shapeOf(body(`.finding-severity.${kind}::before`)), kind).toBe(role);
    }
  });

  test('turn-state lines draw their role shape', () => {
    for (const [state, role] of Object.entries(TURN_STATE_ROLE)) {
      expect(shapeOf(body(`.finding-turn-state.turn-state--${state}::before`)), state).toBe(role);
    }
  });
});
