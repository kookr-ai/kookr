import { describe, expect, test } from 'vitest';
import { buildShareInvite } from './TaskShareModal.js';

const PASSWORD = 'correct-horse-battery-staple';

describe('buildShareInvite', () => {
  test('bundles the task label, url, and expiry into one message', () => {
    const message = buildShareInvite(
      'Fix the login bug',
      'https://relay.example/relay/join/123#password=secret',
      '08:30',
    );
    expect(message).toContain('Fix the login bug');
    expect(message).toContain('https://relay.example/relay/join/123#password=secret');
    expect(message).toContain('expires 08:30');
    // A single pasteable line, not multiple stitched fragments.
    expect(message).not.toContain('\n');
  });

  test('never embeds the password by default', () => {
    // The builder has no password parameter at all, so a secret cannot leak
    // into whatever channel the message is pasted to — even when the caller
    // has the password in scope.
    const message = buildShareInvite(
      'Deploy release',
      `https://relay.example/relay/join/abc#password=${PASSWORD}`,
      '7 days',
    );
    // The URL fragment is expected; assert the bare password string is not
    // otherwise appended as its own field.
    const withoutUrl = message.replace(`https://relay.example/relay/join/abc#password=${PASSWORD}`, '');
    expect(withoutUrl).not.toContain(PASSWORD);
  });

  test('falls back to a neutral label when the task label is blank', () => {
    const message = buildShareInvite('   ', 'https://relay.example/j', '1 hour');
    expect(message).toContain('working on a task');
    expect(message).not.toContain('working on    ');
  });

  test('keeps the message on one line even when the label spans lines', () => {
    // Task titles are not guaranteed single-line; a newline in the label must
    // not split the invite into stitched fragments.
    const message = buildShareInvite('Fix login\nand signup', 'https://relay.example/j', '1 hour');
    expect(message).not.toContain('\n');
    expect(message).toContain('working on Fix login and signup —');
  });
});
