import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  looksLikeInteractiveMenu,
  looksLikeVisibleComposerDraft,
  terminalContentTail,
} from './terminal-input-draft.js';

// Screens captured from Claude Code v2.1.321 in a 120x50 pane, early in a
// session: the output has not filled the screen yet, so every one of them ends
// well above the bottom row. A hand-built row list hides that, which is why
// these go through a real xterm buffer.
const RULE = '─'.repeat(120);
const PROMPT_ECHO = [
  '❯ Ask me which stack to use and whether to proceed. Do not do anything else',
  '  first.',
];

const SCREENS = {
  trustDialog: [
    RULE,
    ' Accessing workspace:',
    '',
    ' /home/dev/project', // portability-ok: captured-screen fixture; generic placeholder path
    '',
    ' Quick safety check: Is this a project you created or one you trust?',
    '',
    ' Security guide',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ],
  singleQuestion: [
    ...PROMPT_ECHO,
    RULE,
    ' ☐ Color',
    '',
    'Which color do you prefer?',
    '',
    '❯ 1. Red (warm)',
    '     A warm, energetic color.',
    '  2. Green (calm)',
    '     A calm, natural color.',
    '  3. Blue (cool)',
    '     A cool, steady color.',
    '  4. Type something.',
    RULE,
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ],
  // Taller than the tail window: the marked row scrolls out of it, so only the
  // footer identifies the menu.
  firstOfTwoQuestions: [
    ...PROMPT_ECHO,
    RULE,
    '←  ☐ Stack  ☐ Proceed  ✔ Submit  →',
    '',
    'Which stack should we use?',
    '',
    '❯ 1. Postgres plus Prisma',
    '     A mature relational database with a type-safe ORM and migration tooling.',
    '     Requires running a Postgres server.',
    '  2. SQLite plus Drizzle',
    '     An embedded, file-based relational database with a lightweight query builder.',
    '     Best for single-node or small-scale apps.',
    '  3. MongoDB plus Mongoose',
    '     A document database with flexible schemas, accessed through an ODM.',
    '     Less natural for heavily relational queries.',
    '  4. DynamoDB plus custom client',
    '     A fully managed AWS key-value and document store.',
    '     Best inside an AWS-centric setup.',
    '  5. Type something.',
    RULE,
    '  6. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ],
  // The review step has no footer hint: the marked row is the only signal.
  reviewAnswers: [
    ...PROMPT_ECHO,
    '',
    RULE,
    '←  ☒ Stack  ☒ Proceed  ✔ Submit  →',
    '',
    'Review your answers',
    '',
    ' ● Which stack should we use?',
    '   → Postgres plus Prisma',
    ' ● Proceed now?',
    '   → Yes',
    '',
    'Ready to submit your answers?',
    '',
    '❯ 1. Submit answers',
    '  2. Cancel',
  ],
  idleComposer: [
    ...PROMPT_ECHO,
    '',
    "● User answered Claude's questions:",
    '  ⎿  · Which stack should we use? → Postgres plus Prisma',
    '     · Proceed now? → Yes',
    '',
    '● You picked Postgres plus Prisma. What should I build with it?',
    '',
    '✻ Churned for 8s',
    '',
    RULE,
    '❯ ',
    RULE,
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ],
} as const;

const SCREEN_ROWS = 50;

async function tailOf(rows: readonly string[], scrollbackRows = 0): Promise<string> {
  const terminal = new Terminal({ cols: 120, rows: SCREEN_ROWS, scrollback: 1000 });
  try {
    const history = Array.from({ length: scrollbackRows }, (_, i) => `earlier output ${i}\r\n`).join('');
    // Clearing the screen mirrors how the agent repaints: old rows stay in
    // scrollback, the live screen starts empty.
    const repaint = scrollbackRows > 0 ? '\x1b[2J\x1b[H' : '';
    await new Promise<void>((resolve) => {
      terminal.write(history + repaint + rows.join('\r\n'), resolve);
    });
    const buffer = terminal.buffer.active;
    return terminalContentTail(
      buffer.length,
      terminal.rows,
      (index) => buffer.getLine(index)?.translateToString(true) ?? '',
    );
  } finally {
    terminal.dispose();
  }
}

describe('menu detection on a screen the session has not filled yet', () => {
  it.each([
    ['folder trust dialog', SCREENS.trustDialog],
    ['single question', SCREENS.singleQuestion],
    ['first of two questions', SCREENS.firstOfTwoQuestions],
    ['answer review step', SCREENS.reviewAnswers],
  ] as const)('recognizes the %s as a menu', async (_name, rows) => {
    expect(rows.length).toBeLessThan(SCREEN_ROWS - 15);
    expect(looksLikeInteractiveMenu(await tailOf(rows))).toBe(true);
  });

  it('still recognizes a menu when earlier output sits in scrollback', async () => {
    expect(looksLikeInteractiveMenu(await tailOf(SCREENS.reviewAnswers, 200))).toBe(true);
  });

  it('reads the idle composer as empty, so Enter still advances', async () => {
    const tail = await tailOf(SCREENS.idleComposer);
    expect(looksLikeInteractiveMenu(tail)).toBe(false);
    expect(looksLikeVisibleComposerDraft(tail)).toBe(false);
  });
});
