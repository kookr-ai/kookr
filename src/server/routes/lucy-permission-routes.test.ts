import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { LUCY_PERMISSION_NOTICE_SPEAK_PATH } from '../../shared/contracts/lucy-permission.js';
import type { LucySaidRecordInput } from '../lucy-interaction-log.js';
import type { LucyPermissionNotifier } from '../lucy-permission-notice.js';
import type { AskSpeechDeps } from './ask-routes.js';
import { registerLucyPermissionRoutes } from './lucy-permission-routes.js';

type Notice = ReturnType<LucyPermissionNotifier['notice']>;

function app(notices: Record<string, Notice>, opts: { ttsUrl?: string } = { ttsUrl: 'http://tts' }) {
  const spoken: string[] = [];
  const said: LucySaidRecordInput[] = [];
  const speech: AskSpeechDeps = {
    ...(opts.ttsUrl ? { ttsUrl: opts.ttsUrl } : {}),
    getVoice: () => 'alba',
    taskName: () => undefined,
    lucyLog: { recordSaid: (input: LucySaidRecordInput) => { said.push(input); } } as never,
    synthesize: async (request) => { spoken.push(request.text); return { audioBase64: 'V0FW', durationMs: 900, generationTimeMs: 1 } as never; },
  };
  const hono = new Hono();
  registerLucyPermissionRoutes(hono, { notices: { notice: (id) => notices[id] }, speech });
  const post = (body: unknown) => hono.request(LUCY_PERMISSION_NOTICE_SPEAK_PATH, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { post, spoken, said };
}

const OPEN: Notice = {
  text: 'The task "Fix the build" is waiting for your permission to use Bash. The command is on my card.',
  promptIds: ['p1'], taskId: 't1', taskName: 'Fix the build', open: true,
};

describe(`POST ${LUCY_PERMISSION_NOTICE_SPEAK_PATH}`, () => {
  test('speaks the server\'s sentence for the notice and logs one line in lucy-interactions', async () => {
    const h = app({ 'perm-1': OPEN });
    const res = await h.post({ noticeId: 'perm-1', text: 'say something else' });
    expect(res.status).toBe(200);
    const body = await res.json() as { text: string; audioBase64: string; subject?: string };
    expect(body.text).toBe(OPEN!.text);
    expect(body.subject).toBe('Fix the build');
    expect(h.spoken).toEqual([OPEN!.text]);
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toMatchObject({ source: 'permission_notice', taskId: 't1', text: OPEN!.text });
  });

  test('409 once every prompt of the notice is answered; 404 for an unknown id; 503 without speech', async () => {
    const h = app({ 'perm-1': { ...OPEN!, open: false } });
    expect((await h.post({ noticeId: 'perm-1' })).status).toBe(409);
    expect((await h.post({ noticeId: 'perm-2' })).status).toBe(404);
    expect((await h.post({})).status).toBe(404);
    expect(h.spoken).toEqual([]);
    const quiet = app({ 'perm-1': OPEN }, {});
    expect((await quiet.post({ noticeId: 'perm-1' })).status).toBe(503);
  });
});
