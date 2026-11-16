import { describe, expect, it } from 'vitest';
import { matchOpenRequest, openableVoiceAsks, sayOpenOutcome, OPEN_LINK_BLOCKED, OPEN_LINK_OPENED, OPEN_NO_REPLY, OPEN_TASK_OPENED, OPEN_TASK_UNAVAILABLE } from './open-intent.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';

describe('matchOpenRequest', () => {
  it.each([
    'show me', 'Show me.', 'open it', 'Open that!', 'show it', 'okay Lucy, show me please', 'can you open it for me',
    'montre-moi', 'ouvre-le',
  ])('"%s" asks to open whatever the question points at', (words) => {
    expect(matchOpenRequest(words)).toEqual({ target: 'any' });
  });

  it.each(['show me the task', 'open the task', 'Open the task, please', 'montre-moi la tâche', 'show me the asking task'])(
    '"%s" asks for the task',
    (words) => expect(matchOpenRequest(words)).toEqual({ target: 'task' }),
  );

  it.each(['show me the artifact', 'show me the mockups', 'open the link', 'open the write-up', 'show me the mock-ups', 'ouvre le lien', 'montre-moi la maquette'])(
    '"%s" asks for the link',
    (words) => expect(matchOpenRequest(words)).toEqual({ target: 'link' }),
  );

  it('picks the link whose label the operator named', () => {
    const labels = ['Open mockups', 'Open the comparison table'];
    expect(matchOpenRequest('show me the comparison table', labels)).toEqual({ target: 'link', index: 1 });
    expect(matchOpenRequest('open the mockups', labels)).toEqual({ target: 'link', index: 0 });
    expect(matchOpenRequest('open the mockups link', labels)).toEqual({ target: 'link', index: 0 });
  });

  it.each([
    'show me the status of the build', 'what does the task do', 'can you show me what failed', 'open a new task to fix the login',
    'I can show you the task that asked instead, if you want.', 'It is open in a new tab.', 'Here is the task that asked.',
    'show me the second link', 'yes', '',
  ])('"%s" is not a request to open the question\'s link or task', (words) => {
    expect(matchOpenRequest(words, ['Open mockups'])).toBeNull();
  });
});

describe('openableVoiceAsks', () => {
  const view = (over: Partial<OperatorAskView>): OperatorAskView => ({
    id: 'a', taskId: 't', question: 'Q?', options: ['x', 'y'], allowText: true, state: 'pending', createdAt: 1, expiresAt: 2, ...over,
  });
  it('keeps waiting questions in the order given (newest first), with their links', () => {
    const asks = [
      view({ id: 'new', taskId: 't2', links: [{ url: 'https://a.example', label: 'Open mockups' }] }),
      view({ id: 'closed', state: 'answered' }),
      view({ id: 'old', taskId: 't1' }),
    ];
    expect(openableVoiceAsks(asks)).toEqual([
      { askId: 'new', taskId: 't2', links: [{ url: 'https://a.example', label: 'Open mockups' }] },
      { askId: 'old', taskId: 't1', links: [] },
    ]);
  });
});

describe('sayOpenOutcome', () => {
  it('says what the browser did, never claiming a blocked tab opened', () => {
    expect(sayOpenOutcome('link', 'opened')).toBe(OPEN_LINK_OPENED);
    expect(sayOpenOutcome('link', 'blocked')).toBe(OPEN_LINK_BLOCKED);
    expect(sayOpenOutcome('link', undefined)).toBe(OPEN_NO_REPLY);
    expect(sayOpenOutcome('task', 'opened')).toBe(OPEN_TASK_OPENED);
    expect(sayOpenOutcome('task', 'unavailable')).toBe(OPEN_TASK_UNAVAILABLE);
    expect(sayOpenOutcome('task', undefined)).toBe(OPEN_NO_REPLY);
  });
});
