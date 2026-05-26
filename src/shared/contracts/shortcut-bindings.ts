export type ShortcutPlatform = 'default' | 'mac';

export type ShortcutGroup =
  | 'Navigation'
  | 'Responding to findings'
  | 'Task management'
  | 'Terminal'
  | 'Detail panel'
  | 'Dialogs'
  | 'Projects';

export type ShortcutActionId =
  | 'next_bottleneck'
  | 'next_task'
  | 'previous_task'
  | 'toggle_auto_advance'
  | 'quick_launch'
  | 'stt_toggle'
  | 'snooze_dialog'
  | 'quick_snooze'
  | 'focus_reply'
  | 'speak_agent'
  | 'complete_task'
  | 'cancel_task'
  | 'toggle_project_sidebar'
  | 'toggle_terminal_focus'
  | 'toggle_achievements'
  | 'select_all_projects'
  | 'terminal_send_1'
  | 'terminal_send_2'
  | 'terminal_send_3'
  | 'select_project_1'
  | 'select_project_2'
  | 'select_project_3'
  | 'select_project_4'
  | 'select_project_5'
  | 'select_project_6'
  | 'toggle_shortcuts_help'
  | 'deselect_task';

export interface ShortcutAction {
  id: ShortcutActionId;
  group: ShortcutGroup;
  label: string;
  description: string;
  context?: string;
  featured?: boolean;
}

export interface ShortcutBinding {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export type ShortcutBindingOverrides = Partial<Record<ShortcutActionId, string>>;
export type PlatformShortcutBindingOverrides = Partial<Record<ShortcutPlatform, ShortcutBindingOverrides>>;
export type ShortcutBindingMap = Record<ShortcutActionId, ShortcutBinding>;

export interface ShortcutValidationResult {
  overrides: PlatformShortcutBindingOverrides;
  warnings: string[];
}

export interface ShortcutConflict {
  binding: string;
  actionIds: ShortcutActionId[];
}

export interface KeyboardShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface ShortcutDisplay {
  id: ShortcutActionId;
  keys: string[];
  description: string;
  context?: string;
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'next_bottleneck', group: 'Navigation', label: 'Next finding', description: 'Jump to next finding by severity', featured: true },
  { id: 'next_task', group: 'Navigation', label: 'Next task', description: 'Next task (findings + healthy)', featured: true },
  { id: 'previous_task', group: 'Navigation', label: 'Previous task', description: 'Previous task', featured: true },
  { id: 'toggle_auto_advance', group: 'Navigation', label: 'Auto-Advance', description: 'Toggle Auto-Advance (follow priority project)', featured: true },
  { id: 'deselect_task', group: 'Navigation', label: 'Deselect task', description: 'Deselect current task', context: 'when no dialog is open' },
  { id: 'stt_toggle', group: 'Responding to findings', label: 'Toggle voice input', description: 'Toggle voice input (speech-to-text)', context: 'when STT is enabled' },
  { id: 'quick_launch', group: 'Task management', label: 'Quick launch', description: 'Open quick launch bar to create a new task', featured: true },
  { id: 'snooze_dialog', group: 'Task management', label: 'Snooze task', description: 'Snooze selected task (opens duration picker)', featured: true },
  { id: 'quick_snooze', group: 'Task management', label: 'Quick snooze', description: 'Quick snooze selected task (5 minutes)' },
  { id: 'complete_task', group: 'Task management', label: 'Complete task', description: 'Complete selected task (with confirmation)' },
  { id: 'cancel_task', group: 'Task management', label: 'Cancel task', description: 'Cancel selected task (with confirmation)' },
  { id: 'terminal_send_1', group: 'Terminal', label: 'Send 1 and next', description: 'Send 1 to terminal and skip to next task' },
  { id: 'terminal_send_2', group: 'Terminal', label: 'Send 2 and next', description: 'Send 2 to terminal and skip to next task' },
  { id: 'terminal_send_3', group: 'Terminal', label: 'Send 3 and next', description: 'Send 3 to terminal and skip to next task' },
  { id: 'toggle_terminal_focus', group: 'Terminal', label: 'Terminal focus mode', description: 'Toggle terminal focus mode', featured: true },
  { id: 'focus_reply', group: 'Detail panel', label: 'Focus reply', description: 'Focus reply input for current finding' },
  { id: 'speak_agent', group: 'Detail panel', label: 'Speak agent summary', description: 'Speak agent summary aloud', context: 'when TTS is enabled' },
  { id: 'select_all_projects', group: 'Projects', label: 'All projects', description: 'Show all projects' },
  { id: 'select_project_1', group: 'Projects', label: 'Project shortcut 1', description: 'Select first visible project' },
  { id: 'select_project_2', group: 'Projects', label: 'Project shortcut 2', description: 'Select second visible project' },
  { id: 'select_project_3', group: 'Projects', label: 'Project shortcut 3', description: 'Select third visible project' },
  { id: 'select_project_4', group: 'Projects', label: 'Project shortcut 4', description: 'Select fourth visible project' },
  { id: 'select_project_5', group: 'Projects', label: 'Project shortcut 5', description: 'Select fifth visible project' },
  { id: 'select_project_6', group: 'Projects', label: 'Project shortcut 6', description: 'Select sixth visible project' },
  { id: 'toggle_project_sidebar', group: 'Dialogs', label: 'Project sidebar', description: 'Toggle project sidebar', featured: true },
  { id: 'toggle_achievements', group: 'Dialogs', label: 'Achievements panel', description: 'Toggle achievements panel' },
  { id: 'toggle_shortcuts_help', group: 'Dialogs', label: 'Help and shortcuts', description: 'Open or close help and shortcuts', featured: true },
];

const ACTION_IDS = new Set<ShortcutActionId>(SHORTCUT_ACTIONS.map((action) => action.id));

const DEFAULT_SHORTCUTS: ShortcutBindingMap = {
  next_bottleneck: binding('n', { alt: true }),
  next_task: binding('j', { alt: true }),
  previous_task: binding('k', { alt: true }),
  toggle_auto_advance: binding('f', { alt: true }),
  quick_launch: binding('l', { alt: true }),
  stt_toggle: binding('m', { alt: true }),
  snooze_dialog: binding('s', { alt: true }),
  quick_snooze: binding('z', { alt: true }),
  focus_reply: binding('r', { alt: true }),
  speak_agent: binding('v', { alt: true }),
  complete_task: binding('End', { alt: true }),
  cancel_task: binding('Delete', { alt: true }),
  toggle_project_sidebar: binding('p', { alt: true }),
  toggle_terminal_focus: binding('t', { alt: true }),
  toggle_achievements: binding('a', { alt: true }),
  select_all_projects: binding('0', { alt: true }),
  terminal_send_1: binding('1', { alt: true }),
  terminal_send_2: binding('2', { alt: true }),
  terminal_send_3: binding('3', { alt: true }),
  select_project_1: binding('4', { alt: true }),
  select_project_2: binding('5', { alt: true }),
  select_project_3: binding('6', { alt: true }),
  select_project_4: binding('7', { alt: true }),
  select_project_5: binding('8', { alt: true }),
  select_project_6: binding('9', { alt: true }),
  toggle_shortcuts_help: binding('?'),
  deselect_task: binding('Escape'),
};

const MAC_SHORTCUTS: ShortcutBindingMap = {
  ...DEFAULT_SHORTCUTS,
  next_bottleneck: binding('n', { meta: true, ctrl: true }),
  next_task: binding('j', { meta: true, ctrl: true }),
  previous_task: binding('k', { meta: true, ctrl: true }),
  toggle_auto_advance: binding('f', { meta: true, ctrl: true }),
  quick_launch: binding('l', { meta: true, ctrl: true }),
  stt_toggle: binding('m', { meta: true, ctrl: true }),
  snooze_dialog: binding('s', { meta: true, ctrl: true }),
  quick_snooze: binding('z', { meta: true, ctrl: true }),
  focus_reply: binding('r', { meta: true, ctrl: true }),
  speak_agent: binding('v', { meta: true, ctrl: true }),
  complete_task: binding('Enter', { meta: true, ctrl: true }),
  cancel_task: binding('Backspace', { meta: true, ctrl: true }),
  toggle_project_sidebar: binding('p', { meta: true, ctrl: true }),
  toggle_terminal_focus: binding('t', { meta: true, ctrl: true }),
  toggle_achievements: binding('a', { meta: true, ctrl: true }),
  select_all_projects: binding('0', { meta: true, ctrl: true }),
  terminal_send_1: binding('1', { meta: true, ctrl: true }),
  terminal_send_2: binding('2', { meta: true, ctrl: true }),
  terminal_send_3: binding('3', { meta: true, ctrl: true }),
  select_project_1: binding('4', { meta: true, ctrl: true }),
  select_project_2: binding('5', { meta: true, ctrl: true }),
  select_project_3: binding('6', { meta: true, ctrl: true }),
  select_project_4: binding('7', { meta: true, ctrl: true }),
  select_project_5: binding('8', { meta: true, ctrl: true }),
  select_project_6: binding('9', { meta: true, ctrl: true }),
};

const DEFAULTS_BY_PLATFORM: Record<ShortcutPlatform, ShortcutBindingMap> = {
  default: DEFAULT_SHORTCUTS,
  mac: MAC_SHORTCUTS,
};

function binding(key: string, modifiers: Omit<ShortcutBinding, 'key'> = {}): ShortcutBinding {
  return { key, ...modifiers };
}

export function detectShortcutPlatform(platform = getNavigatorPlatform()): ShortcutPlatform {
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'default';
}

function getNavigatorPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.platform || '';
}

export function getDefaultShortcutBindings(platform: ShortcutPlatform): ShortcutBindingMap {
  return { ...DEFAULTS_BY_PLATFORM[platform] };
}

export function resolveShortcutBindings(
  platform: ShortcutPlatform,
  overrides: PlatformShortcutBindingOverrides | ShortcutBindingOverrides | undefined,
): ShortcutBindingMap {
  const resolved: ShortcutBindingMap = { ...DEFAULTS_BY_PLATFORM[platform] };
  if (!overrides || typeof overrides !== 'object') return resolved;

  const platformOverrides = isPlatformShortcutOverrides(overrides)
    ? overrides[platform]
    : overrides;
  if (!platformOverrides || typeof platformOverrides !== 'object') return resolved;

  for (const action of SHORTCUT_ACTIONS) {
    if (!(action.id in platformOverrides)) continue;
    const raw = platformOverrides[action.id];
    if (typeof raw !== 'string') continue;
    const parsed = parseShortcutBinding(raw);
    if (parsed) resolved[action.id] = parsed;
  }
  return resolved;
}

export function validateShortcutBindingOverrides(raw: unknown): ShortcutValidationResult {
  if (raw === undefined) return { overrides: {}, warnings: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides: {}, warnings: ['shortcutBindings must be an object; ignored invalid value'] };
  }

  const warnings: string[] = [];
  const rawRecord = raw as Record<string, unknown>;
  const rawByPlatform = isRawPlatformShortcutOverrides(rawRecord)
    ? rawRecord
    : { default: rawRecord, mac: rawRecord };
  const accepted: PlatformShortcutBindingOverrides = {};

  for (const platformKey of Object.keys(rawByPlatform)) {
    if (platformKey !== 'mac' && platformKey !== 'default') {
      warnings.push(`Unknown shortcut platform "${platformKey}" was ignored`);
      continue;
    }
    const platform = platformKey;
    const platformValue = rawByPlatform[platform];
    if (!platformValue || typeof platformValue !== 'object' || Array.isArray(platformValue)) {
      warnings.push(`shortcutBindings.${platform} must be an object; ignored invalid value`);
      continue;
    }
    accepted[platform] = validateShortcutBindingOverrideMap(platformValue as Record<string, unknown>, platform, warnings);
  }

  return { overrides: accepted, warnings };
}

function validateShortcutBindingOverrideMap(
  raw: Record<string, unknown>,
  platform: ShortcutPlatform,
  warnings: string[],
): ShortcutBindingOverrides {
  const accepted: ShortcutBindingOverrides = {};
  const identities = new Map<string, ShortcutActionId[]>();

  for (const action of SHORTCUT_ACTIONS) {
    const defaultIdentity = shortcutIdentity(DEFAULTS_BY_PLATFORM[platform][action.id]);
    identities.set(defaultIdentity, [...(identities.get(defaultIdentity) ?? []), action.id]);
  }

  for (const [id, value] of Object.entries(raw)) {
    if (!ACTION_IDS.has(id as ShortcutActionId)) {
      warnings.push(`Unknown shortcut action "${id}" in ${platform} bindings was ignored`);
      continue;
    }
    if (value === '') {
      continue;
    }
    if (typeof value !== 'string') {
      warnings.push(`Shortcut "${id}" in ${platform} bindings must be a string; ignored invalid value`);
      continue;
    }
    const parsed = parseShortcutBinding(value);
    if (!parsed) {
      warnings.push(`Shortcut "${id}" in ${platform} bindings has invalid binding "${value}"; ignored`);
      continue;
    }
    const identity = shortcutIdentity(parsed);
    const existing = identities.get(identity)?.filter((actionId) => actionId !== id) ?? [];
    if (existing.length > 0) {
      warnings.push(
        `Shortcut "${id}" in ${platform} bindings conflicts with "${existing[0]}" on ${formatShortcutBinding(parsed, 'storage')}; ignored`,
      );
      continue;
    }
    const defaultIdentity = shortcutIdentity(DEFAULTS_BY_PLATFORM[platform][id as ShortcutActionId]);
    identities.set(defaultIdentity, (identities.get(defaultIdentity) ?? []).filter((actionId) => actionId !== id));
    identities.set(identity, [...(identities.get(identity) ?? []), id as ShortcutActionId]);
    accepted[id as ShortcutActionId] = formatShortcutBinding(parsed, 'storage');
  }

  return accepted;
}

export function findShortcutConflicts(bindings: ShortcutBindingMap): ShortcutConflict[] {
  const byIdentity = new Map<string, ShortcutActionId[]>();
  const byDisplay = new Map<string, string>();
  for (const action of SHORTCUT_ACTIONS) {
    const shortcut = bindings[action.id];
    const identity = shortcutIdentity(shortcut);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), action.id]);
    byDisplay.set(identity, formatShortcutBinding(shortcut, 'display'));
  }
  return [...byIdentity.entries()]
    .filter(([, actionIds]) => actionIds.length > 1)
    .map(([identity, actionIds]) => ({ binding: byDisplay.get(identity) ?? identity, actionIds }));
}

export function parseShortcutBinding(raw: string): ShortcutBinding | null {
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers: Omit<ShortcutBinding, 'key'> = {};
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') modifiers.ctrl = true;
    else if (lower === 'alt' || lower === 'option' || lower === 'opt') modifiers.alt = true;
    else if (lower === 'shift') modifiers.shift = true;
    else if (lower === 'cmd' || lower === 'command' || lower === 'meta') modifiers.meta = true;
    else if (key === null) key = canonicalKey(part);
    else return null;
  }

  if (!key) return null;
  if (isUnmodifiedPrintableKey(key, modifiers)) return null;
  return { key, ...modifiers };
}

export function matchesShortcutBinding(event: KeyboardShortcutEventLike, binding: ShortcutBinding): boolean {
  const eventKey = canonicalKey(getPhysicalShortcutKey(event));
  if (eventKey !== binding.key) return false;

  const ignoreShift = binding.key === '?' && !binding.shift;
  return Boolean(event.ctrlKey) === Boolean(binding.ctrl) &&
    Boolean(event.altKey) === Boolean(binding.alt) &&
    Boolean(event.metaKey) === Boolean(binding.meta) &&
    (ignoreShift || Boolean(event.shiftKey) === Boolean(binding.shift));
}

export function getPhysicalShortcutKey(event: Pick<KeyboardShortcutEventLike, 'code' | 'key'>): string {
  if (event.code?.startsWith('Key') && event.code.length === 4) {
    return event.code.slice(3).toLowerCase();
  }
  if (event.code?.startsWith('Digit') && event.code.length === 6) {
    return event.code.slice(5);
  }
  if (event.code === 'Delete') return 'Delete';
  if (event.code === 'End') return 'End';
  return event.key;
}

export function matchesShortcutAction(
  event: KeyboardShortcutEventLike,
  bindings: ShortcutBindingMap,
  actionId: ShortcutActionId,
): boolean {
  return matchesShortcutBinding(event, bindings[actionId]);
}

export function formatShortcutBinding(
  bindingValue: ShortcutBinding,
  style: 'display' | 'storage' = 'display',
): string {
  const parts: string[] = [];
  if (bindingValue.meta) parts.push(style === 'display' ? 'Cmd' : 'Cmd');
  if (bindingValue.ctrl) parts.push(style === 'display' ? 'Ctrl' : 'Ctrl');
  if (bindingValue.alt) parts.push(style === 'display' ? 'Alt' : 'Alt');
  if (bindingValue.shift) parts.push(style === 'display' ? 'Shift' : 'Shift');
  parts.push(displayKey(bindingValue.key));
  return parts.join('+');
}

function isPlatformShortcutOverrides(
  value: PlatformShortcutBindingOverrides | ShortcutBindingOverrides,
): value is PlatformShortcutBindingOverrides {
  return 'mac' in value || 'default' in value;
}

function isRawPlatformShortcutOverrides(value: Record<string, unknown>): value is Record<ShortcutPlatform, unknown> {
  return 'mac' in value || 'default' in value;
}

export function shortcutIdentity(bindingValue: ShortcutBinding): string {
  const shift = bindingValue.key === '?' ? false : bindingValue.shift;
  return [
    bindingValue.meta ? 'meta' : '',
    bindingValue.ctrl ? 'ctrl' : '',
    bindingValue.alt ? 'alt' : '',
    shift ? 'shift' : '',
    bindingValue.key.toLowerCase(),
  ].filter(Boolean).join('+');
}

export function getShortcutHelpGroups(bindings: ShortcutBindingMap): Array<{
  title: ShortcutGroup;
  shortcuts: Array<ShortcutAction & { binding: ShortcutBinding }>;
}> {
  const groups: Array<{ title: ShortcutGroup; shortcuts: Array<ShortcutAction & { binding: ShortcutBinding }> }> = [];
  for (const action of SHORTCUT_ACTIONS) {
    const actionBinding = bindings[action.id];
    if (!actionBinding) continue;
    let group = groups.find((entry) => entry.title === action.group);
    if (!group) {
      group = { title: action.group, shortcuts: [] };
      groups.push(group);
    }
    group.shortcuts.push({ ...action, binding: actionBinding });
  }
  return groups;
}

export function getFeaturedShortcuts(bindingsOrPlatform: ShortcutBindingMap | ShortcutPlatform = detectShortcutPlatform()): ShortcutDisplay[] {
  const bindings = typeof bindingsOrPlatform === 'string'
    ? getDefaultShortcutBindings(bindingsOrPlatform)
    : bindingsOrPlatform;
  return SHORTCUT_ACTIONS
    .filter((action) => action.featured)
    .map((action) => ({
      id: action.id,
      keys: splitShortcutLabel(formatShortcutBinding(bindings[action.id])),
      description: action.description,
      ...(action.context ? { context: action.context } : {}),
    }));
}

function splitShortcutLabel(label: string): string[] {
  return label.split('+');
}

function canonicalKey(raw: string): string {
  const lower = raw.trim().toLowerCase();
  switch (lower) {
    case 'esc': return 'Escape';
    case 'escape': return 'Escape';
    case 'enter': return 'Enter';
    case 'return': return 'Enter';
    case 'backspace': return 'Backspace';
    case 'delete': return 'Delete';
    case 'del': return 'Delete';
    case 'end': return 'End';
    case 'space': return ' ';
    case 'plus': return '+';
    default:
      return raw.length === 1 ? raw.toLowerCase() : raw;
  }
}

function isUnmodifiedPrintableKey(key: string, modifiers: Omit<ShortcutBinding, 'key'>): boolean {
  if (modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta) return false;
  if (key === '?' || key === 'Escape') return false;
  return key.length === 1;
}

function displayKey(key: string): string {
  switch (key) {
    case ' ': return 'Space';
    case 'Escape': return 'Esc';
    case 'Delete': return 'Del';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}
