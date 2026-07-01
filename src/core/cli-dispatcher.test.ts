import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HELP_TEXT } from '../../bin/kookr.js';

const HELP_COMMANDS = new Set(['-h', '--help', 'help']);

function extractCliDispatcherCommands(source: string): string[] {
  const commands = new Set<string>();

  for (const match of source.matchAll(/if\s*\(([^)]*command[^)]*)\)\s*\{/g)) {
    const condition = match[1];
    const commandMatches = [...condition.matchAll(/command\s*===\s*'([^']+)'/g)].map((item) => item[1]);
    const firstRestArg = condition.match(/rest\[0\]\s*===\s*'([^']+)'/)?.[1];

    for (const command of commandMatches) {
      if (HELP_COMMANDS.has(command)) continue;
      commands.add(command === 'command' && firstRestArg ? `${command} ${firstRestArg}` : command);
    }
  }

  return [...commands].sort();
}

function extractCliHelpCommands(helpText: string): string[] {
  const commands = new Set<string>();

  for (const match of helpText.matchAll(/^\s+kookr\s+([a-z|-]+)(?:\s+([a-z][a-z-]*))?/gm)) {
    for (const command of match[1].split('|')) {
      if (command === '') continue;
      if (command === 'command' && match[2]) {
        commands.add(`${command} ${match[2]}`);
        continue;
      }
      commands.add(command);
    }
  }

  return [...commands].sort();
}

describe('CLI dispatcher help coverage', () => {
  it('parses routed root commands and command subcommands from dispatcher source', () => {
    const source = [
      "if (command === '-h' || command === '--help' || command === 'help') {}",
      "if (command === 'spawn') {}",
      "if (command === 'command' && rest[0] === 'outcome') {}",
      "if (command === 'drain' || command === 'resume') {}",
    ].join('\n');

    expect(extractCliDispatcherCommands(source)).toEqual([
      'command outcome',
      'drain',
      'resume',
      'spawn',
    ]);
  });

  it('parses command subcommand forms from root help', () => {
    expect(extractCliHelpCommands('  kookr command outcome [commandId]  Print outcomes.\n')).toEqual([
      'command outcome',
    ]);
  });

  it('keeps root help commands in sync with public dispatcher routes', () => {
    const dispatcherSource = readFileSync(join(process.cwd(), 'bin', 'kookr.js'), 'utf8');
    const routedCommands = extractCliDispatcherCommands(dispatcherSource);
    const documentedCommands = extractCliHelpCommands(HELP_TEXT);

    expect(documentedCommands).toEqual(routedCommands);
  });
});
