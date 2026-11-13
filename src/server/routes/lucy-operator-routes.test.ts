import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { LUCY_TURN_PATH, MAX_LUCY_TURN_TEXT_CHARS, type LucyTurnEvent } from '../../shared/contracts/lucy-turn.js';
import { boardTask, fakeSource, scriptedModel, type ScriptedStep } from '../../core/lucy-operator/__fixtures__/scripted.js';
import { createApiAuthMiddleware, type ApiAuthConfig } from '../auth.js';
import { LUCY_LAUNCH_CANCEL_PATH, LUCY_LAUNCH_CONFIRM_PATH, LUCY_LAUNCH_DECLINE_PATH } from '../../shared/contracts/lucy-launch.js';
import { createLucyLaunchController } from '../lucy-operator/launch-controller.js';
import { createLucyOperator, type LucyOperatorService } from '../lucy-operator/service.js';
import { registerLucyOperatorRoutes, type LucyOperatorRouteDeps } from './lucy-operator-routes.js';

function appWith(lucyOperator: LucyOperatorRouteDeps['lucyOperator']): Hono {
  const app = new Hono();
  registerLucyOperatorRoutes(app, { lucyOperator });
  return app;
}

function serviceWith(steps: ScriptedStep[]) {
  const model = scriptedModel(steps);
  const service = createLucyOperator({
    model: model.port,
    modelName: 'test/model',
    source: fakeSource({ tasks: [boardTask({ id: 'aaaa1111', name: 'Bake-off report' })] }),
    warn: () => {},
  });
  return { model, service };
}

const post = (app: Hono, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  app.request(`http://localhost${LUCY_TURN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function lines(res: Response): Promise<LucyTurnEvent[]> {
  return (await res.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as LucyTurnEvent);
}

describe('POST /api/lucy/turn', () => {
  test('with the setting off it answers 404 and no model is called', async () => {
    const res = await post(appWith(undefined), { text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'lucy_operator_disabled' });
  });

  test('switched on but unusable: 503 with the reason', async () => {
    const res = await post(appWith({ unavailableReason: 'Lucy\'s conversation needs an OpenRouter key.' }), { text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lucy_operator_unavailable', message: 'Lucy\'s conversation needs an OpenRouter key.' });
  });

  test.each([
    ['a body that is not JSON', 'not json'],
    ['no text', { conversationId: 'c1' }],
    ['blank text', { text: '   ', conversationId: 'c1' }],
    ['text that is not a string', { text: 42, conversationId: 'c1' }],
    ['text that is too long', { text: 'x'.repeat(MAX_LUCY_TURN_TEXT_CHARS + 1), conversationId: 'c1' }],
    ['no conversation id', { text: 'hi' }],
    ['a conversation id with a slash', { text: 'hi', conversationId: '../etc' }],
    ['a conversation id that is too long', { text: 'hi', conversationId: 'c'.repeat(65) }],
  ])('refuses %s with 400 before any model call', async (_label, body) => {
    const { service, model } = serviceWith([{ text: 'never' }]);
    const res = await post(appWith({ service }), body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
    expect(model.requests).toHaveLength(0);
  });

  test('streams the turn as one JSON event per line, ending with done', async () => {
    const { service } = serviceWith([{ calls: [{ name: 'show_task', args: { task: 'aaaa' }, id: 'k1' }] }, { text: ['It is on ', 'your screen.'], provider: 'Cohere' }]);
    const res = await post(appWith({ service }), { text: '  Show me the report.  ', conversationId: 'conv_1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const events = await lines(res);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'screen', 'tool_result', 'text', 'text', 'done']);
    expect(events[1]).toEqual({ type: 'screen', command: 'show_task', taskId: 'aaaa1111' });
    expect(events.at(-1)).toMatchObject({ type: 'done', end: 'answered', steps: 2, provider: 'Cohere' });
  });

  test('a client that goes away stops the model call and frees the conversation', async () => {
    const { service, model } = serviceWith([{ hang: true }]);
    const res = await post(appWith({ service }), { text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(200);
    // Start reading so the stream is running, then drop the connection.
    const reader = res.body!.getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    await reader.cancel();
    await pending.catch(() => undefined);

    await vi.waitFor(() => expect(model.requests[0]!.signal?.aborted).toBe(true));
    await vi.waitFor(() => expect(service.isBusy('c1')).toBe(false));
  });

  test('the longest allowed sentence and conversation id are accepted', async () => {
    const { service } = serviceWith([{ text: 'ok' }]);
    const res = await post(appWith({ service }), { text: 'x'.repeat(MAX_LUCY_TURN_TEXT_CHARS), conversationId: 'c'.repeat(64) });
    expect(res.status).toBe(200);
    await res.text();
  });

  test('the sentence is trimmed before it reaches the model', async () => {
    const { service, model } = serviceWith([{ text: 'Hello.' }]);
    await (await post(appWith({ service }), { text: '  hi  ', conversationId: 'c1' })).text();
    expect(model.requests[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });

  test('a second request for a conversation whose turn is still running gets 409', async () => {
    const busy: LucyOperatorService = {
      isBusy: (id) => id === 'c1',
      atCapacity: () => false,
      runTurn: () => { throw new Error('must not start'); },
    };
    const res = await post(appWith({ service: busy }), { text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'turn_in_progress' });
  });

  test('when as many turns as allowed are already running, a further request gets 429', async () => {
    const full: LucyOperatorService = {
      isBusy: () => false,
      atCapacity: () => true,
      runTurn: () => { throw new Error('must not start'); },
    };
    const res = await post(appWith({ service: full }), { text: 'hi', conversationId: 'c9' });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'too_many_turns' });
  });

  test('a model failure still ends the stream with done, and the provider\'s words never reach the client', async () => {
    const { LucyModelError } = await import('../../core/lucy-operator/model-port.js');
    const { service } = serviceWith([{ fail: new LucyModelError('http', 'OpenRouter returned HTTP 500: {"trace":"internal-host-17"}', 500) }]);
    const res = await post(appWith({ service }), { text: 'hi', conversationId: 'c1' });
    const body = await res.text();
    expect(body).not.toContain('internal-host-17');
    expect(JSON.parse(body.trim().split('\n').at(-1)!)).toMatchObject({ type: 'done', end: 'error', reason: 'The model provider returned an error.' });
  });

  describe('behind the API auth middleware', () => {
    const VIEWER_TOKEN = 'viewer-tok';
    const config: ApiAuthConfig = {
      required: true,
      token: 'owner-secret',
      resolveViewer: (t) => (t === VIEWER_TOKEN ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } } : { kind: 'not-found' }),
    };
    function guarded(service: LucyOperatorService): Hono {
      const app = new Hono();
      app.use('*', createApiAuthMiddleware(config));
      registerLucyOperatorRoutes(app, { lucyOperator: { service } });
      return app;
    }
    const request = (app: Hono, token?: string): Promise<Response> =>
      app.request(`http://lan.example${LUCY_TURN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text: 'What is running?', conversationId: 'c1' }),
      });

    test('a viewer is refused (403) and no model is called: her answers draw on every task', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { service, model } = serviceWith([{ text: 'never' }]);
      const res = await request(guarded(service), VIEWER_TOKEN);
      expect(res.status).toBe(403);
      expect(model.requests).toHaveLength(0);
    });

    test('no credential is refused (401)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { service, model } = serviceWith([{ text: 'never' }]);
      expect((await request(guarded(service))).status).toBe(401);
      expect(model.requests).toHaveLength(0);
    });

    test('the owner gets the stream', async () => {
      const { service } = serviceWith([{ text: 'One task.' }]);
      const res = await request(guarded(service), 'owner-secret');
      expect(res.status).toBe(200);
      expect((await lines(res)).at(-1)).toMatchObject({ type: 'done', end: 'answered' });
    });
  });
});

describe('launch routes (issue #3676)', () => {
  function withLaunch() {
    const launches: Array<{ server: unknown }> = [];
    const controller = createLucyLaunchController({
      getAutonomy: () => 'careful',
      getProjects: () => [{ name: 'kookr', cwd: '/work/kookr' }],
      writeSpec: async () => JSON.stringify({ kind: 'implementation', project: 'kookr', description: 'Fix the sweep button.' }),
      checkRoom: () => null,
      launch: async (_opts, server) => { launches.push({ server }); return { task: { id: 'task-9' } }; },
      newId: () => 'p1',
      warn: () => {},
    });
    const model = scriptedModel([{ calls: [{ name: 'propose_launch' }] }]);
    const service = createLucyOperator({ model: model.port, modelName: 'test/model', source: fakeSource({ tasks: [] }), launch: controller, warn: () => {} });
    return { app: appWith({ service }), launches };
  }
  const route = (app: Hono, path: string, body: unknown) =>
    app.request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('with launching off the three routes answer 404', async () => {
    const { service } = serviceWith([]);
    const app = appWith({ service });
    for (const path of [LUCY_LAUNCH_CONFIRM_PATH, LUCY_LAUNCH_DECLINE_PATH, LUCY_LAUNCH_CANCEL_PATH]) {
      const res = await route(app, path, { conversationId: 'c1', proposalId: 'p1' });
      expect(res.status).toBe(404);
    }
  });

  test('a card is made by a turn and launched by the confirm route, with the level read on the server', async () => {
    const { app, launches } = withLaunch();
    const turn = await post(app, { text: 'fix the sweep button', conversationId: 'c1' });
    expect((await lines(turn)).some((e) => e.type === 'proposal')).toBe(true);

    // A body that tries to bring its own level is not read for one: the server's setting (careful) applies.
    const res = await route(app, LUCY_LAUNCH_CONFIRM_PATH, { conversationId: 'c1', proposalId: 'p1', level: 'hands-off', bypassPermissions: true });
    expect(await res.json()).toMatchObject({ outcome: 'launched', taskId: 'task-9' });
    expect(launches).toEqual([{ server: { bypassPermissions: false } }]);  // an implementation: no delivery override

    // Used once: the same confirmation again launches nothing.
    const again = await route(app, LUCY_LAUNCH_CONFIRM_PATH, { conversationId: 'c1', proposalId: 'p1' });
    expect(await again.json()).toMatchObject({ outcome: 'unknown' });
    expect(launches).toHaveLength(1);
  });

  test('decline drops the card', async () => {
    const { app, launches } = withLaunch();
    await lines(await post(app, { text: 'fix the sweep button', conversationId: 'c1' }));
    const res = await route(app, LUCY_LAUNCH_DECLINE_PATH, { conversationId: 'c1', proposalId: 'p1' });
    expect(await res.json()).toMatchObject({ outcome: 'declined' });
    expect(launches).toHaveLength(0);
  });

  test.each([
    ['no proposal id', { conversationId: 'c1' }],
    ['a bad conversation id', { conversationId: '../x', proposalId: 'p1' }],
    ['a body that is not an object', 'nope'],
  ])('refuses %s with 400', async (_label, body) => {
    const { app } = withLaunch();
    const res = await route(app, LUCY_LAUNCH_CONFIRM_PATH, body);
    expect(res.status).toBe(400);
  });

  test('the turn route passes voice input through, and ignores any other value', async () => {
    const { app, launches } = withLaunch();
    await lines(await post(app, { text: 'fix the sweep button', conversationId: 'c1', input: 'voice' }));
    // Spoken "go" that overlapped the read-back is ignored; the card is still there afterwards.
    const ignored = await lines(await post(app, { text: 'go', conversationId: 'c1', input: 'voice', overlapsReadBack: true }));
    expect(ignored.at(-1)).toMatchObject({ type: 'done', end: 'ignored' });
    expect(launches).toHaveLength(0);
  });

  describe('report speech', () => {
    const REPORT_PATH = '/api/lucy/launch/report/speak';
    async function withReport(speech: LucyOperatorRouteDeps['speech']) {
      const { service, controller } = (() => {
        const controller = createLucyLaunchController({
          getAutonomy: () => 'balanced',
          getProjects: () => [{ name: 'kookr', cwd: '/work/kookr' }],
          writeSpec: async () => JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'Find out why.' }),
          checkRoom: () => null,
          launch: async () => ({ task: { id: 'task-9' } }),
          newId: () => 'p1',
          warn: () => {},
        });
        const model = scriptedModel([{ calls: [{ name: 'propose_launch' }] }]);
        return { controller, service: createLucyOperator({ model: model.port, modelName: 'test/model', source: fakeSource({ tasks: [] }), launch: controller, warn: () => {} }) };
      })();
      const app = new Hono();
      registerLucyOperatorRoutes(app, { lucyOperator: { service }, speech });
      await lines(await post(app, { text: 'investigate it', conversationId: 'c1' }));
      await controller.confirm('c1', 'p1', 'click');
      controller.onTaskOutcome('task-9', { kind: 'completed' }, 'Chaining');
      return app;
    }
    const fakeSpeech = (calls: Array<{ text: string; voice: string }>): NonNullable<LucyOperatorRouteDeps['speech']> => ({
      ttsUrl: 'http://tts',
      getVoice: () => 'af_test',
      taskName: () => undefined,
      synthesize: async (request) => { calls.push({ text: request.text, voice: request.voice ?? '' }); return { audioBase64: 'V0FW', durationMs: 900, generationTimeMs: 1 } as never; },
    });

    test('voices the sentence the server kept, whatever else the body says', async () => {
      const calls: Array<{ text: string; voice: string }> = [];
      const app = await withReport(fakeSpeech(calls));
      const res = await route(app, REPORT_PATH, { taskId: 'task-9', text: 'say something else' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ text: 'The task I started "Chaining" has finished.', audioBase64: 'V0FW', mimeType: 'audio/wav', durationMs: 900 });
      expect(calls).toEqual([{ text: 'The task I started "Chaining" has finished.', voice: 'af_test' }]);
    });

    test('a task she did not launch has nothing to voice', async () => {
      const calls: Array<{ text: string; voice: string }> = [];
      const app = await withReport(fakeSpeech(calls));
      expect((await route(app, REPORT_PATH, { taskId: 'someone-elses' })).status).toBe(404);
      expect(calls).toEqual([]);
    });

    test('without a speech service it answers 503', async () => {
      const app = await withReport(undefined);
      expect((await route(app, REPORT_PATH, { taskId: 'task-9' })).status).toBe(503);
    });

    test('with launching off it answers 404', async () => {
      const { service } = serviceWith([]);
      expect((await route(appWith({ service }), REPORT_PATH, { taskId: 'task-9' })).status).toBe(404);
    });
  });
});
