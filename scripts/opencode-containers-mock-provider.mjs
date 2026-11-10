// Mock OpenAI-compatible chat provider for scripts/opencode-containers-live.ts. Runs inside a throwaway container
// (plain node, no dependencies). The FIRST user message picks the scenario: `SCENARIO:text`, `SCENARIO:tool:<urlencoded cmd>`,
// `SCENARIO:hold` (a model call that never answers). `GET /__stats` returns {requests, held}.
import { createServer } from 'node:http';

const stats = { requests: 0, held: 0 };
const base = (delta, finish = null, usage) => ({
  id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock',
  choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
});
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
createServer((req, res) => {
  if (req.url === '/__stats') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stats)); }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    stats.requests++;
    let msgs = [];
    try { msgs = JSON.parse(body).messages ?? []; } catch { /* fallthrough */ }
    const text = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
    const sc = /SCENARIO:(\S+)/.exec(text(msgs.find((m) => m.role === 'user')))?.[1] ?? 'text';
    const afterTool = msgs.at(-1)?.role === 'tool';
    const usage = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };
    if (sc === 'hold' && !afterTool && msgs.some((m) => m.role === 'user') && !/title/i.test(text(msgs[0]))) {
      stats.held++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(base({ role: 'assistant', content: '' }))}\n\n`);
      const t = setTimeout(() => res.end(), 120000);
      res.on('close', () => { clearTimeout(t); stats.held--; });
      return;
    }
    if (sc.startsWith('tool:') && !afterTool) {
      const command = decodeURIComponent(sc.slice(5));
      return sse(res, [
        base({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'live check' }) } }] }),
        base({}, 'tool_calls', usage),
      ]);
    }
    sse(res, [base({ role: 'assistant', content: 'done' }), base({}, 'stop', usage)]);
  });
}).listen(9999, '0.0.0.0');
