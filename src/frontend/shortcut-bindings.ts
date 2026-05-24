export type ShortcutPlatform = 'linux' | 'darwin' | 'wsl2' | 'unknown';

type ShortcutKeyToken =
  | 'alt'
  | 'enter'
  | 'esc'
  | '?'
  | '0'
  | '1'
  | '1-3'
  | '4-9'
  | 'a'
  | 'del'
  | 'end'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'p'
  | 'r'
  | 's'
  | 't'
  | 'z';

interface ShortcutDefinition {
  id: string;
  keys: ShortcutKeyToken[];
  description: string;
  context?: string;
  featured?: boolean;
}

interface ShortcutGroupDefinition {
  title: string;
  shortcuts: ShortcutDefinition[];
}

export interface Shortcut {
  id: string;
  keys: string[];
  description: string;
  context?: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const SHORTCUT_GROUP_DEFINITIONS: ShortcutGroupDefinition[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { id: 'next-finding', keys: ['alt', 'n'], description: 'Jump to next finding by severity', featured: true },
      { id: 'next-task', keys: ['alt', 'j'], description: 'Next task (findings + healthy)', featured: true },
      { id: 'previous-task', keys: ['alt', 'k'], description: 'Previous task', featured: true },
      { id: 'deselect-task', keys: ['esc'], description: 'Deselect current task', context: 'when no dialog is open' },
    ],
  },
  {
    title: 'Responding to findings',
    shortcuts: [
      { id: 'send-response', keys: ['enter'], description: 'Send response and move to next finding' },
      { id: 'quick-action', keys: ['1'], description: 'Trigger quick action by number', context: 'when response input is empty' },
      { id: 'voice-input', keys: ['alt', 'm'], description: 'Toggle voice input (speech-to-text)', context: 'when STT is enabled' },
    ],
  },
  {
    title: 'Task management',
    shortcuts: [
      { id: 'quick-launch', keys: ['alt', 'l'], description: 'Open quick launch bar to create a new task', featured: true },
      { id: 'snooze-task', keys: ['alt', 's'], description: 'Snooze selected task (opens duration picker)', featured: true },
      { id: 'quick-snooze', keys: ['alt', 'z'], description: 'Quick snooze selected task (5 minutes)' },
      { id: 'complete-task', keys: ['alt', 'end'], description: 'Complete selected task (with confirmation)' },
      { id: 'cancel-task', keys: ['alt', 'del'], description: 'Cancel selected task (with confirmation)' },
    ],
  },
  {
    title: 'Terminal',
    shortcuts: [
      { id: 'terminal-number', keys: ['alt', '1-3'], description: 'Send number to terminal and skip to next task' },
      { id: 'terminal-focus', keys: ['alt', 't'], description: 'Toggle terminal focus mode', featured: true },
    ],
  },
  {
    title: 'Projects and panels',
    shortcuts: [
      { id: 'all-projects', keys: ['alt', '0'], description: 'Show all projects' },
      { id: 'select-project', keys: ['alt', '4-9'], description: 'Select project by sidebar order' },
      { id: 'project-sidebar', keys: ['alt', 'p'], description: 'Toggle project sidebar', featured: true },
      { id: 'focus-reply', keys: ['alt', 'r'], description: 'Focus reply input for current finding' },
      { id: 'achievements', keys: ['alt', 'a'], description: 'Toggle achievements panel' },
    ],
  },
  {
    title: 'Help',
    shortcuts: [
      { id: 'help', keys: ['?'], description: 'Open the full shortcuts overlay', featured: true },
      { id: 'close-dialog', keys: ['esc'], description: 'Close current dialog or cancel editing' },
      { id: 'confirm-dialog', keys: ['enter'], description: 'Confirm / submit in dialogs and inline edits' },
    ],
  },
];

export function detectShortcutPlatform(nav: Pick<Navigator, 'platform' | 'userAgent'> | undefined = globalThis.navigator): ShortcutPlatform {
  const platform = nav?.platform?.toLowerCase() ?? '';
  const userAgent = nav?.userAgent?.toLowerCase() ?? '';
  const value = `${platform} ${userAgent}`;

  if (value.includes('mac')) return 'darwin';
  if (value.includes('linux')) return value.includes('microsoft') || value.includes('wsl') ? 'wsl2' : 'linux';
  return 'unknown';
}

export function getShortcutGroups(platform: ShortcutPlatform = detectShortcutPlatform()): ShortcutGroup[] {
  return SHORTCUT_GROUP_DEFINITIONS.map((group) => ({
    title: group.title,
    shortcuts: group.shortcuts.map((shortcut) => formatShortcut(shortcut, platform)),
  }));
}

export function getFeaturedShortcuts(platform: ShortcutPlatform = detectShortcutPlatform()): Shortcut[] {
  return SHORTCUT_GROUP_DEFINITIONS.flatMap((group) => group.shortcuts)
    .filter((shortcut) => shortcut.featured)
    .map((shortcut) => formatShortcut(shortcut, platform));
}

export function getPhysicalShortcutKey(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
  if (event.code.startsWith('Key') && event.code.length === 4) {
    return event.code.slice(3).toLowerCase();
  }
  if (event.code.startsWith('Digit') && event.code.length === 6) {
    return event.code.slice(5);
  }
  if (event.code === 'Delete') return 'Delete';
  if (event.code === 'End') return 'End';
  return event.key;
}

function formatShortcut(shortcut: ShortcutDefinition, platform: ShortcutPlatform): Shortcut {
  return {
    id: shortcut.id,
    keys: shortcut.keys.map((key) => formatKey(key, platform)),
    description: shortcut.description,
    ...(shortcut.context ? { context: shortcut.context } : {}),
  };
}

function formatKey(key: ShortcutKeyToken, platform: ShortcutPlatform): string {
  switch (key) {
    case 'alt':
      return platform === 'darwin' ? 'Option' : 'Alt';
    case 'del':
      return platform === 'darwin' ? 'Delete' : 'Del';
    case 'esc':
      return 'Esc';
    case 'enter':
      return 'Enter';
    case 'end':
      return 'End';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}
