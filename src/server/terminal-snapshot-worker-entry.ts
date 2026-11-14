import { parentPort } from 'node:worker_threads';
import { snapshotStreamingAttachSeed, type StreamingAttachSnapshotOptions } from './streaming-attach-snapshot.js';
import { renderTerminalScreenText, type TerminalScreenTextOptions } from './terminal-screen-text.js';

if (!parentPort) throw new Error('Terminal snapshot requires a worker port');
const port = parentPort;

type Request =
  | { id: number; job?: 'seed'; bytes: Uint8Array; options: StreamingAttachSnapshotOptions }
  | { id: number; job: 'text'; bytes: Uint8Array; options: TerminalScreenTextOptions };

port.on('message', async (request: Request) => {
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
