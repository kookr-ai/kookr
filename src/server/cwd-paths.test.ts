import { describe, it, expect } from 'vitest';
import { expandConfiguredCwd } from './cwd-paths.js';

const HOME = '/home/testuser';
const envWithHome = { HOME } as NodeJS.ProcessEnv;
const envWithoutHome = {} as NodeJS.ProcessEnv;

describe('expandConfiguredCwd', () => {
  it.each([
    ['~', HOME],
    ['$HOME', HOME],
    ['${HOME}', HOME],
    ['~/projects/kookr', `${HOME}/projects/kookr`],
    ['$HOME/projects/kookr', `${HOME}/projects/kookr`],
    ['${HOME}/projects/kookr', `${HOME}/projects/kookr`],
  ] as const)('expands %s to home-rooted path', (input, expected) => {
    expect(expandConfiguredCwd(input, envWithHome)).toBe(expected);
  });

  it.each([
    ['/absolute/path'],
    ['relative/path'],
    ['.'],
    ['~not-a-home'],
    ['$HOMEWARD'],
    ['${HOMEWARD}'],
    ['$HOMEextra'],
    ['prefix$HOME'],
  ] as const)('leaves non-home form %s unchanged', (input) => {
    expect(expandConfiguredCwd(input, envWithHome)).toBe(input);
  });

  it.each([
    ['~'],
    ['$HOME'],
    ['${HOME}'],
    ['~/x'],
    ['$HOME/x'],
    ['${HOME}/x'],
    ['/absolute'],
    ['relative'],
  ] as const)('returns input unchanged when HOME is missing: %s', (input) => {
    expect(expandConfiguredCwd(input, envWithoutHome)).toBe(input);
  });

  it('defaults to process.env when env is omitted', () => {
    // Smoke check only — do not assert a specific HOME value.
    const result = expandConfiguredCwd('/tmp/fixed');
    expect(result).toBe('/tmp/fixed');
  });
});
