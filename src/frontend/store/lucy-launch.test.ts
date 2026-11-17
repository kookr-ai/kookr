import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LucyLaunchProposalView } from '../../shared/contracts/lucy-launch.js';

vi.mock('../audio/ask-announcement.js', () => ({ announceLaunchReport: vi.fn(async () => 'started') }));

import { __resetLucyConversationForTests, getConversationEntries } from './lucy-conversation.js';
import {
  __resetLucyLaunchForTests,
  confirmLucyLaunch,
  expireLucyProposal,
  getLucyLaunchSnapshot,
  handleLucyLaunch,
} from './lucy-launch.js';

const card: LucyLaunchProposalView = {
  id: 'L1', kind: 'investigation', project: 'kookr', description: 'Look into it.', agentType: 'claude-code',
  asked: 'look into it', readBack: 'I will launch an investigation.', expiresAt: 2_000_000, level: 'balanced',
};
const thread = () => getConversationEntries().map((entry) => [entry.id, entry.text, 'started' in entry ? entry.started : null, 'taskId' in entry ? entry.taskId ?? null : null]);
const launched = { outcome: 'launched', proposalId: 'L1', project: 'kookr', taskId: 't9' } as const;

beforeEach(() => {
  __resetLucyLaunchForTests();
  __resetLucyConversationForTests();
});

describe('the launch card store, expiry against the server outcome', () => {
  test('an expiry that fires while Go is in flight does nothing; the server answer then closes the card', async () => {
    handleLucyLaunch({ type: 'lucy_launch', conversationId: 'c1', proposal: card });
    let answer: (response: Response) => void = () => undefined;
    const press = confirmLucyLaunch('click', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch);
    expect(getLucyLaunchSnapshot().sending).toBe(true);
    expireLucyProposal('L1');
    expect(getLucyLaunchSnapshot()).toMatchObject({ proposal: card, sending: true });
    expect(thread()).toEqual([]);
    answer(new Response(JSON.stringify(launched), { status: 200 }));
    await press;
    expect(thread()).toEqual([['launch-L1', 'Started kookr task', true, 't9']]);
  });

  test('a press that fails after the card is due ends it as timed out', async () => {
    handleLucyLaunch({ type: 'lucy_launch', conversationId: 'c1', proposal: { ...card, expiresAt: Date.now() - 1 } });
    await confirmLucyLaunch('click', vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(getLucyLaunchSnapshot().proposal).toBeNull();
    expect(thread()).toEqual([['launch-L1', 'Timed out', false, null]]);
  });

  test('the server outcome for a card this tab already timed out replaces the local timed out line', () => {
    handleLucyLaunch({ type: 'lucy_launch', conversationId: 'c1', proposal: card });
    expireLucyProposal('L1');
    expect(thread()).toEqual([['launch-L1', 'Timed out', false, null]]);
    handleLucyLaunch({ type: 'lucy_launch', conversationId: 'c1', outcome: launched });
    expect(thread()).toEqual([['launch-L1', 'Started kookr task', true, 't9']]);
    handleLucyLaunch({ type: 'lucy_launch', conversationId: 'c1', outcome: launched });
    expect(thread()).toHaveLength(1);
  });

  test('the server saying expired for a card this tab timed out keeps the one line', () => {
    handleLucyLaunch({ type: 'lucy_launch', conversationId: 'c1', proposal: card });
    expireLucyProposal('L1');
    handleLucyLaunch({ type: 'lucy_launch', conversationId: 'c1', outcome: { outcome: 'expired', proposalId: 'L1' } });
    expect(thread()).toEqual([['launch-L1', 'Timed out', false, null]]);
  });
});
