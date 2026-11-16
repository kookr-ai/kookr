import { parentPort } from 'node:worker_threads';
import { snapshotStreamingAttachSeed, type StreamingAttachSnapshotOptions } from './streaming-attach-snapshot.js';
import { renderTerminalScreenText, type TerminalScreenTextOptions } from './terminal-screen-text.js';
import { LiveScreenModelSet, type LiveScreenJob, type LiveScreenJobResult } from './terminal-live-screen.js';

if (!parentPort) throw new Error('Terminal snapshot requires a worker port');
const port = parentPort;

type Request =
  | { id: number; job?: 'seed'; bytes: Uint8Array; options: StreamingAttachSnapshotOptions }
  | { id: number; job: 'text'; bytes: Uint8Array; options: TerminalScreenTextOptions }
  | { id: number; job: 'live'; bytes: Uint8Array; options: LiveScreenJob };

/**
 * Live screen models (issue #3564, step 2). Their jobs run strictly one after
 * another, in arrival order: a model must see its bytes in order, and the host
 * blames a stall on its oldest unanswered job, which is only right if that is
 * the job running.
 */
const models = new LiveScreenModelSet();
let liveQueue: Promise<void> = Promise.resolve();

port.on('message', async (request: Request) => {
  if (request.job === 'live') {
    liveQueue = liveQueue.then(async () => {
      let result: LiveScreenJobResult;
      try { result = await models.run(request.options, request.bytes); }
      catch { result = { kind: 'unavailable', reason: 'failed', elapsedMs: 0 }; }
      port.postMessage({ id: request.id, result }, result.kind === 'seed' ? [result.bytes.buffer as ArrayBuffer] : []);
    });
    return;
  }
  try {
    // One job at a time: the modules' shared slot queues the rest, in this thread.
    const result = request.job === 'text'
      ? await renderTerminalScreenText(request.bytes, request.options)
      : await snapshotStreamingAttachSeed(request.bytes, request.options);
    port.postMessage({ id: request.id, result });
  } catch {
    port.postMessage({ id: request.id, result: { kind: 'unavailable', reason: 'failed', elapsedMs: 0 } });
  }
});
