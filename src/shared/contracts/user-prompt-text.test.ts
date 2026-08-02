import { describe, expect, test } from 'vitest';
import { unwrapProviderUserPrompt } from './user-prompt-text.js';

describe('unwrapProviderUserPrompt', () => {
  test('returns plain prompts unchanged (minus trailing newline normalize)', () => {
    expect(unwrapProviderUserPrompt('Fix the bug')).toBe('Fix the bug');
    expect(unwrapProviderUserPrompt('line one\nline two\n')).toBe('line one\nline two');
  });

  test('strips a Grok <user_query> envelope so activity does not show the tags', () => {
    const raw = '<user_query>\nmerge it\n</user_query>';
    expect(unwrapProviderUserPrompt(raw)).toBe('merge it');
  });

  test('strips the open tag when the close is missing (truncated payload)', () => {
    const raw = '<user_query>\npartial prompt that was truncated';
    expect(unwrapProviderUserPrompt(raw)).toBe('partial prompt that was truncated');
  });

  test('drops trailing <system-reminder> scaffolding after the user query', () => {
    const raw = [
      '<user_query>',
      'Implement the fix',
      '</user_query>',
      '',
      '<system-reminder>',
      'Below are some potentially helpful/relevant pieces of information',
      '<attached_files>',
      '<file_contents path="/tmp/foo.json" isFullFile="true">',
      '1→{"ok":true}',
      '</file_contents>',
      '</attached_files>',
      '</system-reminder>',
    ].join('\n');
    expect(unwrapProviderUserPrompt(raw)).toBe('Implement the fix');
  });

  test('drops pure <system-reminder> bodies (not user-typed)', () => {
    const raw = [
      '<system-reminder>',
      'Background task "call-1" completed (exit code: 0).',
      'Command: rg pattern',
      '</system-reminder>',
    ].join('\n');
    expect(unwrapProviderUserPrompt(raw)).toBeNull();
  });

  test('drops pure <task-notification> bodies (synthetic subagent re-entry)', () => {
    const raw =
      '<task-notification>\n<task-id>abc</task-id>\n<summary>done</summary>\n</task-notification>';
    expect(unwrapProviderUserPrompt(raw)).toBeNull();
  });

  test('does not strip a mid-body mention of the tag string as documentation', () => {
    const plain = 'Please strip <user_query> tags from the activity panel.';
    expect(unwrapProviderUserPrompt(plain)).toBe(plain);
  });

  test('preserves multiline user content inside the envelope', () => {
    const body = 'Line one\n\n## Heading\n- bullet';
    const raw = `<user_query>\n${body}\n</user_query>`;
    expect(unwrapProviderUserPrompt(raw)).toBe(body);
  });

  test('keeps plain empty prompts as empty string (signal-only hooks still flow)', () => {
    expect(unwrapProviderUserPrompt('')).toBe('');
    expect(unwrapProviderUserPrompt('   \n  ')).toBe('');
  });

  test('returns null for empty body inside a user_query envelope', () => {
    expect(unwrapProviderUserPrompt('<user_query>\n\n</user_query>')).toBeNull();
  });
});
