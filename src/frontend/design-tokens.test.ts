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
import { TASK_STUCK_REASONS, type TaskStuckReason } from '../shared/contracts/task-stuck-reason.js';
import { ANOMALY_TYPES } from '../shared/contracts/anomalies.js';
import { findingKindClass, type FindingKindClass } from './presentation.js';

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

/**
 * Declarations per selector, in source order, from innermost `selector { body }`
 * blocks (a selector list is split so each selector gets the shared body).
 * `lookup` returns the LAST declared value of a property, which is what the
 * cascade applies for equal specificity — a later override must not hide
 * behind an earlier matching rule.
 */
function rules(css: string): { lookup: (selector: string, prop: string) => string | undefined } {
  const map = new Map<string, Array<[string, string]>>();
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = [...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map(
      (d) => [d[1], d[2].replace(/!important/, '').trim()] as [string, string],
    );
    for (const selector of match[1].split(',')) {
      const key = selector.trim().replace(/\s+/g, ' ');
      map.set(key, [...(map.get(key) ?? []), ...decls]);
    }
  }
  return {
    lookup: (selector, prop) => map.get(selector)?.filter(([p]) => p === prop).at(-1)?.[1],
  };
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
          // Style objects (fontSize: 11 / '11px' / '0.8em') and JSX attributes (fontSize="11").
          for (const m of src.matchAll(/fontSize\s*[:=]\s*\{?\s*['"`]?(\d+(?:\.\d+)?)(px|r?em)?\b/g)) {
            if (!TYPE_SCALE.has(`${m[1]}${m[2] ?? 'px'}`)) offenders.push(`${path}: fontSize ${m[0]}`);
          }
        }
      }
    };
    walk(frontendDir);
    expect(offenders).toEqual([]);
  });
});

describe('browser default sizes', () => {
  // h5/h6 default to 0.83em/0.67em and <small> to "smaller": inside 12-13 px
  // text they render at 8-11 px unless pinned (markdown renders ##/### as h5/h6).
  for (const file of ['styles.css', 'critical.css']) {
    test(`${file} pins h5, h6 and small to the scale`, () => {
      const css = rules(STYLESHEETS[file]);
      expect(css.lookup('h5', 'font-size')).toBe('13px');
      expect(css.lookup('h6', 'font-size')).toBe('12px');
      expect(css.lookup('small', 'font-size')).toBe('12px');
    });
  }
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

  test('text is never dimmed with partial opacity at rest', () => {
    // Opacity multiplies contrast down (--text-muted at 0.7 fell to 3.6:1),
    // and it applies to inherited colour too, so any partial opacity on a
    // text-bearing rule is suspect. Allowed: inactive states (disabled,
    // hover, stale, paused, locked, …), decorative separators, and the
    // icon-only buttons listed below, whose glyphs are not running text.
    const inactive = /disabled|:hover|-sep\b|inactive|locked|is-revoked|is-expired|stale|muted|paused|blacklisted|drag-active|pending-deletion|snoozed/;
    const iconOnly = new Set([
      '.copy-explanation.btn-icon',
      '.task-id-copy-icon',
      '.branch-icon',
      '.task-actions-mini',
      '.btn-reply',
      '.playbook-pin-btn',
      '.md-copy-btn',
      '.btn-speak-finding-ring',
      '.btn-sound-toggle',
      '.btn-trophy',
      '.hook-inventory-lock',
    ]);
    const offenders: string[] = [];
    for (const file of ['styles.css', 'critical.css']) {
      const css = stripComments(STYLESHEETS[file]).replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].trim().replace(/\s+/g, ' ');
        const opacity = match[2].match(/(?<![\w-])opacity\s*:\s*(0?\.\d+)/);
        if (!opacity || Number(opacity[1]) === 0) continue;
        if (inactive.test(selector) || iconOnly.has(selector)) continue;
        offenders.push(`${file} ${selector} opacity ${opacity[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

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

/** Every finding wants the operator, so findings are "need" or "bad". */
const FINDING_KIND_ROLE: Record<FindingKindClass, Role> = {
  permission: 'need',
  input: 'need',
  'turn-complete': 'need',
  stuck: 'bad',
  error: 'bad',
};

const TURN_STATE_ROLE: Record<string, Role> = {
  waiting: 'need',
  blocked: 'need',
  running: 'work',
  complete: 'neutral',
};

/** `StuckReasonBadge` reasons shown on healthy rows (every contract value). */
const STUCK_REASON_ROLE: Record<TaskStuckReason, Role> = {
  awaiting_completion_ack: 'need',
  provider_paused: 'need',
  waiting_on_input: 'need',
  permission_blocked: 'need',
  hung_suspect: 'bad',
};

describe('state colours: four roles, one shape each', () => {
  test('selection is teal everywhere, including the project sidebar', () => {
    for (const file of ['styles.css', 'critical.css']) {
      expect(rules(STYLESHEETS[file]).lookup('.project-icon.selected', 'border-color'), file).toBe('var(--state-work)');
    }
  });

  test('no selected, active or pressed state is drawn in blue', () => {
    // Blue literals seen in this stylesheet, plus `var(--accent, …)`: --accent
    // is not defined, so its (blue) fallback is what renders.
    const blue = /var\(--blue\)|var\(--accent\s*,|#60a5fa|#4a8eff|#61dafb|rgba\(\s*(96,\s*165,\s*250|120,\s*200,\s*255|122,\s*162,\s*247|64,\s*128,\s*255)\s*,/i;
    const offenders: string[] = [];
    for (const file of ['styles.css', 'critical.css']) {
      for (const match of stripComments(STYLESHEETS[file]).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].trim().replace(/\s+/g, ' ');
        // `.selected`, `.active`, BEM `--active` / `-active` modifiers, aria state.
        if (!/[-.](selected|active)\b|\[aria-(pressed|selected)="true"\]/.test(selector)) continue;
        if (blue.test(match[2])) offenders.push(`${file} ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('a pending (queued) task is neutral everywhere, not amber', () => {
    expect(css.lookup('.detail-badge.pending', 'color')).toBe(ROLE_COLOR.neutral);
    expect(shapeOf('.detail-badge.pending::before')).toBe('neutral');
    expect(css.lookup('.pending-label', 'color')).toBe(ROLE_COLOR.neutral);
    expect(css.lookup('.pending-row', 'border-left')).toBe(`3px dashed ${ROLE_COLOR.neutral}`);
  });

  test('every rail row draws its selection in teal', () => {
    for (const row of ['.finding-card', '.healthy-row', '.pending-row', '.snoozed-row', '.completed-row']) {
      expect(css.lookup(`${row}.selected`, 'box-shadow'), row).toMatch(/^inset 4px 0 0 var\(--(teal|state-work)\)$/);
    }
  });

  const css = rules(STYLESHEETS['styles.css']);
  const tokens = rootTokens(STYLESHEETS['styles.css']);

  /** Which shape a `::before` marker draws (last declaration wins), or null if none/ambiguous. */
  function shapeOf(selector: string): Role | null {
    const get = (prop: string) => css.lookup(selector, prop);
    const matches: Role[] = [];
    const filled = get('background') === 'currentColor';
    if (get('border-radius') === '50%' && filled) matches.push('need'); // dot
    if (get('transform')?.startsWith('rotate(45deg)') && filled) matches.push('bad'); // diamond
    if (get('background') === 'transparent' && get('border') === '2px solid currentColor') matches.push('work'); // ring
    if (get('height') === '2px' && filled) matches.push('neutral'); // dash
    return matches.length === 1 ? matches[0] : null;
  }

  test('role tokens resolve to amber, red, teal and the neutral text tier', () => {
    expect(tokens['--state-need']).toBe('var(--amber)');
    expect(tokens['--state-bad']).toBe('var(--red)');
    expect(tokens['--state-work']).toBe('var(--teal)');
    expect(tokens['--state-neutral']).toBe('var(--text-secondary)');
  });

  test('the styled finding kinds are exactly the kinds the frontend emits', () => {
    const emitted = new Set(
      ANOMALY_TYPES.flatMap((type) => [findingKindClass(type, 'running'), findingKindClass(type, 'completed_turn')]),
    );
    expect([...emitted].sort()).toEqual(Object.keys(FINDING_KIND_ROLE).sort());
  });

  for (const [kind, role] of Object.entries(FINDING_KIND_ROLE)) {
    test(`finding kind "${kind}" is ${role}: card edge, label, detail badge and their shape`, () => {
      expect(css.lookup(`.finding-card.${kind}`, 'border-left-color')).toBe(ROLE_COLOR[role]);
      expect(css.lookup(`.finding-severity.${kind}`, 'color')).toBe(ROLE_COLOR[role]);
      expect(css.lookup(`.detail-badge.${kind}`, 'color')).toBe(ROLE_COLOR[role]);
      expect(shapeOf(`.finding-severity.${kind}::before`)).toBe(role);
      expect(shapeOf(`.detail-badge.${kind}::before`)).toBe(role);
    });
  }

  for (const [state, role] of Object.entries(TURN_STATE_ROLE)) {
    test(`turn state "${state}" is ${role} with its shape`, () => {
      expect(css.lookup(`.finding-turn-state.turn-state--${state}`, 'color')).toBe(ROLE_COLOR[role]);
      expect(shapeOf(`.finding-turn-state.turn-state--${state}::before`)).toBe(role);
    });
  }

  test('every stuck reason in the contract has a role', () => {
    expect(Object.keys(STUCK_REASON_ROLE).sort()).toEqual([...TASK_STUCK_REASONS].sort());
  });

  for (const [reason, role] of Object.entries(STUCK_REASON_ROLE)) {
    test(`stuck reason "${reason}" is ${role} with its shape`, () => {
      expect(css.lookup(`.stuck-reason-badge--${reason}`, 'color')).toBe(ROLE_COLOR[role]);
      expect(shapeOf(`.stuck-reason-badge--${reason}::before`)).toBe(role);
    });
  }

  test('project-drawer task status dots use the role colours and shapes', () => {
    expect(css.lookup('.task-status-dot.inProgress', 'border')).toBe(`2px solid ${ROLE_COLOR.work}`);
    expect(css.lookup('.task-status-dot.terminated', 'background')).toBe(ROLE_COLOR.bad);
    expect(css.lookup('.task-status-dot.terminated', 'transform')).toMatch(/^rotate\(45deg\)/);
    for (const status of ['completed', 'cancelled', 'pending', 'open']) {
      expect(css.lookup(`.task-status-dot.${status}`, 'background'), status).toBe(ROLE_COLOR.neutral);
      expect(css.lookup(`.task-status-dot.${status}`, 'height'), status).toBe('2px');
    }
  });

  test('running and active markers are teal, not green', () => {
    expect(css.lookup('.project-icon-dot.active', 'background')).toBe(ROLE_COLOR.work);
    expect(css.lookup('.agent-provider-mark--running::after', 'border-top-color')).toBe(ROLE_COLOR.work);
    expect(rules(STYLESHEETS['critical.css']).lookup('.project-icon-dot.active', 'background')).toBe(ROLE_COLOR.work);
  });
});
